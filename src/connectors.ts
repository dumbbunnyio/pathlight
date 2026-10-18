import type { DiagramEdge, DiagramView, RelationshipArrowType } from "likec4";

type Point = { x: number; y: number };
type Cell = Point & { glyph: string; strong: string; mask?: number; heavy?: number; t?: number };
type NodeBox = Point & { width: number; height: number; children: readonly string[] };

/** Arrowhead pointing along (dx, dy) in terminal cells; cells are about twice as tall as wide, so the angle is taken in visual space. */
export function arrowGlyph(dx: number, dy: number) {
  const angle = Math.atan2(dy * 2, dx) * 180 / Math.PI;
  const sector = ((Math.round(angle / 45) % 8) + 8) % 8;
  return ["▶", "◢", "▼", "◣", "◀", "◤", "▲", "◥"][sector] ?? "▶";
}

export function terminalPoint(x: number, y: number, bounds: Point, zoom = 1): Point {
  return { x: 2 + (x - bounds.x) * zoom / 16, y: 1 + (y - bounds.y) * zoom / 32 };
}

function mix(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function composeConnectors(routes: readonly {
  edge: { source: string; target: string }; cells: readonly Cell[]; arrows: readonly Cell[];
}[], selected: string | undefined) {
  type PaintedCell = Cell & { emphasis: "outgoing" | "incoming" | "none"; t: number };
  const emphasis = (edge: { source: string; target: string }): PaintedCell["emphasis"] =>
    edge.source === selected ? "outgoing" : edge.target === selected ? "incoming" : "none";
  const ordered = [...routes.filter(route => emphasis(route.edge) === "none"), ...routes.filter(route => emphasis(route.edge) !== "none")];
  const painted = new Map<string, PaintedCell>();
  for (const route of ordered) {
    for (const cell of route.cells) {
      const key = `${cell.x},${cell.y}`;
      const state = emphasis(route.edge);
      const before = painted.get(key);
      const mask = cell.mask !== undefined ? cell.mask | (before?.mask ?? 0) : undefined;
      const heavy = cell.heavy !== undefined ? cell.heavy | (before?.heavy ?? 0) : undefined;
      // Selected connections use the heavy stroke; everything else the medium one.
      const glyph = mask !== undefined ? String.fromCodePoint(0x2800 + (state === "none" ? mask : heavy ?? mask)) : state === "none" ? cell.glyph : cell.strong;
      painted.set(key, { ...cell, mask, heavy, glyph, emphasis: state, t: cell.t ?? 1 });
    }
  }
  for (const route of ordered) {
    for (const cell of route.arrows) painted.set(`${cell.x},${cell.y}`, { ...cell, emphasis: emphasis(route.edge), t: 1 });
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
    // Judged once per connector, in dot space: sampling noise at the single-dot scale must not widen a diagonal.
    const last = points.at(-1) ?? first;
    const chordRatio = first && last ? Math.abs(last.y - first.y) * 4 / Math.max(1, Math.abs(last.x - first.x) * 2) : 1;
    const diagonal = chordRatio > 0.4 && chordRatio < 2.5;
    const dots = new Map<string, Point & { mask: number; heavy: number; t: number }>();
    const masks = [[1, 8], [2, 16], [4, 32], [64, 128]];
    let previousDot: Point | undefined;
    let progress = 0;
    const path: Point[] = [];
    const append = (point: Point) => {
      const cell = { x: Math.round(point.x), y: Math.round(point.y) };
      const previous = path.at(-1);
      if (previous?.x !== cell.x || previous?.y !== cell.y) path.push(cell);
      if (solid) return;
      const next = { x: Math.round(point.x * 2 + 0.5), y: Math.round(point.y * 4 + 1.5) };
      const start = previousDot ?? next;
      const steps = Math.max(1, Math.abs(next.x - start.x), Math.abs(next.y - start.y));
      const shallow = Math.abs(next.x - start.x) >= Math.abs(next.y - start.y);
      // Only near-axis lines get the heavier stroke; a widened diagonal looks fat.
      // Quiet connections are a single dot wide; selected ones also light the next dot across the line.
      const plot = (dx: number, dy: number, field: "mask" | "heavy") => {
        const x = Math.floor(dx / 2), y = Math.floor(dy / 4);
        if (x < 0 || y < 0 || covered({ x, y })) return;
        const bit = masks[((dy % 4) + 4) % 4]?.[((dx % 2) + 2) % 2];
        if (bit === undefined) return;
        const key = `${x},${y}`;
        const cell = dots.get(key) ?? { x, y, mask: 0, heavy: 0, t: progress };
        cell[field] |= bit; if (field === "mask") cell.heavy |= bit;
        cell.t = Math.max(cell.t, progress);
        dots.set(key, cell);
      };
      for (let step = 0; step <= steps; step++) {
        const dx = Math.round(start.x + (next.x - start.x) * step / steps);
        const dy = Math.round(start.y + (next.y - start.y) * step / steps);
        const [ax, ay] = shallow ? [0, 1] : [1, 0];
        plot(dx, dy, "mask"); if (!diagonal) plot(dx + ax, dy + ay, "heavy");
      }
      previousDot = next;
    };
    const cubic = points.length >= 4 && (points.length - 1) % 3 === 0;
    const segments = cubic ? (points.length - 1) / 3 : Math.max(1, points.length - 1);
    for (let index = 0; cubic && index + 3 < points.length; index += 3) {
      const a = points[index], b = points[index + 1], c = points[index + 2], d = points[index + 3];
      if (!a || !b || !c || !d) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
      const steps = Math.max(1, Math.min(16384, Math.ceil(length * 4)));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        progress = (index / 3 + t) / segments;
        const ab = mix(a, b, t), bc = mix(b, c, t), cd = mix(c, d, t);
        append(mix(mix(ab, bc, t), mix(bc, cd, t), t));
      }
    }
    if (!cubic) {
      for (let index = 0; index < points.length; index++) {
        const a = points[index], b = points[index + 1] ?? a;
        if (!a || !b) continue;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2));
        for (let step = 0; step <= steps; step++) { progress = (index + step / steps) / segments; append({ x: a.x + (b.x - a.x) * step / steps, y: a.y + (b.y - a.y) * step / steps }); }
      }
    }
    const cells: Cell[] = path.flatMap((point, index) => {
      if (covered(point)) return [];
      const before = path[index - 1] ?? point, after = path[index + 1] ?? point;
      const dx = after.x - before.x, dy = after.y - before.y;
      const glyph = dy === 0 ? "─" : dx === 0 ? "│" : dx * dy > 0 ? "╲" : "╱";
      return [{ ...point, glyph, strong: glyph === "─" ? "━" : glyph === "│" ? "┃" : glyph, t: index / Math.max(1, path.length - 1) }];
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
      const glyph = type === "diamond" ? "◆" : type === "odiamond" ? "◇" : type === "dot" ? "●" : type === "odot" ? "○" : arrowGlyph(dx, dy);
      return [{ ...point, glyph, strong: glyph }];
    };
    const curves = [...dots.values()].map(cell => {
      const glyph = String.fromCodePoint(0x2800 + cell.mask);
      return { ...cell, glyph, strong: String.fromCodePoint(0x2800 + cell.heavy) };
    });
    return { edge, cells: solid ? cells : curves, arrows: [...arrow(edge.tail, true), ...arrow(edge.head, false)] };
  });
}
