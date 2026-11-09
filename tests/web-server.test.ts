import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { Effect } from "effect";
import { cellAt, rasterize, routeEdges } from "../src/routes";
import { headContent } from "../src/viewer/inspector-view";
import { shapeView, worldCell } from "../src/viewer/shape";
import { loadWorld } from "../src/viewer/world";
import { pack, unpack } from "../src/web/page";
import { policies, policy, startWebServer, type WebServer } from "../src/web/server";
import { spansOf, unlimited } from "../src/web/spans";
import type { Frame, Scene, SceneData, Span } from "../src/web/wire";
import { selectView } from "./effects";

// `pathlight web` against examples/parcel (three views that open one another) and the frozen fixture, without a browser: the guard, the scene
// laid out by the terminal's own code, the frames in the terminal's words, and the windows' acts. The page in a browser is tests/web-page.test.ts.

let web: WebServer;
const base = () => `http://127.0.0.1:${web.port}`;
const api = (path: string, extra = "", server = web) => `http://127.0.0.1:${server.port}${path}?t=${server.token}${extra}`;
const text = (spans: readonly Span[]) => spans.map(span => span.text).join("");

beforeAll(async () => {
  const view = await selectView("examples/parcel", "index");
  const page = unpack(new Uint8Array(pack([{ path: "index.html", gzipped: Bun.gzipSync(new TextEncoder().encode("<!doctype html><p>page")) }])));
  // A theme named here, so the person's own saved theme does not decide the test.
  web = await Effect.runPromise(startWebServer(view, { page, theme: "pathlight" }));
});
afterAll(async () => {
  await web.stop();
});

/** A raw request, so the Host and Origin headers are exactly what a test sets (fetch fills its own Host). */
const raw = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port: web.port, path, headers }, response => { response.resume(); resolve(response.statusCode ?? 0); });
  req.on("error", reject); req.end();
});

/** Reads frames from one window's stream. */
const open = async (extra = "", server = web) => {
  const controller = new AbortController();
  const response = await fetch(api("/api/events", extra, server), { signal: controller.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  let buffered = "";
  const next = async (): Promise<{ window: string; frame: Frame }> => {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) { const event = buffered.slice(0, end); buffered = buffered.slice(end + 2); return JSON.parse(event.replace(/^data: /, "")); }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffered += new TextDecoder().decode(value);
    }
  };
  return { next, close: () => controller.abort() };
};
const send = (window: string, body: unknown, type = "application/json", server = web) =>
  fetch(api("/api/act", `&w=${window}`, server), { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

test("the server answers only its own host and origin, and nothing but the page's files without the token", async () => {
  const host = `127.0.0.1:${web.port}`;
  expect(await raw("/", { host })).toBe(200);
  // DNS rebinding: a name that resolves to 127.0.0.1 reaches the port but not the server.
  expect(await raw("/", { host: "evil.example" })).toBe(421);
  expect(await raw(`/api/scene?t=${web.token}`, { host: `localhost:${web.port}` })).toBe(421);
  expect(await raw(`/api/scene?t=${web.token}`, { host, origin: "http://evil.example" })).toBe(403);
  expect(await raw(`/api/scene?t=${web.token}`, { host, "sec-fetch-site": "cross-site" })).toBe(403);
  expect(await raw(`/api/scene?t=${web.token}`, { host, origin: `http://${host}` })).toBe(200);
  for (const path of ["/api/scene", "/api/events", "/api/act"]) {
    expect(await raw(path, { host })).toBe(403);
    expect(await raw(`${path}?t=wrong`, { host })).toBe(403);
  }
  const page = await fetch(`${base()}/`);
  // The page runs its own scripts and nothing else: no wasm, no inline script, no other origin.
  expect(page.headers.get("content-security-policy")).toBe(policy);
  expect(policy).toContain("script-src 'self';");
  expect(policy).not.toContain("wasm-unsafe-eval");
  expect(policies.rune).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(await page.text()).toBe("<!doctype html><p>page");
  expect((await fetch(`${base()}/missing.js`)).status).toBe(404);
});

/** The parcel views as the terminal reads them. */
const terminal = async () => {
  const view = await selectView("examples/parcel", "services");
  return Effect.runPromise(Effect.scoped(loadWorld(view, { watching: false, reload: false })));
};

test("the scene is every view laid out by the terminal's compact fit, the overview first, with the rail in the view picker's words", async () => {
  const scene = await (await fetch(api("/api/scene"))).json() as SceneData;
  expect(scene.project).toBe("parcel");
  expect(scene.mode).toBe("dark");
  expect(scene.views.map(view => view.id)).toEqual(["index", "checkout", "services"]);
  expect(scene.rail).toEqual([
    { view: "index", name: "System context", holder: "Parcel", detail: "5 boxes" },
    { view: "checkout", name: "Checkout detail", holder: "Parcel", detail: "8 boxes" },
    { view: "services", name: "Service architecture", holder: "Parcel", detail: "16 boxes" },
  ]);
  const world = await terminal();
  for (const view of scene.views) {
    const raw = world.diagrams.get(view.id)!;
    // The same function the terminal shapes a view with (native-viewer.ts `shape`), so the cards sit where the terminal puts them.
    const shaped = shapeView(raw, { all: world.diagrams.values(), planned: world.config?.planned ?? [], files: world.files, watching: false });
    expect(view.cards.map(card => [card.id, ...card.rect])).toEqual(shaped.nodes.map(node => [String(node.id), node.x, node.y, node.width, node.height]));
    for (const card of view.cards) expect([card.rect[0] % 16, card.rect[1] % 32, card.rect[2] % 16, card.rect[3] % 32]).toEqual([0, 0, 0, 0]);
  }
  const services = scene.views.find(view => view.id === "services")!;
  const card = (id: string) => services.cards.find(entry => entry.id === id)!;
  expect(card("parcel.commerce")).toMatchObject({ title: "Commerce", group: true, parent: "parcel" });
  expect(card("parcel.commerce.api")).toMatchObject({ title: "Checkout API", group: false, parent: "parcel.commerce", opens: null });
  expect(services.heading).toBe("Parcel / Service architecture");
  expect(services.title).toBe("Service architecture");
  // Nothing of LikeC4's drawing travels: no shapes, colors or LikeC4 points.
  expect(Object.keys(card("customer")).sort()).toEqual(["group", "id", "level", "opens", "parent", "rect", "title"]);
});

/**
 * Every connector runs through exactly the cells the terminal draws it in: the cells under the page's polylines (cell middles, runs horizontal or
 * vertical) are the cells `rasterize` gives at 100%, once the cards' own cells are left out.
 */
test("the connectors are the terminal's routes, cell for cell", async () => {
  const scene = await (await fetch(api("/api/scene"))).json() as SceneData;
  const world = await terminal();
  for (const view of scene.views) {
    const raw = world.diagrams.get(view.id)!;
    const nodes = shapeView(raw, { all: world.diagrams.values(), planned: world.config?.planned ?? [], files: world.files, watching: false }).nodes;
    const routes = routeEdges(nodes.map(node => ({ id: String(node.id), x: node.x, y: node.y, width: node.width, height: node.height, children: node.children.map(String) })),
      raw.edges.map(edge => ({ source: String(edge.source), target: String(edge.target), points: [] })), worldCell);
    const rects = new Map(nodes.map(node => [String(node.id), { x: cellAt(node.x / 16), y: cellAt(node.y / 32), width: Math.round(node.width / 16), height: Math.round(node.height / 32) }]));
    const covered = (x: number, y: number) => nodes.some(node => {
      const rect = rects.get(String(node.id))!, right = rect.x + rect.width - 1, bottom = rect.y + rect.height - 1;
      return x >= rect.x && x <= right && y >= rect.y && y <= bottom && (!node.children.length || x === rect.x || x === right || y === rect.y || y === bottom);
    });
    const theirs = new Set(rasterize(routes, point => ({ x: point.x / 16, y: point.y / 32 }), covered, undefined, new Map(), id => rects.get(id)).map(cell => `${cell.x},${cell.y}`));
    const ours = new Set<string>();
    expect(view.routes.length).toBe(routes.length);
    for (const route of view.routes) {
      const cells = route.points.map(([x, y]) => ({ x: (x - 8) / 16, y: (y - 16) / 32 }));
      for (let index = 1; index < cells.length; index++) {
        const a = cells[index - 1]!, b = cells[index]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (let step = 0, steps = Math.abs(b.x - a.x) + Math.abs(b.y - a.y); step <= steps; step++) {
          const x = a.x + Math.sign(b.x - a.x) * step, y = a.y + Math.sign(b.y - a.y) * step;
          if (!covered(x, y)) ours.add(`${x},${y}`);
        }
      }
    }
    expect([...ours].sort()).toEqual([...theirs].sort());
  }
});

/** The frozen fixture's screen as the terminal draws it (tests/golden/): the inspector's text sits right of the divider, from column 99. */
const golden = async (name: string) => (await readFile(`tests/golden/${name}.txt`, "utf8")).split("\n");

test("a frame says what the terminal says at the same size: header, inspector, Connects and footer", async () => {
  const fixture = await Effect.runPromise(startWebServer(await selectView("tests/fixtures/viewer", "live", "viewer"), { page: null, theme: "pathlight" }));
  try {
    for (const [name, select] of [["docked-140x36", undefined], ["docked-launcher-140x36", "launcher"]] as const) {
      const screen = await golden(name);
      const win = await open(`&view=live&cols=140&rows=36${select ? `&select=${select}` : ""}`, fixture);
      try {
        const { frame } = await win.next();
        expect(frame.placement).toEqual({ mount: "docked", list: false, width: 42, height: 32 });
        expect(` ${text(frame.header.line1)}`).toBe(screen[0]!.trimEnd());
        expect(` ${text(frame.header.line2)}`).toBe(screen[1]!.trimEnd());
        const inspector = screen.slice(3).map(line => line.slice(99).trimEnd());
        const ours = [text(frame.inspector.title), ...frame.inspector.what.map(text), ...frame.inspector.about.map(text), "", text(frame.inspector.connects.header), ...frame.inspector.connects.lines.map(text)];
        expect(ours.map(line => line.trimEnd())).toEqual(inspector.slice(0, ours.length));
        // The footer's left side is the terminal's; its zoom is the page's own camera.
        expect(text(frame.footer.left).trimEnd()).toBe(screen[35]!.slice(0, 40).trimEnd());
      } finally { win.close(); }
    }
  } finally { await fixture.stop(); }
});

test("a frame carries each card's look and each connector's tone for the selection, as the terminal colors them", async () => {
  const scene = await (await fetch(api("/api/scene"))).json() as SceneData;
  const services = scene.views.find(view => view.id === "services") as Scene;
  const win = await open("&view=services&select=parcel.commerce.api");
  try {
    const { frame } = await win.next();
    const p = scene.palette;
    expect(frame.cards["parcel.commerce.api"]!.border).toBe(p.accent!);
    // Its neighbors a step brighter than the rest, groups in the rule's color with their titles in the top border.
    expect(frame.cards["parcel.commerce.orders"]!.border).toBe(p.edgeDim!);
    expect(frame.cards["parcel.commerce.stock"]!.border).toBe(p.cardEdge!);
    expect(frame.cards["parcel.commerce"]).toMatchObject({ border: p.rule, title: [{ text: "Commerce", fg: p.muted }], label: [] });
    expect(frame.cards["parcel.commerce.api"]!.label.map(text)).toEqual(["", "Checkout API"]);
    const tone = (source: string, target: string) => frame.routes[services.routes.findIndex(route => route.source === source && route.target === target)];
    expect(tone("parcel.storefront", "parcel.commerce.api")).toEqual({ color: p.incoming!, dotted: false, lit: true });
    expect(tone("parcel.commerce.api", "parcel.commerce.orders")).toEqual({ color: p.outgoing!, dotted: false, lit: true });
    expect(tone("customer", "parcel.storefront")).toEqual({ color: p.edgeDim!, dotted: true, lit: false });
  } finally { win.close(); }
});

test("a window opens on the view and selection it asks for, and its acts come back as frames", async () => {
  const win = await open("&view=services&select=parcel.commerce.orders");
  try {
    const first = await win.next();
    expect(first.frame).toMatchObject({ view: "services", selected: "parcel.commerce.orders", canBack: false, restore: null });
    expect(text(first.frame.inspector.title)).toBe("Orders");
    expect(first.frame.inspector.connects.lines.map(line => text(line).trim())).toEqual(["← Checkout API  Commits order and ou…", "← Outbox relay  Reads pending events"]);
    expect(first.frame.inspector.connects.rows).toEqual(["parcel.commerce.api", "parcel.commerce.relay"]);

    expect((await send(first.window, { kind: "select", id: "parcel.commerce.api" })).status).toBe(204);
    const selected = await win.next();
    expect(selected.frame.selected).toBe("parcel.commerce.api");
    expect(selected.frame.inspector.connects.rows).toEqual(["parcel.storefront", "parcel.commerce.inventory", "parcel.commerce.orders", "payments"]);

    // An id that is not in the view leaves the selection where it is.
    await send(first.window, { kind: "select", id: "nothing.here" });
    expect((await win.next()).frame.selected).toBe("parcel.commerce.api");

    // The arrows select the neighbor the terminal's would, and say so when there is none.
    await send(first.window, { kind: "traverse", direction: "right" });
    expect((await win.next()).frame.selected).toBe("parcel.commerce.inventory");
    await send(first.window, { kind: "traverse", direction: "down" });
    expect((await win.next()).frame.selected).toBe("payments");
    await send(first.window, { kind: "traverse", direction: "down" });
    expect(text((await win.next()).frame.footer.left)).toContain("Nothing below Payment provider");
    await send(first.window, { kind: "select", id: "parcel.commerce.inventory" });
    await win.next();

    const camera = { x: 140, y: -20, zoom: 1.4, moved: true };
    await send(first.window, { kind: "open", view: "checkout", camera });
    const opened = await win.next();
    expect(opened.frame).toMatchObject({ view: "checkout", canBack: true, restore: null });
    expect(text(opened.frame.header.line2)).toBe("8 boxes · back 1");

    await send(first.window, { kind: "back" });
    const back = await win.next();
    expect(back.frame).toMatchObject({ view: "services", selected: "parcel.commerce.inventory", canBack: false, restore: camera });

    // `b` with nowhere to go says so; Backspace goes up, to the box that holds the selection.
    await send(first.window, { kind: "back" });
    expect(text((await win.next()).frame.footer.left)).toContain("No previous view");
    await send(first.window, { kind: "back", up: true });
    expect((await win.next()).frame.selected).toBe("parcel.commerce");
    // Enter goes into a group's first child, and Back returns to the group.
    await send(first.window, { kind: "into" });
    const inside = (await win.next()).frame;
    expect(inside.selected).not.toBe("parcel.commerce");
    expect(inside.canBack).toBe(true);
  } finally { win.close(); }
});

test("the inspector sits where the terminal puts it for the window's size, and i opens it over a narrow diagram", async () => {
  const win = await open("&view=services&cols=140&rows=40");
  try {
    const { window, frame } = await win.next();
    expect(frame.placement).toEqual({ mount: "docked", list: false, width: 42, height: 36 });
    await send(window, { kind: "size", cols: 103, rows: 45 });
    expect((await win.next()).frame.placement).toEqual({ mount: "below", list: false, width: 103, height: 18 });
    await send(window, { kind: "size", cols: 100, rows: 30 });
    expect((await win.next()).frame.placement.mount).toBe("none");
    await send(window, { kind: "inspector" });
    expect((await win.next()).frame.placement).toEqual({ mount: "overlay", list: false, width: 50, height: 26 });
    await send(window, { kind: "size", cols: 70, rows: 24 });
    const list = (await win.next()).frame;
    expect(list.placement.list).toBe(true);
    expect(list.list!.ids[0]).toBe("customer");
    expect(text(list.list!.lines[list.list!.ids.indexOf("parcel.commerce.api")]!)).toContain("› ");
    // The footer says the page's zoom, as the terminal's says its own.
    await send(window, { kind: "zoom", zoom: 1.4 });
    expect(text((await win.next()).frame.footer.right)).toContain("zoom 140%");
  } finally { win.close(); }
});

test("each window keeps its own selection, and acts it cannot take are refused", async () => {
  const a = await open("&view=services"), b = await open("&view=services");
  try {
    const [first, second] = [await a.next(), await b.next()];
    expect(first.window).not.toBe(second.window);
    await send(first.window, { kind: "select", id: "parcel.commerce.stock" });
    expect((await a.next()).frame.selected).toBe("parcel.commerce.stock");
    expect(second.frame.selected).toBe("parcel.commerce.api");
    expect((await send("no-such-window", { kind: "back" })).status).toBe(404);
    expect((await send(first.window, { kind: "select", id: 1 })).status).toBe(400);
    expect((await send(first.window, { kind: "traverse", direction: "sideways" })).status).toBe(400);
    expect((await send(first.window, { kind: "select", id: "x" }, "text/plain")).status).toBe(415);
  } finally { a.close(); b.close(); }
});

test("a window with nothing selected says what the app is, in the terminal's words", async () => {
  const win = await open("&view=services");
  try {
    const { window } = await win.next();
    await send(window, { kind: "select", id: null });
    const frame = (await win.next()).frame;
    expect(text(frame.inspector.title)).toBe("No selection");
    expect(frame.inspector.connects.rows).toEqual([null]);
    expect(frame.inspector.connects.lines.map(text)).toEqual(["none"]);
  } finally { win.close(); }
});

test("? lists the terminal's help for the keys the page has, and no others", async () => {
  const win = await open("&view=services&cols=140&rows=40");
  try {
    const help = (await win.next()).frame.help.lines.map(text).join("\n");
    for (const row of ["into a box", "the view a box opens", "back where you were, else up", "this help", "fit everything", "actual size, zoom", "inspector, or the talk and back"]) expect(help).toContain(row);
    // Step 3 brought follow and the work; the journeys, the talk, the themes and replay come later.
    for (const row of ["follow the work", "jump to the agent's work"]) expect(help).toContain(row);
    for (const row of ["ask or tell the agent", "step through a journey", "choose a theme", "replay the session"]) expect(help).not.toContain(row);
  } finally { win.close(); }
});

test("the page's spans carry the terminal's words and colors, without the terminal's padding", () => {
  const head = headContent({ title: "Checkout API", technology: "TypeScript / HTTP", planned: false, tags: ["bug"], description: { txt: "Validates carts." }, opens: "o opens Checkout detail", mapped: 0, width: unlimited });
  const about = spansOf(head.about);
  expect(about.map(span => span.text).join("")).toBe(head.about.chunks.map(chunk => chunk.text).join("").trimEnd());
  expect(about.map(span => span.text).join("")).toBe("Validates carts.\no opens Checkout detail");
  expect(spansOf(head.what)).toEqual([{ text: "TypeScript / HTTP · bug", fg: expect.stringMatching(/^#[0-9a-f]{6}$/) }]);
});

test("an idle stream stays open past Bun's idle timeout", async () => {
  const win = await open("&view=index");
  try {
    const { window } = await win.next();
    await Bun.sleep(32_000);
    await send(window, { kind: "select", id: null });
    expect((await win.next()).frame.selected).toBeNull();
  } finally { win.close(); }
}, 45_000);

test("without a built page the server says how to build it, for either page", async () => {
  const view = await selectView("examples/parcel", "index");
  for (const [kind, hint] of [["page", "bun scripts/build-page.ts"], ["rune", "sh scripts/build-web.sh"]] as const) {
    const bare = await Effect.runPromise(startWebServer(view, { page: null, kind }));
    try {
      const response = await fetch(`http://127.0.0.1:${bare.port}/`);
      expect(await response.text()).toContain(hint);
      expect(response.headers.get("content-security-policy")).toBe(policies[kind]);
      expect((await fetch(`http://127.0.0.1:${bare.port}/main.js`)).status).toBe(404);
    } finally { await bare.stop(); }
  }
});

test("the Rune page keeps the scene and frames it was built for", async () => {
  const view = await selectView("examples/parcel", "index");
  const rune = await Effect.runPromise(startWebServer(view, { page: null, kind: "rune", theme: "github" }));
  try {
    const dark = await (await fetch(api("/api/scene", "&mode=dark", rune))).json() as any;
    const light = await (await fetch(api("/api/scene", "&mode=light", rune))).json() as any;
    expect(dark.palette.background).not.toBe(light.palette.background);
    const services = dark.views.find((entry: any) => entry.id === "services");
    expect(services.nodes.find((node: any) => node.id === "parcel.commerce.orders").role).toBe("store");
    const win = await open("&view=services&select=parcel.commerce.orders", rune);
    try {
      const { frame } = await win.next() as unknown as { frame: any };
      expect(frame.header).toEqual({ project: "parcel", view: "Service architecture", boxes: 13 });
      expect(frame.inspector.links.map((link: any) => `${link.arrow} ${link.title}`)).toEqual(["← Checkout API", "← Outbox relay"]);
    } finally { win.close(); }
  } finally { await rune.stop(); }
});
