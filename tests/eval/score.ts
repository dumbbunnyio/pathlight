import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { acquireModel } from "../../src/catalog";
import { checkWorkspace } from "../../src/check";
import { crowdedAbove } from "../../src/draft";
import { readActivityConfig } from "../../src/activity";
import { io, json } from "../../src/effects";
import { scanWorkspace } from "../../src/scan";

/**
 * Scores a workspace's model and file mapping. Nothing here asks a model for an opinion: every number is counted from the
 * scan, from `pathlight check`, from the computed LikeC4 views, or from rules that a repository's own authors wrote down.
 * Used on drafts, on agent-written models and on hand-written ones, so a change to the scanner, the draft or the skill can be
 * compared with what came before.
 */

export const Assertion = Schema.Struct({
  kind: Schema.Literals(["edge", "no-edge"]), from: Schema.String, to: Schema.String,
  // `stated`: the document says it. `implied`: it follows from what the document says, in the scorer's reading.
  basis: Schema.Literals(["stated", "implied"]), source: Schema.String, quote: Schema.String,
});
export interface Assertion extends Schema.Schema.Type<typeof Assertion> {}
export const Reference = Schema.Struct({ repo: Schema.String, commit: Schema.String, note: Schema.optionalKey(Schema.String), assertions: Schema.Array(Assertion) });
export interface Reference extends Schema.Schema.Type<typeof Reference> {}

export const readReference = (path: string) => io("Eval.reference", () => readFile(path, "utf8")).pipe(
  Effect.flatMap(json), Effect.flatMap(Schema.decodeUnknownEffect(Reference)));

export interface Score {
  elements: number;
  files: { eligible: number; claimed: number; coverage: number };
  /** Of the relationships the model declares, how many an import supports (unverifiable ones, with no mapped files, are left out). */
  edges: { declared: number; supported: number; unsupported: number; unverifiable: number; precision: number };
  /** Of the element pairs the imports connect, how many a relationship covers. */
  pairs: { covered: number; undeclared: number; recall: number };
  assertions: { total: number; passed: number; failures: { assertion: Assertion; found: boolean }[] };
  /** `maxChildren`: in a readable view, the most cards drawn inside one box (a package's, a folder's or a collection's children side by side). */
  views: { count: number; maxNodes: number; medianNodes: number; maxEdges: number; crowded: number; listings: number; maxChildren: number };
}

const within = (element: string, ancestor: string) => element === ancestor || element.startsWith(`${ancestor}.`);
const ratio = (part: number, whole: number) => whole === 0 ? 1 : part / whole;
export { crowdedAbove };

export const scoreWorkspace = Effect.fn("Eval.score")(function* (workspace: string, reference?: Reference) {
  const check = yield* checkWorkspace(workspace);
  // A view the mapping declares as an entry (a complete listing, a report of cycles) is big on purpose.
  const listings = new Set((yield* readActivityConfig(workspace)).entries ?? []);
  const scan = yield* scanWorkspace(workspace);
  const eligible = scan.files.length - check.mappings.ignored;
  const claimed = eligible - check.mappings.unmappedFiles.length;
  const supported = check.relationships.filter(item => item.status === "supported").length;
  const unsupported = check.relationships.filter(item => item.status === "unsupported").length;
  const unverifiable = check.relationships.filter(item => item.status === "unverifiable").length;
  const covered = check.relationships.filter(item => item.status === "supported").length;

  const exists = (from: string, to: string) => check.relationships.some(item => within(item.source, from) && within(item.target, to)
    || (item.direction !== "same" && within(item.source, to) && within(item.target, from) && item.direction === "opposite"));
  const results = (reference?.assertions ?? []).map(assertion => ({ assertion, found: exists(assertion.from, assertion.to) }));
  const failures = results.filter(item => item.found !== (item.assertion.kind === "edge"));

  const source = yield* acquireModel(workspace);
  const views = yield* io("Eval.views", async () => {
    const model = await source.computedModel(check.project);
    return [...model.views()].map(view => {
      const inside = new Map<string, number>();
      for (const node of view.$view.nodes) if (node.parent) inside.set(String(node.parent), (inside.get(String(node.parent)) ?? 0) + 1);
      return { id: String(view.id), nodes: view.$view.nodes.length, edges: view.$view.edges.length, children: Math.max(0, ...inside.values()) };
    });
  });
  // Views meant to be read are counted separately from the complete listings.
  const readable = views.filter(view => !listings.has(view.id));
  const nodeCounts = readable.map(view => view.nodes).sort((a, b) => a - b);

  const elements = new Set<string>([...check.relationships.flatMap(item => [item.source, item.target]), ...check.size.map(item => item.element)]).size;
  return {
    elements,
    files: { eligible, claimed, coverage: ratio(claimed, eligible) },
    edges: { declared: check.relationships.length, supported, unsupported, unverifiable, precision: ratio(supported, supported + unsupported) },
    pairs: { covered, undeclared: check.undeclared.length, recall: ratio(covered, covered + check.undeclared.length) },
    assertions: { total: results.length, passed: results.length - failures.length, failures },
    views: { count: views.length, maxNodes: nodeCounts.at(-1) ?? 0, medianNodes: nodeCounts[Math.floor(nodeCounts.length / 2)] ?? 0, maxEdges: Math.max(0, ...views.map(view => view.edges)), crowded: readable.filter(view => view.nodes > crowdedAbove).length, listings: views.length - readable.length, maxChildren: Math.max(0, ...readable.map(view => view.children)) },
  } satisfies Score;
}, Effect.scoped);

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function formatScore(score: Score, name: string) {
  const lines = [`${name}`,
    `  files       ${percent(score.files.coverage)} claimed (${score.files.claimed} of ${score.files.eligible})`,
    `  edges       ${percent(score.edges.precision)} supported by imports (${score.edges.supported} of ${score.edges.supported + score.edges.unsupported}${score.edges.unverifiable ? `, ${score.edges.unverifiable} unverifiable` : ""})`,
    `  pairs       ${percent(score.pairs.recall)} of connected element pairs declared (${score.pairs.undeclared} undeclared)`,
    `  authors     ${score.assertions.total ? `${score.assertions.passed} of ${score.assertions.total} stated rules hold` : "no reference rules given"}`,
    `  views       ${score.views.count} views (${score.views.listings} complete listings); most boxes in a readable one ${score.views.maxNodes}, median ${score.views.medianNodes}; ${score.views.crowded} over ${crowdedAbove}; most cards inside one box ${score.views.maxChildren}; most lines in any view ${score.views.maxEdges}`];
  for (const item of score.assertions.failures) lines.push(`    ✗ ${item.assertion.kind === "edge" ? `${item.assertion.from} should depend on ${item.assertion.to}` : `${item.assertion.from} should not depend on ${item.assertion.to}`} (${item.assertion.source}: “${item.assertion.quote}”)`);
  return lines.join("\n");
}
