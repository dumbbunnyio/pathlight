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

const help = `c4view list [--workspace PATH]
c4view show VIEW [--workspace PATH] [--project NAME] [--pane %ID] [--socket PATH] [--renderer native|png]
c4view view VIEW [--workspace PATH] [--project NAME] [--renderer native|png]
c4view record --workspace PATH < claude-hook.json

show opens or updates an owned tmux pane. view runs in the current terminal.
Use --pane explicitly when launching from a background agent service.
Add --session ID --source opencode|claude for the live activity panel.
Native is the default. PNG mode accepts --protocol ${protocols.join("|")}.
`;

const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
process.on("SIGHUP", () => abort.abort());
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
    },
  });
  const [command, id, ...extra] = positionals;
  readyPath = values.ready;
  await Effect.runPromise(Effect.gen(function* () {
  const renderer = yield* Schema.decodeUnknownEffect(RenderMode)(values.renderer);
  const protocol = yield* Schema.decodeUnknownEffect(Protocol)(values.protocol);
  const activity = values.session ? yield* Schema.decodeUnknownEffect(ActivityBinding)({ source: values.source, session: values.session }) : undefined;
  if (values.help || !command) process.stdout.write(help);
  else if (extra.length) return yield* Effect.fail(failure("CLI.arguments", "Too many arguments. Use --help."));
  else if (command === "list") {
    if (id) return yield* Effect.fail(failure("CLI.arguments", "list takes no view ID. Use --workspace PATH."));
    process.stdout.write(`${JSON.stringify(yield* listViews(values.workspace), null, 2)}\n`);
  } else if (command === "record") {
    yield* readActivityConfig(values.workspace);
    const input = yield* io("CLI.stdin", async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of Bun.stdin.stream()) {
      bytes += chunk.byteLength;
      if (bytes > 1_048_576) throw new Error("Hook input exceeds 1 MiB.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
    });
    const event = yield* claudeActivity(resolve(values.workspace), yield* json(input));
    yield* writeActivity(values.workspace, event);
  } else if (command === "image") {
    if (!id) return yield* Effect.fail(failure("CLI.arguments", "Missing image path."));
    const { viewImage } = yield* io("CLI.viewer", () => import("./viewer"));
    yield* viewImage({ image: resolve(id), title: values.title ?? id, protocol, ready: values.ready,
      ...(activity ? { activity: { ...activity, workspace: resolve(values.workspace) } } : {}) });
  } else if (command === "show" || command === "view") {
    if (renderer === "native" && protocol !== "auto") return yield* Effect.fail(failure("CLI.arguments", "--protocol applies only to --renderer png."));
    if (!id) return yield* Effect.fail(failure("CLI.arguments", "Missing view ID. Use c4view list."));
    const pane = values.pane ?? (yield* Config.String("TMUX_PANE").pipe(Config.withDefault("")));
    if (command === "show" && !pane) {
      return yield* Effect.fail(failure("CLI.arguments", "No tmux pane. Run inside tmux, pass --pane %ID, or use c4view view in a terminal."));
    }
    const view = yield* selectView(values.workspace, id, values.project);
    if (command === "show" && pane) {
      const result = yield* showView({ view, pane, socket: values.socket, renderer, protocol, activity });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (renderer === "native") {
      const { viewNative } = yield* io("CLI.viewer", () => import("./native-viewer"));
      yield* viewNative({ view, activity, ready: values.ready });
    } else {
      if (activity) yield* validateActivityMapping(view, yield* readActivityConfig(view.workspace));
      const { image } = yield* exportView(view);
      const { viewImage } = yield* io("CLI.viewer", () => import("./viewer"));
      yield* viewImage({ image, title: `${view.project} / ${view.title}`, protocol, ready: values.ready,
        ...(activity ? { activity: { ...activity, workspace: view.workspace } } : {}) });
    }
  } else return yield* Effect.fail(failure("CLI.arguments", `Unknown command '${command}'. Use --help.`));
  }), { signal: abort.signal });
} catch (error) {
  if (readyPath) await Effect.runPromise(writeReady(readyPath, { error: error instanceof Error ? error.message : String(error) }).pipe(Effect.ignore));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
