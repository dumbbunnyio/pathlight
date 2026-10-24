import { expect, test } from "bun:test";
import { badgeText, badgesOf, flowsInView, flowsThrough, pathEdges, stepsAt, type FlowMap } from "../src/flow-view";

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
