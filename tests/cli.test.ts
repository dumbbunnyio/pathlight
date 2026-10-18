import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { selectView, exportView } from "./effects";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let workspace: string;
const cli = resolve("src/cli.ts");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "c4view-cli-"));
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

test("requires a real terminal for foreground rendering", async () => {
  const result = await invoke("image", "missing.png");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("needs a terminal");
});

test("native foreground mode rejects graphics-only options and non-terminal output", async () => {
  const invalid = await invoke("view", "index", "--workspace", workspace, "--protocol", "blocks");
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("--protocol applies only to --renderer png");
  const headless = await invoke("view", "index", "--workspace", workspace);
  expect(headless.code).toBe(1);
  expect(headless.stderr).toContain("native viewer needs a terminal");
});

test.each(["kitty", "sixel"])("rejects unsafe %s placement before opening a tmux pane", async protocol => {
  const result = await invoke("show", "index", "--workspace", workspace,
    "--pane", "%0", "--socket", join(directory, "no-server.sock"), "--renderer", "png", "--protocol", protocol);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not pane-safe");
});

test("rejects activity mappings to nonexistent architecture elements before opening a pane", async () => {
  await writeFile(join(workspace, "c4view.activity.json"), JSON.stringify({ version: 1, project: "parcel",
    mappings: [{ glob: "src/**", element: "parcel.nonexistent" }] }));
  const result = await invoke("show", "index", "--workspace", workspace, "--pane", "%0",
    "--socket", join(directory, "no-server.sock"), "--session", "test-session");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown activity element 'parcel.nonexistent'");
  const foreground = await invoke("view", "index", "--workspace", workspace, "--session", "test-session");
  expect(foreground.stderr).toContain("Unknown activity element 'parcel.nonexistent'");
  await writeFile(join(workspace, "c4view.activity.json"), JSON.stringify({ version: 1, project: "wrong-project", mappings: [] }));
  expect((await invoke("view", "index", "--workspace", workspace, "--session", "test-session")).stderr)
    .toContain("Activity mapping project must match");
});

test("exports the selected project's PNG from a multi-project workspace", async () => {
  const multi = join(directory, "multi");
  await cp("examples/parcel", join(multi, "parcel"), { recursive: true, filter: path => !path.includes(".cache") });
  await cp("examples/viewer", join(multi, "viewer"), { recursive: true, filter: path => !path.includes(".cache") });
  const exported = await exportView(await selectView(multi, "live", "viewer"));
  expect((await readFile(exported.image)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}, 30_000);
