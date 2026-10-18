#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { listViews, selectView, validateActivityMapping } from "./catalog";
import { exportView } from "./export";
import { Protocol, RenderMode, protocols } from "./protocol";
import { Config, Effect, Schema } from "effect";
import { io, json, failure } from "./effects";
import { writeReady } from "./ready";
import { showView } from "./tmux";
import { ActivityBinding, readActivityConfig, writeActivity } from "./activity";
import { claudeActivity } from "./claude";
import { initWorkspace } from "./init";

const help = `c4view list [--workspace PATH]
c4view init [--workspace PATH]
c4view show VIEW [--workspace PATH] [--project NAME] [--pane %ID] [--socket PATH] [--renderer native|png]
c4view view VIEW [--workspace PATH] [--project NAME] [--renderer native|png]
c4view record --workspace PATH < claude-hook.json

init wires Claude Code hooks, a /c4view command and the OpenCode plugin into a workspace.
show opens or updates an owned tmux pane. view runs in the current terminal.
Use --pane explicitly when launching from a background agent service.
Add --follow to watch the most recently active recorded session, or
--session ID --source opencode|claude to bind to one session.
Native is the default. PNG mode accepts --protocol ${protocols.join("|")}.
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
      protocol: { type: "string", default: "auto" },
      renderer: { type: "string", default: "native" },
      title: { type: "string" }, ready: { type: "string" }, help: { type: "boolean" },
      session: { type: "string" }, source: { type: "string", default: "opencode" },
      follow: { type: "boolean" },
    },
  });
  const [command, id, ...extra] = positionals;
  readyPath = values.ready;
  await Effect.runPromise(Effect.gen(function* () {
    const renderer = yield* Schema.decodeUnknownEffect(RenderMode)(values.renderer);
    const protocol = yield* Schema.decodeUnknownEffect(Protocol)(values.protocol);
    const activity = values.session ? yield* Schema.decodeUnknownEffect(ActivityBinding)({ source: values.source, session: values.session }) : undefined;
    const follow = values.follow === true;
    const invalid = (message: string) => Effect.fail(failure("CLI.arguments", message));
    if (values.help || !command) return void process.stdout.write(help);
    if (extra.length) return yield* invalid("Too many arguments. Use --help.");
    if (follow && activity) return yield* invalid("Use either --follow or --session, not both.");
    if (follow && renderer !== "native") return yield* invalid("--follow applies only to --renderer native.");

    if (command === "list") {
      if (id) return yield* invalid("list takes no view ID. Use --workspace PATH.");
      process.stdout.write(`${JSON.stringify(yield* listViews(values.workspace), null, 2)}\n`);
    } else if (command === "init") {
      if (id) return yield* invalid("init takes no argument. Use --workspace PATH.");
      process.stdout.write(`${(yield* initWorkspace(values.workspace)).join("\n")}\n`);
    } else if (command === "record") {
      yield* readActivityConfig(values.workspace);
      const event = yield* claudeActivity(resolve(values.workspace), yield* json(yield* readStdin));
      yield* writeActivity(values.workspace, event);
    } else if (command === "image") {
      if (!id) return yield* invalid("Missing image path.");
      const { viewImage } = yield* io("CLI.viewer", () => import("./viewer"));
      yield* viewImage({ image: resolve(id), title: values.title ?? id, protocol, ready: values.ready,
        ...(activity ? { activity: { ...activity, workspace: resolve(values.workspace) } } : {}) });
    } else if (command === "show" || command === "view") {
      if (renderer === "native" && protocol !== "auto") return yield* invalid("--protocol applies only to --renderer png.");
      if (!id) return yield* invalid("Missing view ID. Use c4view list.");
      const pane = values.pane ?? (yield* Config.String("TMUX_PANE").pipe(Config.withDefault("")));
      if (command === "show" && !pane) {
        return yield* invalid("No tmux pane. Run inside tmux, pass --pane %ID, or use c4view view in a terminal.");
      }
      const view = yield* selectView(values.workspace, id, values.project);
      if (command === "show") {
        const result = yield* showView({ view, pane, socket: values.socket, renderer, protocol, activity, follow });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (renderer === "native") {
        const { viewNative } = yield* io("CLI.viewer", () => import("./native-viewer"));
        yield* viewNative({ view, activity, follow, ready: values.ready });
      } else {
        if (activity) yield* validateActivityMapping(view, yield* readActivityConfig(view.workspace));
        const { image } = yield* exportView(view);
        const { viewImage } = yield* io("CLI.viewer", () => import("./viewer"));
        yield* viewImage({ image, title: `${view.project} / ${view.title}`, protocol, ready: values.ready,
          ...(activity ? { activity: { ...activity, workspace: view.workspace } } : {}) });
      }
    } else return yield* invalid(`Unknown command '${command}'. Use --help.`);
  }), { signal: abort.signal });
} catch (error) {
  if (readyPath) await Effect.runPromise(writeReady(readyPath, { error: error instanceof Error ? error.message : String(error) }).pipe(Effect.ignore));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
