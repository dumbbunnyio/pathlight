import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { failure, io, json, type OperationError } from "./effects";
import { frontEndFor, frontEnds, languageFor, scannedExtensions, type FrontEnd, type Resolution, type Workspace } from "./languages";
import { run } from "./process";
import type { ImportKind, ImportNames, ImportRef } from "./scan-imports";

const Path = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Line = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const Kind = Schema.Literals(["import", "type", "reexport", "dynamic", "require"]);

/**
 * What a static read of the source says about a workspace: files, the imports between them, the packages they use,
 * and an honest account of what could not be read. Nothing here is observed at run time, and the output carries no
 * dates or absolute paths, so scanning the same tree twice gives the same text.
 */
/** Bump when a change to the scanner can change its output for the same files: `pathlight diff` keeps the base commit's scan and trusts it only for the same revision. */
export const scanRevision = 6;

export const Scan = Schema.Struct({
  version: Schema.Literal(1),
  basis: Schema.Literal("static"),
  root: Schema.String,
  files: Schema.Array(Schema.Struct({
    path: Path, language: Schema.Literals(["typescript", "javascript", "python", "go"]), lines: Count,
    // What the file offers to others, read from its `export` statements (names only; at most 80). Absent in scans made before 3.
    exports: Schema.optionalKey(Schema.Array(Schema.Struct({
      name: Schema.String.check(Schema.isMaxLength(200)),
      kind: Schema.Literals(["function", "class", "interface", "type", "enum", "const", "namespace", "default", "named", "reexport"]),
    }))),
  })),
  // Imports that resolve to a file in this workspace; `line` is where the statement starts in `from`.
  imports: Schema.Array(Schema.Struct({ from: Path, to: Path, line: Line, kind: Kind, specifier: Schema.String })),
  // Packages outside the workspace (and `node:` or `bun:` built-ins), once per importing file.
  external: Schema.Array(Schema.Struct({ from: Path, package: Schema.String, line: Line, kind: Kind })),
  // Imports that look like they point into the workspace but did not resolve to a file.
  unresolved: Schema.Array(Schema.Struct({ from: Path, specifier: Schema.String, line: Line, kind: Kind,
    reason: Schema.Literals(["not-found", "alias-not-configured", "package-entry-not-found"]) })),
  coverage: Schema.Struct({
    listing: Schema.Literals(["git", "walk"]), files: Count, imports: Count, external: Count, unresolved: Count,
    // Source files that were listed but not read: unreadable, not regular files, or over the size limit.
    skipped: Count,
    // Languages present in the workspace that this scan does not read, so their dependencies are absent.
    unscanned: Schema.Array(Schema.Struct({ extension: Schema.String, files: Count })),
  }),
});
export interface Scan extends Schema.Schema.Type<typeof Scan> {}

export const readScan = Effect.fn("Scan.read")(function* (path: string) {
  const text = yield* io("Scan.readFile", () => readFile(path, "utf8"));
  return yield* Schema.decodeUnknownEffect(Scan, { onExcessProperty: "error" })(yield* json(text));
});

// Languages that carry imports but are not read by this scan (a .vue or .svelte file holds TypeScript inside markup); one a front end reads is not among them.
const unscannedExtensions = new Set([".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php", ".cs", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm",
  ".scala", ".dart", ".zig", ".ex", ".exs", ".lua", ".vue", ".svelte", ".astro"].filter(extension => !scannedExtensions.has(extension)));
const excludedDirectories = new Set([".git", ".cache", "node_modules"]);
const limits = { entries: 50_000, bytes: 2 * 1024 * 1024 };

const extension = (path: string) => posix.extname(path);

/** Source in a language this scan does not read: it is part of the code, but its imports are unknown. */
export const isUnscannedSource = (path: string) => unscannedExtensions.has(extension(path));
/** Source in a language this scan reads. */
export const isScannedSource = (path: string) => scannedExtensions.has(extension(path));
const languageNames: Record<string, string> = { ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".rb": "Ruby",
  ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".c": "C", ".cc": "C++", ".cpp": "C++", ".h": "C", ".hpp": "C++", ".m": "Objective-C", ".mm": "Objective-C",
  ".scala": "Scala", ".dart": "Dart", ".zig": "Zig", ".ex": "Elixir", ".exs": "Elixir", ".lua": "Lua", ".vue": "Vue", ".svelte": "Svelte", ".astro": "Astro" };
/** The language an unscanned file is written in, by its extension. */
export const languageOf = (path: string) => languageNames[extension(path)] ?? extension(path);

export const listFiles = Effect.fn("Scan.list")(function* (root: string) {
  const ignoredPath = (path: string) => /[\x00-\x1f\x7f]/.test(path);
  const tooMany = () => failure("Scan.list", `The workspace lists more than ${limits.entries} files. Scan a smaller directory with --workspace.`);
  const tracked = yield* run("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).pipe(
    Effect.map(output => output.split("\0").filter(path => path && !ignoredPath(path))), Effect.option);
  if (tracked._tag === "Some") {
    if (tracked.value.length > limits.entries) return yield* Effect.fail(tooMany());
    return { listing: "git" as const, paths: [...new Set(tracked.value)].sort() };
  }
  const found: string[] = [];
  const walk = (directory: string): Effect.Effect<void, OperationError> => Effect.gen(function* () {
    for (const entry of yield* io("Scan.entries", () => readdir(join(root, directory), { withFileTypes: true }))) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (found.length >= limits.entries) return yield* Effect.fail(tooMany());
      if (ignoredPath(path)) continue;
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) yield* walk(path);
      else if (entry.isFile()) found.push(path);
    }
  });
  yield* walk("");
  return { listing: "walk" as const, paths: found.sort() };
});

const readText = (root: string, path: string) => io("Scan.read", async () => {
  const info = await lstat(join(root, path));
  if (!info.isFile() || info.size > limits.bytes) return undefined;
  return await readFile(join(root, path), "utf8");
}).pipe(Effect.catch(() => Effect.succeed(undefined)));

/**
 * Reads every source file under the workspace that a front end reads (`src/languages/`) and reports the imports between them. A file is listed with
 * `git ls-files` (so ignored files are left out) or, outside a repository, by walking the tree. Each file is read and parsed first, then each import is
 * resolved by its language's rules, so a front end may consult what every file declares (a Go import reaches the files that declare the names it uses).
 * What cannot be resolved is listed as unresolved rather than guessed.
 */
export const scanWorkspace = Effect.fn("Scan.workspace")(function* (workspace: string) {
  const root = yield* io("Scan.workspace", () => realpath(workspace));
  const { listing, paths } = yield* listFiles(root);
  const files = new Set(paths);

  const imports: Scan["imports"][number][] = [];
  // What each import takes, by position in `imports`, and the names each file declares itself: enough to follow a name through re-exports.
  const taken: { names?: ImportNames; reexport?: true }[] = [];
  const declared = new Map<string, Set<string>>();
  const unresolved: Scan["unresolved"][number][] = [];
  const external = new Map<string, Scan["external"][number]>();
  const scanned: Scan["files"][number][] = [];
  const found = new Map<string, ImportRef[]>();
  let skipped = 0;
  const sourcePaths = paths.filter(path => isScannedSource(path) && !frontEndFor(path)!.skips?.(path));
  // A grammar is loaded only when the listing holds a file of its language, and once per process.
  const present = frontEnds.filter(frontEnd => sourcePaths.some(path => frontEndFor(path) === frontEnd));
  yield* Effect.forEach(present, frontEnd => io("Scan.grammar", () => frontEnd.load()), { discard: true });
  yield* Effect.forEach(sourcePaths, path => Effect.gen(function* () {
    const text = yield* readText(root, path);
    if (text === undefined) { skipped++; return; }
    const frontEnd = frontEndFor(path)!;
    scanned.push({ path, language: languageFor(path)!, lines: text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, exports: frontEnd.exports(text) });
    declared.set(path, new Set(frontEnd.exports(text, Infinity).filter(item => item.kind !== "reexport").map(item => item.kind === "default" ? "default" : item.name)));
    found.set(path, frontEnd.imports(text, path));
  }), { concurrency: 16, discard: true });

  const context: Workspace = { paths, files, declared, read: path => readText(root, path) };
  const resolvers = new Map<FrontEnd | undefined, (from: string, ref: ImportRef) => Resolution>();
  for (const frontEnd of present) resolvers.set(frontEnd, yield* frontEnd.resolver(context));
  for (const path of sourcePaths) {
    const resolve = resolvers.get(frontEndFor(path));
    for (const ref of found.get(path) ?? []) {
      const { specifier: raw, line, kind, reexport } = ref;
      const resolution = resolve!(path, ref);
      if (!resolution) continue;
      if ("files" in resolution) for (const { to, names } of resolution.files) { imports.push({ from: path, to, line, kind, specifier: raw }); taken.push({ names, reexport }); }
      else if ("unresolved" in resolution) unresolved.push({ from: path, specifier: raw, line, kind, reason: resolution.unresolved });
      else {
        const key = `${path}\0${resolution.external}`;
        if (!external.has(key)) external.set(key, { from: path, package: resolution.external, line, kind });
      }
    }
  }

  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const unscannedCounts = new Map<string, number>();
  for (const path of paths) if (unscannedExtensions.has(extension(path))) unscannedCounts.set(extension(path), (unscannedCounts.get(extension(path)) ?? 0) + 1);
  const unique = <T extends { from: string; line: number }>(items: T[], key: (item: T) => string) =>
    [...new Map(items.map(item => [key(item), item])).values()].sort((a, b) => order(a.from, b.from) || a.line - b.line || order(key(a), key(b)));
  const resolvedImports = unique(throughReexports(imports, taken, declared), item => `${item.from}\0${item.line}\0${item.to}\0${item.kind}\0${item.specifier}`);
  const unresolvedImports = unique(unresolved, item => `${item.from}\0${item.line}\0${item.specifier}\0${item.kind}`);
  const externalImports = [...external.values()].sort((a, b) => order(a.from, b.from) || order(a.package, b.package));
  return Scan.make({
    version: 1, basis: "static", root: basename(root),
    files: scanned.sort((a, b) => order(a.path, b.path)),
    imports: resolvedImports, external: externalImports, unresolved: unresolvedImports,
    coverage: { listing, files: scanned.length, imports: resolvedImports.length, external: externalImports.length, unresolved: unresolvedImports.length, skipped,
      unscanned: [...unscannedCounts].sort(([a], [b]) => order(a, b)).map(([ext, count]) => ({ extension: ext, files: count })) },
  });
});

export type { ImportKind };

/**
 * Imports followed through re-exports. A package's entry file (`index.ts`) usually declares nothing and re-exports everything, so an import of it says
 * which barrel was named, not which code is used: each name is followed through `export * from`, `export { a as b } from` and their type forms to the
 * file that declares it, and the import is recorded against that file (one record per file reached). A name that cannot be followed (a namespace
 * import, a binding re-exported from a local import, a module outside the workspace) keeps the import on the file it named, so nothing is guessed.
 */
export function throughReexports(imports: readonly Scan["imports"][number][], taken: readonly { names?: ImportNames; reexport?: true }[], declared: ReadonlyMap<string, ReadonlySet<string>>) {
  const offers = new Map<string, { to: string; names: ImportNames }[]>();
  imports.forEach((item, index) => { const what = taken[index]; if (what?.reexport && what.names) offers.set(item.from, [...offers.get(item.from) ?? [], { to: item.to, names: what.names }]); });
  const memo = new Map<string, string | undefined>();
  const declaring = (file: string, name: string, depth: number): string | undefined => {
    if (declared.get(file)?.has(name)) return file;
    const key = `${file}\0${name}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, undefined);
    let found: string | undefined;
    for (const edge of depth < 16 ? offers.get(file) ?? [] : []) {
      // `export *` passes on every name but the default.
      if (edge.names === "*") found = name === "default" ? undefined : declaring(edge.to, name, depth + 1);
      else {
        const match = edge.names.find(item => item.exported === name);
        // `export { a } from "./y"` says where `a` comes from even when it cannot be followed further; `export * as ns from` offers the module itself.
        if (match) found = match.imported === "*" ? edge.to : declaring(edge.to, match.imported, depth + 1) ?? edge.to;
      }
      if (found) break;
    }
    memo.set(key, found);
    return found;
  };
  return imports.flatMap((item, index) => {
    const what = taken[index];
    if (what?.reexport || !what?.names || what.names === "*" || !what.names.length || !offers.has(item.to)) return [item];
    const reached = [...new Set(what.names.map(name => declaring(item.to, name.imported, 0) ?? item.to))].sort();
    return reached.filter(to => to !== item.from).map(to => ({ ...item, to }));
  });
}
