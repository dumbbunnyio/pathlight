import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readActivity } from "./effects";

const hookCommand = async () => {
  const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: Record<string, { hooks: { command: string; async?: boolean }[] }[]> };
  expect(Object.keys(manifest.hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "PreToolUse"]);
  const commands = new Set(Object.values(manifest.hooks).flat().flatMap(entry => entry.hooks.map(hook => hook.command)));
  expect(commands.size).toBe(1);
  return [...commands][0] ?? "";
};

test("the plugin's hook records an event through the c4view command, and costs nothing without a mapping", async () => {
  const command = await hookCommand();
  const directory = await mkdtemp(join(tmpdir(), "c4view-plugin-"));
  const bin = join(directory, "bin");
  try {
    await mkdir(bin);
    // `c4view` as `bun link` would provide it: a command on PATH that runs this checkout's CLI.
    await writeFile(join(bin, "c4view"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/cli.ts")}" "$@"\n`);
    await chmod(join(bin, "c4view"), 0o755);
    const workspace = join(directory, "project");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src/a.ts"), "");
    const payload = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "plugin-session", tool_use_id: "call-1", tool_name: "Read",
      tool_input: { file_path: join(workspace, "src/a.ts") }, cwd: workspace });
    const fire = async () => {
      const child = Bun.spawn(["sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: workspace } });
      child.stdin.write(payload); child.stdin.end();
      expect(await child.exited).toBe(0);
    };
    // No c4view.activity.json: the hook exits successfully and records nothing.
    await fire();
    expect(await readActivity(workspace, { source: "claude", session: "plugin-session" })).toEqual([]);
    await writeFile(join(workspace, "c4view.activity.json"), JSON.stringify({ version: 1, project: "p", mappings: [] }));
    await fire();
    expect((await readActivity(workspace, { source: "claude", session: "plugin-session" })).map(event => [event.tool, event.phase, [...event.paths]]))
      .toEqual([["Read", "completed", ["src/a.ts"]]]);
    // Without the command on PATH the hook still exits successfully.
    const missing = Bun.spawn(["sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/", CLAUDE_PROJECT_DIR: workspace } });
    missing.stdin.write(payload); missing.stdin.end();
    expect(await missing.exited).toBe(0);
    await delay(50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the slash command calls the c4view command with the project directory", async () => {
  const text = await readFile("plugins/claude/commands/c4view.md", "utf8");
  expect(text).toContain("allowed-tools: Bash(c4view:*)");
  expect(text).toContain('c4view show $ARGUMENTS --workspace "$CLAUDE_PROJECT_DIR" --follow');
});
