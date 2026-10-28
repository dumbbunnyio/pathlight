import { existsSync, lstatSync } from "node:fs";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Effect } from "effect";
import { readActivityConfig } from "./activity";
import { acquireModel, invalidModel } from "./catalog";
import { failure, io } from "./effects";
import { checkFlows, contentHash, type JourneyReport, type Over, runtimeHops } from "./flows";
import { declarationsFor } from "./languages";
import { run } from "./process";

/**
 * `pathlight flow add`: an agent has read the code and knows the story; this writes it down correctly. The agent supplies the id, a title, the files it
 * read and the hops (`from -> to: event`); nothing here decides what happens. It checks every component against the model, refuses a file it cannot
 * stamp truthfully, writes a LikeC4 dynamic view the viewer and `pathlight flows` already understand, and takes the file back out if the model no longer compiles.
 *
 * The file carries a marker line so `remove` and `--force` only ever touch what this wrote, never a diagram a person or an agent wrote by hand.
 */
export const marker = "// Written by pathlight flow. Delete it with: pathlight flow remove";
const idPattern = /^[a-z][a-z0-9-]{0,47}$/;
const stepPattern = /^(.+?)\s*->\s*(.+?)\s*:\s*(.+)$/;
export const maxSteps = 24;

/** The function a hop calls: where it is declared and what it is called, checked against the file when the flow is written. */
export interface FlowCall { file: string; name: string; declaration: string }
export interface FlowStepInput { from: string; to: string; title: string; over?: Over; call?: { file: string; name: string } }
const callPattern = /(?:^|\s)@\s*(\S+?)#([A-Za-z_$][\w$]*)\s*$/;
/** How a call is kept in the view: one line in the step's notes, `name | file | declaration`. */
export const callNote = (call: FlowCall) => `${call.name} | ${call.file} | ${call.declaration}`;
/** How a runtime hop is kept: its own line in the step's notes, `over | http`, before the call's. */
export const overNote = (over: Over) => `over | ${over}`;

/**
 * `a.b -> c: opens checkout` → a step; `a -> b over http: opens the document` → a hop made over HTTP, a websocket or a spawned process, which no import
 * backs. Anything else is refused with the shape asked for, because a half-parsed hop would be a wrong flow.
 */
export function parseStep(text: string): FlowStepInput | string {
  const match = stepPattern.exec(text.trim());
  if (!match) return `“${text}” is not a step. Write it as: from -> to: what happens (component ids as the model spells them).`;
  const [, from, target, title] = match as unknown as [string, string, string, string];
  const runtime = /^(\S+)\s+over\s+(\S+)$/.exec(target);
  if (runtime && !runtimeHops.includes(runtime[2] as Over)) return `“${text}”: a hop goes over ${runtimeHops.join(", ")} or nothing, not “${runtime[2]}”.`;
  const to = runtime ? runtime[1]! : target, over = runtime?.[2] as Over | undefined;
  if (/\s/.test(from) || /\s/.test(to)) return `“${text}”: component ids have no spaces. Check them with pathlight list and the model.`;
  if (/[\r\n]/.test(title)) return `“${text}”: an event is one line.`;
  const call = callPattern.exec(title);
  const event = (call ? title.slice(0, call.index) : title).trim();
  if (!event) return `“${text}”: say what happens before the @ file#function.`;
  return { from, to, title: event, ...(over ? { over } : {}), ...(call ? { call: { file: call[1]!.replace(/^\.\//, ""), name: call[2]! } } : {}) };
}

/** A LikeC4 single-quoted string. */
const quote = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function renderJourney(options: { id: string; title: string; reads: readonly string[]; sha: string | undefined; uncommitted?: readonly { path: string; hash: string }[]; steps: readonly (FlowStepInput & { declared?: FlowCall })[] }) {
  const note = `Agent-written from ${options.reads.join(", ")}.${options.sha ? ` Synced at ${options.sha}.` : ""}${options.uncommitted?.length ? ` Read with uncommitted changes: ${options.uncommitted.map(entry => `${entry.path}@${entry.hash}`).join(", ")}.` : ""}`;
  return [
    marker, "views {", `  dynamic view ${options.id} {`, `    title ${quote(options.title)}`, `    description ${quote(note)}`,
    ...options.steps.map(step => {
      const notes = [...(step.over ? [overNote(step.over)] : []), ...(step.declared ? [callNote(step.declared)] : [])];
      return notes.length ? `    ${step.from} -> ${step.to} ${quote(step.title)} {\n      notes ${quote(notes.join("\n"))}\n    }` : `    ${step.from} -> ${step.to} ${quote(step.title)}`;
    }), "  }", "}", "",
  ].join("\n");
}

/** Edit distance, for offering back the component a mistyped id was probably meant to be. */
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

const nearest = (id: string, known: readonly string[]) => {
  const tail = (value: string) => value.split(".").at(-1) ?? value;
  const scored = known.map(candidate => ({ candidate, score: Math.min(distance(id, candidate), distance(tail(id), tail(candidate)) + (tail(id) === id ? 0 : 1)) }))
    .filter(({ candidate, score }) => score <= 3 || candidate.endsWith(`.${id}`)).sort((a, b) => a.score - b.score).slice(0, 3);
  return scored.length ? ` Did you mean ${scored.map(entry => entry.candidate).join(", ")}?` : "";
};

/** The folder of a LikeC4 project: where its `likec4.config.json` is (found through git, which skips dependencies), else the workspace root. */
const projectDirectory = Effect.fn("Flow.project")(function* (root: string, project: string) {
  const listed = yield* run("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "--", ":(glob)**/likec4.config.json", "likec4.config.json"]).pipe(Effect.catch(() => Effect.succeed("")));
  for (const path of listed.split("\n").filter(Boolean)) {
    const name = yield* io("Flow.config", async () => (JSON.parse(await readFile(join(root, path), "utf8")) as { name?: string }).name).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (name === project) return join(root, dirname(path));
  }
  return root;
});

export interface AddedFlow { file: string; journey: JourneyReport | undefined; stamped: boolean }

export const addFlow = Effect.fn("Flow.add")(function* (workspace: string, options: { id: string | undefined; title: string | undefined; reads: readonly string[]; steps: readonly string[]; project?: string; force?: boolean }) {
  const invalid = (message: string) => Effect.fail(failure("Flow.add", message));
  const root = yield* io("Flow.workspace", () => realpath(workspace));
  if (!options.id || !idPattern.test(options.id)) return yield* invalid("Name the flow: pathlight flow add ID, with ID lowercase letters, digits and hyphens (for example place-order).");
  if (!options.title?.trim() || /[\r\n]/.test(options.title)) return yield* invalid("Give it a one-line --title that says what the flow shows (for example “Placing an order”).");
  const reads = [...new Set(options.reads.flatMap(value => value.split(",")).map(value => value.trim().replace(/^\.\//, "")).filter(Boolean))];
  if (!reads.length) return yield* invalid("Name the files you read with --reads a.ts,b.ts. A flow that names none cannot be checked, so it would claim more than it shows.");
  for (const path of reads) {
    if (path.startsWith("/") || path.split("/").includes("..") || !existsSync(join(root, path)) || !lstatSync(join(root, path)).isFile()) return yield* invalid(`--reads ${path}: not a file in the workspace.`);
  }
  if (options.steps.length < 2) return yield* invalid("A journey needs at least two steps (--step 'from -> to: event', repeated).");
  if (options.steps.length > maxSteps) return yield* invalid(`A journey of more than ${maxSteps} steps is two journeys. Split it.`);
  const steps: FlowStepInput[] = [];
  for (const text of options.steps) {
    const step = parseStep(text);
    if (typeof step === "string") return yield* invalid(step);
    steps.push(step);
  }

  // The components must be the model's own; a name that is nearly right is the usual mistake, so it is offered back.
  const before = yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* acquireModel(root);
    if (source.hasErrors()) return yield* invalid(invalidModel(source, root));
    const projects = source.projects();
    const mapped = options.project ?? (yield* readActivityConfig(root).pipe(Effect.map(config => config.project), Effect.catch(() => Effect.succeed(undefined))));
    const project = mapped && projects.includes(mapped as never) ? mapped : projects.length === 1 ? projects[0] : undefined;
    if (!project) return yield* invalid(`This workspace has several LikeC4 projects (${projects.join(", ")}). Pass --project NAME.`);
    const model = yield* io("LikeC4.compute", () => source.computedModel(project));
    return { project: String(project), elements: [...model.elements()].map(element => String(element.id)), views: [...model.views()].map(view => String(view.id)) };
  }));
  // A view belongs to the project whose folder holds its file; in a workspace of several projects the root is none of them.
  const directory = yield* projectDirectory(root, before.project);
  const file = `${options.id}.behavior.c4`, path = join(directory, file), shown = relative(root, path);
  const previous = existsSync(path) ? yield* io("Flow.read", () => readFile(path, "utf8")) : undefined;
  if (previous !== undefined && !(options.force && previous.startsWith(marker))) {
    return yield* invalid(previous.startsWith(marker) ? `${shown} already exists. Use --force to replace it, or pathlight flow remove ${options.id}.` : `${shown} exists and was not written by pathlight flow, so it is left alone. Pick another id.`);
  }
  if (before.views.includes(options.id) && previous === undefined) return yield* invalid(`A view called ${options.id} already exists in the model. Pick another id.`);
  const known = new Set(before.elements);
  for (const [index, step] of steps.entries()) {
    for (const element of [step.from, step.to]) if (!known.has(element)) return yield* invalid(`Step ${index + 1}: “${element}” is not a component in the model.${nearest(element, before.elements)}`);
    if (step.from === step.to) return yield* invalid(`Step ${index + 1}: a hop goes between two components; “${step.from}” is both ends.`);
  }

  // A named function must be one the file exports, and its declaration is copied from the file as written: the flow says what the code says, no more.
  const declared: (FlowCall | undefined)[] = [];
  for (const [index, step] of steps.entries()) {
    if (!step.call) { declared.push(undefined); continue; }
    const { file: callFile, name } = step.call;
    const where = `Step ${index + 1}: ${callFile}#${name}`;
    if (!reads.includes(callFile)) return yield* invalid(`${where}: name the file in --reads too. A function in a file you did not read cannot be part of the reading.`);
    if (callFile.startsWith("/") || callFile.split("/").includes("..") || !existsSync(join(root, callFile)) || !lstatSync(join(root, callFile)).isFile()) return yield* invalid(`${where}: not a file in the workspace.`);
    const text = yield* io("Flow.call", () => readFile(join(root, callFile), "utf8"));
    const reader = yield* declarationsFor(callFile);
    const names = reader.exports(text, 400).map(entry => entry.name);
    if (!names.includes(name)) return yield* invalid(`${where}: ${callFile} does not export “${name}”.${names.length ? ` It exports ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}.` : ""}`);
    const declaration = reader.declaration(text, name);
    if (!declaration) return yield* invalid(`${where}: “${name}” is exported but its declaration could not be read. Name the function that is declared in that file.`);
    declared.push({ file: callFile, name, declaration });
  }

  // A commit to stamp: without one nobody can tell how old the reading is, and `pathlight flows` would say so.
  const sha = yield* run("git", ["-C", root, "rev-parse", "--short", "HEAD"]).pipe(Effect.map(text => text.trim() || undefined), Effect.catch(() => Effect.succeed(undefined)));
  // Files read with changes not yet committed: stamped with what they were, so only a later edit counts as the flow being behind.
  const gitNames = (args: string[]) => run("git", ["-C", root, ...args, "--", ...reads]).pipe(Effect.map(text => text.split("\n").map(line => line.trim()).filter(Boolean)), Effect.catch(() => Effect.succeed([] as string[])));
  const dirty = sha ? [...(yield* gitNames(["diff", "--relative", "--name-only", "HEAD"])), ...(yield* gitNames(["ls-files", "--others", "--exclude-standard"]))] : [];
  const uncommitted = yield* Effect.forEach(reads.filter(path => dirty.includes(path)), file => io("Flow.hash", () => readFile(join(root, file))).pipe(Effect.map(content => ({ path: file, hash: contentHash(content) }))));
  yield* io("Flow.write", () => writeFile(path, renderJourney({ id: options.id!, title: options.title!.trim(), reads, sha, uncommitted, steps: steps.map((step, index) => ({ ...step, declared: declared[index] })) })));
  const restore = io("Flow.restore", () => previous === undefined ? rm(path, { force: true }) : writeFile(path, previous)).pipe(Effect.ignore);
  const compiled = yield* Effect.scoped(Effect.gen(function* () {
    const source = yield* acquireModel(root);
    return source.hasErrors() ? ((source.getErrors()[0]?.message ?? "the model no longer compiles").split("\n")[0]!) : undefined;
  })).pipe(Effect.catch(error => Effect.succeed(error.message)));
  if (compiled) { yield* restore; return yield* invalid(`${shown} would break the model (${compiled}). Nothing was written.`); }
  const report = yield* checkFlows(root).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return { file: shown, journey: report?.journeys.find(journey => journey.id === options.id), stamped: sha !== undefined } satisfies AddedFlow;
});

export const removeFlow = Effect.fn("Flow.remove")(function* (workspace: string, id: string | undefined) {
  const root = yield* io("Flow.workspace", () => realpath(workspace));
  if (!id || !idPattern.test(id)) return yield* Effect.fail(failure("Flow.remove", "Name the flow: pathlight flow remove ID."));
  const file = `${id}.behavior.c4`;
  const listed = yield* run("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "--", `:(glob)**/${file}`, file]).pipe(Effect.catch(() => Effect.succeed("")));
  const found = listed.split("\n").filter(Boolean).filter(path => existsSync(join(root, path)));
  if (!found.length && existsSync(join(root, file))) found.push(file);
  if (!found.length) return yield* Effect.fail(failure("Flow.remove", `No ${file} in the workspace.`));
  if (found.length > 1) return yield* Effect.fail(failure("Flow.remove", `${found.join(" and ")} both exist. Delete the one you mean by hand.`));
  const path = join(root, found[0]!);
  if (!(yield* io("Flow.read", () => readFile(path, "utf8"))).startsWith(marker)) return yield* Effect.fail(failure("Flow.remove", `${found[0]} was not written by pathlight flow, so it is left alone. Delete it by hand if you mean to.`));
  yield* io("Flow.remove", () => rm(path));
  return found[0]!;
});

export function formatAdded(added: AddedFlow, steps: number) {
  const lines = [`Wrote ${added.file}: a journey of ${steps} steps.`];
  if (!added.stamped) lines.push("No git commit to stamp it with, so the view has no “Synced at” note and pathlight flows will say so.");
  for (const finding of added.journey?.findings ?? []) lines.push(`Check: ${finding}`);
  if (added.journey && !added.journey.findings.length) lines.push("pathlight flows finds nothing to report. That means every hop has a relationship in the model, not that the story is right.");
  lines.push("It is your reading of the code. Open it in the viewer with F.");
  return `${lines.join("\n")}\n`;
}
