import { expect, test } from "bun:test";
import { badgeText, badgesOf, flowsInView, flowsThrough, gapHops, pathEdges, stepsAt, type FlowMap } from "../src/flow-view";
import { RGBA } from "@opentui/core";
import { stepsCard } from "../src/viewer/cards";
import { palette } from "../src/ui";
import { createFlowMode } from "../src/viewer/flow-mode";

const journey: FlowMap = { id: "order", title: "Placing an order", type: "journey", view: "order", sync: { status: "current", sha: "abc1234" }, findings: [], steps: [
  { n: 1, title: "opens checkout", elements: ["customer", "store"], from: "customer", to: "store", backed: true },
  { n: 2, title: "submits", elements: ["store", "api"], from: "store", to: "api", backed: true },
  { n: 3, title: "back again", elements: ["api", "store"], from: "api", to: "store", backed: true },
] };
const states: FlowMap = { id: "signup", title: "Signing up", type: "behavior", view: "signup", sync: { status: "none" }, findings: [], steps: [
  { n: 1, title: "page", elements: ["store"], backed: null }, { n: 2, title: "saved", elements: ["api", "db"], backed: null },
] };
const nodes = [{ id: "n-customer", modelRef: "customer" }, { id: "n-store", modelRef: "store" }, { id: "n-api", modelRef: "api" }, { id: "n-db", modelRef: "db" }];

test("a journey numbers the node each step arrives at, marks the start, and a node several steps reach carries them all", () => {
  expect(badgesOf(journey, nodes)).toEqual(new Map([["n-customer", [0]], ["n-store", [1, 3]], ["n-api", [2]]]));
  expect(badgeText([0, 3])).toBe(" ▶·3 ");
  expect(badgeText([2])).toBe(" 2 ");
});

test("a state diagram numbers every component a state's files belong to, and draws no hops", () => {
  expect(badgesOf(states, nodes)).toEqual(new Map([["n-store", [1]], ["n-api", [2]], ["n-db", [2]]]));
  expect(pathEdges(states, nodes, [{ source: "n-store", target: "n-api" }])).toEqual(new Set());
});

test("only connectors that run between the components of a step are on the path, in the direction of the step", () => {
  const edges = [{ source: "n-customer", target: "n-store" }, { source: "n-store", target: "n-api" }, { source: "n-api", target: "n-db" }, { source: "n-api", target: "n-store" }, { source: "n-db", target: "n-api" }];
  expect(pathEdges(journey, nodes, edges)).toEqual(new Set(["n-customer\0n-store", "n-store\0n-api", "n-api\0n-store"]));
});

test("a component is in a flow only by its own steps, never because something inside it is", () => {
  expect(stepsAt(journey, "store")).toEqual([1, 2, 3]);
  expect(stepsAt(journey, "parent")).toEqual([]);
  expect(flowsThrough([journey, states], "store").map(entry => [entry.flow.id, entry.steps])).toEqual([["order", [1, 2, 3]], ["signup", [1]]]);
  expect(flowsThrough([journey, states], "db").map(entry => entry.flow.id)).toEqual(["signup"]);
  expect(flowsInView([journey, states], new Set(["db"])).map(flow => flow.id)).toEqual(["signup"]);
  expect(flowsInView([journey, states], new Set(["elsewhere"]))).toEqual([]);
});

test("the start card and the first number agree with the step reader: ▶ on the box step 1 leaves, 1 on the box it reaches", () => {
  const badges = badgesOf(journey, nodes);
  expect(badges.get("n-customer")).toEqual([0]);
  expect(badges.get("n-store")).toEqual([1, 3]);
});

const textOf = (card: { chunks: { text: string }[] }) => card.chunks.map(chunk => chunk.text).join("");

test("the Steps card shows every journey hop under its sentence, from → to behind a bar in the journey colour, wrapped and never clipped", () => {
  // Mealie's code generation: every step leaves the generators, and each row says so.
  const fan: FlowMap = { ...journey, id: "codegen", title: "Code generation", steps: ["schema", "lib", "root", "lang", "composables"].map((to, index) =>
    ({ n: index + 1, title: `writes ${to}`, elements: ["dev", to], from: "dev", to, backed: true })) };
  const titles: Record<string, string> = { dev: "Code generation tools", schema: "Data shapes for API and schema checks", lib: "API client", root: "Backend entry", lang: "Locales", composables: "Composables",
    customer: "Customer", store: "Storefront", api: "Checkout API" };
  const card = stepsCard(fan, 0, new Map(), id => titles[id] ?? id, 40, 0, RGBA.fromHex("#000000"));
  const lines = textOf(card).split("\n");
  // Each hop starts on the line after its sentence, with the bar.
  for (const [index, to] of ["schema", "lib", "root", "lang", "composables"].entries()) {
    const at = lines.findIndex(line => line.includes(`writes ${to}`));
    expect(lines[at + 1]).toMatch(/^ {5}▎ Code generation tools → /);
    expect(card.starts[index]).toBe(at);
  }
  // A long hop wraps inside the bar: every word is there and every line keeps the bar.
  const first = lines.findIndex(line => line.includes("writes schema"));
  const block = lines.slice(first + 1).filter((_, index, all) => all.slice(0, index + 1).every(line => line.startsWith("     ▎ ")));
  expect(block.length).toBeGreaterThan(1);
  expect(block.map(line => line.slice(7).trim()).join(" ")).toBe("Code generation tools → Data shapes for API and schema checks");
  expect(lines.filter(line => line.includes("▎")).join("")).not.toContain("…");
  // The bar is drawn in the journey colour, the titles in the muted tone.
  const bar = card.chunks.find(chunk => chunk.text === "▎ ") as { fg?: RGBA } | undefined;
  expect(bar?.fg).toEqual(RGBA.fromHex(palette.purple));
  // A chain names its source on every step too, not only where it jumps.
  const chain = textOf(stepsCard(journey, 0, new Map(), id => titles[id] ?? id, 60, 0, RGBA.fromHex("#000000")));
  for (const hop of ["Customer → Storefront", "Storefront → Checkout API", "Checkout API → Storefront"]) expect(chain).toContain(`▎ ${hop}`);
});

test("a state diagram's steps are unchanged: the components share the sentence's row, with no bar", () => {
  const text = textOf(stepsCard(states, 0, new Map(), id => id, 60, 0, RGBA.fromHex("#000000")));
  expect(text).not.toContain("▎");
  expect(text).toMatch(/1 page +store/);
  expect(text).toMatch(/2 saved +api \+1/);
});

test("a hop between nested components lands on the nearest card the view draws; a hop inside one card is its badge only", () => {
  // The view draws two packages; the flow's hops are between components inside them.
  const nested: FlowMap = { ...journey, steps: [
    { n: 1, title: "inside the front", elements: ["front.app", "front.server"], from: "front.app", to: "front.server", backed: true },
    { n: 2, title: "to the back", elements: ["front.server", "back.api"], from: "front.server", to: "back.api", backed: true },
    { n: 3, title: "and back", elements: ["back.api", "front.app"], from: "back.api", to: "front.app", backed: false },
  ] };
  const packages = [{ id: "n-front", modelRef: "front" }, { id: "n-back", modelRef: "back" }];
  expect(flowsInView([nested], new Set(["front", "back"]))).toEqual([nested]);
  expect(badgesOf(nested, packages)).toEqual(new Map([["n-front", [0, 1, 3]], ["n-back", [2]]]));
  const edges = [{ source: "n-front", target: "n-back" }];
  expect(pathEdges(nested, packages, edges)).toEqual(new Set(["n-front\0n-back"]));
  // The hop back has no connector: it is a gap, drawn once; the hop inside the front package is no hop at all.
  expect(gapHops(nested, packages, edges)).toEqual([{ source: "n-back", target: "n-front" }]);
  // The element's own card wins over a box that contains it.
  expect(badgesOf(nested, [...packages, { id: "n-api", modelRef: "back.api" }]).get("n-api")).toEqual([2]);
});

test("after a drawing is asked for, the first new journey is what F opens, whatever the selection, and the toast names it; then F cycles as before", () => {
  const said: string[] = [], selected: string[] = [];
  const drawn: FlowMap = { ...journey, id: "pay", title: "Paying for an order", view: null, steps: [{ n: 1, title: "charges", elements: ["api", "db"], from: "api", to: "db", backed: true }] };
  const mode = createFlowMode<string>({ view: () => ({ id: "v", nodes }), selected: () => "customer", nodeFor: element => element, select: node => { selected.push(node); },
    title: element => element, say: message => { if (message) said.push(message); }, update: () => {}, entering: () => {}, leaving: () => {} });
  mode.load([journey, states]);
  // A journey appearing with nothing asked for is just another flow.
  mode.load([journey, states, { ...drawn, id: "other" }]);
  expect(said).toEqual([]);
  mode.expect();
  mode.load([journey, states, { ...drawn, id: "other" }]);
  expect(mode.drawn).toBeUndefined();
  mode.load([journey, states, { ...drawn, id: "other" }, drawn]);
  expect(said).toEqual(["Drawn: Paying for an order · F walks it"]);
  // The selection (customer) is on Placing an order's path, not this one's: F still opens the drawn journey, once.
  mode.cycle();
  expect(mode.active?.id).toBe("pay");
  expect(selected).toEqual(["db"]);
  mode.exit(); mode.cycle();
  expect(mode.active?.id).toBe("order");
});
