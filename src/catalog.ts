import { LikeC4 } from "likec4";
import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import type { ActivityConfig } from "./activity";
import { io, failure } from "./effects";

export const acquireModel = (workspace: string) => Effect.acquireRelease(
  io("LikeC4.open", () => LikeC4.fromWorkspace(workspace, { logger: false, printErrors: false })),
  source => io("LikeC4.dispose", () => source.dispose()).pipe(Effect.orDie),
);

export const listViews = Effect.fn("Catalog.list")(function* (workspace: string) {
  const directory = yield* io("Catalog.workspace", () => realpath(workspace));
  const source = yield* acquireModel(directory);
  if (source.hasErrors()) return yield* Effect.fail(failure("Catalog.validate", "Invalid LikeC4 model. Run likec4 validate in the workspace first."));
  const views = [];
  for (const project of source.projects()) {
    const model = yield* io("LikeC4.compute", () => source.computedModel(project));
    for (const view of model.views()) views.push({ project, id: view.id, title: view.title ?? view.id });
  }
  return { workspace: directory, views };
}, Effect.scoped);

/** The view `open` shows when none is named: the one called `index`, else the first the model declares. */
export const overviewId = Effect.fn("Catalog.overview")(function* (workspace: string, project?: string) {
  const views = (yield* listViews(workspace)).views.filter(view => !project || view.project === project);
  const chosen = views.find(view => view.id === "index") ?? views[0];
  if (!chosen) return yield* Effect.fail(failure("Catalog.overview", "This workspace has no views. Ask the agent to draft a model (/pathlight) or add one."));
  return chosen.id;
});

export const selectView = Effect.fn("Catalog.select")(function* (workspace: string, id: string, project?: string) {
  const catalog = yield* listViews(workspace);
  const matches = catalog.views.filter(view => view.id === id && (!project || view.project === project));
  const view = matches[0];
  if (!view) return yield* Effect.fail(failure("Catalog.select", `Unknown view '${id}'. Run pathlight list --workspace ${workspace}.`));
  if (matches.length !== 1) return yield* Effect.fail(failure("Catalog.select", `View '${id}' exists in multiple projects. Specify --project.`));
  return { workspace: catalog.workspace, ...view };
});

export type View = Effect.Success<ReturnType<typeof selectView>>;

export const validateActivityMapping = Effect.fn("Catalog.validateMapping")(function* (view: View, config: ActivityConfig) {
  if (config.project !== view.project) return yield* Effect.fail(failure("Catalog.validateMapping", "Activity mapping project must match the selected diagram project."));
  const source = yield* acquireModel(view.workspace);
  const model = yield* io("LikeC4.compute", () => source.computedModel(view.project));
  const elements = new Set([...model.elements()].map(element => String(element.id)));
  for (const mapping of config.mappings) {
    if (!elements.has(mapping.element)) return yield* Effect.fail(failure("Catalog.validateMapping", `Unknown activity element '${mapping.element}'.`));
  }
}, Effect.scoped);
