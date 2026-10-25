import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { latestBinding } from "../src/activity";
import { claudeSettings, proposeMappings } from "../src/init";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

test("follow picks the most recently active session in this workspace only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-latest-"));
  const other = await mkdtemp(join(tmpdir(), "pathlight-latest-other-"));
  try {
    expect(await Effect.runPromise(latestBinding(directory))).toBeUndefined();
    const at = (session: string, time: number, workspace = directory) => writeActivity(workspace,
      { ...toolActivity(workspace, { source: "claude", session }, `call-${session}`, "Read", { file_path: "a.ts" }, "completed"), time });
    await at("old", 10); await at("new", 20); await at("elsewhere", 30, other);
    expect(await Effect.runPromise(latestBinding(directory))).toEqual({ source: "claude", session: "new" });
  } finally { await Promise.all([rm(directory, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]); }
}, 30_000);

test("init merges hooks without touching other settings and proposes only mappings that exist on disk", () => {
  const first = claudeSettings({ model: "x", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }] } }, "/p/plugins/claude/hook.sh");
  expect(first.model).toBe("x");
  expect(first.hooks.PreToolUse).toHaveLength(2);
  expect(first.hooks.PostToolUseFailure).toHaveLength(1);
  expect(JSON.stringify(first.hooks.Stop)).toContain("/p/plugins/claude/stop-hook.sh");
  expect(claudeSettings(first, "/p/plugins/claude/hook.sh")).toEqual(first);
  expect(proposeMappings([
    { id: "app.orders", title: "Orders" }, { id: "app.billingApi", title: "Billing API" }, { id: "app.ghost", title: "Ghost" },
  ], ["services/orders/index.ts", "src/billing-api.ts", "README.md"])).toEqual([
    { glob: "services/orders/**", element: "app.orders" }, { glob: "src/billing-api.*", element: "app.billingApi" },
  ]);
}, 30_000);

test("a viewer started with --follow shows the live badge, then switches to a newer session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-follow-"));
  const socket = join("/tmp", `c4f-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src"));
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/activity.ts", element: "activity" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "follow-test", "-x", "130", "-y", "42", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer", "--workspace", directory, "--follow");
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const capture = async (text: string) => {
      let output = "";
      for (let attempt = 0; attempt < 160; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("Selected:");
    expect(await capture("live waiting for a session")).not.toContain("claude:");
    const edit = (session: string, call: string) => writeActivity(directory,
      toolActivity(directory, { source: "claude", session }, call, "Edit", { file_path: join(directory, "src/activity.ts") }, "started"));
    await edit("session-one-aaaa", "e1");
    await capture("live claude:session-");
    // The card carries the tag in its top border while the tool runs.
    expect(await capture("─ ■")).toContain("session-");
    // `w` selects what the agent is working on.
    await tmux("send-keys", "-t", pane, "w");
    await capture("Selected: activity");
    await tmux("send-keys", "-t", pane, "Tab");
    for (let attempt = 0; attempt < 40 && (await screen()).includes("Selected: activity"); attempt++) await delay(50);
    expect(await screen()).not.toContain("Selected: activity");
    // `w` goes back to the work from wherever the selection is.
    await tmux("send-keys", "-t", pane, "w");
    await capture("Selected: activity");
    // `c` opens the session summary; Escape closes it.
    await tmux("send-keys", "-t", pane, "c");
    const summary = await capture("components touched");
    expect(summary).toContain("files edited");
    await tmux("send-keys", "-t", pane, "Escape");
    for (let attempt = 0; attempt < 40 && (await screen()).includes("components touched"); attempt++) await delay(50);
    expect(await screen()).not.toContain("components touched");
    await writeActivity(directory, toolActivity(directory, { source: "claude", session: "session-one-aaaa" }, "e-gap", "Edit",
      { file_path: join(directory, "src/unmapped-gap.ts") }, "completed"));
    // An edit to a file no component claims shows where the mapping has a gap: in the session summary.
    await tmux("send-keys", "-t", pane, "c");
    const gap = await capture("not in the model");
    expect(gap).toContain("src/unmapped-gap.ts");
    await tmux("send-keys", "-t", pane, "Escape");
    for (let attempt = 0; attempt < 40 && (await screen()).includes("components touched"); attempt++) await delay(50);
    await delay(20);
    await edit("zzz-second-session", "e2");
    await capture("live claude:zzz-seco");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
