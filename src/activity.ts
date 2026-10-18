import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Schema, Result } from "effect";
import { io, json, hasCode } from "./effects";

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[\w./:@ -]+$/));
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024), Schema.isPattern(/^[^\x00-\x1f\x7f]+$/),
  Schema.makeFilter(path => !isAbsolute(path) && path !== ".." && !path.startsWith("../")));
export const ActivityBinding = Schema.Struct({ source: Schema.Literals(["opencode", "claude"]), session: Label });
export interface ActivityBinding extends Schema.Schema.Type<typeof ActivityBinding> {}
export const ActivityEvent = Schema.Struct({
  ...ActivityBinding.fields, version: Schema.Literal(1), call: Label, tool: Label,
  phase: Schema.Literals(["started", "completed", "failed"]),
  operation: Schema.Literals(["read", "edit", "command", "other"]),
  paths: Schema.Array(Path).check(Schema.isMaxLength(32)), time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export interface ActivityEvent extends Schema.Schema.Type<typeof ActivityEvent> {}
export const ActivityConfig = Schema.Struct({
  version: Schema.Literal(1), project: Schema.NonEmptyString,
  mappings: Schema.Array(Schema.Struct({ glob: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)), element: Label })).check(Schema.isMaxLength(256)),
});
export interface ActivityConfig extends Schema.Schema.Type<typeof ActivityConfig> {}

export const readActivityConfig = Effect.fn("Activity.config")(function* (workspace: string) {
  const text = yield* io("Activity.readConfig", () => readFile(join(workspace, "c4view.activity.json"), "utf8"));
  return yield* Schema.decodeUnknownEffect(ActivityConfig, { onExcessProperty: "error" })(yield* json(text));
});

export const activityDirectory = Effect.fn("Activity.directory")(function* (workspace: string, binding: ActivityBinding) {
  const root = yield* io("Activity.root", () => realpath(workspace));
  const parsed = yield* Schema.decodeUnknownEffect(ActivityBinding)(binding);
  const id = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  return join(root, ".cache", "c4view", "activity", id);
});

export const toolActivity = Effect.fn("Activity.fromTool")(function* (workspace: string, binding: ActivityBinding, call: string, tool: string,
  input: unknown, phase: ActivityEvent["phase"]) {
  const args = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(input);
  const name = tool.toLowerCase();
  const operation = /^(read|glob|grep|ls|list|view|notebookread)$/.test(name) ? "read"
    : /^(edit|write|patch|apply_patch|multiedit|notebookedit|str_replace_based_edit_tool)$/.test(name) ? "edit"
    : /^(bash|shell|powershell)$/.test(name) ? "command" : "other";
  const candidates: string[] = [];
  if (Result.isSuccess(args) && (operation === "read" || operation === "edit")) {
    for (const key of ["path", "filePath", "file_path", "notebook_path"]) {
      if (typeof args.success[key] === "string") candidates.push(args.success[key]);
    }
    for (const key of ["patchText", "patch"]) {
      const patch = args.success[key];
      if (typeof patch === "string") {
        for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
          if (match[1]) candidates.push(match[1].trim());
        }
      }
    }
  }
  const paths = [...new Set(candidates.map(path => relative(workspace, resolve(workspace, path)))
    .filter(path => path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
      && !/[\x00-\x1f\x7f]/.test(path)).map(path => path.split(sep).join("/")))].slice(0, 32);
  return yield* Schema.decodeUnknownEffect(ActivityEvent)({ ...binding, version: 1, call, tool, phase, operation, paths, time: yield* Effect.clockWith(clock => clock.currentTimeMillis) });
});

export const writeActivity = Effect.fn("Activity.write")(function* (workspace: string, event: ActivityEvent) {
  const parsed = yield* Schema.decodeUnknownEffect(ActivityEvent, { onExcessProperty: "error" })(event);
  const directory = yield* activityDirectory(workspace, parsed);
  yield* io("Activity.mkdir", () => mkdir(directory, { recursive: true, mode: 0o700 }));
  const filename = `${String(parsed.time).padStart(16, "0")}-${randomUUID()}.json`;
  const temporary = join(directory, `${filename}.tmp`);
  yield* Effect.gen(function* () {
    yield* io("Activity.writeTemporary", () => writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: "wx" }));
    yield* io("Activity.publish", () => rename(temporary, join(directory, filename)));
    const files = (yield* io("Activity.entries", () => readdir(directory))).filter(file => file.endsWith(".json")).sort();
    yield* Effect.forEach(files.slice(0, -256), file => io("Activity.prune", () => unlink(join(directory, file))).pipe(
      Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.void)), { concurrency: 8, discard: true });
  }).pipe(Effect.ensuring(io("Activity.removeTemporary", () => unlink(temporary)).pipe(Effect.ignore)), Effect.uninterruptible);
});

export const readActivity = Effect.fn("Activity.read")(function* (workspace: string, binding: ActivityBinding) {
  const directory = yield* activityDirectory(workspace, binding);
  const files = yield* io("Activity.entries", () => readdir(directory)).pipe(Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed([])));
  const records = yield* Effect.forEach(files.filter(file => file.endsWith(".json")).sort().slice(-256), file => Effect.gen(function* () {
    const text = yield* io("Activity.readEvent", () => readFile(join(directory, file), "utf8"));
    return yield* Schema.decodeUnknownEffect(ActivityEvent, { onExcessProperty: "error" })(yield* json(text));
  }).pipe(Effect.catch(() => Effect.succeed(undefined))), { concurrency: 16 });
  const calls = new Map<string, ActivityEvent>();
  for (const event of records) {
    if (!event || event.source !== binding.source || event.session !== binding.session) continue;
    const old = calls.get(event.call);
    if (old && old.phase !== "started" && event.phase === "started") continue;
    if (!old || old.phase === "started" || event.time >= old.time) calls.set(event.call, event);
  }
  return [...calls.values()].sort((a, b) => b.time - a.time).slice(0, 128);
});

const activityRoot = (root: string) => join(root, ".cache", "c4view", "activity");

/** The session that most recently wrote an event for this workspace, for `--follow`. */
export const latestBinding = Effect.fn("Activity.latest")(function* (workspace: string) {
  const base = activityRoot(yield* io("Activity.root", () => realpath(workspace)));
  const directories = yield* io("Activity.sessions", () => readdir(base)).pipe(
    Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed([])));
  const newest = yield* Effect.forEach(directories, directory => io("Activity.entries", () => readdir(join(base, directory))).pipe(
    Effect.map(files => files.filter(file => file.endsWith(".json")).sort().at(-1)),
    Effect.map(file => file ? { directory, file } : undefined),
    Effect.catch(() => Effect.succeed(undefined))), { concurrency: 8 });
  const winner = newest.filter(entry => entry !== undefined).sort((a, b) => b.file.localeCompare(a.file))[0];
  if (!winner) return undefined;
  const text = yield* io("Activity.readEvent", () => readFile(join(base, winner.directory, winner.file), "utf8"));
  const event = yield* Schema.decodeUnknownEffect(ActivityEvent, { onExcessProperty: "error" })(yield* json(text));
  return { source: event.source, session: event.session } satisfies ActivityBinding;
}, Effect.catch(() => Effect.succeed(undefined)));

export type ActivityRow = { state: "started" | "completed" | "failed" | "unconfirmed"; operation: ActivityEvent["operation"]; elements: string[]; target: string; age: number };

export function activityRows(events: ActivityEvent[], config: ActivityConfig, now = Date.now(), limit = 4): ActivityRow[] {
  const rules = config.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) }));
  return events.slice(0, limit).map(event => ({
    state: event.phase === "started" && now - event.time > 30_000 ? "unconfirmed" : event.phase,
    operation: event.operation,
    elements: [...new Set(rules.filter(rule => event.paths.some(path => rule.match.match(path))).map(rule => rule.element))],
    target: event.paths.join(", ") || event.tool,
    age: Math.max(0, now - event.time),
  }));
}

export function activityLines(events: ActivityEvent[], config: ActivityConfig, now = Date.now()) {
  return activityRows(events, config, now).map(row => {
    const state = row.state === "started" ? "started" : row.state;
    return `${state} ${row.operation} | ${row.elements.join(", ") || "unmapped"} | ${row.target}`;
  });
}

/** Coarse on purpose: a finished call must not make the display change every second. */
export function formatAge(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 10 ? "now" : seconds < 60 ? "<1m" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}
