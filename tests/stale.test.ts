import { expect, test } from "bun:test";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { staleText } from "../src/stale";
import { run } from "./effects";

const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);
const stamp = async (directory: string) => JSON.parse(await readFile(join(directory, ".cache/pathlight/stale.json"), "utf8")) as Record<string, number>;

const workspace = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-stale-"));
  await cp("tests/fixtures/viewer", directory, { recursive: true });
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src/launcher.ts"), "export const l = 1;\n");
  // A source file the mapping does not claim: the model is out of date by one file.
  await writeFile(join(directory, "src/extra.ts"), "import { l } from './launcher';\nexport const e = l;\n");
  await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "src/launcher.ts", element: "launcher" }] }));
  return directory;
};

test("every check records its counts, quietly when asked, and the badge text names only what is wrong", async () => {
  const directory = await workspace();
  try {
    expect(await cli("check", "--workspace", directory, "--quiet")).toBe("");
    expect(await stamp(directory)).toMatchObject({ version: 1, unmapped: 1, unmatched: 0, unsupported: 0, undeclared: 0 });
    expect(staleText({ version: 1, time: 0, unmapped: 1, unmatched: 0, unsupported: 2, undeclared: 0 })).toBe("1 file not in the model · 2 relationships no import backs");
    expect(staleText({ version: 1, time: 0, unmapped: 0, unmatched: 0, unsupported: 0, undeclared: 0 })).toBeUndefined();
    expect(staleText(undefined)).toBeUndefined();
    // Mapping the file clears it.
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "src/**", element: "launcher" }] }));
    await cli("check", "--workspace", directory, "--quiet");
    expect(await stamp(directory)).toMatchObject({ unmapped: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("the plugin's Stop hook runs a check through the pathlight command, and does nothing without a mapping", async () => {
  const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: Record<string, { hooks: { command: string; async?: boolean }[] }[]> };
  const command = manifest.hooks.Stop![0]!.hooks[0]!.command;
  expect(manifest.hooks.Stop![0]!.hooks[0]!.async).toBe(true);
  const directory = await workspace();
  const bin = join(directory, "bin");
  try {
    await mkdir(bin);
    await writeFile(join(bin, "pathlight"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/cli.ts")}" "$@"\n`);
    await chmod(join(bin, "pathlight"), 0o755);
    const fire = async (project: string) => {
      const child = Bun.spawn(["sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: project } });
      expect(await child.exited).toBe(0);
    };
    const empty = await mkdtemp(join(tmpdir(), "pathlight-stale-empty-"));
    await fire(empty);
    await expect(readFile(join(empty, ".cache/pathlight/stale.json"), "utf8")).rejects.toBeDefined();
    await rm(empty, { recursive: true, force: true });
    await fire(directory);
    expect(await stamp(directory)).toMatchObject({ unmapped: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("the viewer shows an out-of-date badge from the last check and drops it once the model agrees again", async () => {
  const directory = await workspace();
  const socket = join("/tmp", `c4s-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cli("check", "--workspace", directory, "--quiet");
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "stale", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory);
    const until = async (done: (screen: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 200; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (done(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    const screen = await until(text => text.includes("out of date"), "badge");
    expect(screen).toContain("1 file not in the model");
    expect(screen).toMatch(/checked (just now|<1m ago)/);
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "src/**", element: "launcher" }] }));
    await cli("check", "--workspace", directory, "--quiet");
    const clean = await until(text => !text.includes("out of date") && text.includes("in sync"), "badge gone");
    expect(clean).toMatch(/in sync · checked (just now|<1m ago)/);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
