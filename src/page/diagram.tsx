import { createMemo, For, Index, Show } from "solid-js";
import type { CardLook, Frame, Scene, SceneCard, SceneRoute, Span } from "../web/wire";
import type { PageCamera } from "./camera";
import { type Cell, fontFamily, fontSize, world } from "./cell";
import { Runs } from "./spans";

/**
 * The diagram in SVG (plan 4d, "The look", 3): cards and group frames as one-pixel borders through the middle of their outer cells, where the
 * terminal's box-drawing glyphs sit; a group's title in its frame row, a card's label from its second row, both at the cell's third column;
 * connectors as one-pixel right-angled lines with a small arrowhead where the terminal draws `▶`. Lines stay one pixel at any zoom; the text
 * scales with the camera, as a cell does. The geometry is the server's (the terminal's layout), the colors are the frame's (the terminal's look).
 */
const half = { x: world.x / 2, y: world.y / 2 };

const arrowhead = (route: SceneRoute) => {
  const [x, y] = route.points.at(-1)!, length = 11, wide = 5;
  switch (route.arrow) {
    case "E": return `M${x},${y} L${x - length},${y - wide} L${x - length},${y + wide} Z`;
    case "W": return `M${x},${y} L${x + length},${y - wide} L${x + length},${y + wide} Z`;
    case "S": return `M${x},${y} L${x - wide},${y - length} L${x + wide},${y - length} Z`;
    default: return `M${x},${y} L${x - wide},${y + length} L${x + wide},${y + length} Z`;
  }
};

const length = (spans: readonly Span[]) => spans.reduce((sum, span) => sum + span.text.length, 0);

export const Diagram = (props: {
  scene: Scene; frame: Frame; cell: Cell; camera: PageCamera; pending: string | null;
  select: (id: string) => void; into: (id: string) => void;
}) => {
  const text = () => fontSize * world.x / props.cell.w;
  const groups = createMemo(() => props.scene.cards.filter(card => card.group).sort((a, b) => a.level - b.level));
  const leaves = createMemo(() => props.scene.cards.filter(card => !card.group));
  // Quiet connectors first, the selection's over them, as the terminal ranks them.
  const routes = createMemo(() => props.scene.routes.map((route, index) => ({ route, index })).sort((a, b) =>
    Number(props.frame.routes[a.index]?.lit ?? false) - Number(props.frame.routes[b.index]?.lit ?? false)));
  const look = (card: SceneCard): CardLook => props.frame.cards[card.id] ?? { border: "var(--cardEdge)", dashed: false, title: [], label: [] };
  // A click selects at once; until the server's frame confirms it, the clicked card carries the selection's border and the old one steps back.
  const border = (card: SceneCard) => props.pending !== null && props.pending !== props.frame.selected
    ? card.id === props.pending ? "var(--accent)" : card.id === props.frame.selected ? (card.group ? "var(--rule)" : "var(--cardEdge)") : look(card).border
    : look(card).border;
  const selected = (card: SceneCard) => (props.pending ?? props.frame.selected) === card.id;

  return (
    <g transform={props.camera.transform()} font-family={fontFamily} font-size={text()} style={{ "white-space": "pre" }}>
      <For each={groups()}>{card => {
        const [x, y, width, height] = card.rect;
        return (
          <g class="card group" classList={{ selected: selected(card) }} data-id={card.id}
            onClick={() => props.select(card.id)} onDblClick={() => props.into(card.id)}>
            <rect class="hit" x={x + half.x} y={y + half.y} width={width - world.x} height={height - world.y} rx={6} />
            <rect class="edge" x={x + half.x} y={y + half.y} width={width - world.x} height={height - world.y} rx={6} stroke={border(card)}
              stroke-dasharray={look(card).dashed ? "4 3" : undefined} />
            <Show when={look(card).title.length}>
              <rect class="behind" x={x + world.x * 2} y={y} width={length(look(card).title) * world.x} height={world.y} />
              <text class="title" x={x + world.x * 2} y={y + half.y} dominant-baseline="central"><Runs spans={look(card).title} /></text>
            </Show>
          </g>
        );
      }}</For>
      <For each={routes()}>{({ route, index }) => {
        const tone = () => props.frame.routes[index];
        return (
          <g class="route" classList={{ lit: tone()?.lit ?? false }}>
            <polyline points={route.points.map(point => point.join(",")).join(" ")} stroke={tone()?.color ?? "var(--edgeDim)"}
              stroke-dasharray={tone()?.dotted ? "2 3" : undefined} />
            <path d={arrowhead(route)} fill={tone()?.color ?? "var(--edgeDim)"} />
          </g>
        );
      }}</For>
      <For each={leaves()}>{card => {
        const [x, y, width, height] = card.rect;
        return (
          <g class="card leaf" classList={{ selected: selected(card) }} data-id={card.id}
            onClick={() => props.select(card.id)} onDblClick={() => props.into(card.id)}>
            <rect class="edge" x={x + half.x} y={y + half.y} width={width - world.x} height={height - world.y} rx={6} stroke={border(card)}
              stroke-dasharray={look(card).dashed ? "4 3" : undefined} />
            <Show when={look(card).title.length}>
              <rect class="behind" x={x + width - world.x * 2 - length(look(card).title) * world.x} y={y} width={length(look(card).title) * world.x} height={world.y} />
              <text class="title" x={x + width - world.x * 2} y={y + half.y} text-anchor="end" dominant-baseline="central"><Runs spans={look(card).title} /></text>
            </Show>
            <Index each={look(card).label}>{(line, row) =>
              <text x={x + world.x * 2} y={y + world.y * (row + 1) + half.y} dominant-baseline="central"><Runs spans={line()} /></text>}</Index>
          </g>
        );
      }}</For>
    </g>
  );
};
