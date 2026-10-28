import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// `h j k l` stay on their side: from the last node on the right, `l` says there is nothing there; tab crosses into the inspector, `h` in a card does
// nothing, and tab past the last card comes back.
test("l past the right-most node stays in the diagram; tab crosses into the inspector and back, and h in a card does nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-focus-"));
  const socket = join("/tmp", `c4h-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "focus", "-x", "150", "-y", "42", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory, "--project", "viewer", "--select", "viewer");
    const until = async (text: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await until("Selected: viewer");
    await delay(700);
    // Persistent viewer is the right-most box.
    await tmux("send-keys", "-t", pane, "l");
    const edge = await until("Nothing to the right of Persistent viewer");
    expect(edge).toContain("Selected: viewer");
    expect(edge).not.toContain("esc diagram");
    await tmux("send-keys", "-t", pane, "Tab");
    await until("esc diagram");
    await tmux("send-keys", "-t", pane, "h");
    await delay(300);
    const stayed = await tmux("capture-pane", "-p", "-t", pane);
    expect(stayed).toContain("esc diagram");
    expect(stayed).toContain("Selected: viewer");
    // Connects is the only card shown with no session (Files waits for its number): tab past it is the diagram again, and the selection never moved.
    await tmux("send-keys", "-t", pane, "Tab");
    for (let attempt = 0; attempt < 40 && (await tmux("capture-pane", "-p", "-t", pane)).includes("esc diagram"); attempt++) await delay(50);
    const back = await tmux("capture-pane", "-p", "-t", pane);
    expect(back).not.toContain("esc diagram");
    expect(back).toMatch(/diagram\s+Selected: viewer/);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
