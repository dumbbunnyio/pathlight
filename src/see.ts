import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schedule, Schema } from "effect";
import { failure, hasCode, io, json } from "./effects";
import { run } from "./process";
import { Ready } from "./ready";
import type { View } from "./catalog";

const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");

/**
 * The screen of a view, as text, with no terminal of the user's involved: the viewer runs in a private tmux server of its own at the size asked for
 * (so the same view and size always draw the same cells), is given the keys, and is captured once the picture has stopped changing. An agent cannot
 * look at the viewer, so this is how it checks what a person would see; the tests use it to compare screens against snapshots.
 *
 * It never reads a saved theme (the config directory is empty) and never touches another tmux server or pane. With `agent`, a pane running `cat`
 * in the same private server stands in for the agent's pane, so the talk and the review can be opened and what they type goes nowhere else.
 */
export const seeView = Effect.fn("See.view")(function* (options: { view: View; cols: number; rows: number; select?: string; keys?: readonly string[]; ansi?: boolean; follow?: boolean; agent?: boolean }) {
  const directory = yield* Effect.acquireRelease(io("See.directory", () => mkdtemp(join(tmpdir(), "pathlight-see-"))), path => io("See.remove", () => rm(path, { recursive: true, force: true })).pipe(Effect.ignore));
  const socket = join(directory, "tmux.sock"), ready = join(directory, "ready.json"), config = join(directory, "config");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, "-f", "/dev/null", ...args]);
  yield* Effect.addFinalizer(() => tmux("kill-server").pipe(Effect.ignore));
  const size = ["-x", String(options.cols), "-y", String(options.rows)];
  const agent = options.agent ? (yield* tmux("new-session", "-d", "-s", "see", ...size, "-P", "-F", "#{pane_id}", "cat")).trim() : undefined;
  const viewer = [process.execPath, ...(compiled ? [] : [fileURLToPath(new URL("./cli.ts", import.meta.url))]),
    "view", options.view.id, "--workspace", options.view.workspace, "--project", options.view.project, "--ready", ready, ...(options.select ? ["--select", options.select] : []), ...(options.follow ? ["--follow"] : []),
    ...(agent ? ["--parent", agent] : [])];
  const environment = ["env", `XDG_CONFIG_HOME=${config}`, "COLORTERM=truecolor", ...viewer];
  // The viewer's window is the session's current one, so the keys and the captures go to it.
  if (agent) yield* tmux("new-window", "-t", "see", ...environment);
  else yield* tmux("new-session", "-d", "-s", "see", ...size, ...environment);

  const text = yield* io("See.ready", () => readFile(ready, "utf8")).pipe(
    Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed(undefined)),
    Effect.repeat({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 299 })), while: value => !value }));
  if (!text) return yield* Effect.fail(failure("See.ready", "The viewer did not draw within 30 seconds."));
  const status = yield* Schema.decodeUnknownEffect(Ready)(yield* json(text));
  if ("error" in status) return yield* Effect.fail(failure("See.ready", status.error));

  // Through a buffer and a file, not stdout: the process helper trims its output, which would shift the first row's leading spaces.
  const grab = join(directory, "screen.txt");
  const capture = Effect.fn("See.capture")(function* () {
    yield* tmux("capture-pane", ...(options.ansi ? ["-e"] : []), "-N", "-b", "see", "-t", "see");
    yield* tmux("save-buffer", "-b", "see", grab);
    return yield* io("See.read", () => readFile(grab, "utf8"));
  });
  // A picture has settled when two captures a moment apart agree: the camera eases and the first view blooms in for a short while after it is ready.
  const settled = Effect.fn("See.settle")(function* () {
    let previous = yield* capture();
    for (let attempt = 0; attempt < 40; attempt++) {
      yield* Effect.sleep("150 millis");
      const current = yield* capture();
      if (current === previous) return current;
      previous = current;
    }
    return yield* Effect.fail(failure("See.settle", "The screen kept changing for 6 seconds, so there is no single picture to show."));
  });
  yield* settled();
  for (const key of options.keys ?? []) {
    yield* tmux("send-keys", "-t", "see", key);
    yield* Effect.sleep("100 millis");
    yield* settled();
  }
  const screen = yield* settled();
  // The cursor-addressed grid ends in blank rows; keep every row so columns stay where they are, but drop trailing blanks at the bottom.
  return screen.replace(/(\n\s*)+$/, "\n");
}, Effect.scoped);
