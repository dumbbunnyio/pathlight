import { mix } from "../theme";
import type { Palette } from "../ui";

/**
 * What the browser page draws for one view, decided here so the page only draws (plan 4d, decision 9). LikeC4 is authoritative: ids, nesting,
 * order, sizes and routes are its layout as it computed them; the page tightens only the gaps between cards, in pixels. Colors are resolved
 * here from LikeC4's own styles (the element's color, as the model sets it) and blended into Pathlight's palette, so the look stays Pathlight's.
 */

/** The parts of LikeC4's layouted view that the page needs; anything else on it is ignored. */
export interface LayoutedNode {
  id: unknown; title: string; description?: unknown; technology?: string | null; kind?: unknown; shape: string; color: string;
  children: readonly unknown[]; navigateTo?: unknown; x: number; y: number; width: number; height: number; depth?: number | null; level?: number;
  style?: { border?: string; multiple?: boolean; opacity?: number; size?: string } | null; tags?: readonly string[] | null;
}
export interface LayoutedEdge {
  id: unknown; source: unknown; target: unknown; label?: string | null; technology?: string | null; color: string;
  line?: string; head?: string; tail?: string; dir?: string; points: readonly (readonly [number, number])[];
  labelBBox?: { x: number; y: number; width: number; height: number } | null; navigateTo?: unknown;
}
export interface LayoutedView {
  id: unknown; title?: string | null; description?: unknown; nodes: readonly LayoutedNode[]; edges: readonly LayoutedEdge[];
  autoLayout?: { direction?: string } | null; _type?: string;
}

/** LikeC4's resolved colors for one color name (`$styles.colors`). */
export interface ColorValues { elements: { fill: string; stroke: string }; relationships: { line: string } }
export type ColorsOf = (color: string) => ColorValues;

export interface SceneNode {
  id: string; title: string; technology: string; shape: string; group: boolean; opens: string | null; rect: [number, number, number, number];
  depth: number; border: "solid" | "dashed" | "dotted" | "none"; multiple: boolean;
  /** Fill, outline and title colors, already in Pathlight's palette. */
  fill: string; stroke: string; ink: string;
}
export interface SceneEdge {
  id: string; source: string; target: string; label: string; technology: string; points: [number, number][]; labelAt: [number, number] | null;
  line: "solid" | "dashed" | "dotted"; head: string; tail: string; color: string; opens: string | null;
}
export interface Scene { id: string; title: string; kind: string; nodes: SceneNode[]; edges: SceneEdge[] }

const lines = new Set(["solid", "dashed", "dotted"]);
const borders = new Set(["solid", "dashed", "dotted", "none"]);
const arrows = new Set(["none", "normal", "onormal", "dot", "odot", "diamond", "odiamond", "crow", "open", "vee"]);

/** A view's title as the header shows it: the last part of a `Parent / Child` title. */
export const shortTitle = (view: { id: unknown; title?: string | null }) => {
  const title = view.title ?? String(view.id);
  return title.split(" / ").at(-1) ?? title;
};

/**
 * One view for the page. A box takes its element's color only as a tint: the card is the palette's own surface with an eighth of the element's
 * fill, its outline a third of the way to the element's stroke, so a model's colors read without the cards turning into LikeC4's filled ones.
 * A box whose children this view draws is a group. Arrows keep LikeC4's line and ends; `dir: back` swaps the ends, as LikeC4's `EdgePath` does.
 */
export const sceneOf = (view: LayoutedView, colors: ColorsOf, palette: Palette): Scene => {
  const drawn = new Set(view.nodes.map(node => String(node.id)));
  const nodes = view.nodes.map((node): SceneNode => {
    const values = colors(node.color).elements;
    const group = node.children.some(child => drawn.has(String(child)));
    const border = node.style?.border && borders.has(node.style.border) ? node.style.border as SceneNode["border"] : group ? "dashed" : "solid";
    return {
      id: String(node.id), title: node.title, technology: node.technology ?? "", shape: group ? "rectangle" : node.shape, group,
      opens: node.navigateTo && String(node.navigateTo) !== String(view.id) ? String(node.navigateTo) : null,
      rect: [node.x, node.y, node.width, node.height], depth: node.depth ?? 0, border, multiple: node.style?.multiple === true,
      fill: group ? mix(palette.background, values.fill, 0.04 + 0.02 * Math.min(3, node.depth ?? 0)) : mix(palette.panel, values.fill, 0.12),
      stroke: group ? mix(palette.rule, values.stroke, 0.25) : mix(palette.border, values.stroke, 0.35), ink: palette.text,
    };
  });
  const edges = view.edges.map((edge): SceneEdge => {
    const box = edge.labelBBox;
    const head = edge.head && arrows.has(edge.head) ? edge.head : "normal", tail = edge.tail && arrows.has(edge.tail) ? edge.tail : "none";
    const back = edge.dir === "back";
    return {
      id: String(edge.id), source: String(edge.source), target: String(edge.target), label: edge.label ?? "", technology: edge.technology ?? "",
      points: edge.points.map(([x, y]) => [x, y]), labelAt: box ? [box.x + box.width / 2, box.y + box.height / 2] : null,
      line: edge.line && lines.has(edge.line) ? edge.line as SceneEdge["line"] : "dashed",
      head: back ? tail : head, tail: back ? head : tail,
      color: mix(palette.edgeDim, colors(edge.color).relationships.line, 0.3),
      opens: edge.navigateTo ? String(edge.navigateTo) : null,
    };
  });
  return { id: String(view.id), title: shortTitle(view), kind: view._type ?? "element", nodes, edges };
};

/** The views in the order the rail lists them: the overview first, then by title. */
export const viewOrder = (scenes: readonly Scene[], first: string | undefined) =>
  [...scenes].sort((a, b) => Number(b.id === first) - Number(a.id === first) || a.title.localeCompare(b.title));
