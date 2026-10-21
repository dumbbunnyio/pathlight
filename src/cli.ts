#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listViews, overviewId, selectView } from "./catalog";
import { Config, Effect, Schema } from "effect";
import { io, json, failure } from "./effects";
import { writeReady } from "./ready";
import { atShellPrompt, showView } from "./tmux";
import { ActivityBinding, readActivityConfig, writeActivity } from "./activity";
import { claudeActivity, claudeIgnores } from "./claude";
import { initWorkspace } from "./init";
import { scanWorkspace } from "./scan";
import { draftWorkspace } from "./draft";
import { checkAndRecord } from "./stale";
import { setPlan } from "./plan";
import { diffWorkspace, formatDiff, recordDiff } from "./diff";
import { formatCheck, hasFindings } from "./check";

const help = `pathlight list [--workspace PATH]
pathlight scan [--workspace PATH] [--out FILE]
pathlight check [--workspace PATH] [--json] [--strict] [--quiet]
pathlight diff [--workspace PATH] [--base REV] [--json] [--quiet]
pathlight plan [ELEMENT ...] [--workspace PATH]
pathlight draft [--workspace PATH] [--out DIR] [--force]
pathlight init [--workspace PATH] [--no-claude-hooks]
pathlight show VIEW [--workspace PATH] [--project NAME] [--pane %ID] [--socket PATH]
pathlight view VIEW [--workspace PATH] [--project NAME]
pathlight open [VIEW] [--workspace PATH] [--project NAME] [--here | --split] [--pane %ID] [--socket PATH]
pathlight record --workspace PATH < claude-hook.json

scan reads the source statically and prints files, imports and what it could not read as JSON.
check compares the LikeC4 model and pathlight.activity.json with that scan: unmatched globs, unmapped files,
relationships with no import behind them and imports with no relationship. --strict exits 1 if anything is found. --quiet prints nothing (the Stop hook uses it); every check records its counts for the viewer's out-of-date badge.
diff compares the relationships the imports support now with those at a git commit (default HEAD): which the working tree added or lost, and new imports with no relationship. The viewer draws them; static evidence only.
plan says which elements you are about to work on (ids from the model); the viewer outlines them and marks activity outside them. No ids clears the plan.
draft writes a first architecture picture made from the code alone (packages, folders and the imports between them), with no model
in the loop. It never rewrites a LikeC4 model you wrote: use --out DIR, or --force to replace one.
init wires Claude Code hooks, the pathlight skill and the OpenCode plugin into a workspace.
show opens or updates an owned tmux pane. view runs in the current terminal.
open follows the most recent session and shows VIEW if given, else the view named index, else the first view.
Typed at a shell prompt in tmux it turns that pane into the viewer; run by an agent it splits a pane beside it.
--here always uses the current terminal and --split always splits.
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
      follow: { type: "boolean" }, out: { type: "string" }, json: { type: "boolean" }, strict: { type: "boolean" }, quiet: { type: "boolean" }, base: { type: "string" }, parent: { type: "string" }, "no-claude-hooks": { type: "boolean" }, force: { type: "boolean" }, here: { type: "boolean" }, split: { type: "boolean" },
    },
  });
  const [command, id, ...extra] = positionals;
  readyPath = values.ready;
  await Effect.runPromise(Effect.gen(function* () {
    const activity = values.session ? yield* Schema.decodeUnknownEffect(ActivityBinding)({ source: values.source, session: values.session }) : undefined;
    const follow = values.follow === true;
    const invalid = (message: string) => Effect.fail(failure("CLI.arguments", message));
    if (values.help || !command) return void process.stdout.write(help);
    if (extra.length && command !== "plan") return yield* invalid("Too many arguments. Use --help.");
    if (follow && activity) return yield* invalid("Use either --follow or --session, not both.");

    if (command === "list") {
      if (id) return yield* invalid("list takes no view ID. Use --workspace PATH.");
      process.stdout.write(`${JSON.stringify(yield* listViews(values.workspace), null, 2)}\n`);
    } else if (command === "scan") {
      if (id) return yield* invalid("scan takes no argument. Use --workspace PATH.");
      const text = `${JSON.stringify(yield* scanWorkspace(values.workspace), null, 2)}\n`;
      if (values.out) yield* io("CLI.writeScan", () => writeFile(values.out!, text));
      else process.stdout.write(text);
    } else if (command === "draft") {
      if (id) return yield* invalid("draft takes no argument. Use --workspace PATH.");
      const made = yield* draftWorkspace(values.workspace, { out: values.out, force: values.force });
      process.stdout.write(`Drew ${made.elements} elements (${made.packages ? `${made.packages} packages, ` : ""}${made.components} components${made.collections ? `, ${made.collections} collections` : ""}) and ${made.relationships} relationships from the imports.\n`
        + `${made.mappings} file mappings; ${made.ignored} test files left out.\nWrote pathlight.model.c4, pathlight.activity.json and likec4.config.json in ${made.target}.\n`
        + (made.overlay ? `Applied ${made.overlay} names or notes from pathlight.overlay.json.\n` : "")
        + (made.unknown.length ? `Overlay keys that match nothing in the code now (remove or fix them): ${made.unknown.join(", ")}\n` : ""));
    } else if (command === "check") {
      if (id) return yield* invalid("check takes no argument. Use --workspace PATH.");
      const check = yield* checkAndRecord(values.workspace);
      if (!values.quiet) process.stdout.write(values.json ? `${JSON.stringify(check, null, 2)}\n` : formatCheck(check));
      if (values.strict && hasFindings(check)) process.exitCode = 1;
    } else if (command === "plan") {
      const made = yield* setPlan(values.workspace, [...(id ? [id] : []), ...extra]);
      process.stdout.write(made ? `Plan: ${made.elements.join(", ")}\n` : "Plan cleared.\n");
    } else if (command === "diff") {
      if (id) return yield* invalid("diff takes no argument. Use --base REV and --workspace PATH.");
      const diff = yield* diffWorkspace(values.workspace, values.base);
      yield* recordDiff(values.workspace, diff);
      if (!values.quiet) process.stdout.write(values.json ? `${JSON.stringify(diff, null, 2)}\n` : formatDiff(diff));
    } else if (command === "init") {
      if (id) return yield* invalid("init takes no argument. Use --workspace PATH.");
      process.stdout.write(`${(yield* initWorkspace(values.workspace, { claudeHooks: !values["no-claude-hooks"] })).join("\n")}\n`);
    } else if (command === "record") {
      yield* readActivityConfig(values.workspace);
      const input = yield* json(yield* readStdin);
      if (!claudeIgnores(input)) yield* writeActivity(values.workspace, yield* claudeActivity(resolve(values.workspace), input));
    } else if (command === "show" || command === "view" || command === "open") {
      if (!id && command !== "open") return yield* invalid("Missing view ID. Use pathlight list.");
      const pane = values.pane ?? (yield* Config.String("TMUX_PANE").pipe(Config.withDefault("")));
      if (command === "open" && values.here && values.split) return yield* invalid("Use either --here or --split, not both.");
      const here = command === "view" || (command === "open" && !values.split && (values.here === true || (yield* atShellPrompt(pane, values.socket))));
      if (!here && !pane) {
        return yield* invalid("No tmux pane. Run inside tmux, pass --pane %ID, or use pathlight open --here in a terminal.");
      }
      if (here && process.stdout.isTTY) process.stdout.write("\x1b[2m  pathlight · loading the architecture…\x1b[0m\n");
      // `open` follows the agent when the workspace maps files to components; without a mapping there is nothing to follow.
      const mapped = command !== "open" || (yield* io("CLI.mapping", () => Bun.file(resolve(values.workspace, "pathlight.activity.json")).exists()));
      if (!mapped) process.stderr.write("No pathlight.activity.json here, so the viewer will not follow an agent. Ask the agent to map the model (/pathlight).\n");
      const following = follow || (command === "open" && !activity && mapped);
      // The mapping names the project the agent's files belong to, so a workspace with several LikeC4 projects needs no --project: it is
      // taken from pathlight.activity.json, unless the named view exists only in another project.
      const mappedProject = values.project ? undefined : yield* readActivityConfig(values.workspace).pipe(Effect.map(mapping => mapping.project), Effect.catch(() => Effect.succeed(undefined)));
      const project = values.project ?? (mappedProject && (!id || (yield* listViews(values.workspace)).views.some(entry => entry.id === id && entry.project === mappedProject)) ? mappedProject : undefined);
      const overview = command === "open" && !id ? yield* overviewId(values.workspace, project) : id;
      const view = yield* selectView(values.workspace, overview!, project);
      if (!here) {
        const result = yield* showView({ view, pane, socket: values.socket, activity, follow: following });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const { viewNative } = yield* io("CLI.viewer", () => import("./native-viewer"));
        yield* viewNative({ view, activity, follow: following, parent: values.parent, ready: values.ready });
      }
    } else return yield* invalid(`Unknown command '${command}'. Use --help.`);
  }), { signal: abort.signal });
} catch (error) {
  if (readyPath) await Effect.runPromise(writeReady(readyPath, { error: error instanceof Error ? error.message : String(error) }).pipe(Effect.ignore));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
