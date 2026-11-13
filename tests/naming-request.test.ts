import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { namingCap } from "../src/refresh";

// Phase 6 step 3: when the end of a turn draws boxes nobody has named, the agent is asked once to have them named: Claude Code through the Stop hook
// (`asyncRewake`: exit 2, the line on standard error), OpenCode through a message the plugin sends, marked as its own.
const cli = (directory: string, ...args: string[]) => {
  const done = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args, "--workspace", directory], { stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};
const git = (directory: string, ...args: string[]) => Bun.spawnSync(["git", "-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);

const shop = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop" }));
  await mkdir(join(directory, "src/api"), { recursive: true });
  await mkdir(join(directory, "src/store"), { recursive: true });
  for (const name of ["a", "b", "c"]) {
    await writeFile(join(directory, `src/api/${name}.ts`), `import { save } from "../store/${name}";\nexport const h = () => save();\n`);
    await writeFile(join(directory, `src/store/${name}.ts`), "export const save = () => 1;\n");
  }
  git(directory, "init", "-q");
  expect(cli(directory, "draft").code).toBe(0);
  git(directory, "add", "-A"); git(directory, "commit", "-qm", "start");
  return directory;
};
const folder = async (directory: string, name: string, files = 3) => {
  await mkdir(join(directory, `src/${name}`), { recursive: true });
  for (let n = 0; n < files; n++) await writeFile(join(directory, `src/${name}/f${n}.ts`), `import { save } from "../store/a";\nexport const f${n} = () => save();\n`);
};

/** `pathlight` on the PATH, as an installed one is, running this checkout. */
const shim = async (directory: string) => {
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "bin", "pathlight"), `#!/bin/sh\nexec ${process.execPath} ${resolve("src/cli.ts")} "$@"\n`);
  await chmod(join(directory, "bin", "pathlight"), 0o755);
  return join(directory, "bin");
};

test("the Claude Stop hook wakes the agent once for new unnamed boxes, and stays quiet for a turn with none or a second stop", async () => {
  const directory = await shop("pathlight-naming-claude-");
  const tools = await mkdtemp(join(tmpdir(), "pathlight-naming-bin-"));
  try {
    const manifest = JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: { Stop: { hooks: { command: string; async?: boolean; asyncRewake?: boolean }[] }[] } };
    const hook = manifest.hooks.Stop[0]!.hooks[0]!;
    expect(hook).toMatchObject({ async: true, asyncRewake: true });
    const bin = await shim(tools);
    const stop = (active: boolean) => {
      const done = Bun.spawnSync(["sh", "-c", hook.command], { cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: directory },
        stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/nowhere.jsonl", stop_hook_active: active })), stdout: "pipe", stderr: "pipe" });
      return { code: done.exitCode, err: done.stderr.toString() };
    };
    expect(stop(false)).toEqual({ code: 0, err: "" });

    await folder(directory, "auth");
    const asked = stop(false);
    expect(asked.code).toBe(2);
    expect(asked.err).toContain("src/auth");
    expect(asked.err).toContain("pathlight-namer");
    expect(asked.err.trim().split("\n")).toHaveLength(1);
    // The map was redrawn whether or not the agent is asked.
    expect(await readFile(join(directory, ".pathlight/pathlight.model.c4"), "utf8")).toMatch(/^\s*auth = component/m);

    // The stop that ends the agent's answer to the request asks nothing, even if that turn drew more.
    await folder(directory, "billing");
    expect(stop(true)).toEqual({ code: 0, err: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(tools, { recursive: true, force: true });
  }
}, 60_000);

test("the request names only boxes nobody has named, at most six a turn", async () => {
  const directory = await shop("pathlight-naming-cap-");
  try {
    // A box the agent declared already has its name; a box a person named is never asked about.
    expect(cli(directory, "plan", "--new", "src/auth", "--title", "Auth middleware").code).toBe(0);
    await folder(directory, "auth", 1);
    for (let n = 0; n < namingCap + 2; n++) await folder(directory, `part${n}`);
    const done = JSON.parse(cli(directory, "refresh", "--json").out) as { unnamed: string[]; waiting: number; request: string };
    expect(done.unnamed).toHaveLength(namingCap);
    expect(done.waiting).toBe(2);
    expect(done.unnamed).not.toContain("src/auth");
    expect(done.request).toContain(done.unnamed[0]!);
    // The two past the cap are asked about at the next end of a turn, even though that turn drew nothing; then nothing is left to ask.
    const next = JSON.parse(cli(directory, "refresh", "--json").out) as { unnamed: string[]; waiting: number; request?: string };
    expect(next.unnamed).toHaveLength(2);
    expect(next.unnamed.some(key => done.unnamed.includes(key))).toBe(false);
    expect(next.waiting).toBe(0);
    const third = JSON.parse(cli(directory, "refresh", "--json").out) as { unnamed: string[]; request?: string };
    expect(third.unnamed).toEqual([]);
    expect(third.request).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a run that asks nobody (--no-ask, OpenCode's own run) leaves every new box waiting for the next run that asks", async () => {
  const directory = await shop("pathlight-naming-noask-");
  try {
    for (let n = 0; n < namingCap + 2; n++) await folder(directory, `part${n}`);
    const quiet = JSON.parse(cli(directory, "refresh", "--json", "--no-ask").out) as { unnamed: string[]; waiting: number; request?: string };
    expect(quiet).toMatchObject({ unnamed: [], waiting: namingCap + 2 });
    expect(quiet.request).toBeUndefined();
    const asks = JSON.parse(cli(directory, "refresh", "--json").out) as { unnamed: string[]; waiting: number };
    expect(asks.unnamed).toHaveLength(namingCap);
    expect(asks.waiting).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

type Body = { messages: { role: string; content: unknown }[]; tools?: { function?: { name: string } }[] };
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

test.skipIf(!Bun.which("opencode"))("OpenCode's plugin sends the request once, as its own message, after a run that drew a new box", async () => {
  const directory = await shop("pathlight-naming-opencode-");
  const home = await mkdtemp(join(tmpdir(), "pathlight-naming-home-"));
  const socket = join("/tmp", `c4nm-${process.pid}.sock`);
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-S", socket, ...args]).stdout.toString();
  const requests: Body[] = [];
  let openCodePid = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("{}", { headers: { "content-type": "application/json" } });
      const body = await request.json() as Body;
      requests.push(body);
      const users = body.messages.filter(message => message.role === "user");
      const last = JSON.stringify(users.at(-1) ?? "");
      const answered = body.messages.slice(body.messages.lastIndexOf(users.at(-1)!)).filter(message => message.role === "tool").length;
      const call = body.tools?.length && last.includes("add the auth folder") && answered === 0
        ? { name: "shell", args: { command: "mkdir -p src/auth && for n in 1 2 3; do printf 'export const g = 1;\\n' > src/auth/g$n.ts; done" } } : undefined;
      const lines = call
        ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }), chunk({}, "tool_calls")]
        : [chunk({ role: "assistant", content: body.tools?.length ? "done" : "Title" }), chunk({}, "stop")];
      return new Response([...lines, "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    await writeFile(join(directory, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", model: "fake/m",
      providers: { fake: { name: "Fake", env: ["FAKE_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1` }, models: { m: { name: "Fake" } } } },
      plugins: [{ package: resolve("plugins/opencode"), options: { record: true } }],
    }));
    const bin = await shim(home);
    const dirs = ["config", "data", "state", "cache"].map(name => `XDG_${name.toUpperCase()}_HOME=${join(home, name)}`);
    const pane = tmux("-f", "/dev/null", "new-session", "-d", "-s", "oc", "-x", "160", "-y", "45", "-c", directory, "-P", "-F", "#{pane_id}",
      "env", "FAKE_KEY=x", `PATH=${bin}:${process.env.PATH}`, ...dirs, Bun.which("opencode")!, "--standalone", "--auto").trim();
    openCodePid = Number(tmux("display-message", "-p", "-t", pane, "#{pane_pid}").trim());
    const until = async (check: () => boolean, what: string, attempts = 300) => {
      for (let attempt = 0; attempt < attempts; attempt++) { if (check()) return; await delay(100); }
      throw new Error(`Never saw ${what}\n${tmux("capture-pane", "-p", "-t", pane)}`);
    };
    await until(() => tmux("capture-pane", "-p", "-t", pane).includes("Ask anything"), "the OpenCode prompt");
    tmux("send-keys", "-t", pane, "-l", "please add the auth folder"); await delay(400); tmux("send-keys", "-t", pane, "Enter");
    const asking = () => requests.filter(body => JSON.stringify(body.messages.filter(message => message.role === "user").at(-1) ?? "").includes("pathlight-namer"));
    await until(() => asking().length > 0, "the naming request reaching the model");
    expect(JSON.stringify(asking()[0]!.messages.at(-1))).toContain("src/auth");
    // The conversation shows it as the plugin's, not as something the person typed.
    await until(() => tmux("capture-pane", "-p", "-t", pane).includes("pathlight"), "the request marked as the plugin's");
    // Its own run ends without a second request.
    await delay(3000);
    expect(new Set(asking().map(body => body.messages.length)).size).toBe(1);
  } finally {
    if (openCodePid) try { process.kill(openCodePid, "SIGTERM"); } catch { /* already gone */ }
    tmux("kill-server");
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

test("boxes past the cap are asked about at the person's next turn, after the woken turn's own stop", async () => {
  const directory = await shop("pathlight-naming-waiting-");
  const tools = await mkdtemp(join(tmpdir(), "pathlight-naming-bin-"));
  try {
    const bin = await shim(tools);
    const hook = (JSON.parse(await readFile("plugins/claude/hooks/hooks.json", "utf8")) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0]!.hooks[0]!;
    const stop = (active: boolean) => {
      const done = Bun.spawnSync(["sh", "-c", hook.command], { cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: directory },
        stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/nowhere.jsonl", stop_hook_active: active })), stdout: "pipe", stderr: "pipe" });
      return { code: done.exitCode, err: done.stderr.toString() };
    };
    const keys = (err: string) => err.match(/\(([^)]+)\)/)![1]!.split(" ");
    // The person's turn adds eight folders: six are asked about, two wait.
    for (let n = 0; n < namingCap + 2; n++) await folder(directory, `part${n}`);
    const first = stop(false);
    expect(first.code).toBe(2);
    const asked = keys(first.err);
    expect(asked).toHaveLength(namingCap);
    // The woken turn: the namer names those six, and its own stop asks nothing.
    for (const key of asked) expect(cli(directory, "name", key, "--title", `Named ${key.split("/").at(-1)}`, "--note", "A part.").code).toBe(0);
    expect(stop(true).code).toBe(0);
    // The person's next turn ends: the two that waited are asked about now, and none of the six again.
    const next = stop(false);
    expect(next.code).toBe(2);
    const rest = keys(next.err);
    expect(rest).toHaveLength(2);
    expect(rest.some(key => asked.includes(key))).toBe(false);
    // Asked once: the turn after asks nothing, though nobody named them.
    expect(stop(true).code).toBe(0);
    expect(stop(false).code).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(tools, { recursive: true, force: true });
  }
}, 60_000);
