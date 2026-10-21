import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./effects";

const path = "plugins/claude/skills/pathlight/SKILL.md";

test.each(["pathlight", "pathlight-behavior"])("the %s skill has valid frontmatter for both Claude Code and OpenCode", async name => {
  const text = await readFile(`plugins/claude/skills/${name}/SKILL.md`, "utf8");
  const [, frontmatter, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  expect(frontmatter).toBeDefined();
  const field = (name: string) => frontmatter!.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
  // OpenCode: 1-64 lowercase letters, digits and single hyphens, matching the directory name; description 1-1024 characters.
  expect(field("name")).toBe(name);
  expect(field("name")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(field("description")!.length).toBeGreaterThan(20);
  expect(field("description")!.length).toBeLessThanOrEqual(1024);
  expect(body!.length).toBeGreaterThan(500);
});

test("every pathlight command and flag the skill names exists in the real CLI help", async () => {
  const text = await readFile(path, "utf8");
  const help = await run(process.execPath, [resolve("src/cli.ts"), "--help"]);
  const commands = new Set(help.split("\n").flatMap(line => line.match(/^pathlight ([a-z]+)/)?.[1] ?? []));
  expect([...commands].sort()).toEqual(["check", "diff", "doctor", "draft", "init", "list", "open", "plan", "record", "scan", "show", "view"]);
  const named = [...text.matchAll(/`pathlight ([a-z]+)[ `]/g)].map(match => match[1]!);
  expect(named.length).toBeGreaterThan(4);
  for (const command of named) expect(commands.has(command)).toBe(true);
  const flags = new Set([...text.matchAll(/--[a-z][a-z-]+/g)].map(match => match[0]));
  // --help is accepted everywhere but is not in the usage text itself.
  expect((await run(process.execPath, [resolve("src/cli.ts"), "list", "--help"])).startsWith("pathlight list")).toBe(true);
  for (const flag of flags) if (flag !== "--help") expect([flag, help.includes(flag)]).toEqual([flag, true]);
  expect(flags.size).toBeGreaterThan(5);
});

// The example in the behavior skill is what an agent copies, so it must compile and draw as a view.
test("the behavior skill's example model compiles and is listed as a view", async () => {
  const text = await readFile("plugins/claude/skills/pathlight-behavior/SKILL.md", "utf8");
  const example = text.match(/```likec4\n([\s\S]*?)```/)?.[1];
  expect(example).toBeDefined();
  const directory = await mkdtemp(join(tmpdir(), "pathlight-behavior-"));
  try {
    await writeFile(join(directory, "likec4.config.json"), JSON.stringify({ name: "demo" }));
    await writeFile(join(directory, "signup.behavior.c4"), example!);
    expect(await run(process.execPath, [resolve("src/cli.ts"), "list", "--workspace", directory])).toContain("signup");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a draft rerun leaves a behavior file beside it alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-behavior-draft-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "demo" }));
    await mkdir(join(directory, "src/a"), { recursive: true });
    for (const file of ["x", "y", "z", "w"]) await writeFile(join(directory, "src/a", `${file}.ts`), "export const v = 1;\n");
    const behavior = "specification {\n  element flow\n  element state\n  tag behavior\n}\nmodel {\n  steps = flow 'Steps' {\n    #behavior\n    start = state 'Start'\n  }\n}\nviews {\n  view steps of steps {\n    include *\n  }\n}\n";
    await writeFile(join(directory, "flow.behavior.c4"), behavior);
    await run(process.execPath, [resolve("src/cli.ts"), "draft", "--workspace", directory]);
    await run(process.execPath, [resolve("src/cli.ts"), "draft", "--workspace", directory]);
    expect(await readFile(join(directory, "flow.behavior.c4"), "utf8")).toBe(behavior);
    expect(await run(process.execPath, [resolve("src/cli.ts"), "list", "--workspace", directory])).toContain("steps");
    expect(await readFile(join(directory, "pathlight.model.c4"), "utf8")).toContain("exclude * where tag is #behavior");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// `pathlight init` compiles the skills in by name, so a skill added to the folder must be added there too.
test("init embeds every skill in the plugin's skills folder", async () => {
  expect((await readdir("plugins/claude/skills")).sort()).toEqual(["pathlight", "pathlight-behavior"]);
});
