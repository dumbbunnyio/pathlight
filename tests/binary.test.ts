import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// The release artifact is one compiled file with no source beside it, so it is tested as that: built to a temporary directory, then run on a workspace elsewhere.
test("the compiled binary drafts, initialises, reports on itself and opens its own viewer pane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-binary-"));
  const socket = join("/tmp", `c4bin-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const binary = join(directory, "pathlight");
  const project = join(directory, "project");
  try {
    await run(process.execPath, ["build", "--compile", "src/cli.ts", "--outfile", binary]);
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "demo" }));
    for (const folder of ["alpha", "beta"]) {
      await mkdir(join(project, "src", folder), { recursive: true });
      for (const file of ["a", "b", "c", "d"]) await writeFile(join(project, "src", folder, `${file}.ts`), folder === "beta" ? 'import "../alpha/a";\nexport const v = 1;\n' : "export const v = 1;\n");
    }
    expect(await run(binary, ["draft", "--workspace", project])).toContain("Drew");
    expect(await run(binary, ["check", "--workspace", project,])).toContain("Relationships");
    const initialised = await run(binary, ["init", "--workspace", project]);
    expect(initialised).toContain("Skills: pathlight, pathlight-behavior written");
    expect(await readFile(join(project, ".claude/skills/pathlight/SKILL.md"), "utf8")).toContain("name: pathlight");
    expect(await readFile(join(project, ".claude/skills/pathlight-behavior/SKILL.md"), "utf8")).toContain("name: pathlight-behavior");
    expect(await run(binary, ["doctor", "--workspace", project])).toContain("single binary");
    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "binary", "-x", "150", "-y", "40", "-P", "-F", "#{pane_id}", "sleep", "120");
    const shown = JSON.parse(await run(binary, ["show", "index", "--workspace", project, "--pane", harness, "--socket", socket])) as { pane: string };
    let screen = "";
    for (let attempt = 0; attempt < 100 && !screen.includes("Selected:"); attempt++) { screen = await tmux("capture-pane", "-p", "-t", shown.pane); await delay(100); }
    expect(screen).toContain("Selected:");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
