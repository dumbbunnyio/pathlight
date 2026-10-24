import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./effects";

const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);

const project = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-setup-"));
  await mkdir(join(directory, "src/web"), { recursive: true });
  await mkdir(join(directory, "src/api"), { recursive: true });
  await writeFile(join(directory, "src/web/w.ts"), "import { a } from '../api/a';\nexport const w = a;\n");
  await writeFile(join(directory, "src/api/a.ts"), "export const a = 1;\n");
  await writeFile(join(directory, "package.json"), '{"name":"shop"}\n');
  const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
  return directory;
};

test("setup says what it would write and writes nothing until --yes; then it draws, checks and says how to open", async () => {
  const directory = await project();
  try {
    const plan = await cli("setup", "--workspace", directory);
    expect(plan).toContain("Nothing to look at yet");
    expect(plan).toContain("pathlight.model.c4, pathlight.activity.json and likec4.config.json");
    expect(plan).toContain("Run `pathlight setup --yes`");
    for (const file of ["pathlight.model.c4", "pathlight.activity.json", "likec4.config.json"]) expect(existsSync(join(directory, file))).toBe(false);

    const done = await cli("setup", "--workspace", directory, "--yes");
    expect(done).toContain("Drew 2 elements and 1 relationships from the imports");
    expect(done).toContain("Checked against the code: the picture and the code agree.");
    expect(done).toContain("/pathlight:open in Claude Code");
    for (const file of ["pathlight.model.c4", "pathlight.activity.json", "likec4.config.json"]) expect(existsSync(join(directory, file))).toBe(true);

    // A second run has nothing to do, and does not draw again.
    const before = await readFile(join(directory, "pathlight.model.c4"), "utf8");
    const again = await cli("setup", "--workspace", directory, "--yes");
    expect(again).toContain("nothing to write");
    expect(await readFile(join(directory, "pathlight.model.c4"), "utf8")).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("setup never draws over a model somebody wrote, and says what to do instead", async () => {
  const directory = await project();
  try {
    await writeFile(join(directory, "likec4.config.json"), '{"name":"mine"}\n');
    await writeFile(join(directory, "model.c4"), "specification { element component }\nmodel { web = component 'Web' }\nviews { view index { include * } }\n");
    const out = await cli("setup", "--workspace", directory, "--yes");
    expect(out).toContain("There is a model but no file mapping");
    expect(out).toContain("pathlight init");
    expect(existsSync(join(directory, "pathlight.model.c4"))).toBe(false);
    expect(await readFile(join(directory, "model.c4"), "utf8")).toContain("component 'Web'");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
