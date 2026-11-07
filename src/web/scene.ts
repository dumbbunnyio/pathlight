/**
 * What the browser page draws for one view, decided here so the page only draws (plan 4d, decision 9). LikeC4 gives the structure only: ids,
 * nesting, order, sizes and routes, as it laid them out; the page tightens only the gaps between cards, in pixels. Nothing of LikeC4's drawing
 * travels (its shapes, colors and arrowheads): the page looks like Rune rendering Pathlight (plan, "The look"). What the model says about a box
 * does travel, as words: its technology, and its role where the model gives one through its shape (a person, a store, a queue, an app).
 */

/** The parts of LikeC4's layouted view that the page needs; anything else on it is ignored. */
export interface LayoutedNode {
  id: unknown; title: string; technology?: string | null; shape: string; children: readonly unknown[]; navigateTo?: unknown;
  x: number; y: number; width: number; height: number; depth?: number | null;
}
export interface LayoutedEdge {
  id: unknown; source: unknown; target: unknown; label?: string | null; technology?: string | null; points: readonly (readonly [number, number])[];
  labelBBox?: { x: number; y: number; width: number; height: number } | null; navigateTo?: unknown;
}
export interface LayoutedView { id: unknown; title?: string | null; nodes: readonly LayoutedNode[]; edges: readonly LayoutedEdge[]; _type?: string }

export interface SceneNode {
  id: string; title: string; technology: string; role: string; group: boolean; opens: string | null; rect: [number, number, number, number]; depth: number;
}
export interface SceneEdge {
  id: string; source: string; target: string; label: string; technology: string; points: [number, number][]; labelAt: [number, number] | null; opens: string | null;
}
export interface Scene { id: string; title: string; kind: string; nodes: SceneNode[]; edges: SceneEdge[] }

/** What a LikeC4 shape says the element is, as a word; a rectangle or component says nothing. */
const roles: Record<string, string> = { person: "person", storage: "store", cylinder: "store", bucket: "store", queue: "queue", browser: "app", mobile: "app", document: "document", agent: "agent" };

/** A view's title as the header shows it: the last part of a `Parent / Child` title. */
export const shortTitle = (view: { id: unknown; title?: string | null }) => {
  const title = view.title ?? String(view.id);
  return title.split(" / ").at(-1) ?? title;
};

/** One view for the page. A box whose children this view draws is a group. */
export const sceneOf = (view: LayoutedView): Scene => {
  const drawn = new Set(view.nodes.map(node => String(node.id)));
  const nodes = view.nodes.map((node): SceneNode => {
    const group = node.children.some(child => drawn.has(String(child)));
    return {
      id: String(node.id), title: node.title, technology: node.technology ?? "", role: group ? "" : roles[node.shape] ?? "", group,
      opens: node.navigateTo && String(node.navigateTo) !== String(view.id) ? String(node.navigateTo) : null,
      rect: [node.x, node.y, node.width, node.height], depth: node.depth ?? 0,
    };
  });
  const edges = view.edges.map((edge): SceneEdge => {
    const box = edge.labelBBox;
    return {
      id: String(edge.id), source: String(edge.source), target: String(edge.target), label: edge.label ?? "", technology: edge.technology ?? "",
      points: edge.points.map(([x, y]) => [x, y]), labelAt: box ? [box.x + box.width / 2, box.y + box.height / 2] : null,
      opens: edge.navigateTo ? String(edge.navigateTo) : null,
    };
  });
  return { id: String(view.id), title: shortTitle(view), kind: view._type ?? "element", nodes, edges };
};

/** The views in the order the rail lists them: the overview first, then by title. */
export const viewOrder = (scenes: readonly Scene[], first: string | undefined) =>
  [...scenes].sort((a, b) => Number(b.id === first) - Number(a.id === first) || a.title.localeCompare(b.title));
