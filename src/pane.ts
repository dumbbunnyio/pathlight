import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedFrame, CliRenderer, CliRendererConfig } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Effect } from "effect";
import type { ActivityBinding } from "./activity";
import type { View } from "./catalog";
import { io } from "./effects";
import { setPaneMode } from "./ui";

/**
 * `pathlight pane`: the viewer drawn for a host that shows it in its own window (the Claude Code plugin's pane), not in a terminal of its own.
 *
 * The viewer runs on OpenTUI's headless renderer at the size the host gives. Its standard output is one line per message, for the host to read:
 * `frame COLS ROWS CELLS` whenever the picture changed (CELLS is the host's Raster encoding: standard base64 of little-endian u32 triplets
 * `[codePoint, foreground, background]` per cell, row-major), `ready` once the first frame is fully drawn, `socket PATH` once the key channel
 * listens, and `ask JSON` when the talk sends a request (`{ "id": N, "text": "..." }`, the text exactly as `pathlight show` types it into the
 * agent's pane), and an empty line every half second. The host sends the person's keys, clicks and the pane's size over HTTP on that Unix socket: `POST /key` (`{ key, ctrl?, shift?,
 * meta? }`, or `{ key: "blur" }` when the host's Esc took the keys back), `POST /pointer` (`{ x, y, kind: "down" | "up" | "scroll-up" | "scroll-down" }`), `POST /resize` (`{ cols, rows }`) and `POST /sent`
 * (`{ id, ok, said? }`: what became of an `ask`; `said` is what the talk says instead of its usual line, or the reason it was refused).
 *
 * Nothing here records, follows or calls a model: the binding is the session the host names, and the request goes back to the host to submit.
 * The process ends when its standard output closes, when it is signalled, or when the host that started it is gone.
 */

/** A frame as the host's Raster takes it. */
export function encodeFrame(frame: CapturedFrame): string {
  const words = new Uint32Array(frame.cols * frame.rows * 3);
  const colour = (rgba: { r: number; g: number; b: number; a: number }) =>
    rgba.a === 0 ? 0x01000000 : (Math.round(rgba.r * 255) << 16 | Math.round(rgba.g * 255) << 8 | Math.round(rgba.b * 255)) >>> 0;
  const blend = (a: number, b: number) => {
    if (a & 0x01000000 || b & 0x01000000) return a;
    const mix = (shift: number) => Math.round(((a >> shift) & 255) * 0.55 + ((b >> shift) & 255) * 0.45);
    return (mix(16) << 16 | mix(8) << 8 | mix(0)) >>> 0;
  };
  frame.lines.slice(0, frame.rows).forEach((line, row) => {
    let column = 0;
    for (const span of line.spans) {
      let fg = colour(span.fg), bg = colour(span.bg);
      // The Raster has no attributes: dim is drawn as a colour nearer the background, inverse swaps the two, hidden is the background.
      if (span.attributes & 32) [fg, bg] = [bg, fg];
      if (span.attributes & 2) fg = blend(fg, bg);
      if (span.attributes & 64) fg = bg;
      for (const char of span.text) {
        if (column >= frame.cols) break;
        const code = char.codePointAt(0)!;
        const width = Bun.stringWidth(char);
        // A cell holds one printable width-1 character of the BMP; anything else (a wide glyph, a control) is drawn as a space.
        const printable = code >= 0x20 && code <= 0xffff && code !== 0x7f && width === 1;
        const at = (row * frame.cols + column) * 3;
        words[at] = printable ? code : 0x20; words[at + 1] = fg; words[at + 2] = bg;
        column++;
        if (width === 2 && column < frame.cols) { const next = at + 3; words[next] = 0x20; words[next + 1] = fg; words[next + 2] = bg; column++; }
      }
    }
    // A short line leaves the rest of the row blank in the last colours seen, or the terminal's default.
    for (; column < frame.cols; column++) { const at = (row * frame.cols + column) * 3; words[at] = 0x20; words[at + 1] = 0x01000000; words[at + 2] = 0x01000000; }
  });
  return Buffer.from(words.buffer).toString("base64");
}

/** The text of an encoded frame, row by row (each row's trailing blanks kept), for tests and for `pathlight see`'s comparison. */
export function frameText(cols: number, rows: number, cells: string): string {
  const bytes = Buffer.from(cells, "base64");
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let column = 0; column < cols; column++) line += String.fromCodePoint(words[(row * cols + column) * 3]!);
    lines.push(line);
  }
  return lines.join("\n");
}

/** A key the host forwards (its `ClientKeyEvent`, or `escape` for the pane's own leave key), as the headless renderer's mock keyboard takes it. */
export function pressKey(input: TestRendererSetup["mockInput"], key: { key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }) {
  const modifiers = { ctrl: key.ctrl === true, shift: key.shift === true, meta: key.meta === true };
  const named: Record<string, () => void> = {
    return: () => input.pressEnter(modifiers), enter: () => input.pressEnter(modifiers), tab: () => input.pressTab(modifiers),
    backspace: () => input.pressBackspace(modifiers), escape: () => input.pressEscape(modifiers), delete: () => input.pressKey("DELETE", modifiers),
    up: () => input.pressArrow("up", modifiers), down: () => input.pressArrow("down", modifiers), left: () => input.pressArrow("left", modifiers), right: () => input.pressArrow("right", modifiers),
    home: () => input.pressKey("HOME", modifiers), end: () => input.pressKey("END", modifiers),
    pageup: () => input.pressKey("\x1b[5~", modifiers), pagedown: () => input.pressKey("\x1b[6~", modifiers),
    space: () => input.pressKey(" ", modifiers),
    // The host's Esc handed the keys back to the conversation: the viewer leaves a field that was typing (viewer/keys.ts `paneBlur`).
    blur: () => input.pressKey("F12"),
  };
  const press = named[key.key];
  if (press) return press();
  if ([...key.key].length === 1) return input.pressKey(key.key, modifiers);
}

const whole = (value: unknown, low: number, high: number) => typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

export const paneView = Effect.fn("Pane.view")(function* (options: { view: View; activity?: ActivityBinding; cols: number; rows: number; select?: string; socket?: string; signal?: AbortSignal }) {
  setPaneMode(true);
  const write = (line: string) => { try { process.stdout.write(`${line}\n`); } catch { ended.resolve(); } };
  const ended = Promise.withResolvers<void>();
  process.stdout.on("error", () => ended.resolve());
  process.stdout.on("close", () => ended.resolve());
  options.signal?.addEventListener("abort", () => ended.resolve());
  // The host's process: when it goes, this one is adopted, and nobody reads the frames any more. An empty line every half second finds a closed
  // output even while the picture is still (the host skips empty lines).
  const parent = process.ppid;
  const orphaned = setInterval(() => { if (process.ppid !== parent) ended.resolve(); else write(""); }, 500);

  let setup: TestRendererSetup | undefined;
  let last = "", lastSize = "";
  const sends = new Map<number, (answer: { ok: boolean; said?: string }) => void>();
  let nextSend = 1;
  const emit = () => {
    if (!setup) return;
    // A frame that changed no cell is the last picture again: nothing to read or send (the renderer draws on at its own pace while anything moves).
    const size = `${setup.renderer.width} ${setup.renderer.height}`;
    if (setup.renderer.getNativeStats().cellsUpdated === 0 && size === lastSize) return;
    const frame = setup.captureSpans();
    const cells = encodeFrame(frame);
    if (cells === last && size === lastSize) return;
    last = cells; lastSize = size;
    write(`frame ${frame.cols} ${frame.rows} ${cells}`);
  };

  const directory = options.socket ? undefined : yield* Effect.acquireRelease(io("Pane.directory", () => mkdtemp(join(tmpdir(), "pathlight-pane-"))),
    path => io("Pane.remove", () => rm(path, { recursive: true, force: true })).pipe(Effect.ignore));
  const socket = options.socket ?? join(directory!, "keys.sock");
  const reply = (status = 204) => new Response(null, { status });
  const server = yield* Effect.acquireRelease(io("Pane.socket", async () => Bun.serve({ unix: socket, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return reply(405);
    const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!body || !setup) return reply(400);
    if (path === "/key") {
      if (typeof body.key !== "string" || body.key.length > 16) return reply(400);
      pressKey(setup.mockInput, body as { key: string });
      return reply();
    }
    if (path === "/pointer") {
      if (!whole(body.x, 0, 511) || !whole(body.y, 0, 255)) return reply(400);
      const x = body.x as number, y = body.y as number;
      if (body.kind === "down") await setup.mockMouse.pressDown(x, y);
      else if (body.kind === "up") await setup.mockMouse.release(x, y);
      else if (body.kind === "scroll-up" || body.kind === "scroll-down") await setup.mockMouse.scroll(x, y, body.kind === "scroll-up" ? "up" : "down");
      else return reply(400);
      return reply();
    }
    if (path === "/resize") {
      if (!whole(body.cols, 20, 512) || !whole(body.rows, 8, 256)) return reply(400);
      setup.resize(body.cols as number, body.rows as number);
      return reply();
    }
    if (path === "/sent") {
      if (!whole(body.id, 1, Number.MAX_SAFE_INTEGER) || typeof body.ok !== "boolean" || (body.said !== undefined && typeof body.said !== "string")) return reply(400);
      sends.get(body.id as number)?.({ ok: body.ok, said: (body.said as string | undefined)?.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300) });
      sends.delete(body.id as number);
      return reply();
    }
    return reply(404);
  } })), server => io("Pane.socketClose", async () => { await server.stop(true); }).pipe(Effect.ignore));
  void server;
  write(`socket ${socket}`);

  const host = {
    renderer: async (config: CliRendererConfig): Promise<CliRenderer> => {
      setup = await createTestRenderer({ ...config, width: options.cols, height: options.rows, screenMode: "alternate-screen" });
      setup.renderer.on("frame", emit);
      return setup.renderer;
    },
    ready: () => { emit(); write("ready"); },
    // The request goes up to the host, which submits it as the person's prompt; the talk's line says what the host answered.
    send: (text: string) => Effect.callback<string | undefined, Error>(resume => {
      const id = nextSend++;
      const timer = setTimeout(() => { sends.delete(id); resume(Effect.fail(new Error("The conversation did not answer the request; it may not have been sent"))); }, 10_000);
      sends.set(id, answer => { clearTimeout(timer); resume(answer.ok ? Effect.succeed(answer.said) : Effect.fail(new Error(answer.said ?? "The conversation refused the request"))); });
      write(`ask ${JSON.stringify({ id, text })}`);
    }),
  };
  const { viewNative } = yield* io("Pane.viewer", () => import("./native-viewer"));
  yield* Effect.raceFirst(
    viewNative({ view: options.view, activity: options.activity, select: options.select, host }),
    io("Pane.ended", () => ended.promise),
  ).pipe(Effect.ensuring(Effect.sync(() => clearInterval(orphaned))));
}, Effect.scoped);
