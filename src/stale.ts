import { realpath, rename, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { checkWorkspace, type Check } from "./check";
import { isScannedSource, isUnscannedSource, listFiles } from "./scan";
import { io, json } from "./effects";

/**
 * Whether the picture still matches the code, recorded each time `pathlight check` runs (the Stop hook runs it quietly at the end of every
 * agent turn). The viewer shows the counts and how old they are; it never runs the scan itself. These are static findings, so they say the
 * model and the imports disagree, not which one is wrong.
 */
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const Stale = Schema.Struct({
  version: Schema.Literal(1), time: Count, unmapped: Count, unmatched: Count, unsupported: Count, undeclared: Count,
  // The check could not run because the model or the mapping is broken, so the counts are zero and mean nothing.
  invalid: Schema.optionalKey(Schema.Boolean),
  // What the check could cover: source files the scan reads and source files in languages it does not read. A stamp
  // written before these were recorded has neither, and reads as before.
  read: Schema.optionalKey(Count), unread: Schema.optionalKey(Count),
});
export interface Stale extends Schema.Schema.Type<typeof Stale> {}

const stampPath = (root: string) => join(root, ".cache", "pathlight", "stale.json");

export const staleOf = (check: Check, time = Date.now()): Stale => ({
  version: 1, time, unmapped: check.mappings.unmappedFiles.length, unmatched: check.mappings.unmatched.length,
  unsupported: check.summary.unsupported, undeclared: check.summary.undeclared,
});

const writeStamp = Effect.fn("Stale.write")(function* (workspace: string, stamp: Stale) {
  const root = yield* io("Stale.root", () => realpath(workspace));
  yield* io("Stale.write", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${stampPath(root)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(stamp)}\n`);
    await rename(temporary, stampPath(root));
  }).pipe(Effect.ignore);
  return stamp;
});

/** Records a finished check, with how much of the source it could read. Writing is best effort: a read-only workspace just never shows the badge. */
export const recordStale = (workspace: string, check: Check) => Effect.gen(function* () {
  const listed = yield* listFiles(workspace).pipe(Effect.map(found => found.paths), Effect.catch(() => Effect.succeed(undefined)));
  const coverage = listed ? { read: listed.filter(isScannedSource).length, unread: listed.filter(isUnscannedSource).length } : {};
  return yield* writeStamp(workspace, { ...staleOf(check), ...coverage });
});

/** Whether most of the source is in languages the check does not read, so "in sync" is true only of the languages it reads. */
export const partial = (stale: Stale | undefined) => stale?.read !== undefined && stale.unread !== undefined && stale.unread > stale.read;

// The checks that fail because a model or mapping exists and is wrong. A workspace with no mapping at all is not using pathlight, and records nothing.
const broken = new Set(["Check.model", "Check.mapping", "Check.shared", "Check.planned"]);

/**
 * Runs the check and records it. When the check cannot run because the model or the mapping is broken, that is recorded too, so the badge does not
 * keep saying "in sync" from the last good run while the diagram cannot be read. The failure is still raised.
 */
export const checkAndRecord = Effect.fn("Stale.checkAndRecord")(function* (workspace: string) {
  const check = yield* checkWorkspace(workspace).pipe(Effect.tapError(error => "operation" in error && broken.has(String(error.operation))
    ? writeStamp(workspace, { version: 1, time: Date.now(), unmapped: 0, unmatched: 0, unsupported: 0, undeclared: 0, invalid: true })
    : Effect.void));
  yield* recordStale(workspace, check);
  return check;
});

/** The last recorded check, or nothing when there is none or it cannot be read. */
export const readStale = (workspace: string) => Effect.gen(function* () {
  const root = yield* io("Stale.root", () => realpath(workspace));
  const text = yield* io("Stale.read", () => readFile(stampPath(root), "utf8"));
  return yield* Schema.decodeUnknownEffect(Stale, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));

/** What the badge says, or nothing when the model and the code agree. */
export const staleText = (stale: Stale | undefined) => {
  if (!stale) return undefined;
  if (stale.invalid) return "the model can't be read";
  const parts = [
    stale.unmapped ? `${stale.unmapped} file${stale.unmapped === 1 ? "" : "s"} not in the model` : "",
    stale.undeclared ? `${stale.undeclared} import${stale.undeclared === 1 ? "" : "s"} no relationship covers` : "",
    stale.unsupported ? `${stale.unsupported} relationship${stale.unsupported === 1 ? "" : "s"} no import backs` : "",
    stale.unmatched ? `${stale.unmatched} mapping${stale.unmatched === 1 ? "" : "s"} match no file` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
};
