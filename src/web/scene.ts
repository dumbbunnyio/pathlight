import { cellAt, routeEdges, type Side } from "../routes";
import { boundsOf, type Rect } from "../viewer/compact";
import { type ShapeNode, shapeView, worldCell } from "../viewer/shape";
import type { Scene, SceneCard, SceneRoute } from "./wire";

export type { Scene } from "./wire";

/**
 * What the browser page draws for one view, laid out by the terminal's own code (plan 4d, decision 16): `shapeView` (the compact fit, at the
 * terminal's cell aspect) places the cards and groups, and `routeEdges` finds the right-angled connectors, on the same grid of cells. So the page
 * draws the TUI's diagram by construction; only the drawing is pixels. LikeC4 gives the structure (ids, nesting, order, what connects); nothing
 * of its drawing travels.
 *
 * Everything is in LikeC4's world units after the compact fit: a cell is 16 wide and 32 tall. A card's `rect` is its outer cells; the page draws
 * its border through the middle of the outer cells, as the terminal's box-drawing glyphs sit, and a connector's points are cell middles too.
 */

/** The parts of LikeC4's layouted view that the page needs; anything else on it is ignored. */
export interface LayoutedNode extends ShapeNode { technology?: string | null; shape?: string; depth?: number | null; level?: number }
export interface LayoutedEdge { id: unknown; source: unknown; target: unknown; label?: string | null }
export interface LayoutedView { id: unknown; title?: string | null; nodes: readonly LayoutedNode[]; edges: readonly LayoutedEdge[]; _type?: string }

/** A view's title as the rail shows it: the last part of a `Parent / Child` title. */
export const shortTitle = (view: { id: unknown; title?: string | null }) => {
  const title = view.title ?? String(view.id);
  return title.split(" / ").at(-1) ?? title;
};

/**
 * A route's cells at 100%, as the terminal draws them (routes.ts `rasterize`): leaving the source's right side and entering the target's left on
 * each card's middle row, the run beside the end following it. Then as world-unit cell middles, the ends moved onto the cards' borders, and any
 * one-cell diagonal the rounding left taken as a horizontal step then a vertical one, as the terminal does.
 */
const routePoints = (points: readonly { x: number; y: number }[], from: Rect | undefined, to: Rect | undefined) => {
  const cells = points.map(point => ({ x: cellAt(point.x / worldCell.x), y: cellAt(point.y / worldCell.y) }));
  const projected = cells.map(point => ({ ...point })), last = cells.length - 1;
  const box = (rect: Rect) => ({ x: cellAt(rect.x / worldCell.x), y: cellAt(rect.y / worldCell.y), width: Math.max(3, Math.round(rect.width / worldCell.x)), height: Math.max(3, Math.round(rect.height / worldCell.y)) });
  if (from && last > 0) {
    const card = box(from), middle = card.y + Math.floor(card.height / 2);
    cells[0] = { x: card.x + card.width, y: middle };
    if (last > 1 && projected[1]!.y === projected[0]!.y) cells[1] = { x: projected[1]!.x, y: middle };
  }
  if (to && last > 0) {
    const card = box(to), middle = card.y + Math.floor(card.height / 2);
    cells[last] = { x: card.x, y: middle };
    if (last > 1 && projected[last - 1]!.y === projected[last]!.y) cells[last - 1] = { x: projected[last - 1]!.x, y: middle };
  }
  const straight: { x: number; y: number }[] = [];
  for (const cell of cells) {
    const before = straight.at(-1);
    if (before && before.x !== cell.x && before.y !== cell.y) straight.push({ x: cell.x, y: before.y });
    if (!before || before.x !== cell.x || before.y !== cell.y) straight.push(cell);
  }
  // Drop the middle of three points in one line.
  const runs = straight.filter((point, index) => {
    const a = straight[index - 1], b = straight[index + 1];
    return !a || !b || !((a.x === point.x && point.x === b.x) || (a.y === point.y && point.y === b.y));
  });
  const world = runs.map(point => [point.x * worldCell.x + worldCell.x / 2, point.y * worldCell.y + worldCell.y / 2] as [number, number]);
  // The first run starts on the source's right border, a cell back from the cell beside it; the last ends where it reaches the target's border.
  if (from && world.length > 1 && world[0]![1] === world[1]![1]) world[0]![0] -= worldCell.x;
  const end = world.at(-1), before = world.at(-2);
  let arrow: Side = "E";
  if (end && before) {
    const dx = Math.sign(end[0] - before[0]), dy = Math.sign(end[1] - before[1]);
    arrow = dx > 0 ? "E" : dx < 0 ? "W" : dy > 0 ? "S" : "N";
  }
  return { points: world, arrow };
};

/** One view for the page, laid out as the terminal lays it out. `all` is every view (for the count of boxes a box opens). */
export const sceneOf = (view: LayoutedView, options: { all: Iterable<LayoutedView>; planned: readonly string[]; files: ReadonlyMap<string, readonly string[]>; watching?: boolean }): Scene => {
  const fitted = shapeView(view, { all: options.all, planned: options.planned, files: options.files, watching: options.watching ?? false });
  const nodes = fitted.nodes;
  const byId = new Map(nodes.map(node => [String(node.id), node]));
  // routeEdges drops a relationship whose ends are not drawn; drop it here first, so its routes pair with the relationships they draw.
  const routable = view.edges.filter(edge => byId.has(String(edge.source)) && byId.has(String(edge.target)));
  const routes = routeEdges(nodes.map(node => ({ id: String(node.id), x: node.x, y: node.y, width: node.width, height: node.height, children: node.children.map(String) })),
    routable.map(edge => ({ source: String(edge.source), target: String(edge.target), points: [] })), worldCell);
  const cards = nodes.map((node): SceneCard => ({
    id: String(node.id), title: node.title, group: node.children.length > 0, parent: node.parent ? String(node.parent) : null,
    opens: node.navigateTo && String(node.navigateTo) !== String(view.id) ? String(node.navigateTo) : null,
    rect: [node.x, node.y, node.width, node.height], level: node.level ?? node.depth ?? 0,
  }));
  const sceneRoutes = routes.map((route, index): SceneRoute => {
    const edge = routable[index]!;
    const { points, arrow } = routePoints(route.points, byId.get(route.source), byId.get(route.target));
    return { id: String(edge.id), source: route.source, target: route.target, points, arrow };
  });
  // The terminal's `f` fits the cards and every connector's points, a cell either side, so a run round the outermost card is not cut.
  const bounds = boundsOf([fitted.bounds, ...routes.flatMap(route => route.points.map(point => ({ x: point.x - 16, y: point.y, width: 32, height: 1 })))]);
  return { id: String(view.id), title: shortTitle(view), heading: view.title ?? String(view.id), kind: view._type ?? "element", cards, routes: sceneRoutes,
    bounds: [bounds.x, bounds.y, bounds.width, bounds.height] };
};

/** The views in the order the rail lists them: the overview first, then by title. */
export const viewOrder = <S extends { id: string; title: string }>(scenes: readonly S[], first: string | undefined) =>
  [...scenes].sort((a, b) => Number(b.id === first) - Number(a.id === first) || a.title.localeCompare(b.title));
