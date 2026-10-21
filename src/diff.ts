import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { readActivityConfig } from "./activity";
import { acquireModel } from "./catalog";
import { compareImports } from "./check";
import { failure, io, json } from "./effects";
import { run } from "./process";
import { listFiles, Scan, scanRevision, scanWorkspace } from "./scan";

/**
 * What changed in the architecture between a git commit (default HEAD) and the working tree: the model's relationships that an import
 * backs now and did not before (or the reverse), and pairs of elements that import each other with no relationship, newly. It reads
 * the same imports `check` does, so it is static evidence of a change in the code's dependencies, not of runtime behaviour.
 */
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const Diff = Schema.Struct({
  version: Schema.Literal(1), basis: Schema.Literal("static"), base: Schema.String, sha: Schema.String, time: Count,
  relationships: Schema.Array(Schema.Struct({ source: Name, target: Name, change: Schema.Literals(["added", "removed"]) })).check(Schema.isMaxLength(4096)),
  undeclared: Schema.Array(Schema.Struct({ source: Name, target: Name, imports: Count })).check(Schema.isMaxLength(4096)),
});
export interface Diff extends Schema.Schema.Type<typeof Diff> {}

const stampPath = (root: string) => join(root, ".cache", "pathlight", "diff.json");
const baseDirectory = (root: string) => join(root, ".cache", "pathlight", "base");
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** The files of one commit, unpacked into a fresh temporary directory that is removed afterwards. */
const withCommit = <A, E>(root: string, sha: string, use: (directory: string) => Effect.Effect<A, E>) => Effect.acquireUseRelease(
  io("Diff.mkdir", () => mkdtemp(join(tmpdir(), "pathlight-base-"))),
  directory => io("Diff.unpack", async () => {
    // The commit is a verified hash and every path is an argument, never part of the script.
    const child = Bun.spawn(["sh", "-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", root, sha, directory], { stdout: "ignore", stderr: "pipe" });
    if ((await child.exited) !== 0) throw new Error((await new Response(child.stderr).text()).trim() || "git archive failed");
  }).pipe(Effect.flatMap(() => use(directory))),
  directory => Effect.promise(() => rm(directory, { recursive: true, force: true })));

/**
 * The base commit's scan and file list, kept under `.cache/pathlight/base` so the Stop hook does not unpack and scan the same commit every turn. Only the
 * latest commit is kept; an entry is used only if it names this commit and this scanner revision and still decodes as a scan, and anything else is recomputed.
 */
const Cached = Schema.Struct({ revision: Schema.Number, sha: Schema.String, paths: Schema.Array(Schema.String), scan: Scan });
const baseFacts = (root: string, sha: string) => Effect.gen(function* () {
  const file = join(baseDirectory(root), `${sha}.json`);
  const hit = yield* io("Diff.cache", () => readFile(file, "utf8")).pipe(
    Effect.flatMap(json), Effect.flatMap(Schema.decodeUnknownEffect(Cached)),
    Effect.filterOrFail(entry => entry.revision === scanRevision && entry.sha === sha, () => "stale"), Effect.option);
  if (hit._tag === "Some") return { scan: hit.value.scan, paths: hit.value.paths, cached: true };
  const fresh = yield* withCommit(root, sha, directory => Effect.gen(function* () { return { scan: yield* scanWorkspace(directory), paths: (yield* listFiles(directory)).paths }; }));
  yield* io("Diff.cacheWrite", async () => {
    await mkdir(baseDirectory(root), { recursive: true });
    for (const name of await readdir(baseDirectory(root))) if (name !== `${sha}.json`) await rm(join(baseDirectory(root), name), { force: true });
    const temporary = `${file}.${process.pid}`;
    await writeFile(temporary, JSON.stringify({ revision: scanRevision, sha, paths: fresh.paths, scan: fresh.scan }));
    await rename(temporary, file);
  }).pipe(Effect.ignore);
  return { ...fresh, cached: false };
});

export const diffWorkspace = Effect.fn("Diff.workspace")(function* (workspace: string, base = "HEAD") {
  const root = yield* io("Diff.root", () => realpath(workspace));
  if (!/^[\w./~^@{}-]{1,200}$/.test(base) || base.startsWith("-")) return yield* Effect.fail(failure("Diff.base", `'${base}' is not a git revision.`));
  const sha = (yield* run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`]).pipe(
    Effect.catch(() => Effect.fail(failure("Diff.base", `'${base}' is not a commit in this repository (diff compares with git history).`))))).trim();
  const config = yield* readActivityConfig(root);
  const source = yield* acquireModel(root);
  if (source.hasErrors()) return yield* Effect.fail(failure("Diff.model", "Invalid LikeC4 model. Run likec4 validate in the workspace first."));
  const model = yield* io("LikeC4.compute", () => source.computedModel(config.project));
  const declared = [...model.relationships()].map(item => ({ source: String(item.source.id), target: String(item.target.id), title: item.title ?? null }));

  const now = compareImports(config, yield* scanWorkspace(root), (yield* listFiles(root)).paths, declared);
  const baseline = yield* baseFacts(root, sha);
  const before = compareImports(config, baseline.scan, baseline.paths, declared);

  const key = (item: { source: string; target: string }) => `${item.source}\0${item.target}`;
  const wasSupported = new Map(before.relationships.map(item => [key(item), item.status === "supported"]));
  const relationships = now.relationships.flatMap(item => {
    const was = wasSupported.get(key(item)) ?? false, is = item.status === "supported";
    return was === is ? [] : [{ source: item.source, target: item.target, change: is ? "added" as const : "removed" as const }];
  });
  const hadUndeclared = new Set(before.undeclared.map(key));
  const undeclared = now.undeclared.filter(item => !hadUndeclared.has(key(item))).map(({ source, target, imports }) => ({ source, target, imports }));
  return Diff.make({ version: 1, basis: "static", base, sha, time: Date.now(),
    relationships: relationships.sort((a, b) => order(a.source, b.source) || order(a.target, b.target)).slice(0, 4096), undeclared: undeclared.slice(0, 4096) });
}, Effect.scoped);

/** Records a diff for the viewer. Best effort: a read-only workspace just never shows it. */
export const recordDiff = (workspace: string, diff: Diff) => Effect.gen(function* () {
  const root = yield* io("Diff.root", () => realpath(workspace));
  yield* io("Diff.write", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${stampPath(root)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(diff)}\n`);
    await rename(temporary, stampPath(root));
  });
}).pipe(Effect.ignore);

export const readDiff = (workspace: string) => Effect.gen(function* () {
  const root = yield* io("Diff.root", () => realpath(workspace));
  const text = yield* io("Diff.read", () => readFile(stampPath(root), "utf8"));
  return yield* Schema.decodeUnknownEffect(Diff, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));

export const formatDiff = (diff: Diff) => {
  const lines = [`pathlight diff · ${diff.base} (${diff.sha.slice(0, 8)}) → working tree · static evidence: imports only`, ""];
  const group = (change: "added" | "removed", heading: string) => {
    const items = diff.relationships.filter(item => item.change === change);
    if (items.length) lines.push(heading, ...items.map(item => `  ${change === "added" ? "+" : "−"} ${item.source} → ${item.target}`));
  };
  group("added", "Relationships an import backs now and did not before");
  group("removed", "Relationships that lost the imports behind them");
  if (diff.undeclared.length) lines.push("New imports the model has no relationship for", ...diff.undeclared.map(item => `  ▲ ${item.source} → ${item.target}  ${item.imports} import${item.imports === 1 ? "" : "s"}`));
  if (!diff.relationships.length && !diff.undeclared.length) lines.push("No change in the relationships the imports support.");
  return `${lines.join("\n")}\n`;
};
