import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// From the last node on the right, `l` hands the keys to the inspector and `h` gives them back.
test("l past the right-most node focuses the inspector and h returns to the diagram", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-focus-"));
  const socket = join("/tmp", `c4h-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "focus", "-x", "150", "-y", "42", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory, "--project", "viewer");
    const until = async (text: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await until("Selected:");
    for (let step = 0; step < 12 && !(await tmux("capture-pane", "-p", "-t", pane)).includes("esc diagram"); step++) {
      await tmux("send-keys", "-t", pane, "l"); await delay(150);
    }
    await until("esc diagram");
    await tmux("send-keys", "-t", pane, "h");
    for (let attempt = 0; attempt < 40 && (await tmux("capture-pane", "-p", "-t", pane)).includes("esc diagram"); attempt++) await delay(50);
    expect(await tmux("capture-pane", "-p", "-t", pane)).not.toContain("esc diagram");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
