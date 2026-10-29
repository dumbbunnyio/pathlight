import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Overlay, keysPath } from "../../src/draft";
import { io, json } from "../../src/effects";
import { overlayPath } from "../../src/layout";

/**
 * Scores the names and notes an agent wrote for a draft (`.pathlight/pathlight.overlay.json`) against a hand-written reading of the repository.
 * No model gives an opinion here. Two things are measured: **coverage** (how many of the draft's boxes got a note at all), and, for the boxes the
 * reference describes, **concepts** (each is a group of words, any one of which in the title or note counts as saying that thing) and **forbidden**
 * phrases (a claim the code contradicts). The reference is the scorer's own reading, so a note that says something true in other words can miss a
 * concept; the pass mark asks for most of them, not all.
 */
export const NameReference = Schema.Struct({
  repo: Schema.String, commit: Schema.String, note: Schema.optionalKey(Schema.String),
  // Keyed by overlay key (a package directory, a folder path, a file path), the way the overlay is.
  elements: Schema.Record(Schema.String, Schema.Struct({
    concepts: Schema.Array(Schema.Array(Schema.String).check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
    forbidden: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
  // Where a person says the app really starts: each entry is a group of files, any one of which counts. Scored against what
  // `pathlight brief --first-day` lists under "Where it starts".
  entrypoints: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String).check(Schema.isMinLength(1)))),
});
export interface NameReference extends Schema.Schema.Type<typeof NameReference> {}

export const readNameReference = (path: string) => io("Eval.nameReference", () => readFile(path, "utf8")).pipe(
  Effect.flatMap(json), Effect.flatMap(Schema.decodeUnknownEffect(NameReference)));

export interface NameScore {
  key: string; written: boolean;
  concepts: number; hit: number; missed: string[][];
  forbidden: string[];
  by: string | undefined;
}
export interface NameReport { total: number; noted: number; entries: NameScore[] }

/** A reference entry passes when it has a note, says no forbidden thing, and covers at least two thirds of its concepts. */
export const passes = (score: NameScore) => score.written && !score.forbidden.length && score.hit * 3 >= score.concepts * 2;

export function scoreNames(options: {
  keys: readonly string[];
  overlay: Overlay | undefined;
  reference: NameReference;
}): NameReport {
  const elements = options.overlay?.elements ?? {};
  const noted = options.keys.filter(key => elements[key]?.note?.trim()).length;
  const entries = Object.entries(options.reference.elements).map(([key, expected]) => {
    const entry = elements[key];
    const text = `${entry?.title ?? ""} ${entry?.note ?? ""}`.toLowerCase();
    const written = Boolean(entry?.note?.trim());
    const missed = expected.concepts.filter(group => !group.some(word => text.includes(word.toLowerCase()))).map(group => [...group]);
    return {
      key, written, concepts: expected.concepts.length, hit: expected.concepts.length - missed.length, missed,
      forbidden: (expected.forbidden ?? []).filter(phrase => text.includes(phrase.toLowerCase())),
      by: entry?.by,
    } satisfies NameScore;
  });
  return { total: options.keys.length, noted, entries };
}

export function formatNameScores(report: NameReport, workspace: string) {
  const lines = [`names · ${workspace}`, `coverage: ${report.noted} of ${report.total} boxes have a note`, ""];
  for (const score of report.entries) {
    const mark = passes(score) ? "✓" : "✗";
    const detail = !score.written ? "no note" : `${score.hit}/${score.concepts} concepts${score.forbidden.length ? `, says ${score.forbidden.map(phrase => `“${phrase}”`).join(", ")}` : ""}`;
    lines.push(`${mark} ${score.key}  ${detail}${score.by ? `  (${score.by})` : ""}`);
    for (const group of score.missed) if (score.written) lines.push(`    missing: ${group.join(" / ")}`);
  }
  const ok = report.entries.filter(passes).length;
  lines.push("", `${ok} of ${report.entries.length} described boxes pass`);
  return lines.join("\n");
}

/** The reference's starts that the briefing lists (any file of a group counts), and those it does not. */
export const scoreStarts = (reference: NameReference, listed: readonly string[]) => {
  const found = new Set(listed);
  const groups = reference.entrypoints ?? [];
  return { hits: groups.filter(group => group.some(file => found.has(file))).map(group => [...group]), misses: groups.filter(group => !group.some(file => found.has(file))).map(group => [...group]) };
};

export function formatStarts(starts: ReturnType<typeof scoreStarts>) {
  if (!starts.hits.length && !starts.misses.length) return "";
  return ["", `starts: ${starts.hits.length} of ${starts.hits.length + starts.misses.length} listed under "Where it starts"`,
    ...starts.hits.map(group => `✓ ${group.join(" / ")}`), ...starts.misses.map(group => `✗ ${group.join(" / ")}`)].join("\n");
}

/** What a workspace has now: the keys its draft recorded, and the overlay beside it. */
export const readNames = Effect.fn("Eval.names")(function* (workspace: string) {
  const keysText = yield* io("Eval.keys", () => readFile(join(workspace, keysPath), "utf8"));
  const keys = Object.values((yield* json(keysText) as Effect.Effect<{ keys: Record<string, string> }, never, never>).keys);
  const overlayText = yield* io("Eval.overlay", () => readFile(overlayPath(workspace), "utf8")).pipe(Effect.option);
  const overlay = overlayText._tag === "Some" ? yield* Schema.decodeUnknownEffect(Overlay)(yield* json(overlayText.value)) : undefined;
  return { keys: [...new Set(keys)], overlay };
});
