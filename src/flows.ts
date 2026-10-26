import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { readActivityConfig, type ActivityConfig } from "./activity";
import { acquireModel } from "./catalog";
import { failure, io } from "./effects";
import { run } from "./process";
import { declarationOf } from "./scan-imports";

/**
 * Whether the state diagrams an agent wrote (`*.behavior.c4`, see the pathlight-behavior skill) still agree with the code they were read from.
 * A flow is the agent's reading, so nothing here says it is right; it says what can be shown wrong or old: a state naming a file that is gone,
 * files changed since the commit the flow was synced at, arrows with no event on them, a decision with one answer, a state nothing reaches.
 * A state that names no file cannot be checked at all, and is counted so the gap is visible.
 */
export interface FlowState { id: string; title: string; kind: string; tags: readonly string[]; description: string }
export interface FlowArrow { source: string; target: string; title: string | null }
export interface FlowInput { id: string; title: string; view: string | null; viewDescription: string; states: readonly FlowState[]; arrows: readonly FlowArrow[] }

export type FileStatus = "ok" | "missing" | "changed";
export type Sync =
  | { status: "none" }
  | { status: "unknown"; sha: string }
  | { status: "current" | "behind"; sha: string };
/**
 * One step of a flow, in the order it is told. A journey step is a hop between two components (a LikeC4 dynamic view's step); a behavior step is a
 * state. `elements` are the components it touches, and `backed` is whether the model has a relationship for the hop (null for a state, which is no hop).
 */
export interface FlowStep { n: number; title: string; elements: string[]; from?: string; to?: string; backed: boolean | null; mark?: "bug" | "fixed"; call?: StepCall }
/** The function a journey step calls, as the agent recorded it (`name | file | declaration` in the step's notes). The declaration is the code's own text when it was written. */
export interface StepCall { name: string; file: string; declaration: string }
export const parseCall = (notes: string | undefined): StepCall | undefined => {
  const parts = (notes ?? "").split(" | ");
  return parts.length >= 3 && parts[0] && parts[1] ? { name: parts[0].trim(), file: parts[1].trim(), declaration: parts.slice(2).join(" | ").trim() } : undefined;
};
export interface FlowReport {
  id: string; title: string; view: string | null; sync: Sync;
  steps: FlowStep[];
  states: { id: string; title: string; kind: string; tags: readonly string[]; files: { path: string; status: FileStatus }[]; elements: string[] }[];
  // Plain sentences, each about one thing to look at. They are questions about the diagram, not verdicts on the code.
  findings: string[];
  // States that name no file, so nothing about them can be checked.
  unverified: number;
}

const syncPattern = /\bSynced at ([0-9a-f]{7,40})\b/i;
/**
 * Files an agent read while they had changes not yet committed, as `path@hash` of what it read. `Synced at` names a commit, but the reading was of the
 * working tree; without this, those files would show as "changed since" the moment the flow is written. A file is still reported if it differs from what was read.
 */
const dirtyPattern = /Read with uncommitted changes: ([^\n]*?)\.(?:\s|$)/;
export const dirtyOf = (description: string) => new Map((dirtyPattern.exec(description)?.[1] ?? "").split(", ").flatMap(entry => { const at = entry.lastIndexOf("@"); return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)] as const] : []; }));
export const contentHash = (content: string | Uint8Array) => createHash("sha1").update(content).digest("hex").slice(0, 8);
export const syncOf = (description: string) => syncPattern.exec(description)?.[1]?.toLowerCase();

/**
 * The files a state's description names. A word counts when it has a `/` (it must then exist, or it is reported) or when it is exactly a file in
 * the workspace; a bare word such as `Node.js` that is no file is ordinary prose and is ignored.
 */
export function namedFiles(description: string, exists: (path: string) => boolean) {
  const found = new Map<string, boolean>();
  for (const raw of description.split(/[\s,;()'"`]+/)) {
    const token = raw.replace(/[.:,!?]+$/, "").replace(/^\.\//, "");
    if (!token || /^[a-z]+:\/\//i.test(token) || token.startsWith("/") || token.includes("..")) continue;
    if (exists(token)) found.set(token, true);
    else if (token.includes("/") && /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(token)) found.set(token, false);
  }
  return [...found].map(([path, exists]) => ({ path, exists }));
}

export const elementsOf = (config: ActivityConfig | undefined, path: string) =>
  config ? [...new Set(config.mappings.filter(mapping => new Bun.Glob(mapping.glob).match(path)).map(mapping => mapping.element))].sort() : [];

/** `changed` is the set of files that differ from the sync commit; `known` says whether that commit exists at all. */
export function assessFlow(flow: FlowInput, exists: (path: string) => boolean, config: ActivityConfig | undefined, git: { changed: ReadonlySet<string>; known: (sha: string) => boolean }): FlowReport {
  const sha = syncOf(flow.viewDescription);
  const findings: string[] = [];
  const states = flow.states.map(state => {
    const files = namedFiles(state.description, exists).map(({ path, exists }) => ({
      path, status: !exists ? "missing" as const : sha && git.known(sha) && git.changed.has(path) ? "changed" as const : "ok" as const,
    }));
    return { id: state.id, title: state.title, kind: state.kind, tags: state.tags, files, elements: [...new Set(files.flatMap(file => file.status === "missing" ? [] : elementsOf(config, file.path)))].sort() };
  });
  for (const state of states) {
    for (const file of state.files) {
      if (file.status === "missing") findings.push(`“${state.title}” names ${file.path}, which is not in the workspace.`);
      if (file.status === "changed") findings.push(`“${state.title}” names ${file.path}, which changed after the flow was synced at ${sha}.`);
    }
  }
  const sync: Sync = !sha ? { status: "none" } : !git.known(sha) ? { status: "unknown", sha }
    : { status: states.some(state => state.files.some(file => file.status === "changed")) ? "behind" : "current", sha };
  if (sync.status === "none") findings.push(`The view has no “Synced at <commit>” note, so nobody can tell how old this reading is.`);
  if (sync.status === "unknown") findings.push(`The view was synced at ${sync.sha}, which is not a commit in this repository.`);

  const real = states.filter(state => state.kind !== "decision");
  const unverified = real.filter(state => state.files.length === 0).length;
  if (unverified) findings.push(`${unverified} of ${real.length} states name no file, so they cannot be checked.`);

  const titleOf = new Map(flow.states.map(state => [state.id, state.title]));
  for (const arrow of flow.arrows) if (!arrow.title) findings.push(`The arrow from “${titleOf.get(arrow.source) ?? arrow.source}” to “${titleOf.get(arrow.target) ?? arrow.target}” says no event.`);
  for (const state of flow.states.filter(state => state.kind === "decision")) {
    const answers = flow.arrows.filter(arrow => arrow.source === state.id).length;
    if (answers < 2) findings.push(`The decision “${state.title}” has ${answers === 0 ? "no answer" : "one answer"}; a decision asks a question with two or more.`);
  }
  // Everything should be reachable from the first state written, or the diagram has a piece that nothing leads to.
  const first = flow.states[0];
  if (first) {
    const reached = new Set([first.id]), queue = [first.id];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) for (const arrow of flow.arrows) if (arrow.source === id && !reached.has(arrow.target)) { reached.add(arrow.target); queue.push(arrow.target); }
    for (const state of flow.states) if (!reached.has(state.id)) findings.push(`Nothing leads to “${state.title}” from the first state, “${first.title}”.`);
  }
  const steps = states.filter(state => state.kind !== "decision").map((state, index) => ({ n: index + 1, title: state.title, elements: state.elements, backed: null, ...(state.tags.includes("bug") ? { mark: "bug" as const } : state.tags.includes("fixed") ? { mark: "fixed" as const } : {}) }));
  return { id: flow.id, title: flow.title, view: flow.view, sync, steps, states, findings, unverified };
}

/**
 * A journey is a LikeC4 dynamic view: the path a request takes through components the model already has. Each step names the relationship that backs it;
 * a step with none is the model and the story disagreeing, which is known from the model alone and needs no guess.
 */
export interface JourneyInput { id: string; title: string; viewDescription: string; steps: readonly { source: string; target: string; title: string; backed: boolean; notes?: string }[] }
export interface JourneyReport { id: string; title: string; view: string; sync: Sync; steps: FlowStep[]; findings: string[] }
const last = (id: string) => id.split(".").at(-1) ?? id;

/** `changedElements` are the components some changed file belongs to (files that differ from the sync commit); `known` says whether that commit exists. */
export function assessJourney(journey: JourneyInput, git: { changedElements: ReadonlySet<string>; known: (sha: string) => boolean; declared?: (file: string, name: string) => string | undefined }): JourneyReport {
  const sha = syncOf(journey.viewDescription);
  const findings: string[] = [];
  const steps: FlowStep[] = journey.steps.map((step, index) => ({ n: index + 1, title: step.title, elements: [...new Set([step.source, step.target])], from: step.source, to: step.target, backed: step.backed, ...(parseCall(step.notes) ? { call: parseCall(step.notes)! } : {}) }));
  // A call recorded with the flow must still be what the file declares; if not, the reading is out of date at that step.
  for (const step of steps) if (step.call && git.declared) {
    const now = git.declared(step.call.file, step.call.name);
    if (now === undefined) findings.push(`Step ${step.n} calls ${step.call.name} in ${step.call.file}, which no longer declares it.`);
    else if (now !== step.call.declaration) findings.push(`Step ${step.n}: ${step.call.name} in ${step.call.file} is declared differently from when the flow was written.`);
  }
  for (const step of steps) if (step.backed === false) findings.push(`Step ${step.n}, “${step.title}”, goes from ${last(step.from!)} to ${last(step.to!)} with no relationship between them in the model.`);
  const sync: Sync = !sha ? { status: "none" } : !git.known(sha) ? { status: "unknown", sha } : { status: "current", sha };
  if (sync.status === "none") findings.push("The view has no “Synced at <commit>” note, so nobody can tell how old this reading is.");
  if (sync.status === "unknown") findings.push(`The view was synced at ${sync.sha}, which is not a commit in this repository.`);
  if (sha && git.known(sha)) {
    const behind = [...new Set(steps.flatMap(step => step.elements))].filter(element => git.changedElements.has(element)).sort();
    if (behind.length) {
      findings.push(`Files of ${behind.slice(0, 3).map(last).join(", ")}${behind.length > 3 ? ` and ${behind.length - 3} more` : ""} changed after the flow was synced at ${sha}.`);
      return { id: journey.id, title: journey.title, view: journey.id, sync: { status: "behind", sha }, steps, findings };
    }
  }
  return { id: journey.id, title: journey.title, view: journey.id, sync, steps, findings };
}

export interface Flows { version: 1; basis: "agent-reading"; flows: FlowReport[]; journeys: JourneyReport[]; summary: { flows: number; journeys: number; findings: number; unverified: number; behind: number } }

export const checkFlows = Effect.fn("Flows.check")(function* (workspace: string) {
  const root = yield* io("Flows.workspace", () => realpath(workspace));
  const config = yield* readActivityConfig(root).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));
  // The file listing comes from git, which still lists a tracked file that was deleted from disk, so existence is asked of the filesystem.
  const exists = (path: string) => existsSync(join(root, path)) && lstatSync(join(root, path)).isFile();
  const source = yield* acquireModel(root);
  if (source.hasErrors()) return yield* Effect.fail(failure("Flows.model", "Invalid LikeC4 model. Run likec4 validate in the workspace first."));
  const inputs: FlowInput[] = [];
  for (const project of source.projects()) {
    const model = yield* io("LikeC4.compute", () => source.computedModel(project));
    const views = [...model.views()];
    for (const element of model.elements()) {
      if (element.parent || ![...element.tags].includes("behavior")) continue;
      const id = String(element.id);
      const states = [...element.descendants()].map(child => ({ id: String(child.id), title: child.title, kind: String(child.kind), tags: [...child.tags] as readonly string[], description: child.description?.text ?? "" }));
      const inside = new Set(states.map(state => state.id));
      const arrows = [...model.relationships()].filter(rel => inside.has(String(rel.source.id)) && inside.has(String(rel.target.id)))
        .map(rel => ({ source: String(rel.source.id), target: String(rel.target.id), title: rel.title ?? null }));
      const view = views.find(candidate => (candidate.$view as { viewOf?: string }).viewOf === id) ?? views.find(candidate => candidate.id === id);
      const viewDescription = (view?.$view.description as { txt?: string } | null | undefined)?.txt ?? "";
      inputs.push({ id, title: element.title, view: view?.id ?? null, viewDescription, states, arrows });
    }
  }
  const journeyInputs: JourneyInput[] = [];
  for (const project of source.projects()) {
    const model = yield* io("LikeC4.compute", () => source.computedModel(project));
    for (const entry of model.views()) {
      const raw = entry.$view as { _type?: string; description?: { txt?: string } | null; edges?: readonly { source: string; target: string; label?: string | null; relations?: readonly unknown[]; notes?: { txt?: string } | null }[]; nodes?: readonly { id: string; modelRef?: string }[] };
      if (raw._type !== "dynamic") continue;
      const element = (id: string) => String(raw.nodes?.find(node => node.id === id)?.modelRef ?? id);
      journeyInputs.push({ id: entry.id, title: entry.title ?? entry.id, viewDescription: raw.description?.txt ?? "",
        steps: (raw.edges ?? []).map(edge => ({ source: element(edge.source), target: element(edge.target), title: (edge.label ?? "").trim() || "(no title)", backed: (edge.relations ?? []).length > 0, ...(edge.notes?.txt ? { notes: edge.notes.txt } : {}) })) });
    }
  }
  // One git call for every flow: the files that differ from each distinct sync commit.
  const changedSince = new Map<string, Set<string> | undefined>();
  for (const sha of new Set([...inputs, ...journeyInputs].flatMap(input => syncOf(input.viewDescription) ?? []))) {
    const exists = yield* run("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`]).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
    changedSince.set(sha, exists ? new Set((yield* run("git", ["-C", root, "diff", "--name-only", sha]).pipe(Effect.catch(() => Effect.succeed("")))).split("\n").filter(Boolean)) : undefined);
  }
  // Files that differ from the sync commit, minus those the agent read in exactly their current uncommitted state.
  const changedFor = new Map<object, Set<string>>();
  for (const input of [...inputs, ...journeyInputs]) {
    const sha = syncOf(input.viewDescription), differing = (sha && changedSince.get(sha)) || new Set<string>(), read = dirtyOf(input.viewDescription), kept = new Set<string>();
    for (const path of differing) {
      const recorded = read.get(path);
      const now = recorded === undefined || path.startsWith("/") || path.includes("..") ? undefined : yield* io("Flows.hash", () => readFile(join(root, path))).pipe(Effect.map(contentHash), Effect.catch(() => Effect.succeed(undefined)));
      if (now === undefined || now !== recorded) kept.add(path);
    }
    changedFor.set(input, kept);
  }
  const flows = inputs.map(input => {
    return assessFlow(input, exists, config, { changed: changedFor.get(input) ?? new Set(), known: candidate => changedSince.get(candidate) !== undefined });
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const elementsChanged = (changed: ReadonlySet<string>) => new Set([...changed].flatMap(path => elementsOf(config, path)));
  const callFiles = new Map<string, string | undefined>();
  for (const file of new Set(journeyInputs.flatMap(input => input.steps.flatMap(step => parseCall(step.notes)?.file ?? [])))) {
    callFiles.set(file, file.startsWith("/") || file.includes("..") ? undefined : yield* io("Flows.call", () => readFile(join(root, file), "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined))));
  }
  const declared = (file: string, name: string) => { const text = callFiles.get(file); return text === undefined ? undefined : declarationOf(text, name); };
  const journeys = journeyInputs.map(input => {
    const sha = syncOf(input.viewDescription);
    return assessJourney(input, { declared, changedElements: elementsChanged(changedFor.get(input) ?? new Set()), known: candidate => changedSince.get(candidate) !== undefined });
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const all = [...flows, ...journeys];
  return {
    version: 1, basis: "agent-reading", flows, journeys,
    summary: { flows: flows.length, journeys: journeys.length, findings: all.reduce((sum, flow) => sum + flow.findings.length, 0), unverified: flows.reduce((sum, flow) => sum + flow.unverified, 0), behind: all.filter(flow => flow.sync.status === "behind").length },
  } satisfies Flows;
}, Effect.scoped);

export const hasFlowFindings = (flows: Flows) => flows.summary.findings > 0;

export function formatFlows(flows: Flows) {
  const lines = ["pathlight flows · each flow is a reading of the code, checked only against the files it names, the model, and the commit it was synced at", ""];
  const syncText = (sync: Sync) => sync.status === "none" ? "never synced" : sync.status === "unknown" ? `synced at ${sync.sha} (not a commit here)` : sync.status === "behind" ? `synced at ${sync.sha}, files changed since` : `synced at ${sync.sha}, files unchanged since`;
  if (!flows.flows.length && !flows.journeys.length) lines.push("  no flows in this workspace (state diagrams in *.behavior.c4, or LikeC4 dynamic views)");
  for (const flow of flows.flows) {
    lines.push(`${flow.findings.length ? "▲" : "✓"} ${flow.title}  (state diagram ${flow.id}; ${flow.states.length} states; ${syncText(flow.sync)})`);
    for (const finding of flow.findings) lines.push(`    ${finding}`);
  }
  for (const journey of flows.journeys) {
    lines.push(`${journey.findings.length ? "▲" : "✓"} ${journey.title}  (journey ${journey.id}; ${journey.steps.length} steps; ${syncText(journey.sync)})`);
    for (const finding of journey.findings) lines.push(`    ${finding}`);
  }
  return `${lines.join("\n")}\n`;
}
