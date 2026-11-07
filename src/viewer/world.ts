import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ActivityBinding, readActivityConfig, sessionStart } from "../activity";
import { acquireModel, validateActivityMapping, type View } from "../catalog";
import { readDiff } from "../diff";
import { generatedMarker } from "../draft";
import { failure, hasCode, io } from "../effects";
import { home, modelFile } from "../layout";
import { nodeFiles } from "../node-files";
import { readPlan } from "../plan";
import { readDecisions } from "../review";
import { readStale } from "../stale";
import { readKeys, readOverlay } from "../edit";

/**
 * What the viewer draws from the workspace: the activity mapping (only when it is this project's, unless a session is watched), the files it maps
 * (an error there is shown, not fatal) and every view's LikeC4 layout. On a reload a model with errors is refused, so the last good version stays.
 */
export const loadWorld = (view: View, options: { watching: boolean; reload: boolean }) => Effect.gen(function* () {
  const raw = yield* readActivityConfig(view.workspace).pipe(
    Effect.catchIf(error => !options.watching && hasCode(error, "ENOENT"), () => Effect.succeed(undefined)));
  const config = options.watching || raw?.project === view.project ? raw : undefined;
  if (config && !options.reload) yield* validateActivityMapping(view, config);
  let fileError = "";
  const files = yield* nodeFiles(view.workspace, config).pipe(Effect.catch(error => Effect.sync(() => { fileError = error.message; return new Map<string, string[]>(); })));
  const diagrams = yield* Effect.gen(function* () {
    const source = yield* acquireModel(view.workspace);
    if (options.reload && source.hasErrors()) return yield* Effect.fail(failure("Reload.model", "The model has errors; showing the last good version"));
    const model = yield* io("LikeC4.layout", () => source.layoutedModel(view.project));
    return new Map([...model.views()].map(entry => [String(entry.id), entry.$view]));
  }).pipe(Effect.scoped);
  if (config && options.reload) yield* validateActivityMapping(view, config);
  return { config, files, fileError, diagrams };
});

/**
 * What the hooks and the agent left for the viewer: the last check, the last diff, the review's verdicts, the agent's plan and whether the map is
 * a draft. A plan belongs to the work it was set for: one set more than two hours before the watched session began (or, watching none, before now)
 * is not shown, so an old plan never marks today's work `off plan`. The two hours leave room for a person to state the scope and then start the agent.
 */
export const readChecks = (workspace: string, binding: ActivityBinding | undefined) => Effect.gen(function* () {
  const stale = yield* readStale(workspace), diff = yield* readDiff(workspace), decisions = yield* readDecisions(workspace);
  const set = yield* readPlan(workspace);
  const started = binding && set ? yield* sessionStart(workspace, binding).pipe(Effect.catch(() => Effect.succeed(undefined))) : undefined;
  const plan = set && set.time >= (started ?? Date.now()) - 7_200_000 ? set : undefined;
  const drafted = yield* io("Native.drafted", () => readFile(join(workspace, home, modelFile), "utf8")).pipe(Effect.map(text => text.startsWith(generatedMarker)), Effect.catch(() => Effect.succeed(false)));
  return { stale, diff, decisions, plan, drafted, words: drafted ? yield* wordsOf(workspace) : new Map<string, Words>() };
});

/** Who wrote an element's name and note in a drafted map's overlay: the agent's reading or a person's own. */
export interface Words { note?: string | undefined; by?: "agent" | "human" | undefined }
const wordsOf = (workspace: string) => Effect.gen(function* () {
  const keys = yield* readKeys(workspace), overlay = yield* readOverlay(workspace);
  return new Map<string, Words>([...keys].flatMap(([element, key]) => { const entry = overlay.elements[key]; return entry ? [[element, { note: entry.note, by: entry.by }] as const] : []; }));
}).pipe(Effect.catch(() => Effect.succeed(new Map<string, Words>())));
