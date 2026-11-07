import { palette } from "../ui";
import { firstNode, remember, type Visit } from "../viewer/state";
import { appNoteOf, headContent, isWaiting, opensOf } from "../viewer/inspector-view";
import type { Words } from "../viewer/world";
import { shortTitle } from "./scene";
import { type Span, spansOf, unlimited } from "./spans";

/**
 * One browser window's state, kept by the server so the page only draws (plan 4d, decision 9): which view it shows, what is selected, and the
 * visits Back returns to. The rules are the terminal's own (`firstNode`, `remember`, the inspector's head); the page reports what the person did
 * and draws what comes back. The camera is the page's, but Back restores it, so a visit carries the camera the page had when it left.
 */

/** The parts of a layouted LikeC4 node and view the rules read. */
export interface WorldNode {
  id: unknown; modelRef?: unknown; title: string; description?: unknown; technology?: string | null; navigateTo?: unknown; children: readonly unknown[];
  tags?: readonly string[] | null;
}
export interface WorldEdge { id: unknown; source: unknown; target: unknown; label?: string | null }
export interface WorldView { id: unknown; title?: string | null; description?: unknown; viewOf?: unknown; nodes: readonly WorldNode[]; edges: readonly WorldEdge[] }

export interface World {
  views: ReadonlyMap<string, WorldView>;
  /** Files mapped to each element (`.pathlight/pathlight.activity.json`), and the elements it names as planned. */
  files: ReadonlyMap<string, readonly string[]>;
  planned: readonly string[];
  words: ReadonlyMap<string, Words>;
}

/** Where the page's camera stood, in its own pixels; `moved` is false while it still fits the view. */
export interface Camera { x: number; y: number; zoom: number; moved: boolean }

export interface Link { node: string; title: string; arrow: "←" | "→"; tone: string; label: string }

/** Everything the page draws besides the diagram, for the current view and selection. */
export interface Frame {
  view: string; selected: string | null; canBack: boolean;
  /** Set only on Back: the camera to put back. */
  restore: Camera | null;
  header: { project: string; view: string; boxes: number };
  inspector: { title: string; agent: boolean; what: Span[]; about: Span[]; links: Link[]; opens: { view: string; title: string } | null };
}

export type Act =
  | { kind: "select"; id: string | null }
  | { kind: "open"; view: string; select?: string | null; camera?: Camera }
  | { kind: "back" };

export interface WindowState { view: string; selected: string | undefined; history: (Visit & { camera?: Camera })[]; restore: Camera | null }

export const startWindow = (world: World, view: string, select: string | undefined): WindowState => {
  const diagram = world.views.get(view);
  const chosen = select !== undefined && diagram?.nodes.some(node => String(node.id) === select) ? select : diagram ? String(firstNode(diagram)?.id ?? "") || undefined : undefined;
  return { view, selected: chosen, history: [], restore: null };
};

/** Applies what the person did. An id or view the model does not have is ignored, so a stale page cannot put the state anywhere it cannot be. */
export const act = (world: World, state: WindowState, action: Act): WindowState => {
  const diagram = world.views.get(state.view);
  if (action.kind === "select") {
    if (action.id === null) return { ...state, selected: undefined, restore: null };
    return diagram?.nodes.some(node => String(node.id) === action.id) ? { ...state, selected: action.id, restore: null } : state;
  }
  if (action.kind === "open") {
    const next = world.views.get(action.view);
    if (!next || action.view === state.view) return state;
    const history = [...state.history];
    const camera = action.camera ?? { x: 0, y: 0, zoom: 1, moved: false };
    // The terminal's Placement is its own camera; the page's travels beside it, in its own pixels.
    remember({ history }, { view: state.view, selected: state.selected, x: camera.x, y: camera.y, scale: camera.zoom, camera } as Visit & { camera: Camera });
    const select = action.select ?? undefined;
    const selected = select !== undefined && next.nodes.some(node => String(node.id) === select) ? select : String(firstNode(next)?.id ?? "") || undefined;
    return { view: action.view, selected, history, restore: null };
  }
  const history = [...state.history];
  const visit = history.pop();
  if (!visit || !world.views.has(visit.view)) return { ...state, history: [], restore: null };
  return { view: visit.view, selected: visit.selected, history, restore: visit.camera ?? null };
};

/** The inspector and header for a window, in the terminal's words. */
export const frameOf = (world: World, state: WindowState, project: string): Frame => {
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
  // Who calls it first, then what it calls, as the terminal's Connects lists them.
  const links: Link[] = selected ? [
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
