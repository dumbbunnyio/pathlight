import { expect, test } from "bun:test";
import { Effect } from "effect";
import { acquireModel } from "../src/catalog";
import { type CompactNode, cardSize, compact, gapColumns, gapRows } from "../src/viewer/compact";
import { wrapWords } from "../src/viewer/text";

/**
 * Compact fit keeps LikeC4's arrangement and makes the spacing and card sizes Pathlight's. These are its five promises, checked over the frozen
 * fixture's views, the nested example and hand-made layouts.
 */
const aspect = 0.5, column = 16, row = 16 / aspect;
const options = { aspect, kindRow: true };

const scenes = async (workspace: string) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const source = yield* acquireModel(workspace);
  const model = yield* Effect.promise(() => source.layoutedModel());
  return [...model.views()].map(view => ({ id: String(view.id), nodes: view.$view.nodes.map(node => ({ id: String(node.id), parent: node.parent ? String(node.parent) : null,
    children: node.children.map(String), x: node.x, y: node.y, width: node.width, height: node.height, title: node.title, kind: String(node.kind) })) }));
})));

const leaf = (id: string, x: number, y: number, width = 320, height = 180, title = id, parent: string | null = null): CompactNode => ({ id, parent, children: [], x, y, width, height, title });
const group = (id: string, children: string[], parent: string | null = null): CompactNode => ({ id, parent, children, x: 0, y: 0, width: 0, height: 0, title: id });

const hand: { name: string; nodes: CompactNode[] }[] = [
  { name: "two cards sharing a rank", nodes: [leaf("a", 0, 0), leaf("b", 0, 400), leaf("c", 800, 200)] },
  { name: "a card wider than its minimum", nodes: [leaf("a", 0, 0, 600), leaf("b", 1200, 0)] },
  { name: "a group with one child", nodes: [group("g", ["g.a"]), leaf("g.a", 100, 100, 320, 180, "Alone", "g"), leaf("b", 900, 100)] },
  { name: "nested groups", nodes: [group("outer", ["outer.inner", "outer.c"]), group("outer.inner", ["outer.inner.a", "outer.inner.b"], "outer"),
    leaf("outer.inner.a", 100, 100, 320, 180, "a", "outer.inner"), leaf("outer.inner.b", 100, 500, 320, 180, "b", "outer.inner"), leaf("outer.c", 900, 300, 320, 180, "c", "outer"), leaf("d", 1800, 300)] },
  { name: "a long card overlapping two in a row", nodes: [leaf("long", 0, 0, 1000), leaf("x", 100, 400, 200), leaf("y", 500, 400, 200), leaf("z", 1600, 0)] },
  { name: "server_near: a pair beside a pair it straddles", nodes: [leaf("integrations", 0, 95, 410, 180, "Optional integrations"), leaf("server", 500, 95, 360, 180, "Backend API and services"),
    leaf("app", 1000, 0, 320, 180, "Web client"), leaf("shared", 1000, 230, 320, 180, "Code shared by client and server")] },
  { name: "a long title", nodes: [leaf("a", 0, 0, 320, 180, "A component with a rather long descriptive title that wraps"), leaf("b", 2000, 3000, 320, 180, "Short")] },
  { name: "one long title among three short ones", nodes: [leaf("a", 0, 0, 320, 180, "Collaboration server and websocket gateway"), leaf("b", 600, 0, 320, 180, "Web"),
    leaf("c", 1200, 0, 320, 180, "Store"), leaf("d", 1800, 0, 320, 180, "Jobs")] },
];

const all = async () => [...hand, ...(await scenes("tests/fixtures/viewer")).map(view => ({ name: `fixture ${view.id}`, nodes: view.nodes })),
  ...(await scenes("examples/parcel")).map(view => ({ name: `parcel ${view.id}`, nodes: view.nodes }))];

const leaves = (nodes: readonly CompactNode[]) => nodes.filter(node => !node.children.length);
const axes = [{ start: "x", extent: "width" }, { start: "y", extent: "height" }] as const;

test("order is kept on both axes: before stays before, overlap stays overlap, a shared left or top edge stays shared", async () => {
  for (const { name, nodes } of await all()) {
    const out = new Map(compact(nodes, options).map(node => [node.id, node]));
    for (const a of leaves(nodes)) for (const b of leaves(nodes)) {
      if (a === b) continue;
      const A = out.get(a.id)!, B = out.get(b.id)!;
      for (const { start, extent } of axes) {
        const was = a[start] + a[extent] <= b[start], overlapped = a[start] < b[start] + b[extent] && b[start] < a[start] + a[extent];
        if (was) expect(A[start] + A[extent] <= B[start], `${name}: ${a.id} before ${b.id} on ${start}`).toBe(true);
        if (overlapped) expect(A[start] < B[start] + B[extent] && B[start] < A[start] + A[extent], `${name}: ${a.id} overlaps ${b.id} on ${start}`).toBe(true);
        if (a[start] === b[start]) expect(A[start], `${name}: ${a.id} shares ${start} with ${b.id}`).toBe(B[start]);
      }
    }
  }
});

test("containment is kept: a group is the box around its children with a frame and a clear cell, and nested groups nest", async () => {
  for (const { name, nodes } of await all()) {
    const out = new Map(compact(nodes, options).map(node => [node.id, node]));
    for (const node of nodes.filter(entry => entry.children.length)) {
      const box = out.get(node.id)!, inside = node.children.map(id => out.get(id)!).filter(Boolean);
      expect(inside.length, name).toBeGreaterThan(0);
      expect(box.x, `${name}: ${node.id} left`).toBe(Math.min(...inside.map(child => child.x)) - 2 * column);
      expect(box.y, `${name}: ${node.id} top`).toBe(Math.min(...inside.map(child => child.y)) - 2 * row);
      expect(box.x + box.width, `${name}: ${node.id} right`).toBe(Math.max(...inside.map(child => child.x + child.width)) + 2 * column);
      expect(box.y + box.height, `${name}: ${node.id} bottom`).toBe(Math.max(...inside.map(child => child.y + child.height)) + 2 * row);
    }
  }
});

test("every leaf card is readable and all cards in a view share one size: the widest title decides the width, the most lines at it the height", async () => {
  for (const { name, nodes } of await all()) {
    const out = new Map(compact(nodes, options).map(node => [node.id, node]));
    const cards = leaves(nodes);
    const width = Math.max(...cards.map(card => cardSize(card.title, 20).width));
    const lines = Math.max(...cards.map(card => Math.min(2, wrapWords(card.title, width - 4).length)));
    expect(width, name).toBeLessThanOrEqual(32);
    for (const card of cards) {
      const shaped = out.get(card.id)!, columns = shaped.width / column, rows = shaped.height / row;
      const longest = Math.max(...card.title.split(/\s+/).map(word => word.length));
      expect(columns, `${name}: ${card.id} width`).toBeGreaterThanOrEqual(Math.min(longest, 24) + 4);
      expect(columns, `${name}: ${card.id} width`).toBeGreaterThanOrEqual(20);
      // One size, except a card that grew to keep overlapping a later-starting card on that axis (the order invariant needs it).
      const grew = (start: "x" | "y", extent: "width" | "height") => cards.some(other => other !== card && card[start] < other[start] && other[start] < card[start] + card[extent]);
      if (grew("x", "width")) expect(columns, `${name}: ${card.id} width`).toBeGreaterThanOrEqual(width); else expect(columns, `${name}: ${card.id} width`).toBe(width);
      if (grew("y", "height")) expect(rows, `${name}: ${card.id} rows`).toBeGreaterThanOrEqual(3 + lines); else expect(rows, `${name}: ${card.id} rows`).toBe(3 + lines);
    }
    // Without a kind row a card is one row shorter.
    const bare = new Map(compact(nodes, { aspect, kindRow: false }).map(node => [node.id, node]));
    for (const card of cards) expect(bare.get(card.id)!.height, `${name}: ${card.id}`).toBe(out.get(card.id)!.height - row);
  }
  // One long title sets the width for three short ones, and its two lines the height of all four.
  const shaped = compact(hand.find(scene => scene.name === "one long title among three short ones")!.nodes, options);
  expect(new Set(shaped.map(card => card.width / column))).toEqual(new Set([cardSize("Collaboration server and websocket gateway", 20).width]));
  expect(new Set(shaped.map(card => card.height / row))).toEqual(new Set([5]));
});

test("a card that straddles two later ones shifts to keep the overlap before it grows: server_near's four cards are one size", () => {
  const nodes = hand.find(scene => scene.name.startsWith("server_near"))!.nodes;
  for (const kindRow of [true, false]) {
    const out = new Map(compact(nodes, { aspect, kindRow }).map(node => [node.id, node]));
    const rows = (id: string) => out.get(id)!.height / row, top = (id: string) => out.get(id)!.y / row;
    expect(new Set(["integrations", "server", "app", "shared"].map(rows))).toEqual(new Set([kindRow ? 5 : 4]));
    // The left pair sits between the right pair, overlapping both, and the two of them still share a top edge.
    expect(top("integrations")).toBe(top("server"));
    expect(top("integrations")).toBeGreaterThan(top("app"));
    expect(top("integrations")).toBeLessThan(top("app") + rows("app"));
    expect(top("integrations") + rows("integrations")).toBeGreaterThan(top("shared"));
  }
  // The long card overlapping two in a row cannot shift its way to both, so it still grows.
  const long = compact(hand.find(scene => scene.name === "a long card overlapping two in a row")!.nodes, options);
  expect(long.find(node => node.id === "long")!.width).toBeGreaterThan(long.find(node => node.id === "z")!.width);
});

test("a title takes one line when that costs at most two columns more than two", () => {
  expect(cardSize("Persistent viewer", 20)).toEqual({ width: 21, lines: 1 });
  expect(cardSize("Agent browser extension", 20)).toEqual({ width: 20, lines: 2 });
});

test("gaps are small and sufficient: neighbouring cards are 6 columns or 2 rows apart, more only where group frames stand between them", async () => {
  for (const { name, nodes } of await all()) {
    const shaped = compact(nodes, options), out = new Map(shaped.map(node => [node.id, node]));
    for (const a of leaves(nodes)) for (const b of leaves(nodes)) {
      if (a === b) continue;
      const A = out.get(a.id)!, B = out.get(b.id)!;
      if (a.x + a.width <= b.x) expect(B.x - (A.x + A.width), `${name}: ${a.id} → ${b.id}`).toBeGreaterThanOrEqual(gapColumns * column);
      if (a.y + a.height <= b.y) expect(B.y - (A.y + A.height), `${name}: ${a.id} ↓ ${b.id}`).toBeGreaterThanOrEqual(gapRows * row);
    }
    // Empty bands are compressed: between the cards, no stretch of an axis that no card crosses is wider than the gap (plus the frames of the
    // deepest nesting, which may stand between two cards).
    const depth = (node: CompactNode): number => node.parent ? 1 + depth(nodes.find(entry => entry.id === node.parent)!) : 0;
    const deepest = Math.max(0, ...leaves(nodes).map(depth));
    for (const { start, extent } of axes) {
      const unit = start === "x" ? column : row, allowed = Math.max(start === "x" ? gapColumns : gapRows, 4 * deepest + 1) * unit;
      const spans = leaves(nodes).map(node => out.get(node.id)!).map(node => [node[start], node[start] + node[extent]] as const).sort((p, q) => p[0] - q[0]);
      let reach = spans[0]![1];
      for (const [from, to] of spans.slice(1)) { expect(from - reach, `${name}: empty band on ${start}`).toBeLessThanOrEqual(allowed); reach = Math.max(reach, to); }
    }
  }
  // A layout LikeC4 spread out across a browser comes back close together.
  const spread = compact([leaf("a", 0, 0), leaf("b", 4000, 0), leaf("c", 8000, 0)], options);
  expect(spread[2]!.x - spread[0]!.x).toBeLessThan(2 * (32 + gapColumns) * column + 1);
});

test("compact fit is deterministic and idempotent", async () => {
  for (const { name, nodes } of await all()) {
    const once = compact(nodes, options);
    expect(compact(nodes, options), name).toEqual(once);
    expect(compact(once, options), name).toEqual(once);
  }
});
