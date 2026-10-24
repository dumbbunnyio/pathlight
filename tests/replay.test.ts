import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { readReplay, replayOf, turnActivity, type ActivityEvent } from "../src/activity";
import { claudeActivity, run, toolActivity, writeActivity } from "./effects";

const binding = { source: "claude", session: "sess" } as const;
const event = (call: string, time: number, phase: ActivityEvent["phase"] = "completed", path = "src/a.ts"): ActivityEvent =>
  ({ ...binding, version: 1, call, tool: "Read", phase, operation: "read", paths: [path], time });
const marker = (time: number): ActivityEvent => ({ ...binding, version: 1, call: `turn-${time}`, tool: "prompt", phase: "completed", operation: "turn", paths: [], time });

test("replay groups calls into turns by prompt markers, folding a call's start and end into one step", () => {
  const found = replayOf([
    marker(1000), event("a", 1001, "started"), event("a", 1002), event("b", 1003),
    marker(5000), // a prompt that ran no tool starts no turn
    marker(6000), event("c", 6001, "started"), event("c", 6002, "failed"), event("d", 6003, "started"),
  ]);
  expect(found.steps.map(step => `${step.call}:${step.phase}`)).toEqual(["a:completed", "b:completed", "c:failed", "d:started"]);
  expect(found.turns).toEqual([0, 2]);
});

test("without markers a long pause starts a new turn, and an empty journal has nothing to replay", () => {
  expect(replayOf([event("a", 1000), event("b", 2000), event("c", 200_000)]).turns).toEqual([0, 2]);
  expect(replayOf([])).toEqual({ steps: [], turns: [] });
});

test("the Claude prompt hook records that a turn began and nothing it said", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-turn-"));
  try {
    const turn = await claudeActivity(directory, { hook_event_name: "UserPromptSubmit", cwd: directory, session_id: "replay", prompt: "SECRET prompt text" });
    expect(turn.operation).toBe("turn");
    expect(JSON.stringify(turn)).not.toContain("SECRET");
    await writeActivity(directory, turn);
    await writeActivity(directory, { ...await Effect.runPromise(turnActivity(binding)), time: turn.time + 1, call: "turn-x" });
    await writeActivity(directory, toolActivity(directory, binding, "one", "Read", { file_path: "src/a.ts" }, "completed"));
    expect((await Effect.runPromise(readReplay(directory, binding))).steps.map(step => step.call)).toEqual(["one"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Step through a recorded session in the real viewer: it opens on the last turn, steps and turns move the selection, play stops at the end, esc returns to live.
test("p replays the session: steps, turns, play and exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-replay-"));
  const socket = join("/tmp", `c4r-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const at = (call: string, file: string, time: number) => writeActivity(directory, { ...toolActivity(directory, binding, call, "Read", { file_path: join(directory, file) }, "completed"), time });
    const now = Date.now();
    await writeActivity(directory, { ...await Effect.runPromise(turnActivity(binding)), time: now - 100_000 });
    await at("one", "src/launcher.ts", now - 99_000);
    await writeActivity(directory, { ...await Effect.runPromise(turnActivity(binding)), time: now - 50_000 });
    await at("two", "src/activity.ts", now - 49_000);
    await at("three", "src/launcher.ts", now - 48_000);
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "replay", "-x", "150", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory, "--session", "sess", "--source", "claude");
    const until = async (text: string, absent = false) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text) !== absent) return output;
        await delay(50);
      }
      throw new Error(`${absent ? "Still has" : "Missing"} ${text}:\n${output}`);
    };
    const press = (...keys: string[]) => tmux("send-keys", "-t", pane, ...keys);
    await until("live claude:sess");
    await press("p");
    // Opens on the start of the last turn.
    await until("2/3");
    await until("turn 2/2");
    await until("Selected: activity");
    expect(await until("replay")).toContain("◀ replay");
    // Back a turn, then forward one step at a time.
    await press("[");
    await until("1/3");
    await until("Selected: launcher");
    await press("Right");
    await until("2/3");
    await until("Selected: activity");
    await press("]");
    await until("2/3");
    // Play from the first step to the end, where it stops.
    await press("Home");
    await until("1/3");
    await press("Space");
    await until("3/3");
    await until("⏸");
    // Exit goes back to the live view.
    await press("Escape");
    await until("◀ replay", true);
    await until("live claude:sess");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(socket, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
