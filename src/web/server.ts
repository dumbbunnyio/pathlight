import { Effect } from "effect";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { View } from "../catalog";
import { failure, io } from "../effects";
import { loadThemes, type Mode, paletteOf, savedTheme, themeFromEnvironment } from "../theme";
import { type Palette, palette, setPalette } from "../ui";
import { loadWorld, readChecks } from "../viewer/world";
import { loadPage, type Page } from "./page";
import { type ColorsOf, type LayoutedView, sceneOf, viewOrder } from "./scene";
import { type Act, act, frameOf, startWindow, type WindowState, type World, type WorldView } from "./session";

/**
 * `pathlight web`: the browser page and what it draws, served on 127.0.0.1 only. Loopback does not protect a server on its own: any page the
 * person has open can send requests to it, and `/api/act` changes what is shown. So every request must name this server as its host (no other
 * name can reach it through DNS rebinding), a request from another origin is refused, and everything but the page's own files needs the per-run
 * token the address carries. The page's policy lets it run only its own scripts and its wasm.
 */

export const policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const headers = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

const sameToken = (given: string | null, token: string) => {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The page that says the browser page is not built here, in place of the page. */
const notBuilt = `<!doctype html><meta charset="utf-8"><title>Pathlight</title><body style="font: 15px system-ui; margin: 3em; max-width: 40em">
<h1 style="font-size: 20px">The browser page is not built</h1><p>This copy of Pathlight was built without its browser page. In a checkout, run
<code>sh scripts/build-web.sh</code> (it needs Rust and wasm-bindgen), then start <code>pathlight web</code> again.</p></body>`;

export interface WebServer { url: string; port: number; token: string; stop: () => Promise<void> }

const parseAct = (body: unknown): Act | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const value = body as Record<string, unknown>;
  if (value.kind === "select" && (value.id === null || typeof value.id === "string")) return { kind: "select", id: value.id };
  if (value.kind === "back") return { kind: "back" };
  if (value.kind === "open" && typeof value.view === "string") {
    const c = value.camera as Record<string, unknown> | undefined;
    const camera = c && [c.x, c.y, c.zoom].every(n => typeof n === "number" && Number.isFinite(n)) ? { x: c.x as number, y: c.y as number, zoom: c.zoom as number, moved: c.moved === true } : undefined;
    return { kind: "open", view: value.view, select: typeof value.select === "string" ? value.select : null, ...(camera ? { camera } : {}) };
  }
  return undefined;
};

/** Everything the server needs from the workspace, read once. */
export const loadWebWorld = (view: View, theme?: string) => Effect.gen(function* () {
  const loaded = yield* loadWorld(view, { watching: false, reload: false });
  const checks = yield* readChecks(view.workspace, undefined);
  const world: World = { views: loaded.diagrams as unknown as ReadonlyMap<string, WorldView>, files: loaded.files, planned: loaded.config?.planned ?? [], words: checks.words };
  const colors: ColorsOf = color => loaded.styles.colors(color) as ReturnType<ColorsOf>;
  const themes = yield* loadThemes(view.workspace);
  const environment = yield* themeFromEnvironment();
  const wanted = theme || environment.name || (yield* savedTheme().pipe(Effect.catch(() => Effect.succeed(undefined)))) || "pathlight";
  const paletteFor = (mode: Mode): Palette => {
    try { return paletteOf(themes.get(wanted) ?? themes.get("pathlight")!, mode); } catch { return paletteOf(themes.get("pathlight")!, mode); }
  };
  return { world, layouted: loaded.diagrams as unknown as ReadonlyMap<string, LayoutedView>, colors, palettes: { dark: paletteFor("dark"), light: paletteFor("light") } };
});

/**
 * Starts the server for one workspace's views. `port` 0 takes a free one. Each page that connects to `/api/events` is a window with its own
 * selection and Back; the stream carries its frames, and `/api/act` with its id changes them.
 */
export const startWebServer = (view: View, options: { port?: number; select?: string | undefined; page?: Page | null; theme?: string }) => Effect.gen(function* () {
  const { world, layouted, colors, palettes } = yield* loadWebWorld(view, options.theme);
  // `page: null` serves without one, as a copy built without Rust does; left out, the embedded or built page is used.
  const page = options.page === undefined ? yield* io("Web.page", () => loadPage()) : options.page ?? undefined;
  const token = randomBytes(18).toString("base64url");
  const scenes = new Map<Mode, string>();
  const sceneJson = (mode: Mode) => {
    const cached = scenes.get(mode);
    if (cached) return cached;
    const all = viewOrder([...layouted.values()].map(entry => sceneOf(entry, colors, palettes[mode])), view.id);
    const made = JSON.stringify({ project: view.project, palette: palettes[mode], views: all });
    scenes.set(mode, made);
    return made;
  };
  const windows = new Map<string, { state: WindowState; mode: Mode; send: (text: string) => void }>();
  // The terminal's functions read the palette module's colors; the page asks in its own mode, so a frame is made in that mode's palette.
  const framed = (id: string) => {
    const entry = windows.get(id)!;
    const saved = { ...palette };
    setPalette(palettes[entry.mode], false);
    try { return JSON.stringify({ window: id, frame: frameOf(world, entry.state, view.project) }); } finally { setPalette(saved, false); }
  };
  const encoder = new TextEncoder();

  let port = 0;
  const server = yield* Effect.try({
    try: () => Bun.serve({
      hostname: "127.0.0.1", port: options.port ?? 0, idleTimeout: 30,
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (request.headers.get("host") !== `127.0.0.1:${port}`) return new Response("Wrong host", { status: 421, headers });
        const origin = request.headers.get("origin");
        if (origin && origin !== `http://127.0.0.1:${port}`) return new Response("Wrong origin", { status: 403, headers });
        if (request.headers.get("sec-fetch-site") === "cross-site") return new Response("Cross-site request", { status: 403, headers });
        const mode: Mode = url.searchParams.get("mode") === "light" ? "light" : "dark";

        if (url.pathname.startsWith("/api/")) {
          if (!sameToken(url.searchParams.get("t"), token)) return new Response("Missing or wrong token", { status: 403, headers });
          if (url.pathname === "/api/scene" && request.method === "GET")
            return new Response(sceneJson(mode), { headers: { ...headers, "content-type": "application/json" } });
          if (url.pathname === "/api/events" && request.method === "GET") {
            // An idle stream is not a dead one: Bun would close it after `idleTimeout` and EventSource would hide that by reconnecting.
            server.timeout(request, 0);
            const id = randomBytes(9).toString("base64url");
            const asked = url.searchParams.get("view");
            const start = asked && world.views.has(asked) ? asked : view.id;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                windows.set(id, { state: startWindow(world, start, url.searchParams.get("select") ?? (asked ? undefined : options.select)), mode, send: text => controller.enqueue(encoder.encode(`data: ${text}\n\n`)) });
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
            entry.state = act(world, entry.state, action);
            entry.send(framed(url.searchParams.get("w")!));
            return new Response(null, { status: 204, headers });
          }
          return new Response("Not found", { status: 404, headers });
        }

        if (request.method !== "GET") return new Response("Not allowed", { status: 405, headers });
        if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
        const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!page) return path === "index.html" ? new Response(notBuilt, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": policy } }) : new Response("Not found", { status: 404, headers });
        const file = page.files.get(path);
        if (!file) return new Response("Not found", { status: 404, headers });
        return new Response(file.body, { headers: { ...headers, "content-type": file.type, "content-encoding": "gzip", "content-security-policy": policy } });
      },
    }),
    catch: cause => failure("Web.serve", cause),
  });
  port = server.port ?? 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return { url, port, token, built: page !== undefined, stop: () => server.stop(true) } as WebServer & { built: boolean };
});

/** Serves until `signal` aborts, printing where. */
export const serveWeb = (view: View, options: { port?: number; select?: string | undefined; signal: AbortSignal; print: (line: string) => void }) => Effect.scoped(Effect.gen(function* () {
  const web = yield* Effect.acquireRelease(startWebServer(view, options), web => Effect.promise(() => web.stop()));
  options.print(`${web.url}\n`);
  options.print(web.built ? "Open it in a browser with WebGPU. Ctrl-C stops it.\n" : "The browser page is not built in this copy: run sh scripts/build-web.sh. Ctrl-C stops it.\n");
  yield* Effect.callback<void>(resume => {
    if (options.signal.aborted) return resume(Effect.void);
    options.signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });
}));
