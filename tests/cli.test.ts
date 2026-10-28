import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mappingIn } from "./effects";

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

/** Claude Code's settings folder for these runs: empty, so what the developer has installed never changes a result. */
const claudeHome = () => join(directory, "claude-home");
async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome() } });
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

test("list marks a journey and lists it after the package views", async () => {
  const copy = join(directory, "with-journey");
  await cp("examples/parcel", copy, { recursive: true, filter: source => !source.includes(".cache") });
  await writeFile(join(copy, "journey.c4"), "views {\n  dynamic view placing {\n    title 'Placing an order'\n    customer -> parcel.storefront 'opens checkout'\n  }\n}\n");
  const result = await invoke("list", "--workspace", copy);
  expect(result.code).toBe(0);
  const views = JSON.parse(result.stdout).views as { id: string; journey?: boolean }[];
  expect(views.map(view => view.id)).toEqual(["index", "services", "checkout", "placing"]);
  expect(views.at(-1)).toMatchObject({ id: "placing", journey: true });
  expect(views.filter(view => view.journey)).toHaveLength(1);
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
  await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "parcel",
    mappings: [{ glob: "src/**", element: "parcel.nonexistent" }] }));
  const result = await invoke("show", "index", "--workspace", workspace, "--pane", "%0",
    "--socket", join(directory, "no-server.sock"), "--session", "test-session");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown activity element 'parcel.nonexistent'");
  const foreground = await invoke("view", "index", "--workspace", workspace, "--session", "test-session");
  expect(foreground.stderr).toContain("Unknown activity element 'parcel.nonexistent'");
  await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "wrong-project", mappings: [] }));
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
  expect(await Bun.file(mappingIn(project)).exists()).toBe(true);
  // The plugin supplies the skill to Claude Code, so only the cross-agent location gets a copy.
  expect(await Bun.file(join(project, ".claude", "skills", "pathlight", "SKILL.md")).exists()).toBe(false);
  expect(await Bun.file(join(project, ".agents", "skills", "pathlight", "SKILL.md")).text()).toBe(await Bun.file("plugins/claude/skills/pathlight/SKILL.md").text());
});

test("init writes the pathlight skill next to the Claude hooks and replaces it on a rerun", async () => {
  const project = join(directory, "init-skill");
  await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
  const result = await invoke("init", "--workspace", project);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Skills: pathlight, pathlight-behavior written to .claude/skills");
  expect(await Bun.file(join(project, ".claude", "skills", "pathlight-behavior", "SKILL.md")).text()).toBe(await Bun.file("plugins/claude/skills/pathlight-behavior/SKILL.md").text());
  const written = join(project, ".claude", "skills", "pathlight", "SKILL.md");
  expect(await Bun.file(written).text()).toBe(await Bun.file("plugins/claude/skills/pathlight/SKILL.md").text());
  expect(await Bun.file(join(project, ".agents")).exists()).toBe(false);
  await writeFile(written, "stale");
  expect((await invoke("init", "--workspace", project)).code).toBe(0);
  expect(await Bun.file(written).text()).toContain("name: pathlight");
});

test("init leaves the skills to the installed plugin and removes the copies it once wrote", async () => {
  const project = join(directory, "init-plugin");
  await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
  expect((await invoke("init", "--workspace", project)).code).toBe(0);
  const copy = join(project, ".claude", "skills", "pathlight", "SKILL.md");
  const own = join(project, ".claude", "skills", "mine", "SKILL.md");
  await mkdir(dirname(own), { recursive: true });
  await writeFile(own, "---\nname: mine\n---\n");
  expect(await Bun.file(copy).exists()).toBe(true);
  await mkdir(join(claudeHome(), "plugins"), { recursive: true });
  await writeFile(join(claudeHome(), "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "pathlight@pathlight": [{ scope: "user" }] } }));
  const result = await invoke("init", "--workspace", project);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("removed the copies in .claude/skills (2)");
  expect(await Bun.file(copy).exists()).toBe(false);
  expect(await Bun.file(join(project, ".claude", "skills", "pathlight-behavior", "SKILL.md")).exists()).toBe(false);
  expect(await Bun.file(own).exists()).toBe(true);
  const again = await invoke("init", "--workspace", project);
  expect(again.stdout).toContain("none were written");
  expect(await Bun.file(copy).exists()).toBe(false);
  await mkdir(dirname(copy), { recursive: true });
  await writeFile(copy, "---\nname: pathlight\n---\nold\n");
  expect((await invoke("doctor", "--workspace", project)).stdout).toContain("hides the plugin's newer ones");
  await rm(join(claudeHome(), "plugins"), { recursive: true });
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

test("init registers the OpenCode plugin with recording on, upgrades a bare entry, and respects record: false", async () => {
  const project = join(directory, "init-opencode");
  await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
  const plugin = resolve("plugins/opencode");
  const read = async () => JSON.parse(await Bun.file(join(project, "opencode.json")).text());
  expect((await invoke("init", "--workspace", project, "--no-claude-hooks")).stdout).toContain("recording on");
  expect((await read()).plugins).toEqual([{ package: plugin, options: { record: true } }]);
  // Re-running changes nothing.
  expect((await invoke("init", "--workspace", project, "--no-claude-hooks")).stdout).toContain("already registered (recording on)");
  // A bare entry from an older init gets the option; an explicit false stays false.
  await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: ["./other", plugin] }));
  expect((await invoke("init", "--workspace", project, "--no-claude-hooks")).stdout).toContain("recording turned on");
  expect((await read()).plugins).toEqual(["./other", { package: plugin, options: { record: true } }]);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: plugin, options: { record: false } }] }));
  expect((await invoke("init", "--workspace", project, "--no-claude-hooks")).stdout).toContain("off, as configured");
  expect((await read()).plugins).toEqual([{ package: plugin, options: { record: false } }]);
});

test("init --global registers the OpenCode plugin for every project, keeps the rest of that file, and a project init then adds no second entry", async () => {
  const global = join(process.env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
  const plugin = resolve("plugins/opencode");
  await mkdir(dirname(global), { recursive: true });
  await writeFile(global, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude-sonnet-5-5", plugins: ["opencode-other@1.0.0"] }));
  try {
    expect((await invoke("init", "--global")).stdout).toContain("recording on");
    expect(JSON.parse(await Bun.file(global).text())).toEqual({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude-sonnet-5-5", plugins: ["opencode-other@1.0.0", { package: plugin, options: { record: true } }] });
    expect((await invoke("init", "--global")).stdout).toContain("already registered (recording on)");
    const project = join(directory, "init-under-global");
    await cp("examples/parcel", project, { recursive: true, filter: path => !path.includes(".cache") });
    expect((await invoke("init", "--workspace", project, "--no-claude-hooks")).stdout).toContain("registered for every project");
    expect(await Bun.file(join(project, "opencode.json")).exists()).toBe(false);
    // A configuration with comments is not rewritten: init says what to add.
    await rm(global);
    await writeFile(`${global}c`, "{\n  // mine\n  \"plugins\": []\n}\n");
    expect((await invoke("init", "--global")).stdout).toContain("has comments");
    expect(await Bun.file(`${global}c`).text()).toContain("// mine");
    expect(await Bun.file(global).exists()).toBe(false);
  } finally {
    await rm(dirname(global), { recursive: true, force: true });
  }
});

test("show and open take the project from pathlight.activity.json when the workspace has several LikeC4 projects", async () => {
  const project = join(directory, "two-projects");
  await cp("examples/parcel", join(project, "parcel"), { recursive: true, filter: path => !path.includes(".cache") });
  await cp("tests/fixtures/viewer", join(project, "viewer"), { recursive: true });
  const missing = ["--pane", "%0", "--socket", join(directory, "no-server.sock")];
  // Without a mapping, `index` is ambiguous when both projects have one.
  const bare = await invoke("open", "--workspace", project, "--split", ...missing);
  // With one, the mapped project is used: the failure is now the missing tmux server, not the ambiguity.
  await writeFile(mappingIn(project), JSON.stringify({ version: 1, project: "viewer", mappings: [] }));
  const mapped = await invoke("open", "--workspace", project, "--split", ...missing);
  expect(mapped.stderr).not.toContain("multiple projects");
  // A view that exists only in the other project is still found without --project.
  const other = await invoke("show", "services", "--workspace", project, ...missing);
  expect(other.stderr).not.toContain("Unknown view");
  expect(other.stderr).not.toContain("multiple projects");
  expect(bare.code).toBe(1);
});
