import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { Diff } from "./diff";
import { io, json } from "./effects";

/**
 * The end-of-turn review: dependencies the code gained since the last commit that the model has no relationship for (`pathlight diff`, run by the Stop
 * hook), and what the person decided about each. Accepting one makes the map say so; rejecting one asks the agent to take it out. A decision is kept
 * so the same pair is never asked about twice; it is the person's, kept with the ignored state, and says nothing about whether the code is right.
 */
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Decision = Schema.Struct({ source: Name, target: Name, verdict: Schema.Literals(["accepted", "rejected"]), time: Schema.Number });
export const Decisions = Schema.Struct({ version: Schema.Literal(1), decisions: Schema.Array(Decision).check(Schema.isMaxLength(1024)) });
export interface Decisions extends Schema.Schema.Type<typeof Decisions> {}
export type Verdict = "accepted" | "rejected";

const decisionsPath = (root: string) => join(root, ".cache", "pathlight", "decisions.json");

export const readDecisions = (workspace: string) => Effect.gen(function* () {
  const root = yield* io("Review.root", () => realpath(workspace));
  const text = yield* io("Review.read", () => readFile(decisionsPath(root), "utf8"));
  return yield* Schema.decodeUnknownEffect(Decisions, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : { version: 1 as const, decisions: [] }));

/** Records a verdict on a pair, replacing any earlier one; the newest 1024 are kept. */
export const decide = Effect.fn("Review.decide")(function* (workspace: string, pair: { source: string; target: string }, verdict: Verdict) {
  const root = yield* io("Review.root", () => realpath(workspace));
  const current = yield* readDecisions(root);
  const next: Decisions = { version: 1, decisions: [...current.decisions.filter(item => item.source !== pair.source || item.target !== pair.target),
    { source: pair.source, target: pair.target, verdict, time: Date.now() }].slice(-1024) };
  yield* io("Review.write", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${decisionsPath(root)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`);
    await rename(temporary, decisionsPath(root));
  });
  return next;
});

export interface ReviewItem { source: string; target: string; imports: number; example?: { from: string; line: number; to: string }; verdict?: Verdict }

/**
 * What there is to review: each new dependency with the verdict it has, if any. Undecided ones come first. An accepted pair leaves the list once the
 * model has the relationship (the next diff no longer reports it); a rejected one stays, marked, until the code no longer makes it.
 */
export function reviewItems(diff: Diff | undefined, decisions: Decisions): ReviewItem[] {
  if (!diff) return [];
  const verdictOf = (item: { source: string; target: string }) => decisions.decisions.find(entry => entry.source === item.source && entry.target === item.target)?.verdict;
  return diff.undeclared.map(item => ({ ...item, verdict: verdictOf(item) }))
    .sort((a, b) => Number(a.verdict !== undefined) - Number(b.verdict !== undefined));
}

export const pending = (items: readonly ReviewItem[]) => items.filter(item => !item.verdict);

/** What the agent is asked to do about a pair: take a rejected dependency out, or add an accepted one to a model a person wrote. */
export function reviewMessage(item: ReviewItem, verdict: Verdict, title: (id: string) => string) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const pair = `${clean(title(item.source))} (${clean(item.source)}) → ${clean(title(item.target))} (${clean(item.target)})`;
  const where = item.example ? ` It comes from ${clean(item.example.from)}:${item.example.line}, which imports ${clean(item.example.to)}${item.imports > 1 ? `, and ${item.imports - 1} more import${item.imports === 2 ? "" : "s"}` : ""}.` : "";
  return verdict === "rejected"
    ? `I reviewed the architecture change: the new dependency ${pair} is not wanted.${where} Take it out and tell me how; if it cannot go without a bigger change, say what that change is and wait for me.`
    : `I reviewed the architecture change: the new dependency ${pair} is intended.${where} Add the relationship to the LikeC4 model with a title that says what it is for, and run pathlight check.`;
}
