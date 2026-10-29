import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect, Schema } from "effect";
import type { ActivityBinding } from "./activity";
import { failure, io, json } from "./effects";
import { sessionsPath } from "./layout";

/**
 * Where a recorded session's conversation is kept by its host, and two facts the hooks see that the conversation file does not say: whether the host is
 * waiting for the person in its own pane (a permission prompt, a question), and when its last turn ended. A path, a flag and a time: never a word of
 * the conversation, which the viewer reads from the host's own file when it is showing the talk and keeps nothing of.
 */
export const SessionPointer = Schema.Struct({
  version: Schema.Literal(1), source: Schema.Literals(["opencode", "claude"]), session: Schema.String.check(Schema.isPattern(/^[\w-]{1,128}$/)),
  transcript: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  waiting: Schema.Boolean,
  ended: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});
export interface SessionPointer extends Schema.Schema.Type<typeof SessionPointer> {}

const pointerPath = (root: string, binding: ActivityBinding) => join(sessionsPath(root), `${binding.source}-${binding.session}.json`);

/** What a hook changes: the transcript's path when it names one, the waiting flag, and the end of a turn (a time) or the start of one (`null`). */
export interface SessionChange { transcript?: string; waiting?: boolean; ended?: number | null }

/** Updates a session's pointer with what one hook saw, writing only when something changed (the hooks fire on every tool call). */
export const recordSession = Effect.fn("Sessions.record")(function* (workspace: string, binding: ActivityBinding, change: SessionChange) {
  const root = yield* io("Sessions.root", () => realpath(workspace));
  if (change.transcript !== undefined && !isAbsolute(change.transcript)) return yield* Effect.fail(failure("Sessions.transcript", "A conversation file must be an absolute path."));
  const before = yield* readSession(root, binding);
  const next = yield* Schema.decodeUnknownEffect(SessionPointer)({
    version: 1, source: binding.source, session: binding.session,
    ...(change.transcript ?? before?.transcript) !== undefined ? { transcript: change.transcript ?? before?.transcript } : {},
    waiting: change.waiting ?? before?.waiting ?? false, ended: change.ended === undefined ? before?.ended ?? null : change.ended,
  });
  if (before && JSON.stringify(before) === JSON.stringify(next)) return next;
  yield* io("Sessions.write", async () => {
    await mkdir(sessionsPath(root), { recursive: true });
    const temporary = `${pointerPath(root, binding)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`);
    await rename(temporary, pointerPath(root, binding));
  });
  return next;
});

/** A session's pointer, or undefined when none was recorded (or it cannot be read). */
export const readSession = (workspace: string, binding: ActivityBinding) => Effect.gen(function* () {
  const text = yield* io("Sessions.read", () => readFile(pointerPath(workspace, binding), "utf8"));
  return yield* Schema.decodeUnknownEffect(SessionPointer, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));
