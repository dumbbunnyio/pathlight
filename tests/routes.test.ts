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
