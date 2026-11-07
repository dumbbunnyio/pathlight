import { afterAll, beforeAll, expect, test } from "bun:test";
import { request } from "node:http";
import { Effect } from "effect";
import { headContent } from "../src/viewer/inspector-view";
import { pack, unpack } from "../src/web/page";
import { policy, startWebServer, type WebServer } from "../src/web/server";
import { spansOf, unlimited } from "../src/web/spans";
import { selectView } from "./effects";

// `pathlight web` against examples/parcel (three views that open one another), without a browser: the guard, the scene, and the windows'
// frames and acts. The page itself is Rust (web/, `cargo test`), and the page in a browser is tests/web-page.test.ts.

let web: WebServer;
const base = () => `http://127.0.0.1:${web.port}`;
const api = (path: string, extra = "") => `${base()}${path}?t=${web.token}${extra}`;

beforeAll(async () => {
  const view = await selectView("examples/parcel", "index");
  const page = unpack(new Uint8Array(pack([{ path: "index.html", gzipped: Bun.gzipSync(new TextEncoder().encode("<!doctype html><p>page")) }])));
  // A theme with both modes, named here so the person's own saved theme does not decide the test.
  web = await Effect.runPromise(startWebServer(view, { page, theme: "github" }));
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
const open = async (extra = "") => {
  const controller = new AbortController();
  const response = await fetch(api("/api/events", extra), { signal: controller.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  let buffered = "";
  const next = async (): Promise<{ window: string; frame: any }> => {
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
const send = (window: string, body: unknown, type = "application/json") =>
  fetch(api("/api/act", `&w=${window}`), { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

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
  expect(page.headers.get("content-security-policy")).toBe(policy);
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(policy).toContain("img-src 'self' data: blob:");
  expect(await page.text()).toBe("<!doctype html><p>page");
  expect((await fetch(`${base()}/missing.js`)).status).toBe(404);
});

test("the scene is every view's structure and words in LikeC4's layout, the overview first, and none of LikeC4's drawing", async () => {
  const dark = await (await fetch(api("/api/scene", "&mode=dark"))).json() as any;
  const light = await (await fetch(api("/api/scene", "&mode=light"))).json() as any;
  expect(dark.project).toBe("parcel");
  expect(dark.views.map((v: any) => v.id)).toEqual(["index", "checkout", "services"]);
  const services = dark.views.find((v: any) => v.id === "services");
  const node = (id: string) => services.nodes.find((n: any) => n.id === id);
  expect(node("parcel.commerce.api")).toEqual({ id: "parcel.commerce.api", title: "Checkout API", technology: "TypeScript / HTTP", role: "", group: false, opens: null, rect: expect.any(Array), depth: 0 });
  // What the model says a box is travels as a word; LikeC4's shape for it does not.
  expect([node("parcel.commerce.orders").role, node("customer").role, node("parcel.fulfillment.events").role, node("parcel.storefront").role]).toEqual(["store", "person", "queue", "app"]);
  expect(node("parcel.commerce").group).toBe(true);
  const edge = services.edges.find((e: any) => e.source === "parcel.commerce.api" && e.target === "parcel.commerce.inventory");
  expect(Object.keys(edge).sort()).toEqual(["id", "label", "labelAt", "opens", "points", "source", "target", "technology"]);
  expect(edge.label).toBe("Reserves stock");
  expect(edge.points.length % 3).toBe(1);
  expect(dark.palette.background).not.toBe(light.palette.background);
});

test("a window opens on the view and selection it asks for, and its acts come back as frames", async () => {
  const win = await open("&view=services&select=parcel.commerce.orders");
  try {
    const first = await win.next();
    expect(first.frame).toMatchObject({ view: "services", selected: "parcel.commerce.orders", canBack: false, restore: null });
    expect(first.frame.header).toEqual({ project: "parcel", view: "Service architecture", boxes: 13 });
    expect(first.frame.inspector.title).toBe("Orders");
    expect(first.frame.inspector.links.map((l: any) => `${l.arrow} ${l.title}: ${l.label}`)).toEqual(["← Checkout API: Commits order and outbox", "← Outbox relay: Reads pending events"]);

    expect((await send(first.window, { kind: "select", id: "parcel.commerce.api" })).status).toBe(204);
    const selected = await win.next();
    expect(selected.frame.selected).toBe("parcel.commerce.api");
    expect(selected.frame.inspector.links.map((l: any) => `${l.arrow} ${l.node}`)).toEqual(["← parcel.storefront", "→ parcel.commerce.inventory", "→ parcel.commerce.orders", "→ payments"]);

    // An id that is not in the view leaves the selection where it is.
    await send(first.window, { kind: "select", id: "nothing.here" });
    expect((await win.next()).frame.selected).toBe("parcel.commerce.api");

    const camera = { x: 140, y: -20, zoom: 1.4, moved: true };
    await send(first.window, { kind: "open", view: "checkout", camera });
    const opened = await win.next();
    expect(opened.frame).toMatchObject({ view: "checkout", canBack: true, restore: null });
    expect(opened.frame.selected).not.toBeNull();

    await send(first.window, { kind: "back" });
    const back = await win.next();
    expect(back.frame).toMatchObject({ view: "services", selected: "parcel.commerce.api", canBack: false, restore: camera });
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
    expect((await send(first.window, { kind: "select", id: "x" }, "text/plain")).status).toBe(415);
  } finally { a.close(); b.close(); }
});

test("a window with nothing selected says what the app is, in the terminal's words", async () => {
  const win = await open("&view=services");
  try {
    const { window } = await win.next();
    await send(window, { kind: "select", id: null });
    const frame = (await win.next()).frame;
    expect(frame.inspector.title).toBe("No selection");
    expect(frame.inspector.links).toEqual([]);
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

test("without a built page the server says how to build it", async () => {
  const view = await selectView("examples/parcel", "index");
  const bare = await Effect.runPromise(startWebServer(view, { page: null }));
  try {
    const response = await fetch(`http://127.0.0.1:${bare.port}/`);
    expect(await response.text()).toContain("sh scripts/build-web.sh");
    expect((await fetch(`http://127.0.0.1:${bare.port}/app.js`)).status).toBe(404);
  } finally { await bare.stop(); }
});
