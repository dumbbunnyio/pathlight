import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activityLines, retainedEvents } from "../src/activity";
import { activityDirectory, readActivity, toolActivity, writeActivity, claudeActivity, run } from "./effects";
import { ActivitySubscriptions } from "../src/activity-subscriptions";

test("tool observation keeps only metadata and maps explicit paths without exposing inputs", async () => {
  const event = toolActivity("/work", { source: "opencode", session: "session-a" }, "call-a", "patch", {
    patchText: "*** Update File: src/payments.ts\n+const password = 'SECRET';\n*** Add File: ../outside.ts\n+SECRET",
    token: "SECRET",
  }, "completed");
  expect(event.paths).toEqual(["src/payments.ts"]);
  expect(event.operation).toBe("edit");
  expect(JSON.stringify(event)).not.toContain("SECRET");
  expect(activityLines([event], { version: 1, project: "parcel", mappings: [
    { glob: "src/payments.ts", element: "parcel.commerce.orders" },
  ] })).toEqual(["completed edit | parcel.commerce.orders | src/payments.ts"]);
});

test("a shell command contributes only existing workspace files it names, never its text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-command-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/a.ts"), "");
    const event = toolActivity(directory, { source: "claude", session: "s" }, "c", "Bash",
      { command: "sed -i s/x/SECRET/ src/a.ts ../outside.ts src/missing.ts https://example.com/b.js --flag" }, "started");
    expect(event.operation).toBe("command");
    expect(event.paths).toEqual(["src/a.ts"]);
    expect(JSON.stringify(event)).not.toContain("SECRET");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent writers preserve tool outcomes and isolate sessions and workspaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-activity-"));
  const other = await mkdtemp(join(tmpdir(), "pathlight-other-"));
  const binding = { source: "claude", session: "session-a" } satisfies Parameters<typeof readActivity>[1];
  try {
    const finished = toolActivity(directory, binding, "call-a", "Read", { file_path: join(directory, "src/a.ts") }, "completed");
    await Promise.all([
      writeActivity(directory, finished),
      writeActivity(directory, { ...finished, call: "call-b", phase: "failed" }),
      writeActivity(directory, { ...finished, session: "session-b", call: "other-session" }),
    ]);
    await writeActivity(directory, { ...finished, phase: "started", time: finished.time + 1 });
    const events = await readActivity(directory, binding);
    expect(events.map(event => [event.call, event.phase]).sort()).toEqual([["call-a", "completed"], ["call-b", "failed"]]);
    expect(await readActivity(other, binding)).toEqual([]);
    expect((await readActivity(directory, { ...binding, session: "session-b" })).map(event => event.call)).toEqual(["other-session"]);
    await writeFile(join(await activityDirectory(directory, binding), "9999999999999999-corrupt.json"), "not json");
    expect(await readActivity(directory, binding)).toEqual(events);
    const stale = { ...finished, phase: "started", time: 1 } satisfies typeof finished;
    expect(activityLines([stale], { version: 1, project: "parcel", mappings: [] }, 40_000))
      .toEqual(["unconfirmed read | unmapped | src/a.ts"]);
  } finally { await Promise.all([rm(directory, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]); }
});

test("the activity journal is bounded and Claude failure payloads exclude tool results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-retention-"));
  try {
    const event = await claudeActivity(directory, { hook_event_name: "PostToolUseFailure", cwd: directory,
      session_id: "session-c", tool_use_id: "call-c", tool_name: "Bash", tool_input: { command: "echo SECRET" }, error: "SECRET" });
    expect(event.phase).toBe("failed");
    expect(event.paths).toEqual([]);
    expect(JSON.stringify(event)).not.toContain("SECRET");
    for (let i = 0; i < retainedEvents + 14; i++) await writeActivity(directory, { ...event, call: `call-${i}`, time: i });
    expect((await readdir(await activityDirectory(directory, event))).filter(path => path.endsWith(".json"))).toHaveLength(retainedEvents);
    const events = await readActivity(directory, event);
    expect(events).toHaveLength(128);
    expect(events[0]?.call).toBe(`call-${retainedEvents + 13}`);
    expect(events.at(-1)?.call).toBe(`call-${retainedEvents + 13 - 127}`);
    await expect(claudeActivity(directory, { hook_event_name: "PostToolUse", cwd: "/",
      session_id: "session-c", tool_use_id: "call-c", tool_name: "Read", tool_input: {} })).rejects.toThrow("does not match");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a Claude session that cd'd into a workspace subdirectory is still recorded, with paths resolved from there", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-subdir-"));
  try {
    await mkdir(join(directory, "src/deep"), { recursive: true });
    await writeFile(join(directory, "src/deep/a.ts"), "");
    const event = await claudeActivity(directory, { hook_event_name: "PostToolUse", cwd: join(directory, "src/deep"),
      session_id: "s", tool_use_id: "c", tool_name: "Read", tool_input: { file_path: "a.ts" } });
    expect(event.paths).toEqual(["src/deep/a.ts"]);
    const command = await claudeActivity(directory, { hook_event_name: "PreToolUse", cwd: join(directory, "src/deep"),
      session_id: "s", tool_use_id: "d", tool_name: "Bash", tool_input: { command: "cat a.ts ../../outside.ts" } });
    expect(command.paths).toEqual(["src/deep/a.ts"]);
    await expect(claudeActivity(directory, { hook_event_name: "PostToolUse", cwd: tmpdir(),
      session_id: "s", tool_use_id: "e", tool_name: "Read", tool_input: {} })).rejects.toThrow("does not match");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stop cancels an outstanding attachment and concurrent reservations respect the limit", () => {
  const subscriptions = new ActivitySubscriptions();
  const cancelled = subscriptions.begin("cancelled");
  subscriptions.stop("cancelled");
  expect(subscriptions.complete("cancelled", cancelled)).toBe(false);
  expect(subscriptions.watching("cancelled")).toBe(false);
  for (let index = 0; index < 7; index++) {
    const id = `session-${index}`;
    expect(subscriptions.complete(id, subscriptions.begin(id))).toBe(true);
  }
  const pending = subscriptions.begin("eighth");
  expect(() => subscriptions.begin("eighth")).toThrow("already pending");
  expect(subscriptions.complete("eighth", pending)).toBe(true);
  subscriptions.stop("eighth");
  const replacement = subscriptions.begin("eighth");
  expect(() => subscriptions.begin("ninth")).toThrow("eight sessions");
  subscriptions.fail("eighth", replacement);
  expect(subscriptions.complete("ninth", subscriptions.begin("ninth"))).toBe(true);
  const retry = subscriptions.begin("ninth");
  subscriptions.fail("ninth", retry);
  expect(subscriptions.watching("ninth")).toBe(true);
});

test("cancelling journal publication waits for a pending write before temporary-file cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-write-cancel-"));
  try {
    const output = await run(process.execPath, [resolve("tests/fixtures/activity-cancellation.ts"), directory]);
    expect(JSON.parse(output)).toEqual({ operations: ["written", "cleanup"], temporary: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
