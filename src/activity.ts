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
  const operation = /^(read|glob|grep)$/.test(name) ? "read"
    : /^(edit|write|patch|apply_patch|multiedit)$/.test(name) ? "edit"
    : /^(bash|shell|powershell)$/.test(name) ? "command" : "other";
  const candidates: string[] = [];
  if (Result.isSuccess(args) && (operation === "read" || operation === "edit")) {
    for (const key of ["path", "filePath", "file_path"]) {
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

export function activityLines(events: ActivityEvent[], config: ActivityConfig, now = Date.now()) {
  const rules = config.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) }));
  return events.slice(0, 4).map(event => {
    const elements = [...new Set(rules.filter(rule => event.paths.some(path => rule.match.match(path))).map(rule => rule.element))];
    const state = event.phase === "started" && now - event.time > 30_000 ? "unconfirmed" : event.phase;
    return `${state} ${event.operation} | ${elements.join(", ") || "unmapped"} | ${event.paths.join(", ") || event.tool}`;
  });
}
