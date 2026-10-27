import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { observeOpenCode } from "./opencode-observe";

// Does the real OpenCode accept the tracer agent the plugin registers, and does the model the person can use decide what it is pinned to?
test.skipIf(!Bun.which("opencode"))("in the real OpenCode the tracer is a subagent, unpinned without a Sonnet-class model and pinned to one when the person has an Anthropic key", async () => {
  const without = await observeOpenCode(resolve("plugins/opencode"), ["PATHLIGHT_TEST=1"]);
  expect(without.agent).toMatchObject({ mode: "subagent", model: null });
  expect(without.agent!.rules).toBeGreaterThan(5);
  expect(without.skills).toEqual(expect.arrayContaining(["pathlight", "pathlight-behavior"]));
  const withKey = await observeOpenCode(resolve("plugins/opencode"), ["ANTHROPIC_API_KEY=placeholder"]);
  expect(withKey.agent).toMatchObject({ mode: "subagent", model: { providerID: "anthropic" } });
  expect(withKey.agent!.model!.id).toMatch(/^claude-sonnet/);
}, 120_000);

test.skipIf(!Bun.which("opencode"))("registered by init --global in OpenCode's own configuration, the plugin loads in a project that names it nowhere", async () => {
  const observed = await observeOpenCode(resolve("plugins/opencode"), ["PATHLIGHT_TEST=1"], { global: true });
  expect(observed.agent).toMatchObject({ mode: "subagent" });
  expect(observed.skills).toEqual(expect.arrayContaining(["pathlight", "pathlight-behavior"]));
}, 60_000);
