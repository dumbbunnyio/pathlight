import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run, toolActivity, writeActivity, mappingIn } from "./effects";

const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);
const model = `specification {\n  element component\n}\nmodel {\n  a = component 'Alpha'\n  b = component 'Beta'\n  c = component 'Gamma'\n  a -> b 'uses'\n}\nviews {\n  view index {\n    include *\n    autoLayout LeftRight\n  }\n}\n`;

const workspace = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-plan-"));
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "d" }));
  await writeFile(join(directory, "model.c4"), model);
  await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "d", mappings: [
    { glob: "src/a.ts", element: "a" }, { glob: "src/b.ts", element: "b" }, { glob: "src/c.ts", element: "c" }] }));
  for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/${name}.ts`), `export const ${name} = 1;\n`);
  return directory;
};

test("plan records element ids only, refuses unknown ones, and clears", async () => {
  const directory = await workspace();
  try {
    expect(await cli("plan", "b", "a", "a", "--workspace", directory)).toBe("Plan: a, b");
    const saved = JSON.parse(await readFile(join(directory, ".cache/pathlight/plan.json"), "utf8")) as { elements: string[] };
    expect(saved.elements).toEqual(["a", "b"]);
    expect(Object.keys(saved).sort()).toEqual(["elements", "time", "version"]);
    await expect(cli("plan", "a", "ghost", "--workspace", directory)).rejects.toThrow(/Unknown element: ghost/);
    // A refused plan leaves the previous one alone.
    expect((JSON.parse(await readFile(join(directory, ".cache/pathlight/plan.json"), "utf8")) as { elements: string[] }).elements).toEqual(["a", "b"]);
    expect(await cli("plan", "--workspace", directory)).toBe("Plan cleared.");
    await expect(readFile(join(directory, ".cache/pathlight/plan.json"), "utf8")).rejects.toBeDefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("the viewer outlines the plan in its breadcrumb and marks activity on an element outside it", async () => {
  const directory = await workspace();
  const socket = join("/tmp", `c4n-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cli("plan", "a", "--workspace", directory);
    const binding = { source: "claude" as const, session: "plan-session" };
    const touch = (file: string, call: string) => writeActivity(directory, toolActivity(directory, binding, call, "Read", { file_path: file }, "completed"));
    await touch("src/a.ts", "one"); await touch("src/c.ts", "two");
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "plan", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "index", "--workspace", directory, "--session", binding.session, "--source", "claude");
    let screen = "";
    for (let attempt = 0; attempt < 200 && !(screen.includes("plan 1") && screen.includes("off plan")); attempt++) { screen = await tmux("capture-pane", "-p", "-t", pane); await delay(50); }
    expect(screen).toContain("plan 1");
    // The breadcrumb and the latest-call ticker share one line and must not run together.
    const second = screen.split("\n")[1] ?? "";
    expect(second).toMatch(/plan 1(\s{3,}\S.*)?\s*$/);
    // Only Gamma (c, outside the plan) is marked; Alpha was touched but is in the plan.
    expect((screen.match(/off plan/g) ?? []).length).toBe(1);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
