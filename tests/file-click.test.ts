import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

test("clicking a file row highlights it, and clicking the diagram leaves file mode instead of trapping input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-file-click-"));
  const socket = join("/tmp", `c4c-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src"));
    for (const name of ["a", "b"]) await writeFile(join(directory, "src", `${name}.ts`), "x\n");
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/**", element: "plugin" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "file-click", "-x", "150", "-y", "44", "-P", "-F", "#{pane_id}",
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
    const click = (column: number, row: number) => tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 1};${row + 1}M\x1b[<0;${column + 1};${row + 1}m`);
    const find = (text: string, screenText: string) => {
      const rows = screenText.split("\n");
      const row = rows.findIndex(line => line.includes(text));
      return { row, column: (rows[row] ?? "").indexOf(text) };
    };
    // Files stay out of sight until asked for.
    await until(text => text.includes("e files 2"), "the files count");
    await tmux("send-keys", "-t", pane, "e");
    const before = await until(text => text.includes("a.ts"), "file rows");
    const file = find("b.ts", before);
    await click(file.column + 4, file.row);
    await until(text => text.includes("Click again or Enter to open"), "file highlight");
    const diagram = find("LikeC4", await until(text => text.includes("LikeC4"), "diagram labels"));
    expect(diagram.row).toBeGreaterThan(0);
    await click(diagram.column + 2, diagram.row);
    const after = await until(text => !text.includes("Type to filter") && text.includes("Selected: catalog"), "diagram selection after leaving file mode");
    expect(after).not.toContain("Click again or Enter");
    // Arrow keys pan again rather than typing into a hidden filter.
    await tmux("send-keys", "-t", pane, "k");
    await until(text => text.includes("Selected: plugin"), "hjkl selects again");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
