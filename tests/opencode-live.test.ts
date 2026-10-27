import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { latestBinding, readActivity, readReplay } from "../src/activity";
import { run, mappingIn } from "./effects";

// The real OpenCode V2 runtime (isolated config, `--standalone`) against a fake OpenAI-compatible model that follows a script, checked against what the
// Claude plugin does: recording of reads, failures, edits and shell commands without a `live` request; /pathlight-open bound to the conversation before
// any tool has run; /pathlight handing the agent the pane; the agent opening the viewer itself from its shell; ask-about-node typing into the conversation.
type Call = { name: string; args: Record<string, unknown> };
type Body = { messages: { role: string; content: unknown }[]; tools?: { function?: { name: string } }[] };
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

test.skipIf(!Bun.which("opencode"))("OpenCode matches the Claude plugin: recording, /pathlight-open, /pathlight, the skill, and ask-about-node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-opencode-live-"));
  const workspace = join(directory, "work");
  const socket = join("/tmp", `c4oc-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const requests: Body[] = [];
  let openCodePid = 0;
  // What the fake "model" does for a user message containing the key. Anything else is plain talk.
  const plans: Record<string, Call[]> = {
    "read the files": [{ name: "read", args: { path: "src/activity.ts" } }, { name: "read", args: { path: "src/launcher.ts" } }],
    "work through": [
      { name: "read", args: { path: "src/missing.ts" } },
      { name: "edit", args: { path: "src/launcher.ts", oldString: "export {}", newString: "export const edited = 1" } },
      { name: "shell", args: { command: "cat src/activity.ts" } },
    ],
    "pathlight skill": [{ name: "shell", args: { command: "pathlight show live --workspace . --follow" } }],
    "show me the architecture": [{ name: "shell", args: { command: "pathlight show live --workspace . --follow" } }],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("{}", { headers: { "content-type": "application/json" } });
      const body = await request.json() as Body;
      requests.push(body);
      const users = body.messages.filter(message => message.role === "user");
      const last = JSON.stringify(users.at(-1) ?? "");
      // Calls already answered since the last user message.
      const lastUserIndex = body.messages.lastIndexOf(users.at(-1)!);
      const answered = body.messages.slice(lastUserIndex).filter(message => message.role === "tool").length;
      const plan = body.tools?.length ? Object.entries(plans).find(([key]) => last.includes(key))?.[1] : undefined;
      const call = plan?.[answered];
      const lines = call
        ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }), chunk({}, "tool_calls")]
        : [chunk({ role: "assistant", content: body.tools?.length ? "done" : "Reading" }), chunk({}, "stop")];
      return new Response([...lines, "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    await cp("tests/fixtures/viewer", workspace, { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src/activity.ts"), "export {};\n");
    await writeFile(join(workspace, "src/launcher.ts"), "export {};\n");
    await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "viewer", mappings: [
      { glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", model: "fake/m",
      providers: { fake: { name: "Fake", env: ["FAKE_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1` }, models: { m: { name: "Fake" } } } },
      plugins: [{ package: resolve("plugins/opencode"), options: { record: true } }],
    }));
    // `pathlight` on the PATH, as a user who installed it has.
    await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "bin", "pathlight"), `#!/bin/sh\nexec ${process.execPath} ${resolve("src/cli.ts")} "$@"\n`);
    await chmod(join(directory, "bin", "pathlight"), 0o755);
    const dirs = Object.fromEntries(["config", "data", "state", "cache"].map(name => [name, join(directory, name)]));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "oc", "-x", "170", "-y", "45", "-c", workspace, "-P", "-F", "#{pane_id}",
      "env", "FAKE_KEY=x", `PATH=${join(directory, "bin")}:${process.env.PATH}`, `XDG_CONFIG_HOME=${dirs.config}`, `XDG_DATA_HOME=${dirs.data}`, `XDG_STATE_HOME=${dirs.state}`, `XDG_CACHE_HOME=${dirs.cache}`,
      Bun.which("opencode")!, "--standalone", "--auto");
    openCodePid = Number(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
    const until = async <T>(read: () => Promise<T | undefined | false>, what: string, attempts = 200) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await read();
        if (value) return value;
        await delay(100);
      }
      throw new Error(`Never saw ${what}\n${await tmux("capture-pane", "-p", "-t", pane)}`);
    };
    const type = async (text: string) => { await tmux("send-keys", "-t", pane, text); await delay(400); await tmux("send-keys", "-t", pane, "Enter"); };
    const others = async () => (await tmux("list-panes", "-F", "#{pane_id} #{pane_current_command}")).split("\n").map(line => line.split(" ")).filter(([id]) => id !== pane);
    const viewerPane = () => until(async () => (await others()).find(([, command]) => command === "bun")?.[0], "the viewer pane");
    const viewerShows = (viewer: string, text: RegExp | string) => until(async () => {
      const screen = await tmux("capture-pane", "-p", "-t", viewer);
      return (typeof text === "string" ? screen.includes(text) : text.test(screen)) ? screen : undefined;
    }, `the viewer showing ${text}`);
    await until(async () => (await tmux("capture-pane", "-p", "-t", pane)).includes("Ask anything") || undefined, "the OpenCode prompt", 300);

    // A conversation that has run no tool yet: the viewer must still open bound to it, not to "the newest session" (which here is nothing).
    await type("just talk to me");
    await until(async () => (await tmux("capture-pane", "-p", "-t", pane)).includes("done") || undefined, "the first reply");
    await type("/pathlight-open live");
    const viewer = await viewerPane();
    const early = await viewerShows(viewer, /opencode:ses_\w+/);
    expect(early).not.toContain("waiting for a session");
    const boundTo = /opencode:(ses_\w+)/.exec(early)![1]!;

    // Recording needs no live request. Reads are recorded and shown in the viewer that was bound from the start.
    await type("read the files please");
    const binding = await until(() => Effect.runPromise(latestBinding(workspace)), "a recorded OpenCode session");
    expect(binding.source).toBe("opencode");
    expect(binding.session.startsWith(boundTo.slice(0, 12))).toBe(true);
    const events = (count: number) => until(async () => {
      const found = await Effect.runPromise(readActivity(workspace, binding));
      return found.filter(event => event.phase !== "started").length >= count ? found : undefined;
    }, `${count} finished calls`);
    const summary = (found: Awaited<ReturnType<typeof events>>) => found.map(event => [event.tool, event.phase, event.operation, [...event.paths]].join(" ")).sort();
    expect(summary(await events(2))).toEqual(["read completed read src/activity.ts", "read completed read src/launcher.ts"]);
    await viewerShows(viewer, "src/launcher.ts");

    // The other tool kinds Claude records: a failure, an edit, and a shell command naming an existing file.
    await type("work through the list");
    expect(summary(await events(5))).toEqual([
      "edit completed edit src/launcher.ts", "read completed read src/activity.ts", "read completed read src/launcher.ts",
      "read failed read src/missing.ts", "shell completed command src/activity.ts"]);

    // When a turn ends the plugin runs `pathlight check`, as Claude's Stop hook does: the viewer's out-of-date badge and review come from it.
    await until(async () => existsSync(join(workspace, ".cache", "pathlight", "stale.json")), "the end-of-turn check");

    // Each prompt that ran tools is a turn of its own (two reads, then the three calls of the list), so replay can step by turn.
    expect((await Effect.runPromise(readReplay(workspace, binding))).turns).toEqual([0, 2]);

    // The skill is advertised, and the agent has the tool to load it.
    const asked = requests.filter(request => request.tools?.some(tool => tool.function?.name === "skill"));
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.stringify(asked[0]!.messages)).toContain("<id>pathlight</id>");

    // Ask-about-node: typed into this conversation and submitted, so the model receives it.
    await tmux("send-keys", "-t", viewer, "t");
    await delay(500);
    await tmux("send-keys", "-t", viewer, "why does this exist");
    await delay(400);
    await tmux("send-keys", "-t", viewer, "Enter");
    await until(async () => requests.some(request => JSON.stringify(request.messages.filter(message => message.role === "user").at(-1)).includes("why does this exist")) || undefined, "the question reaching the model");

    // /pathlight: the agent is told the real pane and socket, and following the skill reopens the viewer rather than adding a second one.
    await type("/pathlight live");
    const prompt = await until(async () => requests.map(request => JSON.stringify(request.messages.filter(message => message.role === "user").at(-1))).find(text => text.includes("pathlight skill")), "the /pathlight prompt");
    expect(prompt).toContain(`pane is ${pane}`);
    expect(prompt).toContain(socket);
    await delay(3000);
    expect((await others()).length).toBe(1);

    // Plain English, no slash command: the agent's shell inherits the terminal's pane and opens the viewer beside it.
    await tmux("kill-pane", "-t", viewer);
    await until(async () => (await others()).length === 0 || undefined, "the viewer closed");
    await type("show me the architecture");
    const reopened = await viewerPane();
    await viewerShows(reopened, /live opencode:ses_/);
  } finally {
    // OpenCode ignores the hangup tmux sends, so it is stopped explicitly.
    if (openCodePid) try { process.kill(openCodePid, "SIGTERM"); } catch { /* already gone */ }
    await tmux("kill-server").catch(() => {});
    await rm(socket, { force: true });
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
