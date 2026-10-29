import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { claudePermissions, claudeSettings, hasPathlightPermission, initWorkspace, pathlightPermission } from "../src/init";

test("init lets Claude Code run pathlight without asking: one rule merged into the shared settings, every other rule and setting kept", () => {
  expect(pathlightPermission).toBe("Bash(pathlight *)");
  const merged = claudePermissions({ model: "x", permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"], defaultMode: "default" } });
  expect(merged).toEqual({ model: "x", permissions: { allow: ["Bash(git status)", "Bash(pathlight *)"], deny: ["Read(.env)"], defaultMode: "default" } });
  expect(claudePermissions(merged)).toEqual(merged);
  expect(claudePermissions(undefined)).toEqual({ permissions: { allow: ["Bash(pathlight *)"] } });
});

test("the local hooks include Notification, so the waiting flag is recorded without the plugin too", () => {
  const settings = claudeSettings({}, "/p/plugins/claude/hook.sh");
  expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "UserPromptSubmit"]);
  expect(JSON.stringify(settings.hooks.Notification)).toContain("/p/plugins/claude/hook.sh");
});

test("init writes the rule into .claude/settings.json once, keeping what the project had, and doctor's check reads it back", async () => {
  const project = await mkdtemp(join(tmpdir(), "pathlight-init-permission-"));
  try {
    await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, env: { A: "1" } }));
    expect(hasPathlightPermission(project)).toBe(false);
    const notes = await Effect.runPromise(initWorkspace(project));
    expect(notes.join("\n")).toContain("Bash(pathlight *) added to the allowed rules in .claude/settings.json");
    const settings = JSON.parse(await readFile(join(project, ".claude", "settings.json"), "utf8"));
    expect(settings).toEqual({ permissions: { allow: ["Bash(npm test)", "Bash(pathlight *)"] }, env: { A: "1" } });
    expect(hasPathlightPermission(project)).toBe(true);
    expect((await Effect.runPromise(initWorkspace(project))).join("\n")).toContain("already allows Bash(pathlight *)");
  } finally { await rm(project, { recursive: true, force: true }); }
}, 60_000);
