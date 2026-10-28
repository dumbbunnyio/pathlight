import { wrapWords } from "./text";

/** A diagram node as compact fit reads it, in LikeC4's world units (16 units are one column at 100%; a row is `16 / aspect`). */
export interface CompactNode { id: string; parent: string | null; children: readonly string[]; x: number; y: number; width: number; height: number; title: string; kind?: string;
  /** A status row it always shows (a planned element), which a card without a kind row needs a row for. */
  status?: boolean }
export interface Rect { x: number; y: number; width: number; height: number }

export interface CompactOptions {
  /** A cell's width over its height (0.5 in most terminals). */
  aspect: number;
  /** Whether leaf cards spend a row on their kind (viewer/card-view.ts draws it only when kinds vary in the view). */
  kindRow: boolean;
}

/** Columns between neighbouring cards (so a connector's trunk has a column of its own and a clear cell each side) and rows between them. */
export const gapColumns = 6, gapRows = 2;
/** A group's frame and the clear cell inside it, on every side; its title sits in the top frame row. */
const frame = 2;
/** A card's width in columns: at least LikeC4's usual box (320 units), at most 32; the longest word counts up to 24 characters. */
const narrowest = 20, widest = 32, wordCap = 24;

/** The width in columns a card needs so its title fits on at most two lines (on one when that costs at most two columns more), and the lines it then takes. */
export const cardSize = (title: string, atLeast: number) => {
  const longest = Math.max(0, ...title.split(/\s+/).map(word => word.length));
  const least = Math.max(Math.min(longest, wordCap) + 4, Math.min(widest, atLeast));
  for (let width = least; width <= widest; width++) {
    const lines = wrapWords(title, width - 4);
    if (lines.length <= 2 && lines.every(line => line.length <= width - 4)) {
      const single = Math.max(least, title.length + 4);
      return lines.length === 2 && single <= Math.min(widest, width + 2) ? { width: single, lines: 1 } : { width, lines: lines.length };
    }
  }
  return { width: Math.max(least, widest), lines: 2 };
};

/** Lines a title takes on a card this many columns wide (at most two: a longer one ends in an ellipsis). */
const linesAt = (title: string, width: number) => Math.min(2, wrapWords(title, width - 4).length);

type Axis = "x" | "y";

/**
 * Compact fit: LikeC4's arrangement with Pathlight's spacing and card sizes. Every leaf card of a view gets one readable size in cells (the widest
 * title on one or two lines, from 20 to 32 columns, whatever width LikeC4 drew; 4 rows, 5 when a title takes two lines, one fewer
 * without a kind or status row) and the space between cards shrinks to a small gap. What is kept, on each axis: a card that ended before another began still does (with at least the gap between them, more
 * when group frames stand between them), cards that overlapped still overlap, cards that shared a left or top edge (a dagre rank) still share it, and
 * a group is the box around its children with its frame and a clear cell. The result is in the same units, deterministic and idempotent.
 */
export function compact(nodes: readonly CompactNode[], options: CompactOptions): CompactNode[] {
  const unit = { x: 16, y: 16 / options.aspect };
  const byId = new Map(nodes.map(node => [node.id, node]));
  const leaves = nodes.filter(node => !node.children.length);
  const ancestors = (node: CompactNode) => {
    const list: string[] = [];
    for (let parent = node.parent; parent && byId.has(parent); parent = byId.get(parent)!.parent) list.push(parent);
    return list;
  };
  const lineage = new Map(leaves.map(leaf => [leaf.id, ancestors(leaf)]));
  // How many group frames stand between two cards: the groups each is in that the other is not.
  const frames = (a: CompactNode, b: CompactNode) => {
    const of = lineage.get(a.id)!, other = lineage.get(b.id)!;
    return of.filter(id => !other.includes(id)).length + other.filter(id => !of.includes(id)).length;
  };
  // One size in cells for every card of the view: the widest title decides the width, the most lines at that width the height. A short title
  // leaves its last row blank, under it.
  const width = Math.max(0, ...leaves.map(leaf => cardSize(leaf.title, narrowest).width));
  const height = 2 + (options.kindRow || leaves.some(leaf => leaf.status) ? 1 : 0) + Math.max(1, ...leaves.map(leaf => linesAt(leaf.title, width)));
  const size = new Map(leaves.map(leaf => [leaf.id, { x: width, y: height }]));
  const place = (axis: Axis) => {
    const extent = axis === "x" ? "width" : "height";
    const gap = axis === "x" ? gapColumns : gapRows;
    const start = (node: CompactNode) => node[axis], end = (node: CompactNode) => node[axis] + node[extent];
    const span = new Map(leaves.map(leaf => [leaf.id, size.get(leaf.id)![axis]]));
    const at = new Map(leaves.map(leaf => [leaf.id, frame * lineage.get(leaf.id)!.length]));
    const before = (a: CompactNode, b: CompactNode) => end(a) <= start(b);
    for (let round = 0; round < 64; round++) {
      // Longest path: every card as early as its predecessors (and its rank) allow.
      for (let pass = 0, moved = true; moved && pass < leaves.length + 2; pass++) {
        moved = false;
        for (const b of leaves) for (const a of leaves) {
          if (a === b) continue;
          const need = before(a, b) ? at.get(a.id)! + span.get(a.id)! + Math.max(gap, frame * frames(a, b) + 1) : start(a) <= start(b) ? at.get(a.id)! : -Infinity;
          if (need > at.get(b.id)!) { at.set(b.id, need); moved = true; }
        }
      }
      // A card that overlapped a later-starting one grows to keep overlapping it.
      let grew = false;
      for (const a of leaves) for (const b of leaves) {
        if (a === b || before(a, b) || before(b, a) || start(a) >= start(b)) continue;
        const reach = at.get(b.id)! - at.get(a.id)! + 1;
        if (reach > span.get(a.id)!) { span.set(a.id, reach); grew = true; }
      }
      if (!grew) break;
    }
    return { at, span };
  };
  const x = place("x"), y = place("y");
  const rects = new Map<string, Rect>(leaves.map(leaf => [leaf.id, { x: x.at.get(leaf.id)! * unit.x, y: y.at.get(leaf.id)! * unit.y, width: x.span.get(leaf.id)! * unit.x, height: y.span.get(leaf.id)! * unit.y }]));
  // Groups, from the inside out: the box around their children with the frame and a clear cell on every side.
  const groupRect = (node: CompactNode): Rect | undefined => {
    const known = rects.get(node.id);
    if (known) return known;
    const inside = node.children.flatMap(child => { const found = byId.get(child); const rect = found && groupRect(found); return rect ? [rect] : []; });
    if (!inside.length) return undefined;
    const left = Math.min(...inside.map(rect => rect.x)) - frame * unit.x, top = Math.min(...inside.map(rect => rect.y)) - frame * unit.y;
    const right = Math.max(...inside.map(rect => rect.x + rect.width)) + frame * unit.x, bottom = Math.max(...inside.map(rect => rect.y + rect.height)) + frame * unit.y;
    const rect = { x: left, y: top, width: right - left, height: bottom - top };
    rects.set(node.id, rect);
    return rect;
  };
  return nodes.map(node => ({ ...node, ...(groupRect(node) ?? { x: node.x, y: node.y, width: node.width, height: node.height }) }));
}

/** Whether a view's leaf cards are of more than one kind: only then does a card spend a row saying which (every box reading `component` says nothing). */
export const kindsVary = (nodes: readonly { children: readonly unknown[]; kind?: unknown }[]) => new Set(nodes.filter(node => !node.children.length).map(node => String(node.kind ?? ""))).size > 1;

/** The box around every node. */
export const boundsOf = (nodes: readonly Rect[]): Rect => {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...nodes.map(node => node.x)), top = Math.min(...nodes.map(node => node.y));
  return { x: left, y: top, width: Math.max(...nodes.map(node => node.x + node.width)) - left, height: Math.max(...nodes.map(node => node.y + node.height)) - top };
};
