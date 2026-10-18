import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { run } from "./effects";
import { z } from "zod";
import { toolActivity, writeActivity } from "./effects";

let directory: string;
let workspace: string;
let socket: string;
let parent: string;
const cli = resolve("src/cli.ts");
const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "c4view-tmux-"));
  workspace = join(directory, "parcel's workspace");
  socket = join(directory, "tmux.sock");
  await cp("examples/parcel", workspace, { recursive: true, filter: source => !source.includes(".cache") });
  parent = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "viewer-test", "-x", "140", "-y", "40",
    "-P", "-F", "#{pane_id}", "sleep", "120");
  await tmux("set-environment", "-g", "OPENTUI_IMAGE_PROTOCOL", "kitty");
});
afterAll(async () => {
  await tmux("kill-server").catch(() => {});
  await rm(directory, { recursive: true, force: true });
});

async function show(view: string, protocol = "auto", session?: string) {
  const text = await run(process.execPath, [cli, "show", view, "--workspace", workspace,
    "--pane", parent, "--socket", socket, "--renderer", "png", "--protocol", protocol,
    ...(session ? ["--session", session, "--source", "claude"] : [])]);
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== "object" || !("pane" in result) || typeof result.pane !== "string") {
    throw new Error(`CLI returned no viewer pane: ${text}`);
  }
  return result.pane;
}

async function capture(pane: string, text: string) {
  let output = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    output = await tmux("capture-pane", "-p", "-t", pane);
    if (output.includes(text)) return output;
    await setTimeout(50);
  }
  throw new Error(`Pane did not show '${text}':\n${output}`);
}

test("exports, opens, zooms, reuses, and closes an actual viewer without replacing the parent", async () => {
  const pane = await show("index");
  expect(pane).not.toBe(parent);
  const pid = await tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
  expect((await readFile(`/proc/${pid}/environ`, "utf8")).split("\0")).toContain("OPENTUI_IMAGE_PROTOCOL=kitty");
  expect(await capture(pane, "System context")).toContain("blocks");
  await tmux("send-keys", "-t", pane, "+");
  expect(await capture(pane, "125%")).toContain("125%");
  await tmux("send-keys", "-t", pane, "Right", "Down", "f");
  expect(await capture(pane, "100%")).toContain("100%");

  expect(await show("checkout")).toBe(pane);
  expect(await capture(pane, "Checkout detail")).toContain("Checkout detail");
  expect((await tmux("list-panes", "-a", "-F", "#{pane_id}")).split("\n")).toHaveLength(2);
  expect(await tmux("display-message", "-p", "-t", parent, "#{pane_current_command}")).toBe("sleep");

  await tmux("respawn-pane", "-k", "-t", pane, process.execPath, "-e", "setInterval(() => {}, 1000)");
  const replacement = await show("index");
  expect(replacement).not.toBe(pane);
  expect((await tmux("list-panes", "-a", "-F", "#{pane_id}")).split("\n")).toHaveLength(3);
  await tmux("send-keys", "-t", replacement, "q");
  for (let attempt = 0; attempt < 40; attempt++) {
    const panes = (await tmux("list-panes", "-a", "-F", "#{pane_id}")).split("\n");
    if (!panes.includes(replacement)) break;
    await setTimeout(50);
  }
  expect((await tmux("list-panes", "-a", "-F", "#{pane_id}")).split("\n").sort()).toEqual([parent, pane].sort());
}, 120_000);

test("a cancelled export releases the lock and a concurrent request fails without leaving a waiter", async () => {
  const renders = join(workspace, ".cache", "c4view");
  const before = await readdir(renders);
  const request = Bun.spawn([process.execPath, cli, "show", "services", "--workspace", workspace,
    "--pane", parent, "--socket", socket, "--renderer", "png", "--protocol", "blocks"], { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(request.stdout).text();
  const stderr = new Response(request.stderr).text();
  try {
    let exporting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const files = await readdir(renders);
      exporting = files.some(file => file.startsWith("render-") && !before.includes(file));
      if (exporting) break;
      await setTimeout(10);
    }
    expect(exporting).toBe(true);
    const competing = Bun.spawn([process.execPath, cli, "show", "index", "--workspace", workspace,
      "--pane", parent, "--socket", socket], { stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([competing.exited, new Response(competing.stderr).text()]);
    expect(code).toBe(1);
    expect(error).toContain("request is in progress");
  } finally {
    request.kill("SIGTERM");
    await Promise.all([request.exited, stdout, stderr]);
  }
  expect(await show("index")).toMatch(/^%\d+$/);
}, 120_000);

test("Unicode images remain tmux cells through zoom, pan, resize, replacement, and quit", async () => {
  await expect(show("services", "kitty-unicode")).rejects.toThrow("not visible to an attached tmux client");
  const client = Bun.spawn(["python3", resolve("tests/tmux-client.py"), socket], {
    env: { ...process.env, TMUX: "", TERM: "xterm-256color" }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await tmux("list-clients", "-F", "#{window_id}")) break;
    await setTimeout(20);
  }
  const otherWindow = await tmux("new-window", "-t", "viewer-test", "-P", "-F", "#{window_id}", "sleep", "120");
  await expect(show("services", "kitty-unicode")).rejects.toThrow("not visible to an attached tmux client");
  await tmux("select-window", "-t", parent);
  await tmux("kill-window", "-t", otherWindow);
  const pane = await show("services", "kitty-unicode");
  const fitted = await capture(pane, "kitty-unicode");
  expect(fitted).toContain("\u{10eeee}\u0305\u0305");
  await tmux("send-keys", "-t", pane, "+", "+");
  await capture(pane, "156%");
  await tmux("send-keys", "-t", pane, "Right", "Down");
  let panned = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    panned = await tmux("capture-pane", "-p", "-t", pane);
    if (!panned.includes("\u{10eeee}\u0305\u0305")) break;
    await setTimeout(50);
  }
  expect(panned).toContain("\u{10eeee}");
  expect(panned).not.toContain("\u{10eeee}\u0305\u0305");
  await tmux("resize-pane", "-t", pane, "-x", "55");
  await tmux("send-keys", "-t", pane, "f");
  expect(await capture(pane, "100%")).toContain("\u{10eeee}\u0305\u0305");
  const output = join(directory, "unicode-output.bin");
  await tmux("set-option", "-pu", "-t", pane, "remain-on-exit");
  await tmux("pipe-pane", "-t", pane, `cat > '${output}'`);
  expect(await show("checkout", "kitty-unicode")).toBe(pane);
  expect(await tmux("show-options", "-p", "-v", "-t", pane, "remain-on-exit")).toBe("");
  expect(await capture(pane, "Checkout detail")).toContain("\u{10eeee}");
  await tmux("send-keys", "-t", pane, "q");
  let bytes = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    bytes = await readFile(output, "utf8");
    if ((bytes.match(/a=d,d=I,i=/g) ?? []).length === 2) break;
    await setTimeout(50);
  }
  expect(bytes.match(/a=d,d=I,i=/g)).toHaveLength(2);
  const uploaded = /a=t,f=100,i=(\d+)/.exec(bytes)?.[1];
  expect(uploaded).toMatch(/^\d+$/);
  expect(bytes).toContain(`\x1b[38;5;${Number(uploaded) % 0x1000000}m`);
  expect(bytes).toContain(`a=d,d=I,i=${uploaded},q=2`);
  expect(bytes.indexOf("a=d,d=I,i=")).toBeLessThan(bytes.indexOf("a=t,f=100,i="));
  expect(bytes).toContain("a=p,U=1");
  expect(bytes).not.toMatch(/a=p,i=/);
  } finally {
    await tmux("detach-client", "-s", "viewer-test");
    await client.exited;
  }
}, 120_000);

test("cancellation immediately after split rolls back the newly created pane", async () => {
  const otherParent = await tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", parent, "sleep", "120");
  const before = await tmux("list-panes", "-a", "-F", "#{pane_id}");
  const shimDirectory = join(directory, "bin");
  await mkdir(shimDirectory);
  const realTmux = Bun.which("tmux");
  if (!realTmux) throw new Error("tmux is required for integration tests");
  await writeFile(join(shimDirectory, "tmux"), `#!/bin/sh
"${realTmux}" "$@"
status=$?
case " $* " in
  *" split-window "*) kill -TERM "$PPID" ;;
esac
exit "$status"
`, { mode: 0o755 });
  const request = Bun.spawn([process.execPath, cli, "show", "index", "--workspace", workspace,
    "--pane", otherParent, "--socket", socket], {
    env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}` },
    stdout: "pipe", stderr: "pipe",
  });
  const [code] = await Promise.all([request.exited, new Response(request.stdout).text(), new Response(request.stderr).text()]);
  expect(code).toBe(1);
  expect(await tmux("list-panes", "-a", "-F", "#{pane_id}")).toBe(before);
}, 120_000);

test("a live viewer observes Claude hook metadata without restart and reloads retained state", async () => {
  await writeFile(join(workspace, "c4view.activity.json"), JSON.stringify({ version: 1, project: "parcel",
    mappings: [{ glob: "src/orders.ts", element: "parcel.commerce.orders" }] }));
  const pane = await show("services", "blocks", "live-session");
  const pid = await tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
  await tmux("send-keys", "-t", pane, "+");
  await capture(pane, "125%");
  const record = async (session: string, phase: string, file: string) => {
    const child = Bun.spawn([process.execPath, cli, "record", "--workspace", workspace], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ hook_event_name: phase, session_id: session, tool_use_id: "call-live",
      tool_name: "Read", tool_input: { file_path: join(workspace, file) }, cwd: workspace }));
    child.stdin.end();
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).toBe("");
    expect(code).toBe(0);
  };
  await record("live-session", "PreToolUse", "src/orders.ts");
  expect(await capture(pane, "started read")).toContain("parcel.commerce.orders");
  await record("other-session", "PostToolUse", "PRIVATE-OTHER-SESSION.ts");
  await record("live-session", "PostToolUse", "src/orders.ts");
  const completed = await capture(pane, "completed read");
  expect(completed).not.toContain("PRIVATE-OTHER-SESSION");
  expect(completed).toContain("125%");
  expect(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(pid);
  expect(await show("services", "blocks", "live-session")).toBe(pane);
  expect(await capture(pane, "completed read")).toContain("parcel.commerce.orders");
  await tmux("send-keys", "-t", pane, "q");
}, 120_000);

test("default native show records activity, replaces during search, and switches PNG modes in the owned pane", async () => {
  const nativeWorkspace = join(directory, "native-workspace");
  await cp("examples/parcel", nativeWorkspace, { recursive: true, filter: path => !path.includes(".cache") });
  await writeFile(join(nativeWorkspace, "c4view.activity.json"), JSON.stringify({ version: 1, project: "parcel",
    mappings: [{ glob: "src/orders.ts", element: "parcel.commerce.orders" }] }));
  const nativeParent = await tmux("new-window", "-d", "-t", "viewer-test", "-P", "-F", "#{pane_id}", "sleep", "120");
  const native = async (view: string) => {
    const child = Bun.spawn([process.execPath, cli, "show", view, "--workspace", nativeWorkspace,
      "--pane", nativeParent, "--socket", socket, "--session", "native-session", "--source", "claude"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(directory, "no-browsers") }, stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(error).toBe("");
    expect(code).toBe(0);
    return z.object({ pane: z.string(), renderer: z.literal("native"), protocol: z.literal("native"),
      project: z.literal("parcel"), view: z.literal(view) }).strict().parse(JSON.parse(output));
  };
  const first = await native("services");
  const pane = first.pane;
  expect((await readdir(join(nativeWorkspace, ".cache", "c4view"))).filter(file => file.startsWith("render-"))).toEqual([]);
  await capture(pane, "BRAILLE + Three camera");
  await tmux("send-keys", "-t", pane, "/");
  await tmux("send-keys", "-t", pane, "-l", "Orders");
  await capture(pane, "Search 1/1");
  await tmux("send-keys", "-t", pane, "Enter");
  await capture(pane, "Selected: parcel.commerce.orders");
  await tmux("send-keys", "-t", pane, "0", "r");
  await capture(pane, "Zoom: 100%");
  const pid = await tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
  await writeActivity(nativeWorkspace, toolActivity(nativeWorkspace, { source: "claude", session: "native-session" },
    "native-edit", "Edit", { path: "src/orders.ts" }, "started"));
  expect(await capture(pane, "[EDIT]")).toContain("\n parcel.commerce.orders");
  expect(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(pid);
  await tmux("send-keys", "-t", pane, "/");
  await tmux("send-keys", "-t", pane, "-l", "pending");
  await capture(pane, "Search 0/0");
  expect((await native("checkout")).pane).toBe(pane);
  await capture(pane, "Checkout detail");
  const png = JSON.parse(await run(process.execPath, [cli, "show", "index", "--workspace", nativeWorkspace,
    "--pane", nativeParent, "--socket", socket, "--renderer", "png", "--protocol", "blocks"]));
  expect(png).toMatchObject({ pane, renderer: "png", protocol: "blocks" });
  await capture(pane, "100%");
  expect((await native("services")).pane).toBe(pane);
  expect(await capture(pane, "BRAILLE + Three camera")).toContain("Service architecture");
  expect(await tmux("display-message", "-p", "-t", nativeParent, "#{pane_current_command}")).toBe("sleep");
}, 120_000);

test("native startup errors report readiness failure and roll back newly created panes", async () => {
  const failedWorkspace = join(directory, "failed-native");
  await cp("examples/parcel", failedWorkspace, { recursive: true, filter: path => !path.includes(".cache") });
  await writeFile(join(failedWorkspace, "empty.c4"), "views { view empty { title 'Empty' } }");
  const before = await tmux("list-panes", "-a", "-F", "#{pane_id}");
  await expect(run(process.execPath, [cli, "show", "empty", "--workspace", failedWorkspace,
    "--pane", parent, "--socket", socket])).rejects.toThrow("View 'empty' has no nodes");
  expect(await tmux("list-panes", "-a", "-F", "#{pane_id}")).toBe(before);
}, 30_000);
