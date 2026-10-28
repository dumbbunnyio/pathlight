import { fg, StyledText, type TextChunk } from "@opentui/core";
import { formatAge } from "../activity";
import type { Diff } from "../diff";
import { partial, type Stale, staleText } from "../stale";
import { palette } from "../ui";
import { spinAt } from "./text";

const ago = (time: number, now: number) => { const age = formatAge(now - time); return age === "now" ? "just now" : `${age} ago`; };

/** The last `pathlight check` (the Stop hook runs one at the end of each turn): shown only when the model and the code disagree, with how old that check is. */
export const staleBadge = (stale: Stale | undefined, room: number, now: number): TextChunk[] => {
  const detail = staleText(stale);
  if (!stale) return [];
  // A clean check says so, quietly: silence would look the same as a hook that never ran.
  // When most of the source is in languages the scan does not read, "in sync" says what it covers.
  if (!detail) {
    const options = partial(stale) ? [`✓ in sync · TS/JS only · checked ${ago(stale.time, now)} `, "✓ in sync · TS/JS only ", "✓ TS/JS only "] : [`✓ in sync · checked ${ago(stale.time, now)} `];
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
 * with an out-of-date check it is one badge), then the last check, then the live session when there is one (a spinner replaces the dot while a tool runs).
 */
export const badgeContent = (options: { width: number; replay: boolean; live: string; bound: boolean; watching: boolean; busy: boolean; open: number; stale: Stale | undefined; now: number }) => {
  const room = Math.max(0, options.width - 40), { open, live } = options;
  if (options.replay) return new StyledText([fg(palette.accent)("◀ replay"), fg(palette.border)(` ${live} `)]);
  const sessionRoom = options.watching ? 8 + live.length : 0;
  const merged = open > 0 && staleText(options.stale) !== undefined;
  const ask = open ? `▲ ${open} new dependenc${open === 1 ? "y" : "ies"} · c review ` : "";
  const review = merged ? reviewBadge(open, options.stale, room - sessionRoom) : ask && ask.length <= room ? [fg(palette.accent)(ask)] : [];
  const left = room - (review.length ? ask.length : 0) - sessionRoom;
  const check = merged ? [] : staleBadge(options.stale, left, options.now);
  if (!options.watching) { const only = [...review, ...check]; return only.length ? new StyledText(only) : ""; }
  const session = [fg(options.bound ? palette.incoming : palette.muted)(`${options.busy ? spinAt(options.now) : "●"} live`), fg(palette.border)(` ${live} `)];
  return new StyledText([...review, ...check, ...session]);
};

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
