import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let workspace: string;
const cli = resolve("src/cli.ts");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pathlight-cli-"));
  workspace = join(directory, "parcel's workspace");
  await cp("examples/parcel", workspace, {
    recursive: true,
    filter: source => !source.includes(".cache"),
  });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("lists real project views without starting a terminal viewer", async () => {
  const result = await invoke("list", "--workspace", workspace);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    workspace,
    views: [
      { project: "parcel", id: "index", title: "System context" },
      { project: "parcel", id: "services", title: "Service architecture" },
      { project: "parcel", id: "checkout", title: "Checkout detail" },
    ],
  });
});

test("rejects unknown view IDs rather than interpreting them as export patterns or shell commands", async () => {
  for (const view of ["*", "missing", "index; touch injected"]) {
    const result = await invoke("show", view, "--workspace", workspace, "--pane", "%0");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown view");
  }
});

test("native foreground mode needs a terminal", async () => {
  const headless = await invoke("view", "index", "--workspace", workspace);
  expect(headless.code).toBe(1);
  expect(headless.stderr).toContain("native viewer needs a terminal");
});

test("follow and a bound session are mutually exclusive", async () => {
  const result = await invoke("view", "index", "--workspace", workspace, "--follow", "--session", "s");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("either --follow or --session");
});

test("rejects activity mappings to nonexistent architecture elements before opening a pane", async () => {
  await writeFile(join(workspace, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "parcel",
    mappings: [{ glob: "src/**", element: "parcel.nonexistent" }] }));
  const result = await invoke("show", "index", "--workspace", workspace, "--pane", "%0",
    "--socket", join(directory, "no-server.sock"), "--session", "test-session");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown activity element 'parcel.nonexistent'");
  const foreground = await invoke("view", "index", "--workspace", workspace, "--session", "test-session");
  expect(foreground.stderr).toContain("Unknown activity element 'parcel.nonexistent'");
  await writeFile(join(workspace, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "wrong-project", mappings: [] }));
  expect((await invoke("view", "index", "--workspace", workspace, "--session", "test-session")).stderr)
    .toContain("Activity mapping project must match");
});

test("init can skip the project-local Claude hooks for plugin users", async () => {
  const project = join(directory, "init-plugin");
  await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
  const result = await invoke("init", "--workspace", project, "--no-claude-hooks");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("no local hooks written");
  expect(await Bun.file(join(project, ".claude", "settings.local.json")).exists()).toBe(false);
  expect(await Bun.file(join(project, "pathlight.activity.json")).exists()).toBe(true);
  // The plugin supplies the skill to Claude Code, so only the cross-agent location gets a copy.
  expect(await Bun.file(join(project, ".claude", "skills", "pathlight", "SKILL.md")).exists()).toBe(false);
  expect(await Bun.file(join(project, ".agents", "skills", "pathlight", "SKILL.md")).text()).toBe(await Bun.file("plugins/claude/skills/pathlight/SKILL.md").text());
});

test("init writes the pathlight skill next to the Claude hooks and replaces it on a rerun", async () => {
  const project = join(directory, "init-skill");
  await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
  const result = await invoke("init", "--workspace", project);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Skill: pathlight written to .claude/skills/pathlight");
  const written = join(project, ".claude", "skills", "pathlight", "SKILL.md");
  expect(await Bun.file(written).text()).toBe(await Bun.file("plugins/claude/skills/pathlight/SKILL.md").text());
  expect(await Bun.file(join(project, ".agents")).exists()).toBe(false);
  await writeFile(written, "stale");
  expect((await invoke("init", "--workspace", project)).code).toBe(0);
  expect(await Bun.file(written).text()).toContain("name: pathlight");
});

test("open picks the overview view itself, and without tmux says so rather than guessing a pane", async () => {
  const { overviewId } = await import("../src/catalog");
  const { Effect } = await import("effect");
  expect(String(await Effect.runPromise(overviewId(workspace)))).toBe("index");
  expect(String(await Effect.runPromise(overviewId(workspace, "parcel")))).toBe("index");
  const child = Bun.spawn([process.execPath, cli, "open", "--workspace", workspace], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX_PANE: "" } });
  const [stderr, code] = [await new Response(child.stderr).text(), await child.exited];
  expect(code).toBe(1);
  expect(stderr).toContain("No tmux pane");
});
