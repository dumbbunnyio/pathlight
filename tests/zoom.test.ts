import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// Beside the agent's pane the conversation is on screen, so `t` asks in a modal; zoomed (tmux's full screen, the conversation hidden) the talk is
// the column. The change is read on the resize a zoom causes, and an open request goes across with its kind and its text, both ways.
test("t is a modal beside the agent's pane and the column when the viewer is zoomed, and an open request is carried across", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-zoom-"));
  const socket = join("/tmp", `c4z-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, "-f", "/dev/null", ...args]);
  try {
    await cp("tests/fixtures/viewer", join(directory, "work"), { recursive: true });
    const agent = (await tmux("new-session", "-d", "-s", "zoom", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}", "cat")).trim();
    const pane = (await tmux("split-window", "-h", "-t", agent, "-P", "-F", "#{pane_id}", "env", `XDG_CONFIG_HOME=${join(directory, "config")}`,
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", join(directory, "work"), "--project", "viewer", "--parent", agent)).trim();
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (check: (text: string) => boolean, what: string) => {
      for (let attempt = 0; attempt < 120; attempt++) { const text = await screen(); if (check(text)) return text; await delay(50); }
      throw new Error(`Never saw ${what}:\n${await screen()}`);
    };
    const modal = (text: string) => /─ Ask ─/.test(text) && !text.includes("Talk ·");
    const column = (text: string) => text.includes("Talk · Agent adapters") && !/─ Ask ─/.test(text);
    await until(text => text.includes("Selected: plugin"), "the viewer");
    await delay(500);
    await tmux("send-keys", "-t", pane, "t");
    await until(modal, "the modal beside the agent's pane");
    await tmux("send-keys", "-t", pane, "-l", "where does it start");
    await until(text => text.includes("where does it start"), "the typed request");
    await tmux("resize-pane", "-Z", "-t", pane);
    const zoomed = await until(text => column(text) && text.includes("where does it start"), "the column, with the request carried across");
    expect(zoomed).toContain("Ask   Improve the map   Trace a journey");
    await tmux("resize-pane", "-Z", "-t", pane);
    await until(text => modal(text) && text.includes("where does it start"), "the modal again, with the request");
    // Nothing was sent to the agent's pane.
    expect(await tmux("capture-pane", "-p", "-t", agent)).not.toContain("where does it start");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
