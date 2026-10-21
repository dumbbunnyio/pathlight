import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, open, readFile, unlink } from "node:fs/promises";
import { Config, Effect, Schedule, Schema } from "effect";
import { io, failure, hasCode, json } from "./effects";
import { run } from "./process";
import { validateActivityMapping, type View } from "./catalog";
import { readActivityConfig, type ActivityBinding } from "./activity";
import { Ready } from "./ready";

/**
 * True when this process was typed at a shell prompt in `pane`, so that pane holds nothing but the shell and can become
 * the viewer. A command run by an agent (`! pathlight open` inside Claude Code, a tool call) has the agent between the
 * pane's shell and itself, so it is not the shell's direct child. Anything unclear answers false, which means "split".
 */
export const atShellPrompt = Effect.fn("Tmux.atShellPrompt")(function* (pane: string, socket?: string) {
  if (!/^%\d+$/.test(pane)) return false;
  const pid = yield* run("tmux", [...(socket ? ["-S", socket] : []), "display-message", "-p", "-t", pane, "#{pane_pid}"]).pipe(Effect.catch(() => Effect.succeed("")));
  return pid.trim() === String(process.ppid);
});

/**
 * One viewer request per pane at a time. The lock is a file created exclusively and holding the owner's process id, released when the
 * scope closes; a file left by a process that no longer exists is replaced. Plain filesystem calls, so it works on macOS and Linux alike.
 */
export const acquireLock = (path: string) => Effect.acquireRelease(
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 3; attempt++) {
      const created = yield* io("Tmux.lock", async () => {
        const handle = await open(path, "wx", 0o600).catch(error => hasCode(error, "EEXIST") ? undefined : Promise.reject(error));
        if (!handle) return false;
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        return true;
      });
      if (created) return;
      const holder = Number((yield* io("Tmux.lockOwner", () => readFile(path, "utf8")).pipe(Effect.catch(() => Effect.succeed("")))).trim());
      const alive = Number.isInteger(holder) && holder > 0 && (() => { try { process.kill(holder, 0); return true; } catch (error) { return hasCode(error, "EPERM"); } })();
      if (alive) return yield* Effect.fail(failure("Tmux.lock", "Another diagram request is in progress for this pane. Retry after it finishes."));
      yield* io("Tmux.lockStale", () => unlink(path)).pipe(Effect.ignore);
    }
    return yield* Effect.fail(failure("Tmux.lock", "Could not acquire the viewer lock."));
  }).pipe(Effect.uninterruptible),
  () => io("Tmux.unlock", () => unlink(path)).pipe(Effect.ignore));

const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");

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
  let createdPane: string | undefined;
  let readyPane = false;
  yield* Effect.addFinalizer(() => createdPane && !readyPane ? tmux("kill-pane", "-t", createdPane).pipe(Effect.ignore) : Effect.void);
    yield* acquireLock(join(cache, `${owner}.lock`));
    const directory = yield* io("Tmux.directory", () => mkdtemp(join(cache, "native-")));
    const ready = join(directory, "ready.json");
    // Run from source the viewer is `bun src/cli.ts view ...`; in a compiled binary the executable is the program and has no script to name.
    const args = [process.execPath, ...(compiled ? [] : [fileURLToPath(new URL("./cli.ts", import.meta.url))]),
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
    // The viewer's process is bun from source and the binary itself when compiled; tmux may shorten a long name.
    const runner = basename(process.execPath);
    const panes = yield* tmux("list-panes", "-a", "-F", "#{pane_id}\t#{@pathlight-owner}\t#{pane_current_command}\t#{pane_dead}\t#{pane_start_command}\t#{@pathlight-command}");
    const existing = panes.split("\n").map(line => line.split("\t"))
      .find(([, tag, command, dead, started, expected]) =>
        tag === owner && started === expected && !!expected && (!!command && runner.startsWith(command) || dead === "1"));
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
