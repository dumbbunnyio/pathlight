import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { diffWorkspace, formatDiff } from "../src/diff";
import { run, mappingIn } from "./effects";

const git = (directory: string, ...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
const model = `specification {\n  element component\n}\nmodel {\n  a = component 'A'\n  b = component 'B'\n  c = component 'C'\n  a -> b 'uses'\n  b -> c 'uses'\n}\nviews {\n  view index {\n    include *\n  }\n}\n`;

test("diff reports relationships an import backs now and did not at the base, ones that lost their imports, and new undeclared pairs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-diff-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "d" }));
    await writeFile(join(directory, "model.c4"), model);
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "d", mappings: [
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
    expect(diff.undeclared).toEqual([{ source: "c", target: "a", imports: 1, example: { from: "src/c.ts", line: 1, to: "src/a.ts" } }]);
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

test("the viewer says what changed against the base commit, labelled static, and says nothing when nothing did", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-diff-view-"));
  const socket = join("/tmp", `c4d-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "d" }));
    await writeFile(join(directory, "model.c4"), model);
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "d", mappings: [
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
    for (let attempt = 0; attempt < 200 && !screen.includes("vs HEAD"); attempt++) { screen = await tmux("capture-pane", "-p", "-t", pane); await delay(50); }
    // The new pair is the header's review, not repeated in the breadcrumb.
    expect(screen).toContain("vs HEAD (static) +1");
    expect(screen).not.toContain("undeclared");
    expect(screen).toContain("▲ 1 new dependency · c review");
    // Committing everything leaves nothing to show, and the line goes quiet again.
    await git(directory, "add", "-A"); await git(directory, "commit", "-q", "-m", "now");
    await run(process.execPath, [resolve("src/cli.ts"), "diff", "--workspace", directory, "--quiet"]);
    for (let attempt = 0; attempt < 200 && screen.includes("vs HEAD"); attempt++) { screen = await tmux("capture-pane", "-p", "-t", pane); await delay(50); }
    expect(screen).not.toContain("vs HEAD");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the base commit's scan is kept, used only for the same commit and scanner revision, and replaced when the commit moves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-diff-cache-"));
  const cacheDirectory = join(directory, ".cache/pathlight/base");
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "d" }));
    await writeFile(join(directory, "model.c4"), model);
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "d", mappings: [
      { glob: "src/a.ts", element: "a" }, { glob: "src/b.ts", element: "b" }, { glob: "src/c.ts", element: "c" }] }));
    await writeFile(join(directory, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(directory, "src/b.ts"), "import { c } from './c';\nexport const b = c;\n");
    await writeFile(join(directory, "src/c.ts"), "export const c = 1;\n");
    await run("git", ["-C", directory, "init", "-q"]);
    await git(directory, "add", "-A"); await git(directory, "commit", "-q", "-m", "base");
    // Working tree: b stops importing c, so b -> c is lost relative to the base.
    await writeFile(join(directory, "src/b.ts"), "export const b = 1;\n");
    const lost = [{ source: "b", target: "c", change: "removed" as const }];
    expect((await Effect.runPromise(diffWorkspace(directory))).relationships).toEqual(lost);
    const [name] = await readdir(cacheDirectory);
    const file = join(cacheDirectory, name!);
    const entry = JSON.parse(await readFile(file, "utf8")) as { revision: number; scan: { imports: unknown[] } };
    expect(entry.scan.imports.length).toBe(1);

    // A matching entry is trusted: with its import removed, nothing was lost, so there is no change to report.
    await writeFile(file, JSON.stringify({ ...entry, scan: { ...entry.scan, imports: [] } }));
    expect((await Effect.runPromise(diffWorkspace(directory))).relationships).toEqual([]);
    // One from another scanner revision, or one that is not a scan, is ignored and rebuilt from the commit.
    await writeFile(file, JSON.stringify({ ...entry, revision: entry.revision + 1, scan: { ...entry.scan, imports: [] } }));
    expect((await Effect.runPromise(diffWorkspace(directory))).relationships).toEqual(lost);
    await writeFile(file, "{ not json");
    expect((await Effect.runPromise(diffWorkspace(directory))).relationships).toEqual(lost);
    expect((JSON.parse(await readFile(file, "utf8")) as { scan: { imports: unknown[] } }).scan.imports.length).toBe(1);

    // A new commit makes a new entry and removes the old one.
    await git(directory, "add", "-A"); await git(directory, "commit", "-q", "-m", "next");
    await Effect.runPromise(diffWorkspace(directory));
    const after = await readdir(cacheDirectory);
    expect(after.length).toBe(1);
    expect(after[0]).not.toBe(name);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
