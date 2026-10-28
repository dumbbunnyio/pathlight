import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

test("Three camera, native labels, picking, resize, and editor return", async () => {
  const directory = await mkdtemp("/tmp/opencode/three-check-");
  const tmux = (...args: string[]) => run("tmux", ["-S", join(directory, "tmux.sock"), ...args]);
  try {
    await mkdir(resolve(".cache/native-check"), { recursive: true });
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/activity.ts"), "export const example = true;\n");
    for (let index = 1; index <= 6; index++) await writeFile(join(directory, `src/z${index}.ts`), "export {};\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/*.ts", element: "activity" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "three", "-x", "180", "-y", "45",
      "-e", "VISUAL=nvim -u NONE -i NONE -n", "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", "live",
      "--workspace", directory, "--session", "three-smoke", "--source", "claude");
    const capture = async (text: string | RegExp) => {
      let output = "";
      for (let i = 0; i < 200; i++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (typeof text === "string" ? output.includes(text) : text.test(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    const initial = await capture("Selected: plugin");
    expect(initial).toContain("Activity");
    await delay(500);
    const fitted = await tmux("capture-pane", "-p", "-t", pane);
    expect(Number(fitted.match(/zoom (\d+)%/)?.[1])).toBeGreaterThan(50);
    expect(fitted).not.toContain("6 labels hidden");
    await tmux("send-keys", "-t", pane, "0");
    await delay(700);
    const rendered = await tmux("capture-pane", "-p", "-t", pane);
    expect(rendered).toContain("zoom");
    expect(rendered).toMatch(/[╭╮╰╯]/);
    expect(rendered).toMatch(/[▶◀▲▼]/);
    expect(rendered).toMatch(/[─┈][─┈┴┬]{2,}▶/);
    await tmux("resize-window", "-t", pane, "-y", "46");
    await delay(200);
    expect(await tmux("capture-pane", "-p", "-t", pane)).toMatch(/[─┈][─┈┴┬]{2,}▶/);
    await tmux("resize-window", "-t", pane, "-y", "45");
    await delay(200);
    const divider = rendered.split("\n")[3]?.indexOf("│") ?? -1;
    expect(divider).toBeGreaterThan(100);
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${divider + 1};5M\x1b[<32;${divider - 11};5M\x1b[<0;${divider - 11};5m`);
    await delay(200);
    expect((await tmux("capture-pane", "-p", "-t", pane)).split("\n")[3]?.indexOf("│")).toBe(divider - 12);
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${divider - 11};5M\x1b[<32;${divider + 1};5M\x1b[<0;${divider + 1};5m`);
    await delay(200);
    await writeFile(resolve(".cache/native-check/capture-initial.txt"), rendered);
    await writeFile(resolve(".cache/native-check/capture-initial.ansi"), await tmux("capture-pane", "-e", "-p", "-t", pane));
    const lines = rendered.split("\n");
    const row = lines.findIndex(line => line.includes("Activity") && line.indexOf("Activity") < 125);
    const column = lines[row]?.indexOf("Activity") ?? -1;
    expect(column).toBeGreaterThanOrEqual(0);
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 3};${row + 1}M\x1b[<0;${column + 3};${row + 1}m`);
    await capture("Selected: activity");
    const event = await toolActivity(directory, { source: "claude", session: "three-smoke" }, "read-1", "Read",
      { file_path: join(directory, "src/activity.ts") }, "started");
    await writeActivity(directory, event);
    await capture("◦ read");
    await tmux("send-keys", "-t", pane, "1");
    expect(await capture("read activity.ts")).toContain("◦ read");
    await writeActivity(directory, { ...event, phase: "completed", time: Date.now() });
    expect(await capture("✓ done")).toContain("✓ read activity.ts");
    await tmux("send-keys", "-t", pane, "Escape"); await delay(300);
    await tmux("send-keys", "-t", pane, "+", "Right");
    await delay(700);
    const zoomed = await tmux("capture-pane", "-p", "-t", pane);
    const zoom = (screen: string) => Number(screen.match(/zoom (\d+)%/)?.[1]);
    expect(zoom(zoomed)).toBeGreaterThan(zoom(rendered));
    await writeFile(resolve(".cache/native-check/capture-braille.ansi"), await tmux("capture-pane", "-e", "-p", "-t", pane));
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "36");
    await delay(250);
    await tmux("send-keys", "-t", pane, "2");
    await delay(300);
    expect(await tmux("capture-pane", "-p", "-t", pane)).toMatch(/→ Persistent viewer/);
    await tmux("send-keys", "-t", pane, "Escape");
    await delay(300);
    await tmux("send-keys", "-t", pane, "f");
    await delay(700);
    await writeFile(resolve(".cache/native-check/capture-compact.ansi"), await tmux("capture-pane", "-e", "-p", "-t", pane));
    await tmux("resize-window", "-t", pane, "-x", "80", "-y", "24");
    await delay(250);
    const narrow = await tmux("capture-pane", "-p", "-t", pane);
    expect(narrow).toContain("Selected: activity");
    // With a session attached the Activity card is the last to fold, so the work stays visible on a short pane.
    expect(narrow).toContain("read activity.ts");
    await tmux("send-keys", "-t", pane, "f");
    await delay(700);
    await writeFile(resolve(".cache/native-check/capture-narrow.ansi"), await tmux("capture-pane", "-e", "-p", "-t", pane));
    await tmux("send-keys", "-t", pane, "?");
    await capture("Keyboard shortcuts");
    await tmux("send-keys", "-t", pane, "Right", "Tab", "q", "Escape");
    await delay(200);
    expect(await capture("Selected: activity")).toContain("activity");
    expect(await tmux("capture-pane", "-p", "-t", pane)).not.toContain("Keyboard shortcuts");
    await tmux("send-keys", "-t", pane, "e");
    await capture(/› [├└]─ activity\.ts/);
    await tmux("send-keys", "-t", pane, "-l", "z7");
    await capture(/Files[─\s]+0\/0/);
    await writeFile(join(directory, "src/z7.ts"), "export {};\n");
    await tmux("send-keys", "-t", pane, "C-r");
    expect(await capture(/› [├└]─ z7\.ts/)).toMatch(/Files[─\s]+1\/1/);
    await tmux("send-keys", "-t", pane, "C-u");
    await capture(/› [├└]─ activity\.ts/);
    await tmux("send-keys", "-t", pane, "Down", "Down", "Down", "Down", "Down", "Down");
    await capture(/› [├└]─ z6\.ts/);
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "20");
    await delay(250);
    expect(await capture(/› [├└]─ z6\.ts/)).toMatch(/enter\s+open/);
    await tmux("send-keys", "-t", pane, "Escape");
    await delay(200);
    await tmux("resize-window", "-t", pane, "-x", "160", "-y", "42");
    // A fitted diagram refits to the new size with an eased glide; let it settle.
    await delay(1000);
    const beforeEditor = await tmux("capture-pane", "-p", "-t", pane);
    await tmux("send-keys", "-t", pane, "e");
    await capture(/› [├└]─ activity\.ts/);
    await tmux("send-keys", "-t", pane, "Enter");
    await delay(400);
    await tmux("send-keys", "-t", pane, "Escape", ":q", "Enter");
    const returned = await capture("Returned from editor: src/activity.ts");
    expect(returned).toContain("Selected: activity");
    expect(zoom(returned)).toBe(zoom(beforeEditor));
    await tmux("send-keys", "-t", pane, "Escape", "q");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
