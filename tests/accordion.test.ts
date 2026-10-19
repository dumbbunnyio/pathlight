import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("a number focuses an inspector section: move within it, act on an item, fold it with Space, leave with Esc", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-accordion-"));
  const socket = join("/tmp", `c4acc-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "plugins"));
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, "plugins", `${name}.ts`), "x\n");
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "acc", "-x", "150", "-y", "44", "-P", "-F", "#{pane_id}",
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
    const open = await until(text => /2 Connections[─\s]+2/.test(text) && text.includes("out 2 · in 0") && /3 Files[─\s]+3/.test(text), "expanded sections with mapped files");
            expect(open).toContain("a.ts");
    await delay(700);
    // A number focuses a section: the mode pill names it and the movement keys now belong to it.
    await tmux("send-keys", "-t", pane, "2");
    await until(text => text.includes("Connections") && /enter\s+show in diagram/.test(text), "connections focused");
    expect(await screen()).toContain("out 2 · in 0");
    // j moves to the second connection; Enter shows that node in the diagram, and the focus stays in the section.
    await tmux("send-keys", "-t", pane, "j", "Enter");
    await until(text => text.includes("Selected: launcher"), "walked to tmux launcher");
    expect(await screen()).toContain("Connections");
    // Space folds the focused section to a header with its count.
    await tmux("send-keys", "-t", pane, "Space");
    const collapsed = await until(text => !text.includes("Starts owned pane"), "folded connections");
    expect(collapsed).toMatch(/2 Connections[─\s]+\d/);
    await tmux("send-keys", "-t", pane, "Space");
    await until(text => text.includes("Starts owned pane"), "unfolded connections");
    // Esc hands the keys back to the diagram: hjkl select neighbours again.
    await tmux("send-keys", "-t", pane, "Escape");
    await until(text => /diagram\s+Selected/.test(text), "diagram focus");
    await tmux("send-keys", "-t", pane, "h");
    await until(text => !text.includes("Selected: launcher"), "diagram navigation resumed");
    // Clicking a header folds that section and focuses it.
    await tmux("send-keys", "-t", pane, "3");
    await until(text => text.includes("files") || text.includes("enter  open"), "files focused");
    await tmux("send-keys", "-t", pane, "Space");
    const filesGone = await until(text => !text.includes("a.ts"), "folded files");
    expect(filesGone).toMatch(/3 Files[─\s]+\d/);
    const rows = filesGone.split("\n");
    const row = rows.findIndex(line => line.includes("3 Files"));
    const column = (rows[row] ?? "").indexOf("3 Files");
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 3};${row + 1}M\x1b[<0;${column + 3};${row + 1}m`);
    await until(text => text.includes("a.ts"), "files unfolded by click");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
