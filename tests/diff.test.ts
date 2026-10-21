import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { diffWorkspace, formatDiff } from "../src/diff";
import { run } from "./effects";

const git = (directory: string, ...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
const model = `specification {\n  element component\n}\nmodel {\n  a = component 'A'\n  b = component 'B'\n  c = component 'C'\n  a -> b 'uses'\n  b -> c 'uses'\n}\nviews {\n  view index {\n    include *\n  }\n}\n`;

test("diff reports relationships an import backs now and did not at the base, ones that lost their imports, and new undeclared pairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-diff-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "d" }));
    await writeFile(join(directory, "model.c4"), model);
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "d", mappings: [
      { glob: "src/a.ts", element: "a" }, { glob: "src/b.ts", element: "b" }, { glob: "src/c.ts", element: "c" }] }));
    // At the base: b imports c (backs b -> c); a imports nothing.
    await writeFile(join(directory, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(directory, "src/b.ts"), "import { c } from './c';\nexport const b = c;\n");
    await writeFile(join(directory, "src/c.ts"), "export const c = 1;\n");
    await run("git", ["-C", directory, "init", "-q"]);
    await git(directory, "add", "-A"); await git(directory, "commit", "-q", "-m", "base");

    // Now: a imports b (backs a -> b, new), b stops importing c (b -> c loses its import), c imports a (no relationship: new undeclared).
    await writeFile(join(directory, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");
    await writeFile(join(directory, "src/b.ts"), "export const b = 1;\n");
    await writeFile(join(directory, "src/c.ts"), "import { a } from './a';\nexport const c = a;\n");
    const diff = await Effect.runPromise(diffWorkspace(directory));
    expect(diff.basis).toBe("static");
    expect(diff.relationships).toEqual([{ source: "a", target: "b", change: "added" }, { source: "b", target: "c", change: "removed" }]);
    expect(diff.undeclared).toEqual([{ source: "c", target: "a", imports: 1 }]);
    const text = formatDiff(diff);
    expect(text).toContain("+ a → b");
    expect(text).toContain("− b → c");
    expect(text).toContain("▲ c → a");

    // Against itself nothing has changed.
    await git(directory, "add", "-A"); await git(directory, "commit", "-q", "-m", "now");
    const same = await Effect.runPromise(diffWorkspace(directory));
    expect(same.relationships).toEqual([]);
    expect(same.undeclared).toEqual([]);
    expect(formatDiff(same)).toContain("No change");
    // An earlier commit still shows the change, and a name that is not a commit is refused without running anything.
    const earlier = await Effect.runPromise(diffWorkspace(directory, "HEAD~1"));
    expect(earlier.relationships.length).toBe(2);
    await expect(Effect.runPromise(diffWorkspace(directory, "--output=/tmp/x"))).rejects.toBeDefined();
    await expect(Effect.runPromise(diffWorkspace(directory, "nope"))).rejects.toBeDefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("the viewer says what changed since the base commit, labelled static, once a diff has been recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-diff-view-"));
  const socket = join("/tmp", `c4d-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "d" }));
    await writeFile(join(directory, "model.c4"), model);
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "d", mappings: [
      { glob: "src/a.ts", element: "a" }, { glob: "src/b.ts", element: "b" }, { glob: "src/c.ts", element: "c" }] }));
    await writeFile(join(directory, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(directory, "src/b.ts"), "import { c } from './c';\nexport const b = c;\n");
    await writeFile(join(directory, "src/c.ts"), "export const c = 1;\n");
    await run("git", ["-C", directory, "init", "-q"]);
    await git(directory, "add", "-A"); await git(directory, "commit", "-q", "-m", "base");
    await writeFile(join(directory, "src/a.ts"), "import { b } from './b';\nexport const a = b;\n");
    await writeFile(join(directory, "src/c.ts"), "import { a } from './a';\nexport const c = a;\n");
    await run(process.execPath, [resolve("src/cli.ts"), "diff", "--workspace", directory, "--quiet"]);
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "diff", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "index", "--workspace", directory);
    let screen = "";
    for (let attempt = 0; attempt < 200 && !screen.includes("since HEAD"); attempt++) { screen = await tmux("capture-pane", "-p", "-t", pane); await delay(50); }
    expect(screen).toContain("since HEAD (static): +1 dependencies, 1 new with no relationship");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
