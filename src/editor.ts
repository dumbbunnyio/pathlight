import { spawn } from "node:child_process";
import { Config, Effect } from "effect";
import { editorFile } from "./node-files";
import { attempt, failure, hasCode, io } from "./effects";

export const openEditor = Effect.fn("Editor.open")(function* (options: { workspace: string; path: string }) {
  const file = yield* editorFile(options.workspace, options.path);
  const visual = yield* Config.String("VISUAL").pipe(Config.withDefault(""));
  const fallback = yield* Config.String("EDITOR").pipe(Config.withDefault(""));
  const editor = visual.trim() || fallback.trim();
  if (!editor) return yield* Effect.fail(failure("Editor.config", "Set VISUAL or EDITOR before starting the viewer. For GUI editors, include a wait flag."));
  const child = yield* Effect.acquireRelease(attempt("Editor.spawn", () => {
    const child = spawn("sh", ["-c", `exec ${editor} "$1"`, "c4view-editor", file], {
      cwd: options.workspace, stdio: "inherit", detached: true,
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(
        `Editor exited ${signal ? `with ${signal}` : `with status ${code}`}. Check VISUAL or EDITOR.`,
      )));
    });
    void exited.catch(() => {});
    return { child, exited, completed: false };
  }), state => Effect.gen(function* () {
    if (state.completed) return;
    const kill = (signal: NodeJS.Signals) => attempt("Editor.killGroup", () => {
      if (state.child.pid) process.kill(-state.child.pid, signal);
    }).pipe(Effect.catchIf(error => hasCode(error, "ESRCH"), () => Effect.void));
    yield* kill("SIGTERM");
    yield* Effect.sleep("1 second");
    yield* kill("SIGKILL");
    yield* io("Editor.exit", () => state.exited).pipe(Effect.ignore);
  }).pipe(Effect.orDie));
  const resize = () => {
    if (!child.child.pid) return;
    try { process.kill(-child.child.pid, "SIGWINCH"); }
    catch (error) { if (!hasCode(error, "ESRCH")) throw error; }
  };
  yield* Effect.acquireRelease(Effect.sync(() => process.on("SIGWINCH", resize)),
    () => Effect.sync(() => { process.off("SIGWINCH", resize); }));
  yield* io("Editor.wait", () => child.exited).pipe(Effect.onExit(exit => Effect.sync(() => {
    if (exit._tag === "Success") child.completed = true;
  })));
}, Effect.scoped);
