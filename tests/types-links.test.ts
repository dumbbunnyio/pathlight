import { expect, test } from "bun:test";
import { typesLinks } from "../src/viewer/cards";

// A view of `app` with three cards; `app.api` and `app.view` share only types with `app.store`, and `lib` (drawn as its package) with `app.view`.
const nodes = [{ id: "api", modelRef: "app.api" }, { id: "store", modelRef: "app.store" }, { id: "view", modelRef: "app.view" }, { id: "lib", modelRef: "lib" }];
const pairs = [{ source: "app.api", target: "app.store" }, { source: "app.view", target: "app.store" }, { source: "lib.util", target: "app.view" }, { source: "app.view", target: "ghost.thing" }];

test("Connects lists what a card shares only types with, by the card that draws the other end, unless the view already connects them", () => {
  const edges = [{ source: "api", target: "store" }];
  const rows = (id: string) => typesLinks(nodes.find(node => node.id === id), nodes, edges, pairs).map(link => `${link.arrow}${link.node}`);
  // api → store is drawn already (it also carries code), so it is not repeated.
  expect(rows("api")).toEqual([]);
  expect(rows("store")).toEqual(["←view"]);
  // `lib.util` is drawn as `lib`; `ghost.thing` has no card here, so no row.
  expect(rows("view")).toEqual(["←lib", "→store"]);
  expect(typesLinks(undefined, nodes, edges, pairs)).toEqual([]);
});
