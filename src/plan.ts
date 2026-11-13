import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { readActivityConfig } from "./activity";
import { acquireModel, invalidModel } from "./catalog";
import { failure, io, json } from "./effects";
import { draftWorkspace, generatedMarker, hasFilesIn, writeOverlay } from "./draft";
import { readKeys, readOverlay } from "./edit";
import { homeOf, modelFile } from "./layout";
import { listFiles } from "./scan";

/**
 * The elements an agent says it is about to work on: node ids only, no text, no steps. The viewer outlines them, and activity that lands on an
 * element outside the plan is marked, so a wander shows up. It is a statement of intent, not a record of what happened.
 */
export const Plan = Schema.Struct({
  version: Schema.Literal(1), time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  elements: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[\w.-]+$/))).check(Schema.isMaxLength(64)),
});
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

const planPath = (root: string) => join(root, ".cache", "pathlight", "plan.json");

/** Sets the plan to these elements (each must exist in the model), or clears it with none. */
export const setPlan = Effect.fn("Plan.set")(function* (workspace: string, elements: readonly string[]) {
  const root = yield* io("Plan.root", () => realpath(workspace));
  if (!elements.length) {
    yield* io("Plan.clear", () => rm(planPath(root), { force: true }));
    return undefined;
  }
  const config = yield* readActivityConfig(root);
  const source = yield* acquireModel(root);
  if (source.hasErrors()) return yield* Effect.fail(failure("Plan.model", invalidModel(source, root)));
  const model = yield* io("LikeC4.compute", () => source.computedModel(config.project));
  const known = new Set([...model.elements()].map(element => String(element.id)));
  const unknown = elements.filter(id => !known.has(id));
  if (unknown.length) return yield* Effect.fail(failure("Plan.element", `Unknown element${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Use ids from the model, such as those in pathlight check.`));
  const plan = yield* Schema.decodeUnknownEffect(Plan)({ version: 1, time: Date.now(), elements: [...new Set(elements)].sort() });
  yield* io("Plan.write", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${planPath(root)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(plan)}\n`);
    await rename(temporary, planPath(root));
  });
  return plan;
}, Effect.scoped);

export const readPlan = (workspace: string) => Effect.gen(function* () {
  const root = yield* io("Plan.root", () => realpath(workspace));
  const text = yield* io("Plan.read", () => readFile(planPath(root), "utf8"));
  return yield* Schema.decodeUnknownEffect(Plan, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));

/**
 * `pathlight plan --new PATH --title TEXT`: a box for a folder that does not exist yet, on a map Pathlight drew. The folder and its name go in the
 * overlay's `planned`, the map is redrawn so the box appears dashed where the folder will sit, and the plan is set to it (and any ids given), so the
 * dashed box and the outline appear together before the first edit. A map a person wrote is never changed: there the element goes in the model.
 */
export const planNew = Effect.fn("Plan.new")(function* (workspace: string, wanted: { path: string; title: string; note?: string | undefined }, also: readonly string[] = []) {
  const root = yield* io("Plan.root", () => realpath(workspace));
  const path = posix.normalize(wanted.path.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
  if (!path || path === "." || isAbsolute(path) || path === ".." || path.startsWith("../") || /[\x00-\x1f\x7f*?[\]{}]/.test(path) || path.startsWith(".pathlight") || path.startsWith(".cache/"))
    return yield* Effect.fail(failure("Plan.path", `${wanted.path}: give a folder inside the workspace, relative to it (internal/auth).`));
  const title = wanted.title.trim(), note = wanted.note?.trim();
  if (!title) return yield* Effect.fail(failure("Plan.title", "--new needs a --title: what the person will call the box (Auth middleware)."));
  const model = yield* io("Plan.model", () => readFile(join(homeOf(root), modelFile), "utf8")).pipe(Effect.option);
  if (model._tag === "None" || !model.value.startsWith(generatedMarker))
    return yield* Effect.fail(failure("Plan.written", "This map was not drawn by pathlight draft, so plan --new does not change it. Add the element to the model, list its id under \"planned\" in .pathlight/pathlight.activity.json, then run pathlight plan with its id."));
  const { paths } = yield* listFiles(root);
  if (paths.includes(path)) return yield* Effect.fail(failure("Plan.path", `${path} is a file; plan --new takes the folder you are about to create.`));
  if (hasFilesIn(paths, path)) return yield* Effect.fail(failure("Plan.exists", `${path} already has files, so it is drawn already. Run pathlight plan with the id of its box (pathlight brief ${path} names it).`));
  const overlay = yield* readOverlay(root);
  const pinned = overlay.elements[path]?.by === "human" || (overlay.planned ?? []).some(item => item.path === path && item.by === "human");
  if (pinned) return yield* Effect.fail(failure("Plan.pinned", `${path} has a name a person gave it; it is left as it is.`));
  const next = { ...overlay, planned: [...(overlay.planned ?? []).filter(item => item.path !== path), { path, title, ...(note ? { note } : {}), by: "agent" as const }] };
  yield* writeOverlay(homeOf(root), next).pipe(Effect.mapError(() => failure("Plan.invalid", "A title is at most 60 characters and a note at most 300, each one line. Nothing was written.")));
  const drawn = yield* draftWorkspace(root, { keepJourneys: true }).pipe(Effect.tapError(() => writeOverlay(homeOf(root), overlay)));
  if (drawn.blocked) {
    yield* writeOverlay(homeOf(root), overlay);
    return yield* Effect.fail(failure("Plan.journey", `Redrawing the map now would remove ${drawn.blocked.element}, which journey ${drawn.blocked.journey} uses, so nothing was planned. Rerun or remove that journey first.`));
  }
  const id = [...(yield* readKeys(root))].find(([, key]) => key === path)?.[0];
  if (!id) {
    // Not a place boxes are drawn (inside another box): put the overlay back and redraw, so nothing half-made is left.
    yield* writeOverlay(homeOf(root), overlay);
    yield* draftWorkspace(root);
    const why = drawn.problems.find(text => text.startsWith(`planned '${path}'`));
    return yield* Effect.fail(failure("Plan.place", why ?? `${path} is not where a box would be drawn. Plan a folder beside the folders that are boxes.`));
  }
  return { id, plan: yield* setPlan(root, [id, ...also]) };
});

/**
 * `pathlight plan --drop PATH`: takes back a `plan --new` nobody built. The overlay's `planned` entry goes, the map is redrawn without the dashed box,
 * and the box leaves the plan. A folder with files is not dropped (the next redraw builds it), nor one a person planned.
 */
export const planDrop = Effect.fn("Plan.drop")(function* (workspace: string, given: string) {
  const root = yield* io("Plan.root", () => realpath(workspace));
  const path = posix.normalize(given.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
  const model = yield* io("Plan.model", () => readFile(join(homeOf(root), modelFile), "utf8")).pipe(Effect.option);
  if (model._tag === "None" || !model.value.startsWith(generatedMarker))
    return yield* Effect.fail(failure("Plan.written", "This map was not drawn by pathlight draft, so plan --drop does not change it. Remove the element from the model and its id from \"planned\" in .pathlight/pathlight.activity.json."));
  const overlay = yield* readOverlay(root);
  const item = (overlay.planned ?? []).find(entry => entry.path === path);
  if (!item) return yield* Effect.fail(failure("Plan.unknown", `${path} is not a planned box. plan --drop takes the folder a plan --new declared.`));
  if (item.by === "human") return yield* Effect.fail(failure("Plan.pinned", `${path} was planned by a person; it is left as it is.`));
  const { paths } = yield* listFiles(root);
  if (hasFilesIn(paths, path)) return yield* Effect.fail(failure("Plan.exists", `${path} has files, so the end of the turn draws it as built. Remove its files first to drop it.`));
  const before = yield* readKeys(root);
  const id = [...before].find(([, key]) => key === path)?.[0];
  const { planned: _planned, ...rest } = overlay;
  const remaining = (overlay.planned ?? []).filter(entry => entry.path !== path);
  yield* writeOverlay(homeOf(root), remaining.length ? { ...rest, planned: remaining } : rest);
  const drawn = yield* draftWorkspace(root, { keepJourneys: true }).pipe(Effect.tapError(() => writeOverlay(homeOf(root), overlay)));
  if (drawn.blocked) {
    yield* writeOverlay(homeOf(root), overlay);
    return yield* Effect.fail(failure("Plan.journey", `Redrawing the map now would remove ${drawn.blocked.element}, which journey ${drawn.blocked.journey} uses, so nothing was dropped. Rerun or remove that journey first.`));
  }
  const plan = yield* readPlan(root);
  // The drop is written by now: a plan that no longer fits the model is left for the next plan, never reported as a failed drop.
  if (plan && id && plan.elements.includes(id)) {
    const next = yield* setPlan(root, plan.elements.filter(element => element !== id)).pipe(Effect.option);
    return { id, plan: next._tag === "Some" ? next.value : plan };
  }
  return { id, plan };
});
