import { insideWords } from "./card-view";
import { boundsOf, compact, kindsVary, type Rect } from "./compact";

/** The parts of a layouted LikeC4 node that a view's shape reads. */
export interface ShapeNode { id: unknown; parent?: unknown; children: readonly unknown[]; modelRef?: unknown; navigateTo?: unknown; kind?: unknown;
  x: number; y: number; width: number; height: number; title: string }

/**
 * A view as the viewer draws it: compact fit (viewer/compact.ts) with the terminal's cell aspect, and whether its cards spend their first row on a word
 * (`[36]`), a planned element's status or the activity counts. Decided once per view, so it is on every card or none. The terminal and the browser
 * page both lay a view out here, so they draw the same cards in the same places.
 */
export const shapeView = <N extends ShapeNode>(raw: { id: unknown; nodes: readonly N[] }, options: {
  /** Every view's nodes, for the count of boxes inside a box that opens a view. */
  all: Iterable<{ nodes: readonly { modelRef?: unknown }[] }>;
  planned: readonly string[]; files: ReadonlyMap<string, readonly string[]>;
  /** Watching a session: every card keeps the first row, so the activity counts that appear there never move the layout. */
  watching: boolean;
}) => {
  // A planned element with no files yet keeps its `[planned]` row; the word row is drawn when a card in the view has a word, or its kinds vary (the row
  // it always had, see kindsVary).
  const planned = (ref: string) => options.planned.some(id => ref === id || ref.startsWith(`${id}.`)) && ![...options.files].some(([element, paths]) => (element === ref || element.startsWith(`${ref}.`)) && paths.length);
  const input = raw.nodes.map(node => ({ id: String(node.id), parent: node.parent ? String(node.parent) : null, children: node.children.map(String),
    x: node.x, y: node.y, width: node.width, height: node.height, title: node.title, kind: node.kind ? String(node.kind) : undefined, status: planned(String(node.modelRef)) }));
  const words = insideWords(raw, new Set([...options.all].flatMap(other => other.nodes.map(node => String(node.modelRef)))));
  const row = words.size > 0 || kindsVary(raw.nodes) || options.watching;
  const rects = compact(input, { aspect: 0.5, wordRow: row });
  const nodes: N[] = raw.nodes.map((node, index) => ({ ...node, x: rects[index]!.x, y: rects[index]!.y, width: rects[index]!.width, height: rects[index]!.height }));
  const bounds: Rect = boundsOf(nodes);
  return { nodes, bounds, words, row: row || input.some(node => !node.children.length && node.status) };
};

/** A cell at 100% in world units: 16 wide, `16 / aspect` tall. */
export const worldCell = { x: 16, y: 16 / 0.5 };
