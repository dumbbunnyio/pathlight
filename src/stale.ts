import { realpath, rename, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { checkWorkspace, type Check } from "./check";
import { io, json } from "./effects";

/**
 * Whether the picture still matches the code, recorded each time `pathlight check` runs (the Stop hook runs it quietly at the end of every
 * agent turn). The viewer shows the counts and how old they are; it never runs the scan itself. These are static findings, so they say the
 * model and the imports disagree, not which one is wrong.
 */
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const Stale = Schema.Struct({
  version: Schema.Literal(1), time: Count, unmapped: Count, unmatched: Count, unsupported: Count, undeclared: Count,
});
export interface Stale extends Schema.Schema.Type<typeof Stale> {}

const stampPath = (root: string) => join(root, ".cache", "pathlight", "stale.json");

export const staleOf = (check: Check, time = Date.now()): Stale => ({
  version: 1, time, unmapped: check.mappings.unmappedFiles.length, unmatched: check.mappings.unmatched.length,
  unsupported: check.summary.unsupported, undeclared: check.summary.undeclared,
});

/** Records a finished check. Writing is best effort: a read-only workspace just never shows the badge. */
export const recordStale = Effect.fn("Stale.record")(function* (workspace: string, check: Check) {
  const root = yield* io("Stale.root", () => realpath(workspace));
  const stamp = staleOf(check);
  yield* io("Stale.write", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${stampPath(root)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(stamp)}\n`);
    await rename(temporary, stampPath(root));
  }).pipe(Effect.ignore);
  return stamp;
});

export const checkAndRecord = Effect.fn("Stale.checkAndRecord")(function* (workspace: string) {
  const check = yield* checkWorkspace(workspace);
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
  const parts = [
    stale.unmapped ? `${stale.unmapped} file${stale.unmapped === 1 ? "" : "s"} not in the model` : "",
    stale.undeclared ? `${stale.undeclared} import${stale.undeclared === 1 ? "" : "s"} no relationship covers` : "",
    stale.unsupported ? `${stale.unsupported} relationship${stale.unsupported === 1 ? "" : "s"} no import backs` : "",
    stale.unmatched ? `${stale.unmatched} mapping${stale.unmatched === 1 ? "" : "s"} match no file` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
};
