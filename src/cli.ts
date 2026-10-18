#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { listViews, selectView } from "./catalog";
import { Config, Effect, Schema } from "effect";
import { io, json, failure } from "./effects";
import { writeReady } from "./ready";
import { showView } from "./tmux";
import { ActivityBinding, readActivityConfig, writeActivity } from "./activity";
import { claudeActivity } from "./claude";
import { initWorkspace } from "./init";

const help = `c4view list [--workspace PATH]
c4view init [--workspace PATH] [--no-claude-hooks]
c4view show VIEW [--workspace PATH] [--project NAME] [--pane %ID] [--socket PATH]
c4view view VIEW [--workspace PATH] [--project NAME]
c4view record --workspace PATH < claude-hook.json

init wires Claude Code hooks, a /c4view command and the OpenCode plugin into a workspace.
show opens or updates an owned tmux pane. view runs in the current terminal.
Use --pane explicitly when launching from a background agent service.
Add --follow to watch the most recently active recorded session, or
--session ID --source opencode|claude to bind to one session.
`;

const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
process.on("SIGHUP", () => abort.abort());

const readStdin = io("CLI.stdin", async () => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.byteLength;
    if (bytes > 1_048_576) throw new Error("Hook input exceeds 1 MiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
});

let readyPath: string | undefined;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: {
      workspace: { type: "string", default: "." }, project: { type: "string" },
      pane: { type: "string" }, socket: { type: "string" },
      ready: { type: "string" }, help: { type: "boolean" },
      session: { type: "string" }, source: { type: "string", default: "opencode" },
      follow: { type: "boolean" }, parent: { type: "string" }, "no-claude-hooks": { type: "boolean" },
    },
  });
  const [command, id, ...extra] = positionals;
  readyPath = values.ready;
  await Effect.runPromise(Effect.gen(function* () {
    const activity = values.session ? yield* Schema.decodeUnknownEffect(ActivityBinding)({ source: values.source, session: values.session }) : undefined;
    const follow = values.follow === true;
    const invalid = (message: string) => Effect.fail(failure("CLI.arguments", message));
    if (values.help || !command) return void process.stdout.write(help);
    if (extra.length) return yield* invalid("Too many arguments. Use --help.");
    if (follow && activity) return yield* invalid("Use either --follow or --session, not both.");

    if (command === "list") {
      if (id) return yield* invalid("list takes no view ID. Use --workspace PATH.");
      process.stdout.write(`${JSON.stringify(yield* listViews(values.workspace), null, 2)}\n`);
    } else if (command === "init") {
      if (id) return yield* invalid("init takes no argument. Use --workspace PATH.");
      process.stdout.write(`${(yield* initWorkspace(values.workspace, { claudeHooks: !values["no-claude-hooks"] })).join("\n")}\n`);
    } else if (command === "record") {
      yield* readActivityConfig(values.workspace);
      const event = yield* claudeActivity(resolve(values.workspace), yield* json(yield* readStdin));
      yield* writeActivity(values.workspace, event);
    } else if (command === "show" || command === "view") {
      if (!id) return yield* invalid("Missing view ID. Use c4view list.");
      const pane = values.pane ?? (yield* Config.String("TMUX_PANE").pipe(Config.withDefault("")));
      if (command === "show" && !pane) {
        return yield* invalid("No tmux pane. Run inside tmux, pass --pane %ID, or use c4view view in a terminal.");
      }
      if (command === "view" && process.stdout.isTTY) process.stdout.write("\x1b[2m  c4view · loading the architecture…\x1b[0m\n");
      const view = yield* selectView(values.workspace, id, values.project);
      if (command === "show") {
        const result = yield* showView({ view, pane, socket: values.socket, activity, follow });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const { viewNative } = yield* io("CLI.viewer", () => import("./native-viewer"));
        yield* viewNative({ view, activity, follow, parent: values.parent, ready: values.ready });
      }
    } else return yield* invalid(`Unknown command '${command}'. Use --help.`);
  }), { signal: abort.signal });
} catch (error) {
  if (readyPath) await Effect.runPromise(writeReady(readyPath, { error: error instanceof Error ? error.message : String(error) }).pipe(Effect.ignore));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
