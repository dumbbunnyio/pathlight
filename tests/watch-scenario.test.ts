import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { toolActivity, writeActivity } from "./effects";

// Phase 6's evidence, through the real CLI and the Claude plugin's own Stop hook on a drawn map: the agent declares a box, its edit lights it, the end of
// the turn makes it solid with its arrows and asks for the one box nobody named, and naming it puts the name on the map.
const cli = (directory: string, ...args: string[]) => {
  const done = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args, "--workspace", directory], { stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};
const git = (directory: string, ...args: string[]) => Bun.spawnSync(["git", "-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
const screen = (directory: string, ...extra: string[]) => cli(directory, "see", "index", "--cols", "120", "--rows", "30", ...extra).out.split("\n");
const card = (lines: readonly string[], title: string) => lines.slice(3).find(line => new RegExp(`[│┆] ${title}\\s`).test(line));

test("plan a box, see it dashed, light it, end the turn: it is solid with its arrows, the unnamed box is asked about once, and naming it shows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-watch-"));
  const tools = await mkdtemp(join(tmpdir(), "pathlight-watch-bin-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop" }));
    for (const part of ["api", "store"]) {
      await mkdir(join(directory, `src/${part}`), { recursive: true });
      for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/${part}/${name}.ts`), part === "store" ? "export const save = () => 1;\n" : `import { save } from "../store/${name}";\nexport const h = () => save();\n`);
    }
    git(directory, "init", "-q");
    expect(cli(directory, "draft").code).toBe(0);
    git(directory, "add", "-A"); git(directory, "commit", "-qm", "start");

    // 1. The agent declares the part before writing it: a dashed box with its name.
    expect(cli(directory, "plan", "--new", "src/notify", "--title", "Notifier", "--note", "Sends the order emails.").code).toBe(0);
    const planned = screen(directory);
    expect(card(planned, "Notifier")).toContain("┆");
    expect(planned.join("\n")).toContain("[planned]");

    // 2. Its first edit lights it, before the folder exists on disk.
    const input = { file_path: join(directory, "src/notify/send.ts") };
    await writeActivity(directory, await toolActivity(directory, { source: "claude", session: "turn" }, "write-1", "Write", input, "started"));
    const lit = screen(directory, "--follow");
    expect(lit[1]).toContain("Notifier");
    expect(lit.slice(3).some(line => line.includes("edit") && line.includes("┄"))).toBe(true);

    // 3. The files land, plus a folder the agent did not declare; the turn ends and the plugin's Stop hook runs.
    await mkdir(join(directory, "src/notify"));
    await writeFile(join(directory, "src/notify/send.ts"), `import { save } from "../store/a";\nexport const send = () => save();\n`);
    await mkdir(join(directory, "src/jobs"));
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/jobs/${name}.ts`), `import { send } from "../notify/send";\nexport const q = () => send();\n`);
    await mkdir(join(tools, "bin"));
    await writeFile(join(tools, "bin", "pathlight"), `#!/bin/sh\nexec ${process.execPath} ${resolve("src/cli.ts")} "$@"\n`);
    await chmod(join(tools, "bin", "pathlight"), 0o755);
    const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
    const stop = (active: boolean) => Bun.spawnSync(["sh", "-c", manifest.hooks.Stop[0]!.hooks[0]!.command], { cwd: directory, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PATH: `${join(tools, "bin")}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: directory }, stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "turn", stop_hook_active: active })) });
    const ended = stop(false);
    expect(ended.exitCode).toBe(2);
    // Only the box nobody named is asked about: the declared one kept its name.
    expect(ended.stderr.toString()).toContain("src/jobs");
    expect(ended.stderr.toString()).not.toContain("src/notify");
    const model = await readFile(join(directory, ".pathlight/pathlight.model.c4"), "utf8");
    expect(model).toMatch(/^\s*notify -> store /m);
    expect(model).toMatch(/^\s*jobs -> notify /m);
    const solid = screen(directory);
    expect(card(solid, "Notifier")).toContain("│");
    expect(solid.join("\n")).not.toContain("[planned]");

    // 4. The agent hands the box to the namer, which saves its name; the next stop asks nothing.
    expect(cli(directory, "name", "src/jobs", "--title", "Job queue", "--note", "Retries the order emails.").code).toBe(0);
    expect(card(screen(directory), "Job queue")).toBeDefined();
    expect(stop(true).exitCode).toBe(0);
    expect(stop(false).exitCode).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(tools, { recursive: true, force: true });
  }
}, 120_000);
