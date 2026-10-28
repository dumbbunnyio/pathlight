import type { Placement } from "./camera";
import type { SectionKey } from "./widgets";

/** What Back returns to: the view, its selection and where the camera stood. */
export type Visit = Placement & { view: string; selected: string | undefined };

/** The parts of a LikeC4 node the selection rules read. */
export interface SceneNode { id: unknown; modelRef?: unknown }
export interface Scene<Node extends SceneNode> { id: unknown; nodes: readonly Node[]; viewOf?: unknown }

/**
 * The viewer's selection and where the keys go, without a renderer: the selected node, the trail of visits Back walks, the visit or reload waiting
 * for the next frame, which inspector card (if any) owns the movement keys and each card's cursor. The viewer reads and sets these fields; the small
 * functions below are the changes that have a rule.
 */
export function createState<Node, Diagram, Reload>(selected: Node | undefined) {
  return {
    selected,
    history: [] as Visit[],
    pendingReload: undefined as Reload | undefined,
    pendingVisit: undefined as { diagram: Diagram; restore?: Visit; select?: string; file?: string; notice?: string } | undefined,
    /** Which section (if any) owns the movement keys. Undefined means the diagram does. */
    focusSection: undefined as SectionKey | undefined,
    cursor: { connections: 0, files: 0, activity: 0, steps: 0, flows: 0 } as Record<SectionKey, number>,
    fileCursor: 0,
  };
}

export type ViewState<Node, Diagram, Reload> = ReturnType<typeof createState<Node, Diagram, Reload>>;

/** Back keeps the last 32 visits. */
export const remember = (state: { history: Visit[] }, visit: Visit) => { state.history.push(visit); if (state.history.length > 32) state.history.shift(); };

/** A new selection starts its cards from the top. */
export const choose = <Node>(state: { selected: Node | undefined; fileCursor: number; cursor: Record<SectionKey, number> }, node: Node) => {
  state.selected = node; state.fileCursor = 0; state.cursor.connections = 0;
};

/**
 * The node a view opens on. A view about one element (a neighbourhood) opens with that element selected: `pathlight draft` names a component's
 * neighbourhood `<component>_near`, scoped to it when it can be, which is how the subject is found when it cannot. Any other view opens on its entry:
 * the node the most connectors leave (the first of those in the view's order), else the first node that links to another view, else the first node.
 */
export const firstNode = <Node extends SceneNode & { navigateTo?: unknown }>(scene: Scene<Node> & { edges?: readonly { source: unknown }[] }) => {
  const subject = scene.viewOf;
  const about = scene.nodes.find(node => subject !== undefined && String(node.modelRef) === String(subject))
    ?? scene.nodes.find(node => `${String(node.modelRef).replace(/\./g, "_")}_near` === String(scene.id));
  if (about) return about;
  const leaving = new Map<unknown, number>();
  for (const edge of scene.edges ?? []) leaving.set(edge.source, (leaving.get(edge.source) ?? 0) + 1);
  const most = Math.max(0, ...leaving.values());
  return (most ? scene.nodes.find(node => leaving.get(node.id) === most) : undefined) ?? scene.nodes.find(node => node.navigateTo) ?? scene.nodes[0];
};
