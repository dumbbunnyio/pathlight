import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readActivity, mappingIn } from "./effects";

const hookCommand = async () => {
  const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: Record<string, { hooks: { command: string; async?: boolean }[] }[]> };
  expect(Object.keys(manifest.hooks).sort()).toEqual(["Notification", "PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "UserPromptSubmit"]);
  // The turn's end goes on the session pointer before the checks run (the payload is read once, by record).
  expect(manifest.hooks.Stop![0]!.hooks[0]!.command).toContain("{ pathlight record --workspace \"$f\"; pathlight check");
  expect(manifest.hooks.Notification![0]!.hooks[0]!.async).toBe(true);
  const { UserPromptSubmit: _prompt, Stop: _stop, ...recording } = manifest.hooks;
  const commands = new Set(Object.values(recording).flat().flatMap(entry => entry.hooks.map(hook => hook.command)));
  expect(commands.size).toBe(1);
  return [...commands][0] ?? "";
};

test("the plugin's hook records an event through the pathlight command, and costs nothing without a mapping", async () => {
  const command = await hookCommand();
  const directory = await mkdtemp(join(tmpdir(), "pathlight-plugin-"));
  const bin = join(directory, "bin");
  try {
    await mkdir(bin);
    // `pathlight` as `bun link` would provide it: a command on PATH that runs this checkout's CLI.
    await writeFile(join(bin, "pathlight"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/cli.ts")}" "$@"\n`);
    await chmod(join(bin, "pathlight"), 0o755);
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
    // No pathlight.activity.json: the hook exits successfully and records nothing.
    await fire();
    expect(await readActivity(workspace, { source: "claude", session: "plugin-session" })).toEqual([]);
    await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "p", mappings: [] }));
    await fire();
    expect((await readActivity(workspace, { source: "claude", session: "plugin-session" })).map(event => [event.tool, event.phase, [...event.paths]]))
      .toEqual([["Read", "completed", ["src/a.ts"]]]);
    // Without the command on PATH the hook still exits successfully.
    const missing = Bun.spawn(["sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/", CLAUDE_PROJECT_DIR: workspace } });
    // The hook may exit before reading its input, so the write can meet a closed pipe; that is not a failure.
    await Promise.resolve().then(() => { missing.stdin.write(payload); return missing.stdin.end(); })
      .catch((error: { code?: string }) => { if (error?.code !== "EPIPE") throw error; });
    expect(await missing.exited).toBe(0);
    await delay(50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("/pathlight:open is handled by a hook that blocks the prompt, so the model is never called, and other prompts pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-open-hook-"));
  try {
    await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "bin", "pathlight"), `#!/bin/sh\necho "$@" > "${directory}/args"\n`);
    await chmod(join(directory, "bin", "pathlight"), 0o755);
    const hook = async (prompt: string) => {
      const child = Bun.spawn(["sh", resolve("plugins/claude/open-hook.sh")], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { PATH: `${join(directory, "bin")}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: "/work/project" } });
      child.stdin.write(JSON.stringify({ session_id: "s", prompt })); child.stdin.end();
      return { out: await new Response(child.stdout).text(), code: await child.exited };
    };
    expect(await hook("explain this function")).toEqual({ out: "", code: 0 });
    expect(await hook("please /pathlight:open")).toEqual({ out: "", code: 0 });
    expect(await hook("/pathlight:openly")).toEqual({ out: "", code: 0 });

    const plain = await hook("/pathlight:open");
    expect(JSON.parse(plain.out)).toEqual({ continue: false, stopReason: "Opened the pathlight viewer." });
    expect((await readFile(join(directory, "args"), "utf8")).trim()).toBe("open --workspace /work/project --session s --source claude");

    expect(JSON.parse((await hook("/pathlight:open services")).out).continue).toBe(false);
    expect((await readFile(join(directory, "args"), "utf8")).trim()).toBe("open services --workspace /work/project --session s --source claude");

    // Anything but a plain view id never reaches the command line.
    await hook("/pathlight:open $(touch pwned)");
    expect((await readFile(join(directory, "args"), "utf8")).trim()).toBe("open --workspace /work/project --session s --source claude");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
