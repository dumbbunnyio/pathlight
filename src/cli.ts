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
import { mappingPath } from "./layout";
import { claudeActivity, claudeIgnores } from "./claude";
import { initWorkspace } from "./init";
import { scanWorkspace } from "./scan";
import { draftWorkspace } from "./draft";
import { checkAndRecord } from "./stale";
import { setPlan } from "./plan";
import { diffWorkspace, formatDiff, recordDiff } from "./diff";
import { formatCheck, hasFindings } from "./check";
import { checkFlows, formatFlows, hasFlowFindings } from "./flows";
import { briefOf, changedBoxes, contextOf, formatBrief, formatContext, formatNamed, nameBoxes, select, type NameEntry } from "./brief";
import { addFlow, formatAdded, removeFlow } from "./flow-write";
import { doctor, formatDoctor, hasFailures } from "./doctor";
import { setup } from "./setup";
import { seeView } from "./see";

const help = `pathlight list [--workspace PATH]
pathlight scan [--workspace PATH] [--out FILE]
pathlight check [--workspace PATH] [--json] [--strict] [--quiet]
pathlight diff [--workspace PATH] [--base REV] [--json] [--quiet]
pathlight flows [--workspace PATH] [--json] [--strict] [--quiet]
pathlight flow add ID --title TEXT --reads FILE,FILE --step "FROM -> TO: EVENT [@ FILE#FUNCTION]" ... [--workspace PATH] [--project NAME] [--force]
pathlight flow remove ID [--workspace PATH]
pathlight brief [KEY ... | --changed] [--workspace PATH] [--json]
pathlight name KEY --title TEXT --note TEXT [--workspace PATH]
pathlight name --from FILE|- [--workspace PATH]
pathlight plan [ELEMENT ...] [--workspace PATH]
pathlight draft [--workspace PATH] [--out DIR] [--force]
pathlight init [--workspace PATH] [--no-claude-hooks]
pathlight show VIEW [--workspace PATH] [--project NAME] [--pane %ID] [--socket PATH]
pathlight view VIEW [--workspace PATH] [--project NAME] [--select ELEMENT]
pathlight see VIEW [--workspace PATH] [--project NAME] [--cols N] [--rows N] [--select ELEMENT] [--keys KEY,KEY] [--ansi] [--follow]
pathlight open [VIEW] [--workspace PATH] [--project NAME] [--here | --split] [--pane %ID] [--socket PATH]
pathlight record --workspace PATH < claude-hook.json
pathlight doctor [--workspace PATH]
pathlight setup [--workspace PATH] [--yes]

scan reads the source statically and prints files, imports and what it could not read as JSON.
check compares the LikeC4 model and .pathlight/pathlight.activity.json with that scan: unmatched globs, unmapped files,
relationships with no import behind them and imports with no relationship. --strict exits 1 if anything is found. --quiet prints nothing (the Stop hook uses it); every check records its counts for the viewer's out-of-date badge.
diff compares the relationships the imports support now with those at a git commit (default HEAD): which the working tree added or lost, and new imports with no relationship. The viewer draws them; static evidence only.
flows checks the state diagrams an agent wrote (*.behavior.c4) against the files they name and the commit they were synced at: files that are gone or changed since, arrows with no event, decisions with one answer, states nothing reaches, states that name no file. A flow is the agent's reading, so this finds what is wrong or old, never that it is right. --strict exits 1 if anything is found.
flow add writes a journey you worked out from the code: a LikeC4 dynamic view of hops between components, as ID.behavior.c4, stamped with the commit and the files you read. It checks every component against the model and takes the file back out if the model would stop compiling; it decides nothing about what happens. A step can name the function it calls with a trailing @ FILE#FUNCTION: the file must be one you read and must export that name, and its declaration is copied as written (pathlight flows says when it changes). flow remove deletes only a file flow add wrote.
brief lists, for each box of the draft (or only the boxes under the keys you give, children first), the files it owns with their sizes, what it imports from and what imports it, what is inside it and any name it has: what an agent needs to say what each box is for. With no keys it opens with what the project says about itself (its package description and the start of its README). brief --changed lists only the boxes that are new or whose files changed since pathlight name recorded them, so a later run names just those. name saves the names and notes the agent worked out (one box with --title and --note, or many from a JSON file of {"key","title","note"} entries, a dash for standard input) as the agent's reading (by "agent"), redraws once, never replaces a name a person wrote, and refuses a key that is not a box.
plan says which elements you are about to work on (ids from the model); the viewer outlines them and marks activity outside them. No ids clears the plan.
draft writes a first architecture picture made from the code alone (packages, folders and the imports between them), with no model
in the loop. It never rewrites a LikeC4 model you wrote: use --out DIR, or --force to replace one.
setup is the first run: it checks the machine and the workspace, says what it would write, and with --yes draws a first model from the code when there is none. It never rewrites a model you wrote and leaves hooks and recording to init.
init wires Claude Code hooks, the pathlight skill and the OpenCode plugin into a workspace.
show opens or updates an owned tmux pane. view runs in the current terminal; --select opens it with that element selected.
see prints what the viewer would show as text, from a private tmux server at --cols by --rows (default 120 by 36), after sending --keys (tmux key names, comma separated). It never touches your panes. For agents and tests.
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
      follow: { type: "boolean" }, out: { type: "string" }, json: { type: "boolean" }, changed: { type: "boolean" }, strict: { type: "boolean" }, quiet: { type: "boolean" }, base: { type: "string" }, parent: { type: "string" }, "no-claude-hooks": { type: "boolean" }, force: { type: "boolean" }, yes: { type: "boolean" }, title: { type: "string" }, note: { type: "string" }, from: { type: "string" }, reads: { type: "string", multiple: true }, step: { type: "string", multiple: true }, here: { type: "boolean" }, split: { type: "boolean" }, select: { type: "string" }, cols: { type: "string" }, rows: { type: "string" }, keys: { type: "string" }, ansi: { type: "boolean" },
    },
  });
  const [command, id, ...extra] = positionals;
  readyPath = values.ready;
  await Effect.runPromise(Effect.gen(function* () {
    const activity = values.session ? yield* Schema.decodeUnknownEffect(ActivityBinding)({ source: values.source, session: values.session }) : undefined;
    const follow = values.follow === true;
    const invalid = (message: string) => Effect.fail(failure("CLI.arguments", message));
    if (values.help || !command) return void process.stdout.write(help);
    if (extra.length && command !== "plan" && command !== "brief" && !(command === "flow" && extra.length === 1)) return yield* invalid("Too many arguments. Use --help.");
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
        + (made.overlay ? `Applied ${made.overlay} names or notes from .pathlight/pathlight.overlay.json.\n` : "")
        + made.problems.map(text => `Overlay skipped: ${text}\n`).join("")
        + made.pins.map(text => `Check: ${text}\n`).join("")
        + (made.unknown.length ? `Overlay keys that match nothing in the code now (remove or fix them): ${made.unknown.join(", ")}\n` : ""));
    } else if (command === "check") {
      if (id) return yield* invalid("check takes no argument. Use --workspace PATH.");
      const check = yield* checkAndRecord(values.workspace);
      if (!values.quiet) process.stdout.write(values.json ? `${JSON.stringify(check, null, 2)}\n` : formatCheck(check));
      if (values.strict && hasFindings(check)) process.exitCode = 1;
    } else if (command === "flows") {
      if (id) return yield* invalid("flows takes no argument. Use --workspace PATH.");
      const flows = yield* checkFlows(values.workspace);
      if (!values.quiet) process.stdout.write(values.json ? `${JSON.stringify(flows, null, 2)}\n` : formatFlows(flows));
      if (values.strict && hasFlowFindings(flows)) process.exitCode = 1;
    } else if (command === "flow") {
      const name = extra[0];
      if (id === "add") {
        const steps = values.step ?? [];
        const added = yield* addFlow(values.workspace, { id: name, title: values.title, reads: values.reads ?? [], steps, project: values.project, force: values.force });
        process.stdout.write(formatAdded(added, steps.length));
      } else if (id === "remove") process.stdout.write(`Removed ${yield* removeFlow(values.workspace, name)}.\n`);
      else return yield* invalid("Use pathlight flow add ID ... or pathlight flow remove ID. pathlight flows lists and checks them.");
    } else if (command === "brief") {
      const all = yield* briefOf(values.workspace);
      const chosen = values.changed ? { missing: [] as string[], boxes: [] as typeof all } : select(all, [...(id ? [id] : []), ...extra]);
      if (values.changed) {
        if (id || extra.length) return yield* invalid("--changed takes no keys: it lists every box whose files changed since it was named.");
        const changed = yield* changedBoxes(values.workspace, all);
        chosen.boxes = changed.boxes;
        if (!values.json) process.stdout.write(changed.tracked ? (changed.boxes.length ? `${changed.boxes.length} of ${all.length} boxes are new or have changed files since they were named.\n\n` : "Every box is named and its files are unchanged since.\n") : "Nothing records when these boxes were named, so every box a person did not name is listed. Naming them once starts the record.\n\n");
      }
      if (chosen.missing.length) return yield* invalid(`No box has the key ${chosen.missing.join(", ")}. Run pathlight brief with no keys to see them.`);
      process.stdout.write(values.json ? `${JSON.stringify(chosen.boxes, null, 2)}\n` : `${id || extra.length ? "" : formatContext(yield* contextOf(values.workspace))}${formatBrief(chosen.boxes, all)}`);
    } else if (command === "name") {
      const entries: NameEntry[] = [];
      if (values.from) {
        const text = values.from === "-" ? yield* readStdin : yield* io("CLI.names", () => Bun.file(resolve(values.from!)).text());
        const parsed = yield* json(text);
        if (!Array.isArray(parsed)) return yield* invalid("--from takes a JSON array of {\"key\", \"title\", \"note\"} entries.");
        for (const item of parsed) {
          if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return yield* invalid("Every entry needs a \"key\" (see pathlight brief).");
          const { key, title, note } = item as { key: string; title?: unknown; note?: unknown };
          entries.push({ key, ...(typeof title === "string" ? { title } : {}), ...(typeof note === "string" ? { note } : {}) });
        }
      } else if (id) entries.push({ key: id, ...(values.title ? { title: values.title } : {}), ...(values.note ? { note: values.note } : {}) });
      else return yield* invalid("Use pathlight name KEY --title TEXT --note TEXT, or pathlight name --from FILE.");
      if (id && values.from) return yield* invalid("Give a KEY or --from, not both.");
      process.stdout.write(formatNamed(yield* nameBoxes(values.workspace, entries)));
    } else if (command === "plan") {
      const made = yield* setPlan(values.workspace, [...(id ? [id] : []), ...extra]);
      process.stdout.write(made ? `Plan: ${made.elements.join(", ")}\n` : "Plan cleared.\n");
    } else if (command === "diff") {
      if (id) return yield* invalid("diff takes no argument. Use --base REV and --workspace PATH.");
      const diff = yield* diffWorkspace(values.workspace, values.base);
      yield* recordDiff(values.workspace, diff);
      if (!values.quiet) process.stdout.write(values.json ? `${JSON.stringify(diff, null, 2)}\n` : formatDiff(diff));
    } else if (command === "doctor") {
      if (id) return yield* invalid("doctor takes no argument. Use --workspace PATH.");
      const findings = yield* doctor(values.workspace);
      process.stdout.write(formatDoctor(findings));
      if (hasFailures(findings)) process.exitCode = 1;
    } else if (command === "setup") {
      if (id) return yield* invalid("setup takes no argument. Use --workspace PATH and --yes.");
      process.stdout.write(yield* setup(values.workspace, { yes: values.yes === true }));
    } else if (command === "init") {
      if (id) return yield* invalid("init takes no argument. Use --workspace PATH.");
      process.stdout.write(`${(yield* initWorkspace(values.workspace, { claudeHooks: !values["no-claude-hooks"] })).join("\n")}\n`);
    } else if (command === "record") {
      yield* readActivityConfig(values.workspace);
      const input = yield* json(yield* readStdin);
      if (!claudeIgnores(input)) yield* writeActivity(values.workspace, yield* claudeActivity(resolve(values.workspace), input));
    } else if (command === "see") {
      if (!id) return yield* invalid("Missing view ID. Use pathlight list.");
      const size = (name: string, text: string | undefined, fallback: number) => {
        const value = text === undefined ? fallback : Number(text);
        return Number.isInteger(value) && value >= 20 && value <= 500 ? Effect.succeed(value) : invalid(`--${name} must be a whole number from 20 to 500.`);
      };
      const mappedProject = values.project ?? (yield* readActivityConfig(values.workspace).pipe(Effect.map(mapping => mapping.project), Effect.catch(() => Effect.succeed(undefined))));
      const view = yield* selectView(values.workspace, id, mappedProject && (yield* listViews(values.workspace)).views.some(entry => entry.id === id && entry.project === mappedProject) ? mappedProject : values.project);
      const screen = yield* seeView({ view, cols: yield* size("cols", values.cols, 120), rows: yield* size("rows", values.rows, 36), select: values.select, keys: values.keys?.split(",").map(key => key.trim()).filter(Boolean), ansi: values.ansi, follow: values.follow });
      process.stdout.write(screen);
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
      const mapped = command !== "open" || (yield* io("CLI.mapping", () => Bun.file(mappingPath(resolve(values.workspace))).exists()));
      if (!mapped) process.stderr.write("No .pathlight/pathlight.activity.json here, so the viewer will not follow an agent. Ask the agent to map the model (/pathlight).\n");
      const following = follow || (command === "open" && !activity && mapped);
      // The mapping names the project the agent's files belong to, so a workspace with several LikeC4 projects needs no --project: it is
      // taken from .pathlight/pathlight.activity.json, unless the named view exists only in another project.
      const mappedProject = values.project ? undefined : yield* readActivityConfig(values.workspace).pipe(Effect.map(mapping => mapping.project), Effect.catch(() => Effect.succeed(undefined)));
      const project = values.project ?? (mappedProject && (!id || (yield* listViews(values.workspace)).views.some(entry => entry.id === id && entry.project === mappedProject)) ? mappedProject : undefined);
      const overview = command === "open" && !id ? yield* overviewId(values.workspace, project) : id;
      const view = yield* selectView(values.workspace, overview!, project);
      if (!here) {
        const result = yield* showView({ view, pane, socket: values.socket, activity, follow: following });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const { viewNative } = yield* io("CLI.viewer", () => import("./native-viewer"));
        yield* viewNative({ view, activity, follow: following, parent: values.parent, ready: values.ready, select: values.select });
      }
    } else return yield* invalid(`Unknown command '${command}'. Use --help.`);
  }), { signal: abort.signal });
} catch (error) {
  if (readyPath) await Effect.runPromise(writeReady(readyPath, { error: error instanceof Error ? error.message : String(error) }).pipe(Effect.ignore));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
