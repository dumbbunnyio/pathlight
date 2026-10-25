import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chooseTracerModel, type ModelInfo } from "../plugins/opencode/tracer-model";

// What OpenCode 2.1.4 reported with an Anthropic key set (trimmed): enabled models are the ones the person can use.
const reported = async () => JSON.parse(await readFile("tests/fixtures/opencode-models.json", "utf8")) as ModelInfo[];

test("an enabled Sonnet-class model is pinned: the newest active one, never a deprecated, disabled or other-family model", async () => {
  const choice = chooseTracerModel(await reported());
  expect(choice).toMatchObject({ ref: "anthropic/claude-sonnet-5-5", source: "sonnet", tested: true });
  expect(choice.note).toContain("Set tracerModel to change it");
});

test("without a Sonnet-class model nothing is pinned, and models in Sonnet's price range are only suggested", async () => {
  const models = (await reported()).filter(model => !/sonnet/.test(model.id));
  const other: ModelInfo = { provider: "other", id: "mid-1", name: "Mid", released: 1, status: "active", enabled: true, tools: true, cost: [{ in: 1, out: 8 }] };
  const cheap: ModelInfo = { ...other, id: "tiny", cost: [{ in: 0.1, out: 0.4 }] };
  const noTools: ModelInfo = { ...other, id: "notools", tools: false };
  const none = chooseTracerModel([...models, other, cheap, noTools]);
  expect(none.ref).toBeUndefined();
  expect(none.source).toBe("none");
  expect(none.candidates).toEqual(["other/mid-1 ($8 per million output tokens)"]);
  expect(none.note).toContain("none of them tested");
  const empty = chooseTracerModel([cheap]);
  expect(empty).toMatchObject({ source: "none", candidates: [] });
  expect(empty.note).toContain("Set tracerModel");
});

test("tracerModel wins when the person can use it; otherwise it is reported and the rule decides", async () => {
  const models = await reported();
  expect(chooseTracerModel(models, "anthropic/claude-opus-5-5")).toMatchObject({ ref: "anthropic/claude-opus-5-5", source: "option", tested: false });
  expect(chooseTracerModel(models, "anthropic/claude-sonnet-4-6")).toMatchObject({ ref: "anthropic/claude-sonnet-4-6", source: "option", tested: true });
  const gone = chooseTracerModel(models, "opencode/claude-sonnet-5-5");
  expect(gone).toMatchObject({ ref: "anthropic/claude-sonnet-5-5", source: "sonnet" });
  expect(gone.note).toContain("you cannot use right now");
  // Before the host has listed anything, the person's choice is trusted.
  expect(chooseTracerModel([], "x/y")).toMatchObject({ ref: "x/y", source: "option" });
  expect(chooseTracerModel(models, "  ")).toMatchObject({ source: "sonnet" });
});
