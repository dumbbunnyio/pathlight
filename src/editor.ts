import { spawn } from "node:child_process";
import { Config, Effect } from "effect";
import { editorFile } from "./node-files";
import { attempt, failure, hasCode, io } from "./effects";
import { run } from "./process";

/**
 * The shell command that opens `$1` in the editor, at `line` when the editor is one whose way of taking a line we know (`+N file` for the vi family,
 * nano, emacs, micro and kakoune; `file:N` for helix). Any other editor opens the file at the top: a guessed flag could open the wrong file or none.
 */
export function editorCommand(editor: string, line?: number) {
  const program = editor.trim().split(/\s+/)[0]?.split("/").at(-1) ?? "";
  if (line === undefined || !Number.isInteger(line) || line < 1) return `exec ${editor} "$1"`;
  if (/^(n?vim?|view|gvim|nano|emacs(client)?|micro|kak)$/.test(program)) return `exec ${editor} +${line} "$1"`;
  if (/^(hx|helix)$/.test(program)) return `exec ${editor} "$1:${line}"`;
  return `exec ${editor} "$1"`;
}

/** The first line a file's uncommitted changes touch (against HEAD), so opening it lands on what changed; undefined when it has none or is not in git. */
export const firstChange = (workspace: string, path: string) => run("git", ["-C", workspace, "diff", "--relative", "--no-color", "-U0", "HEAD", "--", path]).pipe(
  Effect.map(text => { const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(text); return hunk ? Math.max(1, Number(hunk[1])) : undefined; }),
  Effect.catch(() => Effect.succeed(undefined)));

export const openEditor = Effect.fn("Editor.open")(function* (options: { workspace: string; path: string; line?: number }) {
  const file = yield* editorFile(options.workspace, options.path);
  const visual = yield* Config.String("VISUAL").pipe(Config.withDefault(""));
  const fallback = yield* Config.String("EDITOR").pipe(Config.withDefault(""));
  const editor = visual.trim() || fallback.trim();
  if (!editor) return yield* Effect.fail(failure("Editor.config", "Set VISUAL or EDITOR before starting the viewer. For GUI editors, include a wait flag."));
  const child = yield* Effect.acquireRelease(attempt("Editor.spawn", () => {
    const child = spawn("sh", ["-c", editorCommand(editor, options.line), "pathlight-editor", file], {
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
