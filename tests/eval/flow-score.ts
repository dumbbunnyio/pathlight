import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { Effect, Schema } from "effect";
import { readActivityConfig, type ActivityConfig } from "../../src/activity";
import { io, json } from "../../src/effects";
import { checkFlows, elementsOf, namedFiles, type JourneyReport } from "../../src/flows";
import { run } from "../../src/process";
import { scanWorkspace } from "../../src/scan";

/**
 * Scores the journeys an agent wrote (`pathlight flow add`) against a hand-written answer and against the code. As with the map score, nothing
 * here asks a model for an opinion: a hop is counted as matching the answer, backed by a model relationship, or supported by an import between
 * files the agent says it read. The answer is the scorer's own reading of the code, so a hop it does not list is not called wrong by that alone:
 * a hop is only **invented** when it is outside the answer *and* no import stands behind it.
 */
export const FlowReference = Schema.Struct({
  repo: Schema.String, commit: Schema.String, note: Schema.optionalKey(Schema.String),
  questions: Schema.Array(Schema.Struct({
    id: Schema.String, question: Schema.String, note: Schema.optionalKey(Schema.String),
    // The hops of a correct trace, in order, as component ids.
    // `optional`: a hop a good trace may or may not draw; it is never missed, and counts as matched when it is there.
    // `over`: the hop is not an import but a request, a socket or a spawned process, written in by hand from reading the code. The import-drawn
    // map cannot hold such an edge, so the hop is not failed for lacking a relationship or an import; it is still required, in order.
    hops: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String, optional: Schema.optionalKey(Schema.Boolean), over: Schema.optionalKey(Schema.Literals(["http", "websocket", "process"])) })),
    // Files a correct trace has to read; citing them is how a reader can check the hops.
    files: Schema.Array(Schema.String),
  })),
});
export interface FlowReference extends Schema.Schema.Type<typeof FlowReference> {}
export type Question = FlowReference["questions"][number];

export const readFlowReference = (path: string) => io("Eval.flowReference", () => readFile(path, "utf8")).pipe(
  Effect.flatMap(json), Effect.flatMap(Schema.decodeUnknownEffect(FlowReference)));

export interface Hop { from: string; to: string; backed: boolean }
export interface FlowScoreInput {
  question: Question;
  // `undefined`: the agent wrote no journey with this id.
  written?: { hops: readonly Hop[]; cited: readonly string[]; missingFiles: readonly string[]; findings: readonly string[] };
  // Whether an import joins two components through a file the agent cited (either direction: data can flow against the import).
  supported: (from: string, to: string, cited: readonly string[]) => boolean;
}
export interface FlowScore {
  id: string; written: boolean;
  hops: number; matched: number; missed: string[];
  // Outside the answer and with no import joining the two components through a file the agent read: nothing in the code stands behind it. The pass mark forbids it.
  invented: string[];
  // Outside the answer, an import supports it, but the model has no relationship for it: the story and the model disagree (the viewer shows `≠`),
  // so either the hop or the model is wrong. Not an invention, and not a pass either.
  modelGaps: string[];
  // Outside the answer but backed by the model and by an import: a different reading, to be read, not counted against it.
  additional: string[];
  // Hops without a model relationship, and without an import in either direction; a runtime hop counts in neither.
  unbacked: number; unsupported: number;
  // Hops matching an answer hop marked `over`, and how many of them the model has no relationship for: shown, not failed.
  runtime: string[]; runtimeUnbacked: number;
  // Of the hops that match the answer, how many come in the answer's order.
  ordered: number;
  citedKey: number; keyFiles: number; missingFiles: string[];
  findings: number;
}

const label = (hop: { from: string; to: string }) => `${hop.from} → ${hop.to}`;

export function scoreFlow(input: FlowScoreInput): FlowScore {
  const { question, written } = input;
  const answer = question.hops.map(label), required = question.hops.filter(hop => !hop.optional).map(label);
  const base = { id: question.id, keyFiles: question.files.length };
  if (!written) return { ...base, written: false, hops: 0, matched: 0, missed: required, invented: [], modelGaps: [], additional: [], unbacked: 0, unsupported: 0, runtime: [], runtimeUnbacked: 0, ordered: 0, citedKey: 0, missingFiles: [], findings: 0 };
  const hops = written.hops.map(hop => ({ ...hop, text: label(hop), expected: answer.indexOf(label(hop)), supported: input.supported(hop.from, hop.to, written.cited) }))
    .map(hop => ({ ...hop, over: hop.expected >= 0 ? question.hops[hop.expected]!.over : undefined }));
  const runtime = hops.filter(hop => hop.over), imported = hops.filter(hop => !hop.over);
  const matched = hops.filter(hop => hop.expected >= 0);
  // The longest run of matched hops that never goes backwards in the answer's order.
  const tails: number[] = [];
  for (const { expected } of matched) {
    let slot = tails.findIndex(tail => tail >= expected);
    if (slot < 0) slot = tails.length;
    tails[slot] = expected;
  }
  const outside = hops.filter(hop => hop.expected < 0);
  return {
    ...base, written: true, hops: hops.length, matched: new Set(matched.map(hop => hop.text)).size,
    missed: required.filter(text => !hops.some(hop => hop.text === text)),
    invented: outside.filter(hop => !hop.supported).map(hop => hop.text),
    modelGaps: outside.filter(hop => hop.supported && !hop.backed).map(hop => hop.text),
    additional: outside.filter(hop => hop.backed && hop.supported).map(hop => hop.text),
    unbacked: imported.filter(hop => !hop.backed).length, unsupported: imported.filter(hop => !hop.supported).length,
    runtime: runtime.map(hop => `${hop.text} over ${hop.over}`), runtimeUnbacked: runtime.filter(hop => !hop.backed).length,
    ordered: tails.length,
    citedKey: question.files.filter(file => written.cited.includes(file)).length,
    missingFiles: [...written.missingFiles], findings: written.findings.length,
  };
}

/** What a run has to meet: every hop of the answer present and in order, nothing invented, every hop backed by the model and an import (a runtime hop by neither), no file cited that is not there, and every key file read. */
export const passes = (score: FlowScore) => score.written && score.missed.length === 0 && score.ordered === score.matched && score.invented.length === 0 && score.unbacked === 0 && score.unsupported === 0 && score.missingFiles.length === 0 && score.citedKey === score.keyFiles;

export const scoreFlows = Effect.fn("Eval.flows")(function* (workspace: string, reference: FlowReference) {
  const config: ActivityConfig = yield* readActivityConfig(workspace);
  const scan = yield* scanWorkspace(workspace);
  const report = yield* checkFlows(workspace);
  const exists = (path: string) => existsSync(join(workspace, path)) && lstatSync(join(workspace, path)).isFile();
  const listed = yield* run("git", ["-C", workspace, "ls-files", "-co", "--exclude-standard", "--", ":(glob)**/*.behavior.c4"]).pipe(Effect.catch(() => Effect.succeed("")));
  const files = listed.split("\n").filter(Boolean);
  const within = (element: string, ancestor: string) => element === ancestor || element.startsWith(`${ancestor}.`);
  const supported = (from: string, to: string, cited: readonly string[]) => scan.imports.some(item => {
    const a = elementsOf(config, item.from), b = elementsOf(config, item.to);
    const forwards = a.some(id => within(id, from)) && b.some(id => within(id, to)), backwards = a.some(id => within(id, to)) && b.some(id => within(id, from));
    return (forwards || backwards) && (cited.includes(item.from) || cited.includes(item.to));
  });
  const scores: FlowScore[] = [];
  for (const question of reference.questions) {
    const journey: JourneyReport | undefined = report.journeys.find(entry => entry.id === question.id);
    const path = files.find(candidate => candidate.endsWith(`/${question.id}.behavior.c4`) || candidate === `${question.id}.behavior.c4`);
    const text = path ? yield* io("Eval.flowFile", () => readFile(join(workspace, path), "utf8")) : "";
    const note = /description\s+'((?:[^'\\]|\\.)*)'/.exec(text)?.[1] ?? "";
    const named = namedFiles(note, exists);
    scores.push(scoreFlow({
      question, supported,
      written: journey ? {
        // A reply (a hop back over a pair an earlier step opened) is that step's answer, as `pathlight flows` reads it, not a hop the model must declare.
        hops: journey.steps.map(step => ({ from: step.from!, to: step.to!, backed: step.backed === true || step.reply === true })),
        cited: named.filter(file => file.exists).map(file => file.path), missingFiles: named.filter(file => !file.exists).map(file => file.path), findings: journey.findings,
      } : undefined,
    }));
  }
  return scores;
}, Effect.scoped);

export function formatFlowScores(scores: readonly FlowScore[], name: string) {
  const lines = [name];
  for (const score of scores) {
    if (!score.written) { lines.push(`  ${score.id.padEnd(12)} no journey written`); continue; }
    lines.push(`  ${score.id.padEnd(12)} ${passes(score) ? "✓" : "✗"} ${score.matched} of the answer's hops, ${score.missed.length} missed, ${score.ordered} in order; ${score.invented.length} invented, ${score.modelGaps.length} model gaps, ${score.additional.length} additional; ${score.unbacked} without a model relationship, ${score.unsupported} without an import; key files read ${score.citedKey}/${score.keyFiles}; ${score.missingFiles.length} cited files missing`);
    if (score.runtime.length) lines.push(`      runtime hops: ${score.runtime.length}, of which ${score.runtimeUnbacked} unbacked in the model (${score.runtime.join(", ")})`);
    for (const text of score.missed) lines.push(`      missed       ${text}`);
    for (const text of score.invented) lines.push(`      invented     ${text} (no import joins them through a file it read)`);
    for (const text of score.modelGaps) lines.push(`      model gap    ${text} (an import supports it; the model has no relationship: is the hop or the model wrong?)`);
    for (const text of score.additional) lines.push(`      additional   ${text} (backed by the model and an import; read it)`);
    for (const text of score.missingFiles) lines.push(`      not a file   ${text}`);
  }
  return lines.join("\n");
}
