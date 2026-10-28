import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("native relationship emphasis follows selection and long labels wrap and scroll without panning the diagram", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-relations-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const model = join(directory, "model.c4");
    await writeFile(model, (await readFile(model, "utf8")).replace("Records tool lifecycle",
      "Records tool lifecycle with workspace attribution and bounded retention so each agent session remains separate. " +
      "Long relationship descriptions must remain readable while the diagram stays stationary. ".repeat(8)));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "relations-test", "-x", "180", "-y", "24",
      "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory, "--project", "viewer");
    const capture = async (text: string) => {
      let output = "";
      for (let i = 0; i < 120; i++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("→ Activity metadata");
    await delay(700);
    const initial = await tmux("capture-pane", "-p", "-t", pane);
    const connectorColors = async () => {
      const colors = new Set<string>();
      let foreground = "";
      for (const match of (await tmux("capture-pane", "-e", "-p", "-t", pane)).matchAll(/\x1b\[([0-9;]*)m|([─│╭╮╰╯├┤┬┴┼┈┊▶◀▲▼])/g)) {
        if (match[2]) colors.add(foreground);
        else {
          const codes = match[1]!.split(";").map(Number);
          for (let i = 0; i < codes.length; i++) {
            if (codes[i] === 38 && codes[i + 1] === 2) { foreground = codes.slice(i + 2, i + 5).join(";"); i += 4; }
            else if (codes[i] === 48 && codes[i + 1] === 2) i += 4;
            else if (codes[i] === 0 || codes[i] === 39) foreground = "";
          }
        }
      }
      return colors;
    };
    expect(initial).toContain("Records tool lifecycle");
    expect(initial).toMatch(/[╭╮╰╯]/);
    expect(initial).toMatch(/[▶◀▲▼]/);
    expect(await connectorColors()).toContain("232;180;90");
    // A long description is clipped on its row; moving the cursor onto the row shows all of it, wrapped, and the camera does not move.
    const zoom = (text: string) => text.match(/zoom \d+%/)?.[0];
    expect(initial).toContain("Opens a view");
    await tmux("send-keys", "-t", pane, "1");
    const expanded = await capture("Long relationship");
    expect(zoom(expanded)).toBe(zoom(initial));
    expect(expanded).toContain("Selected: plugin");
    expect(expanded).toContain("Opens a view");
    await tmux("send-keys", "-t", pane, "Escape");
    await delay(300);
    expect(zoom(await tmux("capture-pane", "-p", "-t", pane))).toBe(zoom(initial));
    await tmux("send-keys", "-t", pane, "/");
    await tmux("send-keys", "-t", pane, "-l", "activity");
    await capture("› activity");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("← Agent adapters")).toContain("Selected: activity");
    await delay(700);
    expect(await connectorColors()).toContain("111;202;214");
    await tmux("send-keys", "-t", pane, "q");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
