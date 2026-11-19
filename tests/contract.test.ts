import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { contract } from "../src/contract";

// Before any release: the plugins and the binary ship apart, and a binary older than the plugin redrew a map without what it did not know (Phase 7's
// `runs`), after which the viewer failed. The plugins ask `pathlight needs N` first; a binary older than that command fails it too.
const cli = (args: string[], env: Record<string, string> = {}) => {
  const done = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

/** A workspace with a mapping, and a `pathlight` on the PATH as old as any before `needs`: it logs each call and knows no `needs`. */
const withOldBinary = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-contract-"));
  await mkdir(join(directory, ".pathlight"), { recursive: true });
  await writeFile(join(directory, ".pathlight/pathlight.activity.json"), JSON.stringify({ version: 1, project: "x", mappings: [] }));
  const bin = join(directory, "bin"), log = join(directory, "calls.log");
  await mkdir(bin);
  await writeFile(join(bin, "pathlight"), `#!/bin/sh\necho "$1" >> '${log}'\n[ "$1" = needs ] && { echo "Unknown command 'needs'." >&2; exit 1; }\nexit 0\n`);
  await chmod(join(bin, "pathlight"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: directory } as Record<string, string>;
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { directory, bin, env, calls };
};

test("needs passes for this binary's contract and fails above it", () => {
  expect(cli(["needs", String(contract)])).toMatchObject({ code: 0, out: "", err: "" });
  const above = cli(["needs", String(contract + 1)]);
  expect(above.code).toBe(1);
  expect(above.err).toContain("npm i -g @dumbbunnyio/pathlight");
  expect(cli(["needs", "x"]).code).toBe(1);
});

test("the Claude plugin's hooks ask for this binary's contract", async () => {
  const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  const stop = manifest.hooks.Stop[0]!.hooks[0]!.command;
  expect(stop).toContain(`pathlight needs ${contract} `);
  expect(stop.indexOf("pathlight needs")).toBeLessThan(stop.indexOf("pathlight refresh"));
  expect(await readFile("plugins/claude/open-hook.sh", "utf8")).toContain(`pathlight needs ${contract} `);
  expect(await readFile("plugins/claude/needs-hook.sh", "utf8")).toContain(`pathlight needs ${contract} `);
});

// The agent's own calls write too (the map skill's `pathlight name` redraws): an old binary is refused before it runs, inside the turn.
test("with a pathlight older than the plugin, the agent's call to a command that writes the map is refused; any other call is untouched", async () => {
  const { env, calls } = await withOldBinary();
  try {
    const gate = (command: string, tool = "Bash") => {
      const done = Bun.spawnSync(["sh", "plugins/claude/needs-hook.sh"], { env, stdout: "pipe", stderr: "pipe",
        stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } })) });
      const out = done.stdout.toString().trim();
      return { code: done.exitCode, decision: out ? (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : undefined };
    };
    expect(gate("cd x && pathlight name --from - <<'EOF'\n[]\nEOF")).toEqual({ code: 0, decision: "deny" });
    expect(gate("pathlight draft --workspace .").decision).toBe("deny");
    expect(await calls()).toEqual(["needs", "needs"]);
    // Reading commands, other programs and other tools pass without asking anything.
    expect(gate("pathlight brief --first-day")).toEqual({ code: 0, decision: undefined });
    expect(gate("ls -la")).toEqual({ code: 0, decision: undefined });
    expect(gate("pathlight name", "Read")).toEqual({ code: 0, decision: undefined });
    expect(await calls()).toEqual(["needs", "needs"]);
  } finally {
    await rm(join(env.CLAUDE_PROJECT_DIR!), { recursive: true, force: true });
  }
});

test("with a pathlight that meets the contract, the gate lets the agent's call through", async () => {
  const { env, bin } = await withOldBinary();
  try {
    await writeFile(join(bin, "pathlight"), "#!/bin/sh\nexit 0\n");
    const done = Bun.spawnSync(["sh", "plugins/claude/needs-hook.sh"], { env, stdout: "pipe",
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pathlight name --title x" } })) });
    expect([done.exitCode, done.stdout.toString()]).toEqual([0, ""]);
  } finally {
    await rm(env.CLAUDE_PROJECT_DIR!, { recursive: true, force: true });
  }
});

test("with a pathlight older than the plugin, the end of a turn records but never refreshes, and wakes the agent once per binary", async () => {
  const { directory, bin, env, calls } = await withOldBinary();
  try {
    const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
    const stop = () => Bun.spawnSync(["sh", "-c", manifest.hooks.Stop[0]!.hooks[0]!.command], { cwd: directory, env, stdout: "pipe", stderr: "pipe",
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/nowhere.jsonl", stop_hook_active: false })) });
    const first = stop();
    expect(first.exitCode).toBe(2);
    expect(first.stderr.toString()).toContain(join(bin, "pathlight"));
    expect(await calls()).toEqual(["record", "needs"]);
    // Told once: the next turn with the same binary is quiet, and still never refreshes.
    expect(stop().exitCode).toBe(0);
    expect((await calls()).filter(call => call === "refresh")).toEqual([]);
    // Another binary, still old, is told again.
    await writeFile(join(bin, "pathlight"), `${await readFile(join(bin, "pathlight"), "utf8")}# another build\n`);
    expect(stop().exitCode).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("with a pathlight older than the plugin, /pathlight:open opens nothing and says why", async () => {
  const { directory, env, calls } = await withOldBinary();
  try {
    const done = Bun.spawnSync(["sh", "plugins/claude/open-hook.sh"], { env, stdout: "pipe", stderr: "pipe",
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "/pathlight:open" })) });
    const reply = JSON.parse(done.stdout.toString()) as { continue: boolean; stopReason: string };
    expect(reply.continue).toBe(false);
    expect(reply.stopReason).toContain("npm i -g @dumbbunnyio/pathlight");
    expect(await calls()).toEqual(["needs"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor fails when the pathlight on the PATH is older than itself", async () => {
  const { directory, bin } = await withOldBinary();
  try {
    const done = cli(["doctor", "--workspace", directory], { PATH: `${bin}:${process.env.PATH}` });
    expect(done.code).toBe(1);
    expect(done.out.split("\n").find(line => line.includes(join(bin, "pathlight")))).toContain("older");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
