import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { draftWorkspace, viewCap } from "../src/draft";
import { run } from "./effects";

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

// A view about one component opens with that component selected, whether LikeC4 scopes the view to it or (for a hub with more neighbours than a view
// holds) the view lists them by name.
test("a component's neighbourhood opens with the component selected, for an ordinary one and for a hub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-near-"));
  const socket = join("/tmp", `c4n-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "near" }) };
    const spokes = viewCap + 4;
    for (const leaf of ["a", "b", "c"]) files[`src/hub/${leaf}.ts`] = leaf === "a" ? `import "../mid/a";\\n` : `export const ${leaf} = 1;\\n`;
    files["src/mid/a.ts"] = "export const a = 1;\n"; files["src/mid/b.ts"] = "export const b = 1;\n"; files["src/mid/c.ts"] = "export const c = 1;\n";
    files["src/hub/a.ts"] = `import "../mid/a";\n` + Array.from({ length: spokes }, (_, n) => `import "../s${String(n).padStart(2, "0")}/a";\n`).join("");
    for (let n = 0; n < spokes; n++) for (const leaf of ["a", "b", "c"]) files[`src/s${String(n).padStart(2, "0")}/${leaf}.ts`] = `export const ${leaf} = 1;\n`;
    await write(directory, files);
    await Effect.runPromise(draftWorkspace(directory));
    const opened = async (view: string) => {
      const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", view, "-x", "160", "-y", "45", "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", view, "--workspace", directory);
      for (let attempt = 0; attempt < 200; attempt++) {
        const screen = await tmux("capture-pane", "-p", "-t", pane);
        const selected = screen.match(/Selected: (\S+)/);
        if (selected) { await tmux("kill-session", "-t", view); return selected[1]; }
        await delay(50);
      }
      throw new Error(`${view} never opened`);
    };
    // `mid` has a few neighbours: scoped to it. `hub` has more than a view holds: listed by name. Both select their own component.
    expect(await opened("mid_near")).toBe("mid");
    expect(await opened("hub_near")).toBe("hub");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
