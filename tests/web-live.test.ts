import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { recordSession } from "../src/sessions";
import { startWebServer, type WebServer } from "../src/web/server";
import type { Frame, Span } from "../src/web/wire";
import { mappingIn, selectView, toolActivity, writeActivity } from "./effects";

// Step 3 of the browser page (plan 4d): the agent's activity, read from the journal as the terminal reads it, in each window's frame: the tag in a
// card's top border and its pulse, the news line, the Work card, follow (`a`, paused by the person's own move) and `w`. Activity never moves a
// window's view or selection unless follow is on (contract 3); reads show nowhere live. No browser: the frames are read off the stream.

const text = (spans: readonly Span[]) => spans.map(span => span.text).join("");
const binding = { source: "claude", session: "live" } as const;

test("the page shows the work as the terminal does, and only follow moves the window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-web-live-"));
  let web: WebServer | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await cp(resolve("examples/parcel"), directory, { recursive: true });
    await mkdir(join(directory, "src", "api"), { recursive: true });
    await mkdir(join(directory, "src", "ship"), { recursive: true });
    for (const file of ["src/api/checkout.ts", "src/ship/label.ts", "src/api/notes.md"]) await writeFile(join(directory, file), "export {};\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "parcel", mappings: [
      { glob: "src/api/**", element: "parcel.commerce.api" }, { glob: "src/ship/**", element: "parcel.fulfillment.shipping" }] }));
    await Effect.runPromise(recordSession(directory, binding, { ended: null }));
    const view = await selectView(directory, "checkout");
    web = await Effect.runPromise(startWebServer(view, { page: null, theme: "pathlight", activity: binding, poll: 40 }));
    const server = web;

    // One window on Checkout detail, Checkout API selected, at 140 by 40 cells (the inspector docked).
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events?t=${server.token}&cols=140&rows=40&view=checkout&select=parcel.commerce.api`);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "", window = "";
    const frames: Frame[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader!.read();
        if (done) return;
        buffer += decoder.decode(value);
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const message = JSON.parse(buffer.slice(6, end)) as { window: string; frame: Frame };
          buffer = buffer.slice(end + 2); window = message.window; frames.push(message.frame);
        }
      }
    })();
    // The newest frame that passes, among those that arrived after `from` (the frame count when the step began).
    const until = async (what: string, check: (frame: Frame) => boolean, from = 0) => {
      for (let waited = 0; waited < 5000; waited += 20) { const found = frames.slice(from).findLast(check); if (found) return found; await Bun.sleep(20); }
      throw new Error(`No frame where ${what}; the last: ${JSON.stringify(frames.at(-1)?.header)}`);
    };
    const act = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/act?t=${server.token}&w=${window}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const call = async (id: string, file: string, phase: "started" | "completed", tool = "Edit") =>
      writeActivity(directory, toolActivity(directory, binding, id, tool, { file_path: join(directory, file) }, phase));

    const first = await until("the first frame", () => true);
    expect(first.selected).toBe("parcel.commerce.api");
    // Bound, nothing observed yet: Work says so, first of the cards; Connects is second.
    expect(text(first.inspector.work!.header)).toContain("Work");
    expect(text(first.inspector.work!.lines[0]!)).toBe("nothing observed here yet");
    expect(text(first.inspector.connects.header)).toContain("2 Connects");

    // A running edit: the card's tag, the news line naming the box, the Work row; the selection and view stay where the person left them.
    await call("one", "src/api/checkout.ts", "started");
    const running = await until("the edit runs", frame => text(frame.cards["parcel.commerce.api"]!.title).includes("■ edit"));
    expect(text(running.header.news)).toContain("now ■ edit in Checkout API");
    expect(text(running.inspector.work!.lines[0]!)).toMatch(/edit\s+checkout\.ts/);
    expect(running.cards["parcel.commerce.api"]!.pulse).toBeUndefined();
    expect([running.view, running.selected, running.reveal]).toEqual(["checkout", "parcel.commerce.api", false]);
    await call("one", "src/api/checkout.ts", "completed");
    await until("the edit is done", frame => text(frame.cards["parcel.commerce.api"]!.title).includes("✓ done"));

    // A read is kept in the journal and shown nowhere live.
    await call("read", "src/api/notes.md", "started", "Read");
    await call("read", "src/api/notes.md", "completed", "Read");
    await Bun.sleep(200);
    expect(frames.some(frame => text(frame.cards["parcel.commerce.api"]!.title).includes("read") || text(frame.header.news).includes("read"))).toBe(false);

    // Work in a box only Service architecture draws: offered while the turn is open, and the window does not move.
    await call("two", "src/ship/label.ts", "started");
    const offered = await until("the work is offered", frame => text(frame.header.news).includes("working in Parcel / Service architecture"));
    expect(text(offered.header.news)).toMatch(/ w +go and follow/);
    expect([offered.view, offered.selected]).toEqual(["checkout", "parcel.commerce.api"]);
    await call("two", "src/ship/label.ts", "completed");

    // Follow on: the next call takes the window to the view that draws it, selects the box and brings it into view.
    await act({ kind: "follow" });
    await until("follow is on", frame => text(frame.footer.left).includes("Following the work"));
    await call("three", "src/ship/label.ts", "started");
    await until("follow went to the work", frame => frame.view === "services");
    // The frame that arrives there brings the box into view; the frames after it leave the camera to the person.
    const followed = frames.find(frame => frame.view === "services")!;
    expect([followed.selected, followed.reveal]).toEqual(["parcel.fulfillment.shipping", true]);
    expect(text(followed.header.news)).toContain("following Shipping");
    await call("three", "src/ship/label.ts", "completed");

    // The person's own selection pauses it, and the next call moves nothing.
    await act({ kind: "select", id: "parcel.commerce.api" });
    const paused = await until("follow paused", frame => text(frame.footer.left).includes("Follow paused · a to resume"));
    expect(paused.selected).toBe("parcel.commerce.api");
    const before = frames.length;
    await call("four", "src/ship/label.ts", "started");
    await until("the call shows", frame => text(frame.cards["parcel.fulfillment.shipping"]?.title ?? []).includes("■ edit"), before);
    const after = frames.at(-1)!;
    expect([after.view, after.selected]).toEqual(["services", "parcel.commerce.api"]);
    // A running call on a box that is not selected pulses.
    expect(after.cards["parcel.fulfillment.shipping"]!.pulse).toBe(true);
    await call("four", "src/ship/label.ts", "completed");
    await reader.cancel(); reader = undefined;
    await pump.catch(() => undefined);
  } finally {
    await reader?.cancel().catch(() => undefined);
    await web?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a window with no session and no mapping shows the model only, as the terminal does", async () => {
  const view = await selectView("examples/parcel", "checkout");
  const web = await Effect.runPromise(startWebServer(view, { page: null, theme: "pathlight", poll: 40 }));
  try {
    const response = await fetch(`http://127.0.0.1:${web.port}/api/events?t=${web.token}&cols=140&rows=40&view=checkout`);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = (JSON.parse(new TextDecoder().decode(value).slice(6)) as { frame: Frame }).frame;
    expect(frame.inspector.work).toBeNull();
    expect(frame.header.news).toEqual([]);
    expect(text(frame.inspector.connects.header)).toContain("1 Connects");
    await reader.cancel();
  } finally { await web.stop(); }
});

test("an edit to the model redraws every window with the new model, keeping its view and selection", async () => {
  const { readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "pathlight-web-reload-"));
  let web: WebServer | undefined;
  try {
    await cp(resolve("examples/parcel"), directory, { recursive: true });
    web = await Effect.runPromise(startWebServer(await selectView(directory, "checkout"), { page: null, theme: "pathlight", poll: 40 }));
    const server = web;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events?t=${server.token}&cols=140&rows=40&view=checkout&select=parcel.commerce.inventory`);
    const reader = response.body!.getReader(), decoder = new TextDecoder(), frames: { frame: Frame; scene: number }[] = [];
    let buffer = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value);
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) { frames.push(JSON.parse(buffer.slice(6, end))); buffer = buffer.slice(end + 2); }
      }
    })();
    for (let waited = 0; !frames.length && waited < 5000; waited += 20) await Bun.sleep(20);
    expect(frames[0]!.scene).toBe(0);
    const model = (await Array.fromAsync(new Bun.Glob("*.c4").scan(directory))).map(name => join(directory, name));
    for (const file of model) {
      const source = await readFile(file, "utf8");
      if (source.includes('"Checkout API"')) await writeFile(file, source.replace('"Checkout API"', '"Checkout service"'));
    }
    for (let waited = 0; !frames.some(entry => entry.scene === 1) && waited < 15_000; waited += 50) await Bun.sleep(50);
    const reloaded = frames.find(entry => entry.scene === 1)!;
    expect([reloaded.frame.view, reloaded.frame.selected]).toEqual(["checkout", "parcel.commerce.inventory"]);
    const scene = await (await fetch(`http://127.0.0.1:${server.port}/api/scene?t=${server.token}`)).json() as { revision: number; views: { id: string; cards: { id: string; title: string }[] }[] };
    expect(scene.revision).toBe(1);
    expect(scene.views.find(view => view.id === "checkout")!.cards.find(card => card.id === "parcel.commerce.api")!.title).toBe("Checkout service");
    await reader.cancel(); await pump.catch(() => undefined);
  } finally {
    await web?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
