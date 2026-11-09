import { Effect } from "effect";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { View } from "../catalog";
import { failure, io } from "../effects";
import { loadThemes, type Mode, paletteOf, savedTheme, themeFromEnvironment } from "../theme";
import { type Palette, palette, setPalette } from "../ui";
import { loadWorld, readChecks } from "../viewer/world";
import pkg from "../../package.json" with { type: "json" };
import { splitTitle } from "../viewer/pickers";
import { shapeView } from "../viewer/shape";
import { buildHints, loadPage, type Page, type PageKind } from "./page";
import { type RuneLayoutedView, runeFrameOf, runeSceneOf } from "./rune";
import { type LayoutedView, type Scene, sceneOf, viewOrder } from "./scene";
import type { RailRow, SceneData } from "./wire";
import { type Act, act, frameOf, startWindow, type WindowState, type World, type WorldView } from "./session";

/**
 * `pathlight web`: the browser page and what it draws, served on 127.0.0.1 only. Loopback does not protect a server on its own: any page the
 * person has open can send requests to it, and `/api/act` changes what is shown. So every request must name this server as its host (no other
 * name can reach it through DNS rebinding), a request from another origin is refused, and everything but the page's own files needs the per-run
 * token the address carries. The default page runs only its own scripts; the Rune experiment also runs its wasm.
 */

export const policies: Record<PageKind, string> = {
  page: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  rune: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
export const policy = policies.page;

const headers = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

const sameToken = (given: string | null, token: string) => {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The page that says the browser page is not built here, in place of the page. */
const notBuilt = (kind: PageKind) => `<!doctype html><meta charset="utf-8"><title>Pathlight</title><body style="font: 15px system-ui; margin: 3em; max-width: 40em">
<h1 style="font-size: 20px">The browser page is not built</h1><p>This copy of Pathlight was built without its ${kind === "rune" ? "Rune page" : "browser page"}. In a checkout, run
<code>${buildHints[kind]}</code>, then start <code>pathlight web${kind === "rune" ? " --rune" : ""}</code> again.</p></body>`;

export interface WebServer { url: string; port: number; token: string; stop: () => Promise<void> }

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const cameraOf = (value: unknown) => {
  const c = value as Record<string, unknown> | undefined;
  return c && [c.x, c.y, c.zoom].every(number) ? { x: c.x as number, y: c.y as number, zoom: c.zoom as number, moved: c.moved === true } : undefined;
};

const parseAct = (body: unknown): Act | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const value = body as Record<string, unknown>;
  const camera = cameraOf(value.camera);
  if (value.kind === "select" && (value.id === null || typeof value.id === "string")) return { kind: "select", id: value.id };
  if (value.kind === "back") return { kind: "back", ...(value.up === true ? { up: true } : {}), ...(camera ? { camera } : {}) };
  if (value.kind === "into") return { kind: "into", ...(camera ? { camera } : {}) };
  if (value.kind === "openView") return { kind: "openView", ...(camera ? { camera } : {}) };
  if (value.kind === "traverse" && ["left", "right", "up", "down"].includes(value.direction as string)) return { kind: "traverse", direction: value.direction as "left" };
  if (value.kind === "inspector") return { kind: "inspector" };
  if (value.kind === "size" && number(value.cols) && number(value.rows)) return { kind: "size", cols: value.cols as number, rows: value.rows as number };
  if (value.kind === "zoom" && number(value.zoom) && (value.zoom as number) > 0) return { kind: "zoom", zoom: value.zoom as number };
  if (value.kind === "open" && typeof value.view === "string")
    return { kind: "open", view: value.view, select: typeof value.select === "string" ? value.select : null, ...(camera ? { camera } : {}) };
  return undefined;
};

/**
 * Everything the server needs from the workspace, read once: the views laid out in the terminal's cells, and the palette the terminal would
 * use (decision 13): the theme from `--theme`, else the environment, else the saved one; dark unless the environment says light.
 */
export const loadWebWorld = (view: View, theme?: string, mode?: Mode) => Effect.gen(function* () {
  const loaded = yield* loadWorld(view, { watching: false, reload: false });
  const checks = yield* readChecks(view.workspace, undefined);
  const layouted = loaded.diagrams as unknown as ReadonlyMap<string, LayoutedView>;
  const planned = loaded.config?.planned ?? [];
  const scenes = new Map<string, Scene>(), rows = new Map<string, { words: ReadonlyMap<string, string>; row: boolean }>();
  for (const [id, raw] of layouted) {
    if (!raw.nodes.length) continue;
    scenes.set(id, sceneOf(raw, { all: layouted.values(), planned, files: loaded.files }));
    const shaped = shapeView(raw, { all: layouted.values(), planned, files: loaded.files, watching: false });
    rows.set(id, { words: shaped.words, row: shaped.row });
  }
  const world: World = { views: loaded.diagrams as unknown as ReadonlyMap<string, WorldView>, scenes, rows, files: loaded.files, planned, words: checks.words, version: pkg.version };
  const themes = yield* loadThemes(view.workspace);
  const environment = yield* themeFromEnvironment();
  const wanted = theme || environment.name || (yield* savedTheme().pipe(Effect.catch(() => Effect.succeed(undefined)))) || "pathlight";
  const chosenMode: Mode = mode ?? environment.mode ?? "dark";
  const paletteFor = (mode: Mode): Palette => {
    try { return paletteOf(themes.get(wanted) ?? themes.get("pathlight")!, mode); } catch { return paletteOf(themes.get("pathlight")!, mode); }
  };
  return { world, layouted, palette: paletteFor(chosenMode), mode: chosenMode, paletteFor };
});

/**
 * Starts the server for one workspace's views. `port` 0 takes a free one. Each page that connects to `/api/events` is a window with its own
 * selection and Back; the stream carries its frames, and `/api/act` with its id changes them.
 */
export const startWebServer = (view: View, options: { port?: number; select?: string | undefined; page?: Page | null; kind?: PageKind; theme?: string; mode?: Mode }) => Effect.gen(function* () {
  const kind = options.kind ?? "page";
  const { world, layouted, palette: chosen, mode, paletteFor } = yield* loadWebWorld(view, options.theme, options.mode);
  // The palette as the terminal installs it (setPalette makes every entry distinct), so the page's variables are the frames' colors exactly.
  const installed = (next: Palette): Palette => { const saved = { ...palette }; setPalette(next, false); const made = { ...palette }; setPalette(saved, false); return made; };
  const colors = installed(chosen);
  // `page: null` serves without one, as a copy built without its page does; left out, the embedded or built page is used.
  const page = options.page === undefined ? yield* io("Web.page", () => loadPage(kind)) : options.page ?? undefined;
  const token = randomBytes(18).toString("base64url");
  const ordered = viewOrder([...world.scenes.values()], view.id);
  // The rail, in the view picker's words (viewer/pickers.ts): the view's own name, what holds it, its boxes.
  const rail: RailRow[] = ordered.map(scene => { const { name, holder } = splitTitle(scene.heading); return { view: scene.id, name, holder, detail: `${scene.cards.length} ${scene.cards.length === 1 ? "box" : "boxes"}` }; });
  const sceneJson = JSON.stringify({ project: view.project, mode, palette: colors, views: ordered, rail } satisfies SceneData);
  // The Rune page asks for its own mode and draws LikeC4's layout (rune.ts).
  const runeScenes = new Map<Mode, string>();
  const runeScene = (asked: Mode) => {
    const known = runeScenes.get(asked);
    if (known) return known;
    const made = JSON.stringify({ project: view.project, palette: installed(paletteFor(asked)), views: viewOrder([...layouted.values()].filter(raw => raw.nodes.length).map(raw => runeSceneOf(raw as unknown as RuneLayoutedView)), view.id) });
    runeScenes.set(asked, made);
    return made;
  };
  const windows = new Map<string, { state: WindowState; mode: Mode; send: (text: string) => void }>();
  // The terminal's functions read the palette module's colors: a frame is made in the page's palette, and the module's own is put back.
  const framed = (id: string) => {
    const entry = windows.get(id)!;
    const saved = { ...palette };
    setPalette(kind === "rune" ? paletteFor(entry.mode) : colors, false);
    try { return JSON.stringify({ window: id, frame: kind === "rune" ? runeFrameOf(world, entry.state, view.project) : frameOf(world, entry.state) }); } finally { setPalette(saved, false); }
  };
  const encoder = new TextEncoder();
  const csp = policies[kind];

  let port = 0;
  const server = yield* Effect.try({
    try: () => Bun.serve({
      hostname: "127.0.0.1", port: options.port ?? 0, idleTimeout: 30,
      fetch: async (request, server) => {
        const url = new URL(request.url);
        const asked: Mode = url.searchParams.get("mode") === "light" ? "light" : "dark";
        if (request.headers.get("host") !== `127.0.0.1:${port}`) return new Response("Wrong host", { status: 421, headers });
        const origin = request.headers.get("origin");
        if (origin && origin !== `http://127.0.0.1:${port}`) return new Response("Wrong origin", { status: 403, headers });
        if (request.headers.get("sec-fetch-site") === "cross-site") return new Response("Cross-site request", { status: 403, headers });

        if (url.pathname.startsWith("/api/")) {
          if (!sameToken(url.searchParams.get("t"), token)) return new Response("Missing or wrong token", { status: 403, headers });
          if (url.pathname === "/api/scene" && request.method === "GET")
            return new Response(kind === "rune" ? runeScene(asked) : sceneJson, { headers: { ...headers, "content-type": "application/json" } });
          if (url.pathname === "/api/events" && request.method === "GET") {
            // An idle stream is not a dead one: Bun would close it after `idleTimeout` and EventSource would hide that by reconnecting.
            server.timeout(request, 0);
            const id = randomBytes(9).toString("base64url");
            const wanted = url.searchParams.get("view");
            const start = wanted && world.scenes.has(wanted) ? wanted : view.id;
            const cols = Number(url.searchParams.get("cols")), rows = Number(url.searchParams.get("rows"));
            const size = Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 ? { cols: Math.min(1000, Math.max(20, Math.round(cols))), rows: Math.min(500, Math.max(8, Math.round(rows))) } : undefined;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                windows.set(id, { state: startWindow(world, start, url.searchParams.get("select") ?? (wanted ? undefined : options.select), size), mode: asked, send: text => controller.enqueue(encoder.encode(`data: ${text}\n\n`)) });
                controller.enqueue(encoder.encode(`data: ${framed(id)}\n\n`));
              },
              cancel() { windows.delete(id); },
            });
            request.signal.addEventListener("abort", () => windows.delete(id));
            return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream", connection: "keep-alive" } });
          }
          if (url.pathname === "/api/act" && request.method === "POST") {
            const entry = windows.get(url.searchParams.get("w") ?? "");
            if (!entry) return new Response("No such window", { status: 404, headers });
            if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return new Response("Expected JSON", { status: 415, headers });
            const action = parseAct(await request.json().catch(() => undefined));
            if (!action) return new Response("Not an act", { status: 400, headers });
            const before = entry.state;
            entry.state = act(world, entry.state, action);
            // A camera report that does not change the footer's zoom, or a size the page already had, sends nothing back.
            if (action.kind === "zoom" && Math.round(before.zoom * 100) === Math.round(entry.state.zoom * 100)) return new Response(null, { status: 204, headers });
            entry.send(framed(url.searchParams.get("w")!));
            return new Response(null, { status: 204, headers });
          }
          return new Response("Not found", { status: 404, headers });
        }

        if (request.method !== "GET") return new Response("Not allowed", { status: 405, headers });
        if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
        const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!page) return path === "index.html" ? new Response(notBuilt(kind), { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": csp } }) : new Response("Not found", { status: 404, headers });
        const file = page.files.get(path);
        if (!file) return new Response("Not found", { status: 404, headers });
        return new Response(file.body, { headers: { ...headers, "content-type": file.type, "content-encoding": "gzip", "content-security-policy": csp } });
      },
    }),
    catch: cause => failure("Web.serve", cause),
  });
  port = server.port ?? 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return { url, port, token, built: page !== undefined, stop: () => server.stop(true) } as WebServer & { built: boolean };
});

/** Serves until `signal` aborts, printing where. */
export const serveWeb = (view: View, options: { port?: number; select?: string | undefined; kind?: PageKind; signal: AbortSignal; print: (line: string) => void }) => Effect.scoped(Effect.gen(function* () {
  const kind = options.kind ?? "page";
  const web = yield* Effect.acquireRelease(startWebServer(view, options), web => Effect.promise(() => web.stop()));
  options.print(`${web.url}\n`);
  options.print(!web.built ? `The ${kind === "rune" ? "Rune page" : "browser page"} is not built in this copy: run ${buildHints[kind]}. Ctrl-C stops it.\n`
    : kind === "rune" ? "Open it in a browser with WebGPU (experimental). Ctrl-C stops it.\n" : "Open it in a browser. Ctrl-C stops it.\n");
  yield* Effect.callback<void>(resume => {
    if (options.signal.aborted) return resume(Effect.void);
    options.signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });
}));
