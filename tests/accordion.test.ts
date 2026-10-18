import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("the inspector's numbered sections collapse to a header with its count, by key or by click", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-accordion-"));
  const socket = join("/tmp", `c4acc-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "plugins"));
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, "plugins", `${name}.ts`), "x\n");
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
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
    const open = await until(text => text.includes("[2] Connections") && text.includes("OUTGOING"), "expanded sections");
    expect(open).toContain("[3] Files");
    expect(open).toMatch(/\[3\] Files\s+3/);
    expect(open).toContain("plugins/a.ts");
    await delay(700);
    await tmux("send-keys", "-t", pane, "2");
    const collapsed = await until(text => !text.includes("OUTGOING"), "collapsed connections");
    expect(collapsed).toMatch(/\[2\] Connections\s+2/);
    expect(collapsed).toContain("plugins/a.ts");
    await tmux("send-keys", "-t", pane, "3");
    const filesGone = await until(text => !text.includes("plugins/a.ts"), "collapsed files");
    expect(filesGone).toMatch(/\[3\] Files\s+3/);
    // Clicking a header toggles it back.
    const rows = filesGone.split("\n");
    const row = rows.findIndex(line => line.includes("[3] Files"));
    const column = (rows[row] ?? "").indexOf("[3] Files");
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 3};${row + 1}M\x1b[<0;${column + 3};${row + 1}m`);
    await until(text => text.includes("plugins/a.ts"), "files expanded by click");
    await tmux("send-keys", "-t", pane, "2");
    await until(text => text.includes("OUTGOING"), "connections expanded again");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
