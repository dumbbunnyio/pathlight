import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { readActivityConfig } from "./activity";
import { acquireModel, invalidModel } from "./catalog";
import { failure, io, json } from "./effects";

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
