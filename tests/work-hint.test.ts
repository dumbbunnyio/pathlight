import { expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

// Work in a component that this view does not show is offered, never taken: a hint names the view, and `w` goes there and selects the component.
test("work outside the view shows a hint and w switches to the view that has it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-work-hint-"));
  const socket = join("/tmp", `c4h-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer\n    autoLayout LeftRight\n  }\n}\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work-hint", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--workspace", directory, "--session", "work", "--source", "claude");
    const until = async (text: string, absent = false) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text) !== absent) return output;
        await delay(50);
      }
      throw new Error(`${absent ? "Still has" : "Missing"} ${text}:\n${output}`);
    };
    const call = async (id: string, file: string) => {
      const input = { file_path: join(directory, file) };
      await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "work" }, id, "Read", input, "started"));
      await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "work" }, id, "Read", input, "completed"));
    };
    await until("Launch path");
    await call("one", "src/launcher.ts");
    await until("Pathlight implementation", true);
    expect(await tmux("capture-pane", "-p", "-t", pane)).not.toContain("working in");
    await call("two", "src/activity.ts");
    await until("working in Pathlight implementation");
    // Nothing moved by itself.
    expect(await tmux("capture-pane", "-p", "-t", pane)).toContain("Launch path");
    await tmux("send-keys", "-t", pane, "w");
    await until("Selected: activity");
    expect(await tmux("capture-pane", "-p", "-t", pane)).toContain("Pathlight implementation");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
