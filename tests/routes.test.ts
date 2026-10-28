import { expect, test } from "bun:test";
import { rasterize, routeEdges, type RouteNode } from "../src/routes";

const node = (id: string, x: number, y: number, width = 160, height = 64): RouteNode => ({ id, x, y, width, height, children: [] });
const straight = (points: { x: number; y: number }[]) => points.every((point, index) => index === 0 || point.x === points[index - 1]?.x || point.y === points[index - 1]?.y);

test("routes are made only of horizontal and vertical runs, and leave and enter on the facing sides", () => {
  const nodes = [node("a", 0, 100), node("b", 320, 220), node("c", 640, 100)];
  const routes = routeEdges(nodes, [
    { source: "a", target: "b", points: [[160, 132], [240, 132], [240, 252], [320, 252]] },
    { source: "b", target: "c", points: [[480, 252], [560, 252], [560, 132], [640, 132]] },
  ]);
  expect(routes).toHaveLength(2);
  for (const route of routes) {
    expect(straight(route.points)).toBe(true);
    expect(route.points.length).toBeGreaterThanOrEqual(2);
    expect(route.entry).toBe("W");
  }
  expect(routes[0]?.points[0]).toMatchObject({ x: 160 });
});

test("a route goes around a node that sits in the way instead of through it", () => {
  const nodes = [node("a", 0, 100), node("wall", 280, 60, 120, 140), node("b", 600, 100)];
  const [route] = routeEdges(nodes, [{ source: "a", target: "b", points: [[160, 132], [380, 132], [600, 132]] }]);
  expect(route).toBeDefined();
  const wall = nodes[1]!;
  const inside = (x: number, y: number) => x > wall.x && x < wall.x + wall.width && y > wall.y && y < wall.y + wall.height;
  const points = route?.points ?? [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!;
    for (let step = 0; step <= 20; step++) expect(inside(a.x + (b.x - a.x) * step / 20, a.y + (b.y - a.y) * step / 20)).toBe(false);
  }
});

test("edges leave the middle of the source's right side and enter the middle of the target's left side, with the vertical in the middle of the gap", () => {
  const nodes = [node("a", 0, 100), node("b", 400, 300)];
  const [route] = routeEdges(nodes, [{ source: "a", target: "b", points: [[160, 132], [400, 332]] }]);
  // The gap is columns 10–24 (x 160–399); the trunk takes its middle column, 17.
  expect(route?.points).toEqual([{ x: 160, y: 132 }, { x: 272, y: 132 }, { x: 272, y: 332 }, { x: 400, y: 332 }]);
  // Two edges from one source share its exit point and trunk, then split.
  const split = routeEdges([node("a", 0, 200), node("b", 400, 40), node("c", 400, 360)], [
    { source: "a", target: "b", points: [[160, 232], [400, 72]] }, { source: "a", target: "c", points: [[160, 232], [400, 392]] }]);
  expect(split.map(item => item.points[0])).toEqual([{ x: 160, y: 232 }, { x: 160, y: 232 }]);
  expect(split.map(item => item.points[1]?.x)).toEqual([272, 272]);
});

test("a detour around a node in the way is still only horizontal and vertical, and still ends flush on the target's left middle", () => {
  const nodes = [node("a", 0, 100), node("wall", 220, 60, 160, 400), node("b", 560, 300)];
  const [route] = routeEdges(nodes, [{ source: "a", target: "b", points: [[160, 132], [560, 332]] }]);
  const points = route?.points ?? [];
  expect(straight(points)).toBe(true);
  expect(points[0]).toEqual({ x: 160, y: 132 });
  expect(points.at(-1)).toEqual({ x: 560, y: 332 });
  expect(points.at(-2)?.y).toBe(332);
});

test("a backward edge still leaves east and arrives from the west", () => {
  const nodes = [node("a", 400, 100), node("b", 0, 100)];
  const [route] = routeEdges(nodes, [{ source: "a", target: "b", points: [[400, 132], [160, 132]] }]);
  const points = route?.points ?? [];
  expect(straight(points)).toBe(true);
  expect(points[0]).toEqual({ x: 560, y: 132 });
  expect(points.at(-1)).toEqual({ x: 0, y: 132 });
});

test("rasterizing draws rounded bends, dotted quiet runs, solid selected runs, and an arrowhead outside the target", () => {
  const route = { source: "a", target: "b", entry: "W" as const, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 8, y: 3 }] };
  const project = (point: { x: number; y: number }) => ({ x: point.x, y: point.y });
  const target = (x: number, y: number) => x >= 8 && y === 3; // the target card starts at column 8
  const quiet = rasterize([route], project, target, undefined);
  const glyphAt = (cells: typeof quiet, x: number, y: number) => cells.find(cell => cell.x === x && cell.y === y)?.glyph;
  expect(glyphAt(quiet, 2, 0)).toBe("┈");
  expect(glyphAt(quiet, 4, 0)).toBe("╮");
  expect(glyphAt(quiet, 4, 1)).toBe("┊");
  expect(glyphAt(quiet, 4, 3)).toBe("╰");
  expect(glyphAt(quiet, 7, 3)).toBe("▶");
  const picked = rasterize([route], project, target, "a");
  expect(glyphAt(picked, 2, 0)).toBe("─");
  expect(picked.find(cell => cell.x === 2 && cell.y === 0)?.tone).toBe("out");
  expect(rasterize([route], project, target, "b").find(cell => cell.x === 2 && cell.y === 0)?.tone).toBe("in");
  // Cells under a node are left to the node.
  expect(glyphAt(rasterize([route], project, (x, y) => x >= 6 && y === 3, undefined), 7, 3)).toBeUndefined();
});

test("two connectors that share a run merge into a junction", () => {
  const a = { source: "a", target: "c", entry: "W" as const, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 8, y: 4 }] };
  const b = { source: "b", target: "d", entry: "W" as const, points: [{ x: 0, y: 8 }, { x: 4, y: 8 }, { x: 4, y: 0 }, { x: 8, y: 0 }] };
  const cells = rasterize([a, b], point => point, () => false, undefined);
  expect(cells.find(cell => cell.x === 4 && cell.y === 0)?.glyph).toBe("┬");
  expect(cells.find(cell => cell.x === 4 && cell.y === 4)?.glyph).toBe("├");
});

test("connectors marked added or lost keep their own tints, and the selection still wins", () => {
  const route = { source: "a", target: "b", entry: "W" as const, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 8, y: 3 }] };
  const project = (point: { x: number; y: number }) => point;
  const target = (x: number, y: number) => x >= 8 && y === 3;
  const toneAt = (cells: ReturnType<typeof rasterize>, x: number, y: number) => cells.find(cell => cell.x === x && cell.y === y);
  const added = rasterize([route], project, target, undefined, new Map([["a\0b", "added" as const]]));
  expect(toneAt(added, 2, 0)).toMatchObject({ tone: "added", glyph: "─" });
  const lost = rasterize([route], project, target, undefined, new Map([["a\0b", "lost" as const]]));
  expect(toneAt(lost, 2, 0)).toMatchObject({ tone: "lost", glyph: "┈" });
  expect(toneAt(rasterize([route], project, target, "a", new Map([["a\0b", "added" as const]])), 2, 0)?.tone).toBe("out");
  // An unmarked connector crossing a marked one does not repaint it.
  const other = { source: "c", target: "d", entry: "W" as const, points: [{ x: 4, y: -2 }, { x: 4, y: 2 }] };
  expect(toneAt(rasterize([route, other], project, target, undefined, new Map([["a\0b", "added" as const]])), 4, 0)?.tone).toBe("added");
});

// Clearance is counted in terminal cells at 100%: a column is 16 units, a row 32.
const card = (id: string, column: number, row: number, columns = 20, rows = 4): RouteNode => ({ id, x: column * 16, y: row * 32, width: columns * 16, height: rows * 32, children: [] });
const cellsOf = (points: { x: number; y: number }[]) => {
  const cells: { column: number; row: number }[] = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!;
    const steps = Math.max(Math.abs(b.x - a.x) / 16, Math.abs(b.y - a.y) / 32);
    for (let step = 0; step <= steps; step++) cells.push({ column: Math.round((a.x + (b.x - a.x) * step / steps) / 16), row: Math.round((a.y + (b.y - a.y) * step / steps) / 32) });
  }
  return cells;
};
const clearOf = (cells: { column: number; row: number }[], node: RouteNode) => {
  const left = node.x / 16, right = (node.x + node.width) / 16 - 1, top = node.y / 32, bottom = (node.y + node.height) / 32 - 1;
  return cells.every(cell => cell.column < left - 1 || cell.column > right + 1 || cell.row < top - 1 || cell.row > bottom + 1);
};

test("a straight route that would graze a third card detours to keep a clear cell from it", () => {
  // `wall` sits just under the straight line from a to b: its top border is one row below the run, so the run would touch its clear row.
  const a = card("a", 0, 10), b = card("b", 60, 10), wall = card("wall", 30, 13, 20, 4);
  const [route] = routeEdges([a, b, wall], [{ source: "a", target: "b", points: [] }]);
  const points = route?.points ?? [];
  expect(straight(points)).toBe(true);
  expect(points.length).toBeGreaterThan(2);
  expect(clearOf(cellsOf(points), wall)).toBe(true);
  expect(points[0]).toEqual({ x: 20 * 16, y: 12 * 32 });
  expect(points.at(-1)).toEqual({ x: 60 * 16, y: 12 * 32 });
});

test("two edges from one card into a column still share a trunk, a clear column from both sides", () => {
  const a = card("a", 0, 10), b = card("b", 26, 4), c = card("c", 26, 16);
  const routes = routeEdges([a, b, c], [{ source: "a", target: "b", points: [] }, { source: "a", target: "c", points: [] }]);
  const trunks = routes.map(route => route.points[1]?.x);
  expect(trunks[0]).toBe(trunks[1]);
  const column = trunks[0]! / 16;
  expect(column).toBeGreaterThanOrEqual(20 + 1);
  expect(column).toBeLessThanOrEqual(26 - 2);
  for (const route of routes) for (const other of [b, c].filter(node => node.id !== route.target)) expect(clearOf(cellsOf(route.points), other)).toBe(true);
});
