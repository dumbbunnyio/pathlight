/**
 * Orthogonal connectors: every relationship is a run of horizontal and vertical segments with rounded bends, drawn
 * with thin box-drawing characters. Routes are found once per layout, in diagram coordinates, on a coarse grid that
 * steers around leaf nodes and prefers few bends; they are projected and rasterized onto terminal cells each frame.
 * The endpoints stay LikeC4's: only the path between them is ours.
 */
export type Point = { x: number; y: number };
export type Side = "E" | "W" | "N" | "S";
export interface RouteNode { id: string; x: number; y: number; width: number; height: number; children: readonly string[] }
export interface RouteEdge { source: string; target: string; points: readonly (readonly [number, number])[] }
export interface Route { source: string; target: string; points: Point[]; entry: Side }

const grid = 8;
const normals: Record<Side, Point> = { E: { x: 1, y: 0 }, W: { x: -1, y: 0 }, N: { x: 0, y: -1 }, S: { x: 0, y: 1 } };
const directions: Side[] = ["E", "S", "W", "N"];

const nearestSide = (node: RouteNode, point: Point): Side => {
  const distances: [Side, number][] = [["W", Math.abs(point.x - node.x)], ["E", Math.abs(point.x - (node.x + node.width))],
    ["N", Math.abs(point.y - node.y)], ["S", Math.abs(point.y - (node.y + node.height))]];
  return distances.sort((a, b) => a[1] - b[1])[0]?.[0] ?? "E";
};

class Heap {
  private items: [number, number][] = [];
  get size() { return this.items.length; }
  push(priority: number, value: number) {
    const items = this.items;
    items.push([priority, value]);
    for (let index = items.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if ((items[parent]?.[0] ?? 0) <= (items[index]?.[0] ?? 0)) break;
      [items[parent], items[index]] = [items[index]!, items[parent]!];
      index = parent;
    }
  }
  pop(): [number, number] | undefined {
    const items = this.items, top = items[0], last = items.pop();
    if (!top || !last) return top;
    if (items.length) {
      items[0] = last;
      for (let index = 0;;) {
        const left = index * 2 + 1, right = left + 1;
        let smallest = index;
        if (left < items.length && (items[left]?.[0] ?? 0) < (items[smallest]?.[0] ?? 0)) smallest = left;
        if (right < items.length && (items[right]?.[0] ?? 0) < (items[smallest]?.[0] ?? 0)) smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index]!, items[smallest]!];
        index = smallest;
      }
    }
    return top;
  }
}

export function routeEdges(nodes: readonly RouteNode[], edges: readonly RouteEdge[]): Route[] {
  const leaves = nodes.filter(node => !node.children.length);
  const groups = nodes.filter(node => node.children.length);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const xs = [...nodes.flatMap(node => [node.x, node.x + node.width]), ...edges.flatMap(edge => edge.points.map(point => point[0]))];
  const ys = [...nodes.flatMap(node => [node.y, node.y + node.height]), ...edges.flatMap(edge => edge.points.map(point => point[1]))];
  const originX = Math.min(...xs, 0) - grid * 6, originY = Math.min(...ys, 0) - grid * 6;
  const width = Math.ceil((Math.max(...xs, 0) + grid * 6 - originX) / grid) + 1, height = Math.ceil((Math.max(...ys, 0) + grid * 6 - originY) / grid) + 1;
  const toCell = (value: number, origin: number) => Math.round((value - origin) / grid);
  const band = grid * 1.5;

  // A run may cross a group's outline but never travel along it: these mark where vertical / horizontal travel would.
  const alongVertical = (x: number, y: number) => groups.some(group => y >= group.y - band && y <= group.y + group.height + band
    && (Math.abs(x - group.x) <= band || Math.abs(x - (group.x + group.width)) <= band));
  const alongHorizontal = (x: number, y: number) => groups.some(group => x >= group.x - band && x <= group.x + group.width + band
    && (Math.abs(y - group.y) <= band || Math.abs(y - (group.y + group.height)) <= band));

  return edges.flatMap(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) return [];
    // Always out of the middle of the source's right side and into the middle of the target's left side.
    const start = { x: source.x + source.width, y: source.y + source.height / 2 };
    const end = { x: target.x, y: target.y + target.height / 2 };
    const others = leaves.filter(node => node !== source && node !== target);
    const blockedPoint = (x: number, y: number) => others.some(node => x >= node.x - grid && x <= node.x + node.width + grid && y >= node.y - grid && y <= node.y + node.height + grid);
    const free = (a: Point, b: Point) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (grid / 2)));
      for (let step = 0; step <= steps; step++) {
        const x = a.x + (b.x - a.x) * step / steps, y = a.y + (b.y - a.y) * step / steps;
        if (blockedPoint(x, y)) return false;
        if (a.x === b.x && alongVertical(x, y) && Math.abs(b.y - a.y) > grid) return false;
        if (a.y === b.y && alongHorizontal(x, y) && Math.abs(b.x - a.x) > grid) return false;
      }
      return true;
    };

    // Preferred: horizontal, then vertical in the middle of the gap between the two columns, then horizontal.
    // If that column is blocked, the nearest free one in the gap.
    const gap = end.x - start.x;
    if (gap >= grid * 4) {
      const middle = (start.x + end.x) / 2;
      const candidates: number[] = [];
      for (let x = start.x + grid * 2; x <= end.x - grid * 2; x += grid) candidates.push(x);
      candidates.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
      for (const x of candidates) {
        const route: Point[] = start.y === end.y ? [start, end] : [start, { x, y: start.y }, { x, y: end.y }, end];
        if (route.every((point, index) => index === 0 || free(route[index - 1]!, point))) return [{ source: edge.source, target: edge.target, points: route, entry: "W" as const }];
      }
    }

    // No such route (a node in the way, a backward edge, or no gap): search around, still leaving east and arriving from the west.
    const startCell = { x: toCell(start.x, originX) + 3, y: toCell(start.y, originY) };
    const goal = { x: toCell(end.x, originX) - 3, y: toCell(end.y, originY) };
    const memo = new Int8Array(width * height).fill(-1);
    const blocked = (cx: number, cy: number) => {
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) return true;
      const key = cy * width + cx, known = memo[key];
      if (known !== undefined && known >= 0) return known === 1;
      const x = originX + cx * grid, y = originY + cy * grid;
      const hit = others.some(node => x >= node.x - grid && x <= node.x + node.width + grid && y >= node.y - grid && y <= node.y + node.height + grid)
        || [source, target].some(node => !node.children.length && x > node.x - grid * 0.5 && x < node.x + node.width + grid * 0.5 && y > node.y - grid * 0.5 && y < node.y + node.height + grid * 0.5
          && !(x >= start.x - grid && x <= start.x + grid * 4 && Math.abs(y - start.y) < grid) && !(x <= end.x + grid && x >= end.x - grid * 4 && Math.abs(y - end.y) < grid));
      memo[key] = hit ? 1 : 0;
      return hit;
    };
    const states = width * height * 4;
    const cost = new Float32Array(states).fill(Infinity), previous = new Int32Array(states).fill(-1);
    const heap = new Heap();
    const startState = (startCell.y * width + startCell.x) * 4;
    cost[startState] = 0;
    heap.push(0, startState);
    let found = -1;
    for (let steps = 0; heap.size && steps < 160_000; steps++) {
      const popped = heap.pop();
      if (!popped) break;
      const state = popped[1], direction = state & 3, cellIndex = state >> 2;
      const cx = cellIndex % width, cy = Math.floor(cellIndex / width);
      if (cx === goal.x && cy === goal.y) { found = state; break; }
      for (let turn = 0; turn < 4; turn++) {
        if (turn === ((direction + 2) & 3)) continue;
        const step = normals[directions[turn] as Side];
        const nx = cx + step.x, ny = cy + step.y;
        const isGoal = nx === goal.x && ny === goal.y;
        if (!isGoal && blocked(nx, ny)) continue;
        const wx = originX + cx * grid, wy = originY + cy * grid;
        if (step.x === 0 && alongVertical(wx, wy)) continue;
        if (step.y === 0 && alongHorizontal(wx, wy)) continue;
        const next = (ny * width + nx) * 4 + turn;
        const total = (cost[state] ?? Infinity) + 1 + (turn === direction ? 0 : 5);
        if (total < (cost[next] ?? Infinity)) {
          cost[next] = total; previous[next] = state;
          heap.push(total + Math.abs(nx - goal.x) + Math.abs(ny - goal.y), next);
        }
      }
    }
    const cells: Point[] = [];
    if (found >= 0) for (let state = found; state >= 0; state = previous[state] ?? -1) {
      const cellIndex = state >> 2;
      cells.unshift({ x: originX + (cellIndex % width) * grid, y: originY + Math.floor(cellIndex / width) * grid });
    }
    const around = cells.length ? cells : [{ x: start.x + grid * 3, y: start.y }, { x: start.x + grid * 3, y: end.y }, { x: end.x - grid * 3, y: end.y }];
    // The search works on the grid; the first and last runs are pinned back onto the exact middles so they leave and enter flush.
    const points: Point[] = [start, ...around.map((point, index) => index === 0 ? { x: point.x, y: start.y } : index === around.length - 1 ? { x: point.x, y: end.y } : point), end];
    // Pinning can leave a short diagonal; split it into a horizontal-first corner (vertical-first on the final approach).
    const square: Point[] = [];
    points.forEach((point, index) => {
      const before = square.at(-1);
      if (before && before.x !== point.x && before.y !== point.y) square.push(index === points.length - 1 ? { x: before.x, y: point.y } : { x: point.x, y: before.y });
      square.push(point);
    });
    const corners = square.filter((point, index) => {
      const before = square[index - 1], after = square[index + 1];
      if (!before || !after) return true;
      return !(before.x === point.x && point.x === after.x || before.y === point.y && point.y === after.y);
    });
    return [{ source: edge.source, target: edge.target, points: corners, entry: "W" as const }];
  });
}

export interface RasterCell { x: number; y: number; glyph: string; tone: "out" | "in" | "dim" | "added" | "lost" | "path"; t: number }

const N = 1, E = 2, S = 4, W = 8;
const solid: Record<number, string> = { [E | W]: "─", [N | S]: "│", [S | E]: "╭", [S | W]: "╮", [N | E]: "╰", [N | W]: "╯",
  [N | S | E]: "├", [N | S | W]: "┤", [E | W | S]: "┬", [E | W | N]: "┴", [N | S | E | W]: "┼", [E]: "─", [W]: "─", [N]: "│", [S]: "│" };
const arrows: Record<Side, string> = { E: "▶", W: "◀", S: "▼", N: "▲" };

/**
 * Projected routes as terminal cells. Quiet connectors are dotted where they run straight; the selected node's are
 * solid and tinted by direction. `covered` hides cells under nodes; `t` is the position along the route (0..1).
 * `marks` (keyed `source\0target`) picks out connectors whose imports were added or lost since a base commit: solid, in their own tints, under the selection's.
 */
export function rasterize(routes: readonly Route[], project: (point: Point) => Point, covered: (x: number, y: number) => boolean, selected: string | undefined, marks: ReadonlyMap<string, "added" | "lost" | "path"> = new Map()): RasterCell[] {
  const cells = new Map<string, { x: number; y: number; mask: number; tone: RasterCell["tone"]; t: number; arrow?: string }>();
  const toneOf = (route: Route): RasterCell["tone"] => route.source === selected ? "out" : route.target === selected ? "in" : marks.get(`${route.source}\0${route.target}`) ?? "dim";
  const rank = (tone: RasterCell["tone"]) => tone === "dim" ? 0 : tone === "added" || tone === "lost" || tone === "path" ? 1 : 2;
  const ordered = [...routes].sort((a, b) => rank(toneOf(a)) - rank(toneOf(b)));
  for (const route of ordered) {
    const tone = toneOf(route);
    const points = route.points.map(project).map(point => ({ x: Math.round(point.x), y: Math.round(point.y) }));
    let length = 0;
    for (let index = 1; index < points.length; index++) length += Math.abs((points[index]?.x ?? 0) - (points[index - 1]?.x ?? 0)) + Math.abs((points[index]?.y ?? 0) - (points[index - 1]?.y ?? 0));
    let walked = 0;
    const touch = (x: number, y: number, bit: number, at: number) => {
      if (covered(x, y)) return;
      const key = `${x},${y}`, cell = cells.get(key) ?? { x, y, mask: 0, tone, t: at };
      cell.mask |= bit; cell.t = Math.min(cell.t, at);
      if (rank(tone) >= rank(cell.tone)) cell.tone = tone;
      cells.set(key, cell);
    };
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      if (!a || !b) continue;
      let x = a.x, y = a.y;
      const stepX = Math.sign(b.x - a.x), stepY = Math.sign(b.y - a.y);
      // Rounding can leave a one-cell diagonal; take it as a horizontal step then a vertical one.
      const moves: [number, number][] = [];
      for (let cx = a.x; cx !== b.x; cx += stepX) moves.push([stepX, 0]);
      for (let cy = a.y; cy !== b.y; cy += stepY) moves.push([0, stepY]);
      for (const [dx, dy] of moves) {
        const forward = dx > 0 ? E : dx < 0 ? W : dy > 0 ? S : N, back = forward === E ? W : forward === W ? E : forward === S ? N : S;
        touch(x, y, forward, length ? walked / length : 0);
        x += dx; y += dy; walked++;
        touch(x, y, back, length ? walked / length : 1);
      }
    }
    const end = points.at(-1), before = points.at(-2);
    if (end && before) {
      const dx = Math.sign(end.x - before.x), dy = Math.sign(end.y - before.y);
      const side: Side = dx > 0 ? "E" : dx < 0 ? "W" : dy > 0 ? "S" : "N";
      // The arrow sits on the cell next to the node: the end cell itself when it is outside the card, else the one before it.
      const inside = covered(end.x, end.y);
      const x = inside ? end.x - dx : end.x, y = inside ? end.y - dy : end.y;
      if (!covered(x, y)) { const key = `${x},${y}`, cell = cells.get(key) ?? { x, y, mask: 0, tone, t: 1 }; cell.arrow = arrows[side]; cell.tone = tone; cell.t = 1; cells.set(key, cell); }
    }
  }
  return [...cells.values()].map(cell => {
    const straight = cell.mask === (E | W) ? "┈" : cell.mask === (N | S) ? "┊" : undefined;
    return { x: cell.x, y: cell.y, tone: cell.tone, t: cell.t, glyph: cell.arrow ?? ((cell.tone === "dim" || cell.tone === "lost") && straight ? straight : solid[cell.mask] ?? "·") };
  });
}
