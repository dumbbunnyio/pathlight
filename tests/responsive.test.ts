import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("the diagram stays fitted through resize until panned or zoomed; narrow terminals overlay the inspector and under 80 columns list the nodes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-responsive-"));
  const socket = join("/tmp", `c4r-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "responsive", "-x", "150", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer", "--workspace", directory);
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await screen();
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    const zoom = (text: string) => Number(text.match(/zoom (\d+)%/)?.[1]);
    // The inspector's rows for the selected node, as they appear on the right of the screen.
    const inspectorShown = (text: string) => text.includes("2 Connections");

    // Wide: docked inspector. Resizing a fitted diagram refits it.
    await until(text => text.includes("Selected: plugin") && inspectorShown(text), "docked inspector");
    await delay(900);
    const wide = zoom(await screen());
    await tmux("resize-window", "-t", pane, "-x", "130", "-y", "40");
    await until(text => Math.abs(zoom(text) - wide) >= 1, "refit after resize");
    await delay(900);

    // A zoom the user chose survives the next resize.
    await tmux("send-keys", "-t", pane, "+");
    await delay(700);
    const zoomed = zoom(await screen());
    await tmux("resize-window", "-t", pane, "-x", "150", "-y", "40");
    await delay(1200);
    expect(zoom(await screen())).toBe(zoomed);
    // `f` fits again, and the diagram follows the next resize.
    await tmux("send-keys", "-t", pane, "f");
    await delay(900);
    const fitted = zoom(await screen());
    expect(fitted).toBeLessThan(zoomed);

    // Below 120 columns the inspector is an overlay that `i` toggles.
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "40");
    await until(text => !inspectorShown(text) && text.includes("zoom"), "inspector hidden below 120 columns");
    await delay(600);
    await tmux("send-keys", "-t", pane, "i");
    const overlay = await until(inspectorShown, "inspector overlay");
    expect(overlay).toContain("│ Agent adapters");
    await tmux("send-keys", "-t", pane, "i");
    await until(text => !inspectorShown(text), "overlay closed");

    // Under 80 columns the nodes are a list: the selection moves with the arrows, not by neighbour.
    await tmux("resize-window", "-t", pane, "-x", "70", "-y", "40");
    await delay(400);
    const list = await until(text => /› Agent adapters\s+component/.test(text), "node list");
    expect(list).not.toContain("╭");
    await tmux("send-keys", "-t", pane, "Down");
    const next = await until(text => /Selected: (?!plugin)/.test(text), "selection moved down the list");
    expect(next).toMatch(/› \S/);
    await tmux("send-keys", "-t", pane, "Up");
    await until(text => text.includes("Selected: plugin") && /› Agent adapters/.test(text), "selection back on the first row");

    // Back to a wide terminal: the diagram returns.
    await tmux("resize-window", "-t", pane, "-x", "150", "-y", "40");
    await until(text => text.includes("╭") && inspectorShown(text), "diagram and docked inspector again");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the first click on an inspector header focuses the section and the second folds it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-header-click-"));
  const socket = join("/tmp", `c4h-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "header-click", "-x", "150", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer", "--workspace", directory);
    const screen = () => tmux("capture-pane", "-p", "-t", pane);
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        output = await screen();
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    const click = async (text: string) => {
      const lines = (await screen()).split("\n");
      const y = lines.findIndex(line => line.includes(text));
      expect(y).toBeGreaterThanOrEqual(0);
      const x = lines[y]!.indexOf(text) + 1;
      await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
    };
    await until(text => text.includes("Selected: plugin") && text.includes("2 Connections"), "inspector");
    await delay(900);
    const open = (text: string) => text.includes("▾ 2 Connections");
    expect(open(await screen())).toBe(true);
    await click("2 Connections");
    await until(text => /^ connections /m.test(text) || text.includes(" connections  "), "connections focused");
    expect(open(await screen())).toBe(true);
    await click("2 Connections");
    await until(text => text.includes("▸ 2 Connections"), "connections folded");
    await click("2 Connections");
    await until(text => text.includes("▾ 2 Connections") || text.includes("▸ 2 Connections"), "still drawn");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
