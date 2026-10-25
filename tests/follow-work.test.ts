import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

// Follow (`a`) selects the node of the running tool, and the user's own selection pauses it until `a` is pressed again.
test("follow selects the node being worked on, pauses when the user selects, and resumes on a, ignoring older work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-follow-work-"));
  const socket = join("/tmp", `c4w-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }, { glob: "src/viewer.ts", element: "viewer" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "follow-work", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory, "--session", "work", "--source", "claude");
    const until = async (text: string, absent = false) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text) !== absent) return output;
        await delay(50);
      }
      throw new Error(`${absent ? "Still has" : "Missing"} ${text}:\n${output}`);
    };
    // Reads end within milliseconds, so the call has usually completed by the time the viewer polls.
    const start = async (call: string, file: string) => {
      const input = { file_path: join(directory, file) };
      await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "work" }, call, "Read", input, "started"));
      await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "work" }, call, "Read", input, "completed"));
    };
    await until("Selected:");
    await delay(700);

    // Work from before follow was turned on is history, not something to jump to.
    await start("old", "src/activity.ts");
    await delay(700);
    await tmux("send-keys", "-t", pane, "a");
    await until("Following the work");
    await delay(700);
    expect((await tmux("capture-pane", "-p", "-t", pane)).match(/Selected: (\S+)/)?.[1]).not.toBe("activity");
    await start("one", "src/launcher.ts");
    await until("Selected: launcher");
    // Activity is open while it happens, even on a short pane.
    await tmux("resize-window", "-t", pane, "-x", "140", "-y", "26");
    await delay(400);
    expect(await tmux("capture-pane", "-p", "-t", pane)).toContain("launcher.ts");

    // The user selects something else: follow pauses and the next call does not move them.
    await tmux("send-keys", "-t", pane, "Tab");
    await until("Follow paused");
    const chosen = (await tmux("capture-pane", "-p", "-t", pane)).match(/Selected: (\S+)/)?.[1];
    expect(chosen).not.toBe("launcher");
    await start("two", chosen === "activity" ? "src/viewer.ts" : "src/activity.ts");
    await delay(700);
    expect((await tmux("capture-pane", "-p", "-t", pane)).match(/Selected: (\S+)/)?.[1]).toBe(chosen);
    // `a` resumes, and the newest running call is selected again.
    await tmux("send-keys", "-t", pane, "a");
    await until("Following the work");
    await start("three", chosen === "viewer" ? "src/launcher.ts" : "src/viewer.ts");
    await until(`Selected: ${chosen === "viewer" ? "launcher" : "viewer"}`);
    // Once more turns it off.
    await tmux("send-keys", "-t", pane, "a");
    await until("Follow off");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
