import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { run } from "./effects";

const path = "plugins/claude/skills/pathlight/SKILL.md";

test("the pathlight skill has valid frontmatter for both Claude Code and OpenCode", async () => {
  const text = await readFile(path, "utf8");
  const [, frontmatter, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  expect(frontmatter).toBeDefined();
  const field = (name: string) => frontmatter!.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
  // OpenCode: 1-64 lowercase letters, digits and single hyphens, matching the directory name; description 1-1024 characters.
  expect(field("name")).toBe("pathlight");
  expect(field("name")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect(field("description")!.length).toBeGreaterThan(20);
  expect(field("description")!.length).toBeLessThanOrEqual(1024);
  expect(body!.length).toBeGreaterThan(500);
});

test("every pathlight command and flag the skill names exists in the real CLI help", async () => {
  const text = await readFile(path, "utf8");
  const help = await run(process.execPath, [resolve("src/cli.ts"), "--help"]);
  const commands = new Set(help.split("\n").flatMap(line => line.match(/^pathlight ([a-z]+)/)?.[1] ?? []));
  expect([...commands].sort()).toEqual(["check", "init", "list", "record", "scan", "show", "view"]);
  const named = [...text.matchAll(/`pathlight ([a-z]+)[ `]/g)].map(match => match[1]!);
  expect(named.length).toBeGreaterThan(4);
  for (const command of named) expect(commands.has(command)).toBe(true);
  const flags = new Set([...text.matchAll(/--[a-z][a-z-]+/g)].map(match => match[0]));
  // --help is accepted everywhere but is not in the usage text itself.
  expect((await run(process.execPath, [resolve("src/cli.ts"), "list", "--help"])).startsWith("pathlight list")).toBe(true);
  for (const flag of flags) if (flag !== "--help") expect([flag, help.includes(flag)]).toEqual([flag, true]);
  expect(flags.size).toBeGreaterThan(5);
});
