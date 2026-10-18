import { createCliRenderer, ImageRenderable, NativeSession, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { PlaceholderRenderable } from "./placeholder";
import { writeReady } from "./ready";
import { terminalProtocol, type Protocol } from "./protocol";
import { activityLines, readActivity, readActivityConfig, type ActivityBinding } from "./activity";
import { Config, Effect, Schedule } from "effect";
import { io, failure } from "./effects";

export const viewImage = Effect.fn("Image.view")(function* (options: { image: string; title: string; protocol: Protocol; ready?: string;
  activity?: ActivityBinding & { workspace: string } }) {
  const tmux = yield* Config.String("TMUX").pipe(Config.withDefault(""));
  const pane = yield* Config.String("TMUX_PANE").pipe(Config.withDefault(""));
  const terminal = yield* Config.String("TERM_PROGRAM").pipe(Config.withDefault(""));
  const protocol = terminalProtocol(options.protocol, Boolean(tmux || pane || terminal === "tmux"));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return yield* Effect.fail(failure("Image.terminal", "The viewer needs a terminal. Use c4view show to open a tmux pane."));
  }
  const session = new NativeSession(process.stdout);
  const renderer = yield* Effect.acquireRelease(io("Image.renderer", () => createCliRenderer({
    nativeSession: session,
    exitOnCtrlC: false,
    exitSignals: [],
    backgroundColor: "#111827",
    consoleMode: "disabled",
  })), renderer => io("Image.close", async () => { renderer.destroy(); await renderer.closed; }).pipe(Effect.orDie));
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();
    const header = new TextRenderable(renderer, {
      content: options.title, height: 1, flexShrink: 0, fg: "#f9fafb",
    });
    const viewport = new ScrollBoxRenderable(renderer, {
      flexGrow: 1, scrollX: true, scrollY: true,
      contentOptions: { flexDirection: "column", alignItems: "flex-start" },
    });
    const displayed = protocol === "kitty-unicode" ? new PlaceholderRenderable(renderer, session, Boolean(tmux), options.image) : new ImageRenderable(renderer, {
      source: options.image, protocol, fit: "fit", flexShrink: 0,
    });
    const image = displayed;
    yield* Effect.addFinalizer(() => image instanceof PlaceholderRenderable
      ? io("Image.release", () => image.release()).pipe(Effect.orDie) : Effect.void);
    const footer = new TextRenderable(renderer, { height: 2, flexShrink: 0, fg: "#cbd5e1" });
    renderer.root.add(header);
    renderer.root.add(viewport);
    viewport.add(image);
    const activityHeight = options.activity ? 6 : 0;
    if (options.activity) {
      const binding = options.activity;
      const config = yield* readActivityConfig(binding.workspace);
      const panel = new TextRenderable(renderer, { height: activityHeight, flexShrink: 0, fg: "#93c5fd", wrapMode: "none" });
      renderer.root.add(panel);
      yield* Effect.gen(function* () {
            const events = yield* readActivity(binding.workspace, binding);
            const newest = events[0];
            const state = !newest ? "waiting for events" : Date.now() - newest.time > 30_000
              ? "no recent events; status may be stale" : "observing tool activity";
            panel.content = `${binding.source} / ${binding.session} / ${state}\n${activityLines(events, config).join("\n")}`;
      }).pipe(Effect.catch(() => Effect.sync(() => { panel.content = "Activity unavailable; diagram remains usable."; })),
        Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped);
    }
    renderer.root.add(footer);
    let zoom = 1;
    const layout = () => {
      const image = displayed;
      if (image instanceof PlaceholderRenderable) {
        const pixels = renderer.resolution;
        const cellAspect = pixels && pixels.width > 0 && pixels.height > 0
          ? (pixels.width / renderer.width) / (pixels.height / renderer.height) : 0.5;
        zoom = image.fit(renderer.width - 2, renderer.height - 5 - activityHeight, zoom, cellAspect);
      }
      else {
        image.width = Math.max(1, Math.floor((renderer.width - 2) * zoom));
        image.height = Math.max(1, Math.floor((renderer.height - 5 - activityHeight) * zoom));
      }
      footer.content = `${image.effectiveProtocol} | ${Math.round(zoom * 100)}% | +/- zoom | arrows pan | f fit | q quit\n`
        + (image.effectiveProtocol === "blocks"
          ? "Block preview: use kitty-unicode for compatible terminals with tmux passthrough."
          : "Image mode. Press f to fit after resizing.");
    };
    renderer.on("resize", layout);
    let resolution = renderer.resolution;
    renderer.on("frame", () => {
      if (renderer.resolution !== resolution) {
        resolution = renderer.resolution;
        layout();
      }
    });
    renderer.keyInput.on("keypress", key => {
      if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) { stop(); return; }
      else if (key.name === "+" || key.name === "=" || key.sequence === "+") zoom = Math.min(8, zoom * 1.25);
      else if (key.name === "-" || key.sequence === "-") zoom = Math.max(1, zoom / 1.25);
      else if (key.name === "f") { zoom = 1; viewport.scrollTo({ x: 0, y: 0 }); }
      else if (key.name === "left") viewport.scrollBy({ x: -8, y: 0 });
      else if (key.name === "right") viewport.scrollBy({ x: 8, y: 0 });
      else if (key.name === "up") viewport.scrollBy({ x: 0, y: -4 });
      else if (key.name === "down") viewport.scrollBy({ x: 0, y: 4 });
      layout();
    });
    yield* io("Image.load", async () => { await image.loadPromise; });
    if (image.loadError) {
      const message = String(image.loadError);
      if (options.ready) yield* writeReady(options.ready, { error: message });
      return yield* Effect.fail(failure("Image.load", message));
    }
    layout();
    if (options.ready) yield* writeReady(options.ready, { protocol: image.effectiveProtocol });
    yield* io("Image.wait", () => Promise.race([stopped.promise, renderer.closed]));
}, Effect.scoped);
