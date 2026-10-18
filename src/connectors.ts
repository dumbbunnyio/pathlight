import type { DiagramEdge, DiagramView, RelationshipArrowType } from "likec4";

type Point = { x: number; y: number };
type Cell = Point & { glyph: string; strong: string; mask?: number };
type NodeBox = Point & { width: number; height: number; children: readonly string[] };

export function terminalPoint(x: number, y: number, bounds: Point, zoom = 1): Point {
  return { x: 2 + (x - bounds.x) * zoom / 16, y: 1 + (y - bounds.y) * zoom / 32 };
}

function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function composeConnectors(routes: readonly {
  edge: { source: string; target: string }; cells: readonly Cell[]; arrows: readonly Cell[];
}[], selected: string | undefined) {
  type PaintedCell = Cell & { emphasis: "outgoing" | "incoming" | "none" };
  const emphasis = (edge: { source: string; target: string }): PaintedCell["emphasis"] =>
    edge.source === selected ? "outgoing" : edge.target === selected ? "incoming" : "none";
  const ordered = [...routes.filter(route => emphasis(route.edge) === "none"), ...routes.filter(route => emphasis(route.edge) !== "none")];
  const painted = new Map<string, PaintedCell>();
  for (const route of ordered) {
    for (const cell of route.cells) {
      const key = `${cell.x},${cell.y}`;
      const state = emphasis(route.edge);
      const mask = cell.mask ? cell.mask | (painted.get(key)?.mask ?? 0) : undefined;
      const glyph = mask ? String.fromCodePoint(0x2800 + mask) : state === "none" ? cell.glyph : cell.strong;
      painted.set(key, { ...cell, mask, glyph, emphasis: state });
    }
  }
  for (const route of ordered) {
    for (const cell of route.arrows) painted.set(`${cell.x},${cell.y}`, { ...cell, emphasis: emphasis(route.edge) });
  }
  return painted.values();
}

export function terminalConnectors<Edge extends Pick<DiagramEdge, "points" | "head" | "tail">>(
  diagram: { edges: readonly Edge[]; bounds: Pick<DiagramView["bounds"], "x" | "y"> }, nodes: readonly NodeBox[], zoom = 1,
) {
  const project = ([x, y]: readonly [number, number]): Point => terminalPoint(x, y, diagram.bounds, zoom);
  const covered = (point: Point) => nodes.some(node => {
    const right = node.x + node.width - 1, bottom = node.y + node.height - 1;
    return point.x >= node.x && point.x <= right && point.y >= node.y && point.y <= bottom
      && (!node.children.length || point.x === node.x || point.x === right || point.y === node.y || point.y === bottom);
  });
  return diagram.edges.map(edge => {
    const points = edge.points.map(project);
    const first = points[0];
    const solid = points.every(point => point.x === first?.x) || points.every(point => point.y === first?.y);
    const dots = new Map<string, Point & { mask: number }>();
    const masks = [[1, 8], [2, 16], [4, 32], [64, 128]];
    let previousDot: Point | undefined;
    const path: Point[] = [];
    const append = (point: Point) => {
      const cell = { x: Math.round(point.x), y: Math.round(point.y) };
      const previous = path.at(-1);
      if (previous?.x !== cell.x || previous?.y !== cell.y) path.push(cell);
      if (solid) return;
      const next = { x: Math.round(point.x * 2 + 0.5), y: Math.round(point.y * 4 + 1.5) };
      const start = previousDot ?? next;
      const steps = Math.max(1, Math.abs(next.x - start.x), Math.abs(next.y - start.y));
      for (let step = 0; step <= steps; step++) {
        const dx = Math.round(start.x + (next.x - start.x) * step / steps);
        const dy = Math.round(start.y + (next.y - start.y) * step / steps);
        const x = Math.floor(dx / 2), y = Math.floor(dy / 4);
        if (x < 0 || y < 0 || covered({ x, y })) continue;
        const bit = masks[dy % 4]?.[dx % 2];
        if (bit === undefined) continue;
        const key = `${x},${y}`;
        dots.set(key, { x, y, mask: (dots.get(key)?.mask ?? 0) | bit });
      }
      previousDot = next;
    };
    const cubic = points.length >= 4 && (points.length - 1) % 3 === 0;
    for (let index = 0; cubic && index + 3 < points.length; index += 3) {
      const a = points[index], b = points[index + 1], c = points[index + 2], d = points[index + 3];
      if (!a || !b || !c || !d) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
      const steps = Math.max(1, Math.min(16384, Math.ceil(length * 4)));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const ab = mix(a, b, t), bc = mix(b, c, t), cd = mix(c, d, t);
        append(mix(mix(ab, bc, t), mix(bc, cd, t), t));
      }
    }
    if (!cubic) {
      for (let index = 0; index < points.length; index++) {
        const a = points[index], b = points[index + 1] ?? a;
        if (!a || !b) continue;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2));
        for (let step = 0; step <= steps; step++) append({ x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps });
      }
    }
    const cells: Cell[] = path.flatMap((point, index) => {
      if (covered(point)) return [];
      const before = path[index - 1] ?? point, after = path[index + 1] ?? point;
      const dx = after.x - before.x, dy = after.y - before.y;
      const glyph = dy === 0 ? "─" : dx === 0 ? "│" : dx * dy > 0 ? "╲" : "╱";
      return [{ ...point, glyph, strong: glyph === "─" ? "━" : glyph === "│" ? "┃" : glyph }];
    });
    const arrow = (type: RelationshipArrowType | undefined, tail: boolean): Cell[] => {
      if (type === "none" || tail && !type) return [];
      const point = tail ? cells[0] : cells.at(-1);
      if (!point) return [];
      const endpoint = tail ? points[0] : points.at(-1);
      const distinct = (candidate: Point) => candidate.x !== endpoint?.x || candidate.y !== endpoint?.y;
      const neighbor = tail ? points.find(distinct) : points.findLast(distinct);
      if (!endpoint || !neighbor) return [];
      const dx = endpoint.x - neighbor.x, dy = endpoint.y - neighbor.y;
      const glyph = type === "diamond" ? "◆" : type === "odiamond" ? "◇" : type === "dot" ? "●" : type === "odot" ? "○"
        : Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? "▶" : "◀" : dy >= 0 ? "▼" : "▲";
      return [{ ...point, glyph, strong: glyph }];
    };
    const curves = [...dots.values()].map(cell => {
      const glyph = String.fromCodePoint(0x2800 + cell.mask);
      return { ...cell, glyph, strong: glyph };
    });
    return { edge, cells: solid ? cells : curves, arrows: [...arrow(edge.tail, true), ...arrow(edge.head, false)] };
  });
}
