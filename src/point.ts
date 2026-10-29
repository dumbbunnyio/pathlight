import { readdir, readFile, readlink, realpath, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { readActivityConfig } from "./activity";
import { acquireModel, invalidModel } from "./catalog";
import { readKeys } from "./edit";
import { failure, io, json } from "./effects";

/**
 * Where an agent walking a person through the map asks the viewer to look: one element (and, if it says so, the view to show it in), ids and a time
 * only. The viewer selects it once, marks it as the agent's pointing until the person presses a key, and never follows it again: a new pointer is a
 * new request, and nothing here makes the viewer track the agent.
 */
export const Point = Schema.Struct({
  version: Schema.Literal(1), at: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  element: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[\w.-]+$/)),
  view: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[\w.-]+$/))),
});
export interface Point extends Schema.Schema.Type<typeof Point> {}

const pointPath = (root: string) => join(root, ".cache", "pathlight", "point.json");

/**
 * Whether a viewer is open on this workspace: a `pathlight view` process (as `show`, `open` and `see` start it) whose workspace is this one. Read from
 * Linux's process table, the platform the viewer is verified on; anywhere else it says no viewer is open.
 */
export const viewerOpen = (root: string) => io("Point.viewers", async () => {
  for (const pid of (await readdir("/proc").catch(() => [] as string[])).filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) {
    const args = (await readFile(join("/proc", pid, "cmdline"), "utf8").catch(() => "")).split("\0").filter(Boolean);
    const at = args.indexOf("view");
    if (at < 1 || !(basename(args[0]!).startsWith("pathlight") || args.slice(1, at).some(arg => arg.endsWith("cli.ts")))) continue;
    const flag = args.indexOf("--workspace", at), cwd = await readlink(join("/proc", pid, "cwd")).catch(() => undefined);
    if (!cwd) continue;
    if (await realpath(resolve(cwd, flag > 0 ? args[flag + 1] ?? "." : ".")).catch(() => "") === root) return true;
  }
  return false;
});

/**
 * Points the viewer at an element (it must exist in the model; a view, if given, must draw it), or clears the pointer with none. On a drafted map a
 * box's key from `pathlight brief` (`src/session`, `.#loose`) names its element too, so the identifiers in the briefing can be pointed at as printed.
 */
export const setPoint = Effect.fn("Point.set")(function* (workspace: string, named: string | undefined, view?: string) {
  const root = yield* io("Point.root", () => realpath(workspace));
  if (!named) {
    if (view) return yield* Effect.fail(failure("Point.view", "--view needs an element to point at."));
    yield* io("Point.clear", () => rm(pointPath(root), { force: true }));
    return { cleared: true as const };
  }
  // The mapping names the project when there is one; a model with no mapping yet is its own first project.
  const config = yield* readActivityConfig(root).pipe(Effect.option);
  const source = yield* acquireModel(root);
  if (source.hasErrors()) return yield* Effect.fail(failure("Point.model", invalidModel(source, root)));
  const project = config._tag === "Some" ? config.value.project : [...source.projects()][0];
  if (!project) return yield* Effect.fail(failure("Point.model", "No LikeC4 project in this workspace."));
  const model = yield* io("LikeC4.compute", () => source.computedModel(project));
  const ids = new Set([...model.elements()].map(item => String(item.id)));
  const element = ids.has(named) ? named : [...(yield* readKeys(root))].find(([id, key]) => key === named && ids.has(id))?.[0];
  if (!element) return yield* Effect.fail(failure("Point.element", `Unknown element: ${named}. Use an id from the model (pathlight check) or a box's key from pathlight brief.`));
  if (view) {
    const found = [...model.views()].find(item => item.id === view);
    if (!found) return yield* Effect.fail(failure("Point.view", `Unknown view: ${view}. pathlight list names the views.`));
    if (![...found.elements()].some(item => String(item.element.id) === element)) return yield* Effect.fail(failure("Point.view", `The view ${view} does not draw ${element}. Leave out --view and the viewer finds one that does.`));
  }
  if (!(yield* viewerOpen(root))) return { written: false as const };
  const point = yield* Schema.decodeUnknownEffect(Point)({ version: 1, at: Date.now(), element, ...(view ? { view } : {}) });
  yield* io("Point.write", async () => {
    await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
    const temporary = `${pointPath(root)}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(point)}\n`);
    await rename(temporary, pointPath(root));
  });
  return { written: true as const, point };
}, Effect.scoped);

export const readPoint = (workspace: string) => Effect.gen(function* () {
  const text = yield* io("Point.read", () => readFile(pointPath(workspace), "utf8"));
  return yield* Schema.decodeUnknownEffect(Point, { onExcessProperty: "error" })(yield* json(text));
}).pipe(Effect.option, Effect.map(found => found._tag === "Some" ? found.value : undefined));
