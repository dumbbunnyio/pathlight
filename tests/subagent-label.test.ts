import { expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

// A subagent's calls arrive in the conversation's journal; they are shown with its type, and `s` hides them.
test("subagent calls carry their label in the activity list and s hides them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-subagent-"));
  const socket = join("/tmp", `c4s-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await appendFile(join(directory, "model.c4"), "\nviews {\n  view small {\n    title 'Launch path'\n    include launcher, viewer, activity\n    autoLayout LeftRight\n  }\n}\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "subagent", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "small", "--select", "activity", "--workspace", directory, "--session", "sub", "--source", "claude");
    const until = async (text: string, absent = false) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text) !== absent) return output;
        await delay(50);
      }
      throw new Error(`${absent ? "Still has" : "Missing"} ${text}:\n${output}`);
    };
    const call = async (id: string, file: string, agent?: string) => {
      const input = { file_path: join(directory, file) };
      const binding = { source: "claude", session: "sub" } as const;
      await writeActivity(directory, await toolActivity(directory, binding, id, "Read", input, "started", directory, agent));
      await writeActivity(directory, await toolActivity(directory, binding, id, "Read", input, "completed", directory, agent));
    };
    await until("Launch path");
    await call("own", "src/launcher.ts");
    // Distinct timestamps: two calls in the same millisecond have no newest.
    await delay(20);
    await call("sub", "src/activity.ts", "Explore");
    // The selected component's own rows carry the label; the header's line names the newest call and who made it.
    const shown = await until("·Explore");
    expect(shown).toContain("activity.ts");
    expect(shown).toContain("[Explore]");
    await tmux("send-keys", "-t", pane, "s");
    await until("·Explore", true);
    // Hidden, the newest call that remains is the conversation's own.
    expect(await until("launcher.ts")).not.toContain("[Explore]");
    await tmux("send-keys", "-t", pane, "s");
    await until("·Explore");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
