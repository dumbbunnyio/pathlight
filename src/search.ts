import { fuzzyScore } from "./fuzzy";

/**
 * Search across everything the viewer can show: views, boxes (components) and the files mapped to them. A result is scored in two parts that
 * are added together: how well the text matches (exact beats prefix beats substring beats fuzzy) and where the result is (a box in the view
 * you are in beats a file in it, a box elsewhere, a view, and a file elsewhere). The match classes are spaced further apart than the whole
 * location ladder, so an exact match always comes first wherever it is, and location only orders results of similar quality.
 */
export type Kind = "view" | "box" | "file";

export interface Candidate {
  readonly kind: Kind;
  /** What is shown and matched first: a title, or a file's base name. */
  readonly name: string;
  /** Other texts that also match, a little weaker: ids, full paths. */
  readonly aliases: readonly string[];
  /** In the view the user is looking at. */
  readonly here: boolean;
}

export const classScore = { exact: 1000, prefix: 300, substring: 200, fuzzyMax: 100, typo: 80, aliasPenalty: 50 } as const;
/** Added to the match score. The total is below the gap between the classes, so location never outweighs an exact match. */
export const locationBonus = { boxHere: 160, fileHere: 120, boxElsewhere: 80, view: 40, fileElsewhere: 0 } as const;

export const bonusOf = (candidate: Pick<Candidate, "kind" | "here">) =>
  candidate.kind === "view" ? locationBonus.view
    : candidate.kind === "box" ? candidate.here ? locationBonus.boxHere : locationBonus.boxElsewhere
      : candidate.here ? locationBonus.fileHere : locationBonus.fileElsewhere;

const normal = (text: string) => text.toLowerCase().trim();
const wordStart = (text: string, query: string) => new RegExp(`(^|[^a-z0-9])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text);

/** The query with two neighbouring letters swapped, or one letter dropped: a typo that the plain match misses. Only used as a whole piece of the text. */
const typos = (query: string) => query.length < 4 ? [] : [
  ...Array.from({ length: query.length - 1 }, (_, at) => query.slice(0, at) + query[at + 1] + query[at] + query.slice(at + 2)),
  ...Array.from({ length: query.length }, (_, at) => query.slice(0, at) + query.slice(at + 1)),
];

/** How well one text matches the query, 0 for no match. */
export const textScore = (query: string, raw: string): number => {
  const q = normal(query), text = normal(raw);
  if (!q || !text) return 0;
  if (text === q) return classScore.exact;
  if (text.startsWith(q) || wordStart(text, q)) return classScore.prefix + (text.startsWith(q) ? 10 : 0) - Math.min(text.length - q.length, 40) / 4;
  if (text.includes(q)) return classScore.substring - Math.min(text.length - q.length, 40) / 4;
  const loose = fuzzyScore(q, text);
  // Scattered letters count for less in a long text than in a short one, so `ctx` prefers `context` to `css.test.tsx`.
  if (loose !== undefined) return Math.max(1, Math.min(classScore.fuzzyMax, loose) * Math.sqrt(q.length / text.length));
  return typos(q).some(variant => text.includes(variant)) ? classScore.typo : 0;
};

/** The score of a candidate for a query, or undefined when nothing matches. An empty query matches everything on location alone. */
export const scoreOf = (query: string, candidate: Candidate): number | undefined => {
  if (!query.trim()) return bonusOf(candidate);
  // Several words must each match; the weakest word sets the class, and the rest add a little.
  const words = query.trim().split(/\s+/);
  const best = (word: string) => Math.max(textScore(word, candidate.name), ...candidate.aliases.map(alias => textScore(word, alias) - classScore.aliasPenalty));
  const scores = words.map(best);
  if (scores.some(score => score <= 0)) return words.length > 1 ? wholeScore(query, candidate) : undefined;
  return Math.min(...scores) + (scores.reduce((sum, score) => sum + score, 0) - Math.min(...scores)) / 20 + bonusOf(candidate);
};

/** A multi-word query such as "hono mid" is also tried against the name and its aliases joined, so words may span them. */
const wholeScore = (query: string, candidate: Candidate): number | undefined => {
  const joined = [candidate.name, ...candidate.aliases].join(" ");
  const loose = fuzzyScore(query, joined);
  return loose === undefined ? undefined : Math.min(classScore.fuzzyMax, Math.max(1, loose)) + bonusOf(candidate);
};

/** The candidates that match, best first. Ties keep their given order. */
export const search = <T extends Candidate>(query: string, candidates: readonly T[]): T[] =>
  candidates.flatMap((candidate, index) => { const score = scoreOf(query, candidate); return score === undefined ? [] : [{ candidate, score, index }]; })
    .sort((a, b) => b.score - a.score || a.index - b.index).map(entry => entry.candidate);
