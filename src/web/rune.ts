import { palette } from "../ui";
import { appNoteOf, headContent, isWaiting, opensOf } from "../viewer/inspector-view";
import { shortTitle } from "./scene";
import type { Camera, WindowState, World } from "./session";
import { type Span, spansOf, unlimited } from "./spans";

/**
 * The Rune page (`web/`, experimental, `pathlight web --rune`) reads the scene and frame it was built for: LikeC4's own layout, with the page
 * tightening the gaps, and the inspector's words unwrapped. Kept apart from the default page's scene in cells (scene.ts) and frame (session.ts),
 * so the experiment keeps working as it was; the window state and acts are shared.
 */

/** The parts of LikeC4's layouted view that the page needs; anything else on it is ignored. */
interface RuneNode {
  id: unknown; title: string; technology?: string | null; shape: string; children: readonly unknown[]; navigateTo?: unknown;
  x: number; y: number; width: number; height: number; depth?: number | null;
}
interface RuneEdge {
  id: unknown; source: unknown; target: unknown; label?: string | null; technology?: string | null; points: readonly (readonly [number, number])[];
  labelBBox?: { x: number; y: number; width: number; height: number } | null; navigateTo?: unknown;
}
export interface RuneLayoutedView { id: unknown; title?: string | null; nodes: readonly RuneNode[]; edges: readonly RuneEdge[]; _type?: string }

interface RuneSceneNode {
  id: string; title: string; technology: string; role: string; group: boolean; opens: string | null; rect: [number, number, number, number]; depth: number;
}
interface RuneSceneEdge {
  id: string; source: string; target: string; label: string; technology: string; points: [number, number][]; labelAt: [number, number] | null; opens: string | null;
}
export interface RuneScene { id: string; title: string; kind: string; nodes: RuneSceneNode[]; edges: RuneSceneEdge[] }

/** What a LikeC4 shape says the element is, as a word; a rectangle or component says nothing. */
const roles: Record<string, string> = { person: "person", storage: "store", cylinder: "store", bucket: "store", queue: "queue", browser: "app", mobile: "app", document: "document", agent: "agent" };

/** One view for the page. A box whose children this view draws is a group. */
export const runeSceneOf = (view: RuneLayoutedView): RuneScene => {
  const drawn = new Set(view.nodes.map(node => String(node.id)));
  const nodes = view.nodes.map((node): RuneSceneNode => {
    const group = node.children.some(child => drawn.has(String(child)));
    return {
      id: String(node.id), title: node.title, technology: node.technology ?? "", role: group ? "" : roles[node.shape] ?? "", group,
      opens: node.navigateTo && String(node.navigateTo) !== String(view.id) ? String(node.navigateTo) : null,
      rect: [node.x, node.y, node.width, node.height], depth: node.depth ?? 0,
    };
  });
  const edges = view.edges.map((edge): RuneSceneEdge => {
    const box = edge.labelBBox;
    return {
      id: String(edge.id), source: String(edge.source), target: String(edge.target), label: edge.label ?? "", technology: edge.technology ?? "",
      points: edge.points.map(([x, y]) => [x, y]), labelAt: box ? [box.x + box.width / 2, box.y + box.height / 2] : null,
      opens: edge.navigateTo ? String(edge.navigateTo) : null,
    };
  });
  return { id: String(view.id), title: shortTitle(view), kind: view._type ?? "element", nodes, edges };
};


export interface RuneLink { node: string; title: string; arrow: "←" | "→"; tone: string; label: string }

export interface RuneFrame {
  view: string; selected: string | null; canBack: boolean; restore: Camera | null;
  header: { project: string; view: string; boxes: number };
  inspector: { title: string; agent: boolean; what: Span[]; about: Span[]; links: RuneLink[]; opens: { view: string; title: string } | null };
}

/** The inspector and header for a window, as the Rune page draws them. */
export const runeFrameOf = (world: World, state: WindowState, project: string): RuneFrame => {
  const diagram = world.views.get(state.view);
  if (!diagram) throw new Error(`No view ${state.view}`);
  const selected = diagram.nodes.find(node => String(node.id) === state.selected);
  const ref = String(selected?.modelRef ?? "");
  const target = selected?.navigateTo ? world.views.get(String(selected.navigateTo)) : undefined;
  const all = [...world.views.values()].flatMap(view => view.nodes);
  const head = headContent({
    title: selected?.title, technology: selected?.technology, planned: Boolean(selected && isWaiting(world.planned, world.files, ref)), tags: selected?.tags ?? [],
    description: selected?.description, opens: opensOf(selected, diagram, target), width: unlimited, by: world.words.get(ref)?.by, note: world.words.get(ref)?.note,
    mapped: (world.files.get(ref) ?? []).length, app: selected ? undefined : appNoteOf(all, diagram.viewOf, world.words),
  });
  const name = (id: unknown) => diagram.nodes.find(node => node.id === id)?.title ?? String(id);
  const links: RuneLink[] = selected ? [
    ...diagram.edges.filter(edge => edge.target === selected.id).map(edge => ({ node: String(edge.source), title: name(edge.source), arrow: "←" as const, tone: palette.incoming, label: edge.label ?? "" })),
    ...diagram.edges.filter(edge => edge.source === selected.id).map(edge => ({ node: String(edge.target), title: name(edge.target), arrow: "→" as const, tone: palette.accent, label: edge.label ?? "" })),
  ] : [];
  const opens = selected?.navigateTo && String(selected.navigateTo) !== state.view && target ? { view: String(selected.navigateTo), title: shortTitle({ id: selected.navigateTo, title: target.title }) } : null;
  return {
    view: state.view, selected: state.selected ?? null, canBack: state.history.length > 0, restore: state.restore,
    header: { project, view: shortTitle(diagram), boxes: diagram.nodes.filter(node => !node.children.some(child => diagram.nodes.some(other => other.id === child))).length },
    inspector: { title: selected?.title ?? "No selection", agent: world.words.get(ref)?.by === "agent", what: head.hasWhat ? spansOf(head.what) : [], about: head.hasAbout ? spansOf(head.about) : [], links, opens },
  };
};
