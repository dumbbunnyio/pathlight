import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { Config, Effect, Schedule, Schema } from "effect";
import { io, failure, hasCode, json } from "./effects";
import { run } from "./process";
import { validateActivityMapping, type View } from "./catalog";
import { readActivityConfig, type ActivityBinding } from "./activity";
import { Ready } from "./ready";

export const showView = Effect.fn("Tmux.show")(function* (options: {
  view: View; pane: string; socket?: string; activity?: ActivityBinding; follow?: boolean;
}) {
  if (!/^%\d+$/.test(options.pane)) return yield* Effect.fail(failure("Tmux.pane", "Pass an exact tmux pane ID, such as %2."));
  const tmux = (...args: string[]) => run("tmux", [
    ...(options.socket ? ["-S", options.socket] : []), ...args,
  ]);
  if (options.activity || options.follow) yield* validateActivityMapping(options.view, yield* readActivityConfig(options.view.workspace));
  const socket = yield* tmux("display-message", "-p", "-t", options.pane, "#{socket_path}");
  const owner = createHash("sha256").update(`${socket}\0${options.pane}\0${options.view.workspace}`).digest("hex");
  const cache = join(options.view.workspace, ".cache", "pathlight");
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
    const directory = yield* io("Tmux.directory", () => mkdtemp(join(cache, "native-")));
    const ready = join(directory, "ready.json");
    const args = [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "view", options.view.id, "--workspace", options.view.workspace, "--project", options.view.project, "--parent", options.pane, "--ready", ready];
    const editorEnvironment: string[] = [];
    for (const key of ["VISUAL", "EDITOR"]) {
      const value = yield* Config.String(key).pipe(Config.withDefault(""));
      if (value) editorEnvironment.push("-e", `${key}=${value}`);
    }
    if (options.activity) {
      args.push("--session", options.activity.session, "--source", options.activity.source);
    }
    if (options.follow) args.push("--follow");
    const panes = yield* tmux("list-panes", "-a", "-F", "#{pane_id}\t#{@pathlight-owner}\t#{pane_current_command}\t#{pane_dead}\t#{pane_start_command}\t#{@pathlight-command}");
    const existing = panes.split("\n").map(line => line.split("\t"))
      .find(([, tag, command, dead, started, expected]) =>
        tag === owner && started === expected && !!expected && (command === "bun" || dead === "1"));
    let pane = existing?.[0];
    if (pane) {
      const owned = pane;
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
      yield* tmux("set-option", "-p", "-t", pane, "@pathlight-owner", owner);
    }
    const started = yield* tmux("display-message", "-p", "-t", pane, "#{pane_start_command}");
    yield* tmux("set-option", "-p", "-t", pane, "@pathlight-command", started);
    const text = yield* io("Tmux.ready", () => readFile(ready, "utf8")).pipe(
      Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed(undefined)),
      Effect.repeat({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 99 })), while: value => !value }));
    if (!text) return yield* Effect.fail(failure("Tmux.ready", `Viewer in ${pane} did not become ready. Inspect that pane for errors.`));
    const status = yield* Schema.decodeUnknownEffect(Ready)(yield* json(text));
    if ("error" in status) return yield* Effect.fail(failure("Tmux.ready", status.error));
    readyPane = true;
    return { pane, project: options.view.project, view: options.view.id };
}, Effect.scoped);
