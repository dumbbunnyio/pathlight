import { expect, test } from "bun:test";
import { type Candidate, classScore, locationBonus, scoreOf, search, textScore } from "../src/search";

const view = (title: string, id: string): Candidate => ({ kind: "view", name: title, aliases: [id], here: false });
const box = (title: string, id: string, here = false): Candidate => ({ kind: "box", name: title, aliases: [id, id.split(".").at(-1)!], here });
const file = (path: string, here = false): Candidate => ({ kind: "file", name: path.split("/").at(-1)!, aliases: [path], here });

// A slice of Hono's real names, with the view the user is in being the middleware one.
const universe: Candidate[] = [
  view("Packages", "index"), view("hono", "hono_components"), view("hono / everything", "hono_all_components"), view("hono / middleware", "hono_middleware_near"),
  view("hono / helper", "hono_helper_near"), view("hono / request", "hono_request_near"), view("hono / loose files", "hono_loose_components"),
  box("middleware", "hono.middleware", true), box("context", "hono.loose.context", true), box("helper", "hono.helper", true), box("types", "hono.loose.types"),
  box("hono.ts", "hono.loose.hono"), box("request", "hono.request"), box("router", "hono.router"), box("validator", "hono.validator"), box("utils", "hono.utils"),
  file("src/hono.ts"), file("src/hono-base.ts"), file("src/context.ts", true), file("src/request.ts"), file("src/middleware/cors/index.ts", true),
  file("src/middleware/basic-auth/index.ts", true), file("src/helper/html/index.ts", true), file("adapters/bun/src/index.ts"),
];
const top = (query: string, count = 1) => search(query, universe).slice(0, count).map(item => `${item.kind}:${item.aliases[0]}`);

test("an exact match comes first wherever it is, before anything in the current view", () => {
  expect(top("hono_components")).toEqual(["view:hono_components"]);
  expect(top("hono.ts")[0]).toMatch(/^(box:hono\.loose\.hono|file:src\/hono\.ts)$/);
  expect(top("hono.ts", 2).sort()).toEqual(["box:hono.loose.hono", "file:src/hono.ts"]);
  expect(top("router")).toEqual(["box:hono.router"]);
  expect(top("index.ts")[0]).toMatch(/^file:/);
});

test("with equal quality, the current view comes first, then boxes, views, then files elsewhere", () => {
  const same = (kind: Candidate["kind"], here: boolean): Candidate => ({ kind, name: "thing", aliases: [], here });
  const order = search("thing", [same("file", false), same("view", false), same("box", false), same("file", true), same("box", true)]);
  expect(order.map(item => `${item.kind}${item.here ? "*" : ""}`)).toEqual(["box*", "file*", "box", "view", "file"]);
});

test("a prefix or word match elsewhere is not buried by a weak match in the view", () => {
  // `req` is a prefix of the request box elsewhere; nothing in the middleware view starts with it.
  expect(top("req", 3)).toContain("box:hono.request");
  expect(top("req")[0]).not.toMatch(/helper|context/);
  // `ctx` only matches `context` loosely, and that is the best there is.
  expect(top("ctx")[0]).toMatch(/context/);
  expect(top("mid")[0]).toBe("box:hono.middleware");
});

test("typos and several words still find the thing", () => {
  expect(top("midlewar")[0]).toBe("box:hono.middleware");
  expect(top("hepler")[0]).toMatch(/helper/);
  expect(top("hono mid")[0]).toMatch(/middleware/);
  expect(search("zzzzqq", universe)).toEqual([]);
});

test("an empty query lists the current view first", () => {
  const all = search("", universe);
  expect(all.length).toBe(universe.length);
  expect(all[0]!.kind === "box" && all[0]!.here).toBe(true);
});

test("the location ladder never outweighs a step between match classes", () => {
  const ladder = locationBonus.boxHere - locationBonus.fileElsewhere;
  expect(classScore.exact - classScore.prefix).toBeGreaterThan(ladder);
  expect(classScore.prefix - classScore.substring).toBeGreaterThan(0);
  expect(textScore("abc", "abc")).toBe(classScore.exact);
  expect(scoreOf("abc", { kind: "file", name: "abc", aliases: [], here: false })!).toBeGreaterThan(scoreOf("abc", { kind: "box", name: "xabcx", aliases: [], here: true })!);
});
