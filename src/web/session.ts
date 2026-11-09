import { RGBA } from "@opentui/core";
import { routeTone } from "../routes";
import { palette, toneColor } from "../ui";
import { cardLook } from "../viewer/card-view";
import { connectsCard } from "../viewer/cards";
import { footerContent } from "../viewer/footer";
import { helpContent } from "../viewer/help";
import { boxesText, viewHeading } from "../viewer/header";
import { appNoteOf, headContent, isWaiting, nodeListContent, opensOf, sectionHeader } from "../viewer/inspector-view";
import { firstNode, remember, type Visit } from "../viewer/state";
import { neighborIn, nothingThere } from "../viewer/where";
import type { Words } from "../viewer/world";
import { spansOf } from "./spans";
import type { Act, Camera, CardLook, Frame, Placement, Scene, Span } from "./wire";

export type { Act, Camera, Frame } from "./wire";

/**
 * One browser window's state, kept by the server so the page only draws (plan 4d, decision 9): which view it shows, what is selected, the visits
 * Back returns to, and the page's size in cells. The rules are the terminal's own (`firstNode`, `remember`, the inspector's head, the card's
 * look, the header and footer, the inspector's placement); the page reports what the person did and draws what comes back. The camera is the
 * page's, but Back restores it, so a visit carries the camera the page had when it left.
 */

/** The parts of a layouted LikeC4 node and view the rules read. */
export interface WorldNode {
  id: unknown; modelRef?: unknown; title: string; description?: unknown; technology?: string | null; navigateTo?: unknown; children: readonly unknown[];
  parent?: unknown; tags?: readonly string[] | null; kind?: unknown; level?: number;
}
export interface WorldEdge { id: unknown; source: unknown; target: unknown; label?: string | null }
export interface WorldView { id: unknown; title?: string | null; description?: unknown; viewOf?: unknown; nodes: readonly WorldNode[]; edges: readonly WorldEdge[] }

export interface World {
  views: ReadonlyMap<string, WorldView>;
  /** Each view laid out in the terminal's cells (scene.ts), by id. */
  scenes: ReadonlyMap<string, Scene>;
  /** Whether a view's cards spend their first row on a word, and the words (viewer/shape.ts). */
  rows: ReadonlyMap<string, { words: ReadonlyMap<string, string>; row: boolean }>;
  /** Files mapped to each element (`.pathlight/pathlight.activity.json`), and the elements it names as planned. */
  files: ReadonlyMap<string, readonly string[]>;
  planned: readonly string[];
  words: ReadonlyMap<string, Words>;
  version: string;
}

export interface WindowState {
  view: string; selected: string | undefined; history: (Visit & { camera?: Camera })[]; restore: Camera | null;
  cols: number; rows: number; zoom: number;
  /** `i`: the inspector shown where the terminal shows it by default (`auto`), or opened over a narrow diagram. */
  inspector: "auto" | "open" | "closed";
  /** A one-line notice in the footer, as the terminal's (`No previous view`), until the next act. */
  message: string;
}

export const startWindow = (world: World, view: string, select: string | undefined, size = { cols: 140, rows: 40 }): WindowState => {
  const diagram = world.views.get(view);
  const chosen = select !== undefined && diagram?.nodes.some(node => String(node.id) === select) ? select : diagram ? String(firstNode(diagram)?.id ?? "") || undefined : undefined;
  return { view, selected: chosen, history: [], restore: null, cols: size.cols, rows: size.rows, zoom: 1, inspector: "auto", message: "" };
};

const visitOf = (state: WindowState, camera: Camera | undefined) => ({ view: state.view, selected: state.selected, x: camera?.x ?? 0, y: camera?.y ?? 0, scale: camera?.zoom ?? 1, camera });

const goTo = (world: World, state: WindowState, view: string, select: string | undefined, camera: Camera | undefined): WindowState => {
  const next = world.views.get(view)!;
  const history = [...state.history];
  // The terminal's Placement is its own camera; the page's travels beside it, in its own pixels.
  remember({ history }, visitOf(state, camera) as Visit & { camera?: Camera });
  const selected = select !== undefined && next.nodes.some(node => String(node.id) === select) ? select : String(firstNode(next)?.id ?? "") || undefined;
  return { ...state, view, selected, history, restore: null, message: "" };
};

/**
 * Applies what the person did. An id or view the model does not have is ignored, so a stale page cannot put the state anywhere it cannot be.
 * `into` is Enter: into the selected box's children when this view draws them, else into the view it opens; `openView` is `o`. `back` is `b`:
 * the last visit; with `up` it is Backspace: the last visit, else the box that holds the selection, else the view whose box opens this one.
 */
export const act = (world: World, state: WindowState, action: Act): WindowState => {
  const diagram = world.views.get(state.view);
  const quiet = { ...state, restore: null, message: "" };
  if (action.kind === "size") return { ...state, restore: null, cols: Math.max(20, Math.min(1000, Math.round(action.cols))), rows: Math.max(8, Math.min(500, Math.round(action.rows))) };
  if (action.kind === "zoom") return { ...state, restore: null, zoom: action.zoom };
  if (action.kind === "inspector") {
    const shown = placementOf(state).mount !== "none";
    return { ...quiet, inspector: shown ? "closed" : "open" };
  }
  if (action.kind === "select") {
    if (action.id === null) return { ...quiet, selected: undefined };
    return diagram?.nodes.some(node => String(node.id) === action.id) ? { ...quiet, selected: action.id } : state;
  }
  if (action.kind === "open") {
    if (!world.views.has(action.view) || action.view === state.view) return state;
    return goTo(world, state, action.view, action.select ?? undefined, action.camera);
  }
  if (action.kind === "traverse") {
    const scene = world.scenes.get(state.view), current = diagram?.nodes.find(node => String(node.id) === state.selected);
    if (!scene || !current || !diagram) return state;
    // The neighbor by the cards as drawn: the scene's rectangles after the compact fit, as the terminal's.
    const placed = scene.cards.map(card => ({ id: card.id, parent: card.parent, children: diagram.nodes.find(node => String(node.id) === card.id)?.children.map(String) ?? [],
      x: card.rect[0], y: card.rect[1], width: card.rect[2], height: card.rect[3] }));
    const best = neighborIn(placed, placed.find(card => card.id === state.selected)!, action.direction);
    return best ? { ...quiet, selected: best.id } : { ...quiet, message: nothingThere(action.direction, current.title) };
  }
  if (action.kind === "openView") {
    const selected = diagram?.nodes.find(node => String(node.id) === state.selected);
    const target = selected?.navigateTo ? String(selected.navigateTo) : undefined;
    return target && target !== state.view && world.views.has(target) ? goTo(world, state, target, undefined, action.camera) : { ...quiet, message: "Opens no other view" };
  }
  if (action.kind === "into") {
    const selected = diagram?.nodes.find(node => String(node.id) === state.selected);
    if (!selected || !diagram) return state;
    const child = diagram.nodes.find(node => node.id === selected.children[0]);
    if (child) {
      const history = [...state.history];
      remember({ history }, visitOf(state, action.camera) as Visit & { camera?: Camera });
      return { ...quiet, selected: String(child.id), history };
    }
    const target = selected.navigateTo ? String(selected.navigateTo) : undefined;
    return target && target !== state.view && world.views.has(target) ? goTo(world, state, target, undefined, action.camera) : { ...quiet, message: "Nothing inside to open" };
  }
  const history = [...state.history];
  const visit = history.pop();
  if (visit && world.views.has(visit.view)) return { ...quiet, view: visit.view, selected: visit.selected, history, restore: visit.camera ?? null };
  if (!action.up) return { ...quiet, history: [], message: "No previous view" };
  const selected = diagram?.nodes.find(node => String(node.id) === state.selected);
  const holder = selected && diagram?.nodes.find(node => node.id === selected.parent);
  if (holder) return { ...quiet, selected: String(holder.id), history: [] };
  const above = [...world.views].find(([id, other]) => id !== state.view && other.nodes.some(node => String(node.navigateTo ?? "") === state.view));
  if (!above) return { ...quiet, history: [], message: "No previous view" };
  const opener = above[1].nodes.find(node => String(node.navigateTo ?? "") === state.view)!;
  return goTo(world, { ...state, history: [] }, above[0], String(opener.id), action.camera);
};

/**
 * The terminal's placement of the inspector (native-viewer.ts `layout`): docked beside the diagram from 120 columns, below it under 120 with 40
 * rows or more, else an overlay that `i` opens; under 80 columns the node list replaces the diagram.
 */
export const placementOf = (state: Pick<WindowState, "cols" | "rows" | "inspector">): Placement => {
  const { cols, rows } = state;
  const side = cols >= 120, list = cols < 80, under = !side && !list && rows >= 40;
  const visible = state.inspector === "open" || state.inspector === "auto" && (side || under);
  const mount = !visible ? "none" : side ? "docked" : under ? "below" : "overlay";
  if (mount === "docked") return { mount, list, width: Math.min(64, Math.max(38, Math.floor(cols * 0.30))), height: rows - 4 };
  if (mount === "below") return { mount, list, width: cols, height: Math.max(12, Math.round((rows - 4) * 0.45)) };
  if (mount === "overlay") return { mount, list, width: Math.min(cols - 2, Math.max(38, Math.floor(cols * 0.5))), height: rows - 4 };
  return { mount, list, width: 0, height: 0 };
};

/** A styled text as lines of spans. */
const lines = (spans: Span[]): Span[][] => {
  const out: Span[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    parts.forEach((part, index) => {
      if (index) out.push([]);
      if (part) out.at(-1)!.push({ ...span, text: part });
    });
  }
  return out;
};

/** The actions the page has in step 1, for the rows `?` lists. */
const pageActions = new Set(["traverse", "listMove", "open", "openView", "back", "parent", "help", "fit", "inspector", "zoom", "actualSize", "pan"]);

/** The header, the footer, every card's look, the connectors' tones and the inspector for a window, in the terminal's words and colors. */
export const frameOf = (world: World, state: WindowState): Frame => {
  const diagram = world.views.get(state.view), scene = world.scenes.get(state.view);
  if (!diagram || !scene) throw new Error(`No view ${state.view}`);
  const placement = placementOf(state);
  const selected = diagram.nodes.find(node => String(node.id) === state.selected);
  const ref = String(selected?.modelRef ?? "");
  const target = selected?.navigateTo ? world.views.get(String(selected.navigateTo)) : undefined;
  const all = [...world.views.values()].flatMap(view => view.nodes);
  const waiting = (node: WorldNode) => isWaiting(world.planned, world.files, String(node.modelRef));
  // The inspector's text width, as the terminal gives it: the panel less its padding (and the overlay's border).
  const inner = Math.max(10, placement.width - 3);
  const head = headContent({
    title: selected?.title, technology: selected?.technology, planned: Boolean(selected && waiting(selected)), tags: selected?.tags ?? [],
    description: selected?.description, opens: opensOf(selected, diagram, target), width: inner, by: world.words.get(ref)?.by, note: world.words.get(ref)?.note,
    mapped: (world.files.get(ref) ?? []).length, app: selected ? undefined : appNoteOf(all, diagram.viewOf, world.words),
  });
  const name = (id: string) => diagram.nodes.find(node => String(node.id) === id)?.title ?? id;
  // Who calls it first, then what it calls, as the terminal's Connects lists them.
  const links = selected ? [
    ...diagram.edges.filter(edge => edge.target === selected.id).map(edge => ({ node: String(edge.source), arrow: "←", tone: palette.incoming, label: edge.label })),
    ...diagram.edges.filter(edge => edge.source === selected.id).map(edge => ({ node: String(edge.target), arrow: "→", tone: palette.accent, label: edge.label })),
  ] : [];
  const hot = RGBA.fromHex(palette.hot);
  const connects = connectsCard(links, name, undefined, Math.max(16, placement.width - 3), hot);
  const connectLines = lines(spansOf(connects.chunks)).slice(0, connects.lines);
  const rows: (string | null)[] = connectLines.map((_, line) => { const index = connects.starts.findLastIndex(start => start <= line); return index >= 0 ? links[index]!.node : null; });
  const opens = selected?.navigateTo && String(selected.navigateTo) !== state.view && target ? { view: String(selected.navigateTo), title: target.title ?? String(selected.navigateTo) } : null;

  // Cards, as the terminal draws them at 100%: a card's cells are its world rectangle over 16 by 32.
  const shape = world.rows.get(state.view) ?? { words: new Map<string, string>(), row: false };
  const neighbours = new Set(selected ? diagram.edges.flatMap(edge => edge.source === selected.id ? [String(edge.target)] : edge.target === selected.id ? [String(edge.source)] : []) : []);
  const cards: Record<string, CardLook> = {};
  const byId = new Map(diagram.nodes.map(node => [String(node.id), node]));
  for (const card of scene.cards) {
    const node = byId.get(card.id);
    if (!node) continue;
    const width = Math.max(3, Math.round(card.rect[2] / 16)), height = Math.max(3, Math.round(card.rect[3] / 32));
    const look = cardLook({ title: card.title, word: shape.words.get(card.id) ?? "", header: shape.row, group: card.group, tags: node.tags ?? [], related: [], now: 0,
      selected: card.id === state.selected, previewed: false, flashing: false, neighbour: neighbours.has(card.id), unbuilt: waiting(node), planned: false, offPlan: false,
      numbers: undefined, flow: false, width, height });
    const border = typeof look.border === "string" ? look.border : `#${[look.border.r, look.border.g, look.border.b].map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
    cards[card.id] = { border, dashed: Boolean(look.dashes), title: look.title ? [{ text: look.title, fg: look.titleColor ?? palette.muted }] : [],
      label: look.label ? lines(spansOf(look.label)) : [] };
  }
  const routes = scene.routes.map(route => {
    const tone = routeTone(route, state.selected);
    return { color: toneColor(tone), dotted: tone === "dim" || tone === "lost" || tone === "gap", lit: tone !== "dim" };
  });

  const footing = footerContent({ mode: "diagram", selected: state.selected ?? "", message: state.message, hidden: 0, scale: 16 / state.zoom, width: state.cols, hints: () => [] });
  const guide = helpContent({ tier: 1, vim: false, screenWidth: state.cols, version: world.version, only: does => does.some(action => pageActions.has(action)) });
  const list = placement.list ? nodeListContent(diagram.nodes.map(node => ({ ...node, level: node.level ?? 0 })), { selected: selected?.id, width: Math.max(10, state.cols - 2), background: hot, state: () => undefined }) : undefined;
  return {
    view: state.view, selected: state.selected ?? null, canBack: state.history.length > 0, restore: state.restore,
    size: { cols: state.cols, rows: state.rows }, placement,
    header: {
      line1: spansOf(viewHeading(diagram.title ?? String(diagram.id))), badge: [],
      line2: [{ text: boxesText({ boxes: diagram.nodes.length, planned: diagram.nodes.filter(waiting).length, back: state.history.length }), fg: palette.muted }],
    },
    footer: { left: spansOf(footing.left), right: spansOf(footing.right) },
    cards, routes,
    inspector: {
      title: spansOf(head.title), what: head.hasWhat ? lines(spansOf(head.what)) : [], about: head.hasAbout ? lines(spansOf(head.about)) : [],
      connects: { header: spansOf(sectionHeader({ open: true, focused: false, number: 1, name: "Connects", count: String(links.length), width: placement.width })), lines: connectLines, rows },
      opens,
    },
    list: list ? { lines: lines(spansOf(list)), ids: diagram.nodes.map(node => String(node.id)) } : null,
    help: { lines: lines(spansOf(guide.content)), meta: spansOf(guide.meta) },
  };
};
