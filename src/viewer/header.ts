import { fg, StyledText, type TextChunk } from "@opentui/core";
import { formatAge } from "../activity";
import type { Diff } from "../diff";
import { partial, type Stale, staleText } from "../stale";
import { palette } from "../ui";
import { clip, spinAt } from "./text";

const ago = (time: number, now: number) => { const age = formatAge(now - time); return age === "now" ? "just now" : `${age} ago`; };

/** The last `pathlight check` (the Stop hook runs one at the end of each turn): the model and the code disagreeing, with how old that check is. */
export const staleBadge = (stale: Stale | undefined, room: number, now: number): TextChunk[] => {
  const detail = staleText(stale);
  if (!stale) return [];
  // A clean check says so, quietly and without its age: silence would look the same as a hook that never ran, and nothing is wrong to date.
  // When most of the source is in languages the scan does not read, "in sync" says what it covers.
  if (!detail) {
    const options = partial(stale) ? ["✓ in sync · TS/JS only ", "✓ TS/JS only "] : ["✓ in sync "];
    const text = options.find(option => option.length <= room);
    return text ? [fg(palette.muted)(text)] : [];
  }
  const full = `▲ out of date: ${detail} · checked ${ago(stale.time, now)} `;
  const text = full.length <= room ? full : room >= 16 ? "▲ out of date " : "";
  return text ? [fg(palette.accent)(text)] : [];
};

/**
 * New dependencies waiting for a verdict and an out-of-date check, as one badge: `▲ 2 new dependencies · 3 files not in the model · c review`,
 * shortened the way the out-of-date badge is (the details go first, then the count of new dependencies), and nothing when even that does not fit.
 */
export const reviewBadge = (open: number, stale: Stale | undefined, room: number): TextChunk[] => {
  const detail = staleText(stale), deps = `${open} new dependenc${open === 1 ? "y" : "ies"}`;
  const text = [`▲ ${deps} · ${detail} · c review `, `▲ ${deps} · out of date · c review `, `▲ ${deps} · c review `, "▲ c review "].find(option => option.length <= room);
  return text ? [fg(palette.accent)(text)] : [];
};

/**
 * The header's right-hand side: the replay, or the new dependencies waiting for a verdict (the one thing in the header that asks for a decision;
 * with an out-of-date check it is one badge), then the last check, then `● live` when there is a session (a spinner replaces the dot while a tool runs).
 */
export const badgeContent = (options: { width: number; replay: boolean; live: string; bound: boolean; watching: boolean; busy: boolean; open: number; stale: Stale | undefined; now: number }) => {
  const room = Math.max(0, options.width - 40), { open, live } = options;
  if (options.replay) return new StyledText([fg(palette.accent)("◀ replay"), fg(palette.border)(` ${live} `)]);
  const sessionRoom = options.watching ? 8 : 0;
  const merged = open > 0 && staleText(options.stale) !== undefined;
  const ask = open ? `▲ ${open} new dependenc${open === 1 ? "y" : "ies"} · c review ` : "";
  const review = merged ? reviewBadge(open, options.stale, room - sessionRoom) : ask && ask.length <= room ? [fg(palette.accent)(ask)] : [];
  const left = room - (review.length ? ask.length : 0) - sessionRoom;
  const check = merged ? [] : staleBadge(options.stale, left, options.now);
  if (!options.watching) { const only = [...review, ...check]; return only.length ? new StyledText(only) : ""; }
  // The session's id is in `c`; the header only says that one is live.
  const session = [fg(options.bound ? palette.incoming : palette.muted)(`${options.busy ? spinAt(options.now) : "●"} live `)];
  return new StyledText([...review, ...check, ...session]);
};

/**
 * In journey mode, the header's first line says where you are in it, after the view's title: `◇ Placing an order · 4/5 · Orders`, the box being the
 * step's own (a journey's hop arrives there, a state diagram's state names it), even when the card drawn for it is the box that holds it. `← agent`
 * follows when the agent's pointer put the reading there.
 */
export const journeyHeading = (options: { title: string; step: number; steps: number; box: string | undefined; pointed: boolean }): TextChunk[] =>
  [fg(palette.purple)(`  ◇ ${clip(options.title, 32)} · ${options.step + 1}/${options.steps}${options.box ? ` · ${clip(options.box, 28)}` : ""}`), ...(options.pointed ? [fg(palette.purple)("  ← agent")] : [])];

/** Header line 1: where you are, `◆ pathlight / View title`, then what follows it (the journey and step, or the agent's pointer). */
export const viewHeading = (title: string, after: readonly TextChunk[] = []) =>
  new StyledText([fg(palette.accent)("◆ "), fg(palette.muted)("pathlight"), fg(palette.border)(" / "), fg(palette.text)(title), ...after]);

/** Header line 2's left side, as plain text: the box count, then what is planned, how far Back goes, the diff and the agent's plan. */
export const boxesText = (options: { boxes: number; planned: number; back: number; diff?: Diff | undefined; plan?: number | undefined }) =>
  `${options.boxes} ${options.boxes === 1 ? "box" : "boxes"}${options.planned ? ` · ${options.planned} planned` : ""}${options.back ? ` · back ${options.back}` : ""}${diffText(options.diff)}${options.plan !== undefined ? ` · plan ${options.plan}` : ""}`;

/** What the last `pathlight diff` found, for the breadcrumb. Nothing changed, nothing said; new dependencies are the header's review, not repeated here. */
export const diffText = (diff: Diff | undefined) => {
  if (!diff) return "";
  const added = diff.relationships.filter(item => item.change === "added").length, lost = diff.relationships.length - added;
  const parts = [added ? `+${added}` : "", lost ? `−${lost}` : ""].filter(Boolean);
  return parts.length ? ` · vs ${diff.base} (static) ${parts.join(" ")}` : "";
};

/** Connectors whose imports were added or lost since the diff's base, and the flow being read (which wins: it is what the person asked to see). */
export const edgeMarks = (diff: Diff | undefined, nodes: readonly { id: unknown; modelRef?: unknown }[], edges: readonly { source: unknown; target: unknown }[], flowPath: ReadonlySet<string>) => {
  const marks = new Map<string, "added" | "lost" | "path">();
  if (!diff) { for (const key of flowPath) marks.set(key, "path"); return marks; }
  const within = (id: string, ancestor: string) => id === ancestor || id.startsWith(`${ancestor}.`);
  const ref = new Map(nodes.map(node => [String(node.id), String(node.modelRef)] as const));
  for (const edge of edges) {
    const from = ref.get(String(edge.source)), to = ref.get(String(edge.target));
    if (!from || !to) continue;
    const hits = diff.relationships.filter(item => within(item.source, from) && within(item.target, to));
    if (hits.some(item => item.change === "added")) marks.set(`${edge.source}\0${edge.target}`, "added");
    else if (hits.length) marks.set(`${edge.source}\0${edge.target}`, "lost");
  }
  for (const key of flowPath) marks.set(key, "path");
  return marks;
};
