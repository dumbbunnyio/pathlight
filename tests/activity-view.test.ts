import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { ActivityEvent } from "../src/activity";
import { agentLabel, nowCard, ticker } from "../src/viewer/activity-view";

const text = (chunks: { text: string }[] | undefined) => (chunks ?? []).map(chunk => chunk.text).join("");

test("a subagent is labelled by its own name: the plugin's prefix and pathlight's own prefix dropped", () => {
  expect(agentLabel("pathlight:pathlight-tracer")).toBe("tracer");
  expect(agentLabel("pathlight:pathlight-namer")).toBe("namer");
  expect(agentLabel("Explore")).toBe("Explore");
  expect(agentLabel("some-plugin:reviewer")).toBe("reviewer");
});

test("the Now row and the header line show the label, not the first characters of a prefixed name", () => {
  const now = Date.now();
  const event: ActivityEvent = { version: 1, source: "claude", session: "s", call: "c1", tool: "Read", phase: "completed", operation: "read", paths: ["src/launcher.ts"], time: now - 1000, agent: "pathlight:pathlight-tracer" };
  const config = { version: 1 as const, project: "viewer", mappings: [{ glob: "src/launcher.ts", element: "launcher" }] };
  const row = text(nowCard({ error: "", bound: true, following: false, config, events: [event], element: "launcher", now, width: 40, flashes: new Map(), background: RGBA.fromHex("#000000") }).chunks);
  expect(row).toContain("·tracer");
  expect(row).not.toContain("pathlight:pa");
  expect(text(ticker(config, [{ ...event, phase: "started" }], id => id, now))).toContain("[tracer]");
});

test("the header line is live only: the verb, the label and the boxes while a call runs, no path or age, and nothing once it has an outcome", () => {
  const now = Date.now();
  const config = { version: 1 as const, project: "viewer", mappings: [{ glob: "src/launcher.ts", element: "launcher" }] };
  const event: ActivityEvent = { version: 1, source: "claude", session: "s", call: "c1", tool: "Edit", phase: "started", operation: "edit", paths: ["src/launcher.ts"], time: now - 5000 };
  const title = (id: string) => id === "launcher" ? "Backend server" : id;
  expect(text(ticker(config, [event], title, now))).toBe("now ■ edit in Backend server");
  expect(text(ticker(config, [{ ...event, agent: "Explore" }], title, now))).toBe("now ■ edit [Explore] in Backend server");
  expect(ticker(config, [{ ...event, phase: "completed", time: now - 1000 }], title, now)).toBeUndefined();
  expect(ticker(config, [{ ...event, phase: "failed", time: now - 1000 }], title, now)).toBeUndefined();
});
