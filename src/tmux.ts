import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { Config, Effect, Schedule, Schema } from "effect";
import { io, failure, hasCode, json } from "./effects";
import { run } from "./process";
import { exportView } from "./export";
import { validateActivityMapping, type View } from "./catalog";
import { readActivityConfig, type ActivityBinding } from "./activity";
import { terminalProtocol, type Protocol, type RenderMode } from "./protocol";
import { Ready } from "./ready";

export const showView = Effect.fn("Tmux.show")(function* (options: {
  view: View; pane: string; socket?: string; renderer: RenderMode; protocol: Protocol; activity?: ActivityBinding; follow?: boolean;
}) {
  const protocol = options.renderer === "png" ? terminalProtocol(options.protocol, true) : "native";
  if (!/^%\d+$/.test(options.pane)) return yield* Effect.fail(failure("Tmux.pane", "Pass an exact tmux pane ID, such as %2."));
  const tmux = (...args: string[]) => run("tmux", [
    ...(options.socket ? ["-S", options.socket] : []), ...args,
  ]);
  const requireVisible = Effect.fn("Tmux.visible")(function* (pane: string) {
    if (protocol !== "kitty-unicode") return;
    const [window, zoomed, active] = (yield* tmux("display-message", "-p", "-t", pane,
      "#{window_id}\t#{window_zoomed_flag}\t#{pane_active}")).split("\t");
    const windows = (yield* tmux("list-clients", "-F", "#{window_id}")).split("\n");
    if (!window || !windows.includes(window) || (zoomed === "1" && active !== "1")) {
      return yield* Effect.fail(failure("Tmux.visible", `Pane ${pane} is not visible to an attached tmux client. Switch to its window, unzoom it, and retry. Keep it visible until the image finishes loading; tmux drops hidden image uploads.`));
    }
  });
  yield* requireVisible(options.pane);
  if (options.activity || options.follow) yield* validateActivityMapping(options.view, yield* readActivityConfig(options.view.workspace));
  const socket = yield* tmux("display-message", "-p", "-t", options.pane, "#{socket_path}");
  const owner = createHash("sha256").update(`${socket}\0${options.pane}\0${options.view.workspace}`).digest("hex");
  const cache = join(options.view.workspace, ".cache", "c4view");
  yield* io("Tmux.cache", () => mkdir(cache, { recursive: true }));
  const lock = yield* Effect.acquireRelease(io("Tmux.openLock", () => open(join(cache, `${owner}.lock`), "a", 0o600)),
    handle => io("Tmux.closeLock", () => handle.close()).pipe(Effect.orDie));
  let createdPane: string | undefined;
  let readyPane = false;
  yield* Effect.addFinalizer(() => createdPane && !readyPane ? tmux("kill-pane", "-t", createdPane).pipe(Effect.ignore) : Effect.void);
    yield* io("Tmux.lock", () => new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", lock.fd] });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(
        code === 1 ? "Another diagram request is in progress for this pane. Retry after it finishes."
          : "Could not acquire the viewer lock. Linux flock is required.",
      )));
    })).pipe(Effect.uninterruptible);
    const exported = options.renderer === "png" ? yield* exportView(options.view) : undefined;
    yield* requireVisible(options.pane);
    const directory = exported?.directory ?? (yield* io("Tmux.directory", () => mkdtemp(join(cache, "native-"))));
    const ready = join(directory, "ready.json");
    const args = [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url)),
      ...(exported ? ["image", exported.image, "--title", `${options.view.project} / ${options.view.title}`, "--protocol", protocol]
        : ["view", options.view.id, "--workspace", options.view.workspace, "--project", options.view.project, "--renderer", "native"]),
      "--ready", ready];
    const editorEnvironment: string[] = [];
    for (const key of ["VISUAL", "EDITOR"]) {
      const value = yield* Config.String(key).pipe(Config.withDefault(""));
      if (value) editorEnvironment.push("-e", `${key}=${value}`);
    }
    if (options.activity) {
      if (exported) args.push("--workspace", options.view.workspace);
      args.push("--session", options.activity.session, "--source", options.activity.source);
    }
    if (options.follow) args.push("--follow");
    const panes = yield* tmux("list-panes", "-a", "-F", "#{pane_id}\t#{@c4view-owner}\t#{pane_current_command}\t#{pane_dead}\t#{pane_start_command}\t#{@c4view-command}");
    const existing = panes.split("\n").map(line => line.split("\t"))
      .find(([, tag, command, dead, started, expected]) =>
        tag === owner && started === expected && !!expected && (command === "bun" || dead === "1"));
    let pane = existing?.[0];
    if (pane) {
      const owned = pane;
      yield* requireVisible(owned);
      yield* Effect.gen(function* () {
        const remain = yield* tmux("show-options", "-p", "-v", "-t", owned, "remain-on-exit");
        yield* Effect.acquireRelease(tmux("set-option", "-p", "-t", owned, "remain-on-exit", "on"), () =>
          (remain ? tmux("set-option", "-p", "-t", owned, "remain-on-exit", remain)
            : tmux("set-option", "-pu", "-t", owned, "remain-on-exit")).pipe(Effect.orDie));
        if (existing?.[3] !== "1") yield* tmux("send-keys", "-t", owned, "C-c");
        const stopped = yield* tmux("display-message", "-p", "-t", owned, "#{pane_dead}").pipe(
          Effect.repeat({ schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ times: 99 })), while: value => value !== "1" }));
        if (stopped !== "1") return yield* Effect.fail(failure("Tmux.replace", `Viewer in ${owned} did not shut down cleanly. Refusing to kill it.`));
        yield* tmux("respawn-pane", "-t", owned, ...editorEnvironment, ...args);
      }).pipe(Effect.scoped);
    } else {
      pane = yield* tmux("split-window", "-h", "-d", "-l", "50%", "-t", options.pane,
        "-P", "-F", "#{pane_id}", ...editorEnvironment, ...args).pipe(
          Effect.tap(value => Effect.sync(() => { createdPane = value; })), Effect.uninterruptible);
      yield* tmux("set-option", "-p", "-t", pane, "@c4view-owner", owner);
    }
    const started = yield* tmux("display-message", "-p", "-t", pane, "#{pane_start_command}");
    yield* tmux("set-option", "-p", "-t", pane, "@c4view-command", started);
    const text = yield* io("Tmux.ready", () => readFile(ready, "utf8")).pipe(
      Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed(undefined)),
      Effect.repeat({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 99 })), while: value => !value }));
    if (!text) return yield* Effect.fail(failure("Tmux.ready", `Viewer in ${pane} did not become ready. Inspect that pane for errors.`));
    const status = yield* Schema.decodeUnknownEffect(Ready)(yield* json(text));
    if ("error" in status) return yield* Effect.fail(failure("Tmux.ready", status.error));
    yield* requireVisible(pane);
    readyPane = true;
    return { pane, project: options.view.project, view: options.view.id, renderer: options.renderer, protocol: status.protocol,
      ...(exported ? { image: exported.image } : {}) };
}, Effect.scoped);
