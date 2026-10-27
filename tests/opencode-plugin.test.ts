import { expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import plugin from "../plugins/opencode/index";
import { readActivity, run, mappingIn } from "./effects";

// The plugin runs the `pathlight` binary, as a user who installed it has on the PATH.
const withPathlight = async () => {
  const bin = await mkdtemp(join(tmpdir(), "pathlight-opencode-bin-"));
  await writeFile(join(bin, "pathlight"), `#!/bin/sh\nexec "${process.execPath}" "${resolve("src/cli.ts")}" "$@"\n`);
  await chmod(join(bin, "pathlight"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  return async () => { process.env.PATH = before; await rm(bin, { recursive: true, force: true }); };
};

type Tool = { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> };

test("the OpenCode plugin registers its tools, asks permission, opens a viewer, and records only after a live request until stopped", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pathlight-opencode-"));
  const socket = join("/tmp", `c4o-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const hooks = new Map<string, (event: unknown) => unknown>();
  const tools = new Map<string, Tool>();
  const permissions: { action: string }[] = [];
  let cleanup: void | (() => Promise<void> | void) = undefined;
  const restore = await withPathlight();
  try {
    await cp("tests/fixtures/viewer", workspace, { recursive: true });
    await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/**", element: "activity" }] }));
    const context = {
      location: { directory: workspace },
      session: { get: async () => ({ location: { directory: workspace } }) },
      permission: { assert: async (request: { action: string }) => { permissions.push(request); } },
      tool: {
        hook: async (name: string, handler: (event: unknown) => unknown) => { hooks.set(name, handler); },
        transform: async (apply: (editor: unknown) => void) => apply({
          namespace: () => undefined,
          add: (tool: Tool) => { tools.set(tool.name, tool); },
        }),
      },
    };
    cleanup = await plugin.setup(context as never);
    expect([...tools.keys()].sort()).toEqual(["list", "models", "show", "stop"]);
    expect([...hooks.keys()].sort()).toEqual(["execute.after", "execute.before"]);

    const call = { sessionID: "ses_test", agent: "build", messageID: "m1", id: "t1", signal: new AbortController().signal };
    const listed = JSON.parse((await tools.get("list")!.execute({}, call)).content) as { views: { id: string }[] };
    expect(listed.views.map(view => view.id)).toContain("live");
    expect(permissions.map(request => request.action)).toEqual(["pathlight_list"]);

    // Before any live request nothing is recorded, even for a session that is making tool calls.
    const edit = (id: string, phase: "before" | "after") => hooks.get(`execute.${phase}`)!({
      sessionID: "ses_test", id, tool: "edit", input: { filePath: join(workspace, "src/activity.ts") }, status: "completed" });
    await edit("c1", "before"); await edit("c1", "after");
    await delay(300);
    expect(await readActivity(workspace, { source: "opencode", session: "ses_test" })).toEqual([]);

    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "oc", "-x", "150", "-y", "40", "-P", "-F", "#{pane_id}", "sleep", "120");
    const shown = JSON.parse((await tools.get("show")!.execute({ view: "live", project: "viewer", pane: harness, socket, live: true }, call)).content) as { pane: string };
    expect(shown.pane).toMatch(/^%\d+$/);
    expect(permissions.map(request => request.action)).toEqual(["pathlight_list", "pathlight_show"]);

    await edit("c2", "before"); await edit("c2", "after");
    let events = await readActivity(workspace, { source: "opencode", session: "ses_test" });
    for (let attempt = 0; attempt < 60 && !events.length; attempt++) { await delay(50); events = await readActivity(workspace, { source: "opencode", session: "ses_test" }); }
    expect(events.map(event => [event.call, event.phase, event.operation, [...event.paths]])).toEqual([["c2", "completed", "edit", ["src/activity.ts"]]]);

    // pathlight tool calls are never recorded, and stop ends recording for the session.
    await hooks.get("execute.before")!({ sessionID: "ses_test", id: "own", tool: "pathlight_show", input: {} });
    expect((await tools.get("stop")!.execute({}, call)).content).toContain("stopped");
    await edit("c3", "before"); await edit("c3", "after");
    await delay(400);
    expect((await readActivity(workspace, { source: "opencode", session: "ses_test" })).map(event => event.call)).toEqual(["c2"]);
  } finally {
    await restore();
    await cleanup?.();
    await tmux("kill-server").catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
}, 90_000);

test("with record: true the plugin records root sessions in its workspace without a live request, never subagents or other workspaces, and stop still stops one", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pathlight-opencode-record-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "pathlight-opencode-elsewhere-"));
  const hooks = new Map<string, (event: unknown) => unknown>();
  const tools = new Map<string, Tool>();
  let cleanup: void | (() => Promise<void> | void) = undefined;
  try {
    await cp("tests/fixtures/viewer", workspace, { recursive: true });
    await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "src/**", element: "activity" }] }));
    const sessions: Record<string, { location: { directory: string }; parentID?: string }> = {
      root: { location: { directory: workspace } }, child: { location: { directory: workspace }, parentID: "root" }, other: { location: { directory: elsewhere } },
    };
    const context = {
      location: { directory: workspace }, options: { record: true },
      session: { get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID] },
      permission: { assert: async () => undefined },
      skill: { list: async () => ({ data: [] }), transform: async () => undefined },
      tool: {
        hook: async (name: string, handler: (event: unknown) => unknown) => { hooks.set(name, handler); },
        transform: async (apply: (editor: unknown) => void) => apply({ namespace: () => undefined, add: (tool: Tool) => { tools.set(tool.name, tool); } }),
      },
    };
    cleanup = await plugin.setup(context as never);
    const read = async (sessionID: string, id: string) => {
      const event = { sessionID, id, tool: "read", input: { path: "src/activity.ts" }, status: "completed" };
      await hooks.get("execute.before")!(event); await hooks.get("execute.after")!(event);
    };
    const seen = (session: string) => readActivity(workspace, { source: "opencode", session });
    await read("root", "r1"); await read("child", "k1"); await read("other", "o1");
    let events = await seen("root");
    for (let attempt = 0; attempt < 60 && events.length < 1; attempt++) { await delay(50); events = await seen("root"); }
    await delay(300);
    expect(events.map(event => [event.call, event.phase, [...event.paths]])).toEqual([["r1", "completed", ["src/activity.ts"]]]);
    expect(await seen("child")).toEqual([]);
    expect(await seen("other")).toEqual([]);
    expect((await tools.get("stop")!.execute({}, { sessionID: "root", agent: "build", messageID: "m", id: "s", signal: new AbortController().signal })).content).toContain("stopped");
    await read("root", "r2");
    await delay(400);
    expect((await seen("root")).map(event => event.call)).toEqual(["r1"]);
  } finally {
    await cleanup?.();
    await rm(workspace, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
}, 60_000);

test("registered for every project, the plugin records nothing in a workspace without a mapping, and nothing is written there", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pathlight-opencode-unmapped-"));
  const hooks = new Map<string, (event: unknown) => unknown>();
  let cleanup: void | (() => Promise<void> | void) = undefined;
  try {
    await writeFile(join(workspace, "notes.md"), "# a project that never set up pathlight\n");
    const context = {
      location: { directory: workspace }, options: { record: true },
      session: { get: async () => ({ location: { directory: workspace } }) },
      permission: { assert: async () => undefined },
      skill: { list: async () => ({ data: [] }), transform: async () => undefined },
      tool: {
        hook: async (name: string, handler: (event: unknown) => unknown) => { hooks.set(name, handler); },
        transform: async (apply: (editor: unknown) => void) => apply({ namespace: () => undefined, add: () => undefined }),
      },
    };
    cleanup = await plugin.setup(context as never);
    const event = { sessionID: "root", id: "r1", tool: "read", input: { path: "notes.md" }, status: "completed" };
    await hooks.get("execute.before")!(event); await hooks.get("execute.after")!(event);
    await delay(400);
    expect(await readdir(workspace)).toEqual(["notes.md"]);
  } finally {
    await cleanup?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);

test("the plugin registers a read-only tracer subagent pinned to the newest enabled Sonnet, reports the choice in pathlight_models, and rebuilds the agent when the model list arrives late", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pathlight-opencode-agent-"));
  const tools = new Map<string, Tool>();
  const agents: Record<string, Record<string, unknown>> = {};
  const reloads: string[] = [];
  let rebuild: (() => void) | undefined;
  let modelsEditor: ((editor: { list: () => unknown[] }) => void) | undefined;
  const host = (id: string, enabled: boolean, out: number, status = "active") => ({ providerID: "anthropic", id, name: id, time: { released: id.endsWith("5-5") ? 2 : 1 }, status, enabled, capabilities: { tools: true }, cost: [{ input: 2, output: out }] });
  let list: unknown[] = [];
  let cleanup: void | (() => Promise<void> | void) = undefined;
  try {
    const context = {
      location: { directory: workspace }, options: { tracerModel: undefined },
      session: { get: async () => ({ location: { directory: workspace } }) },
      permission: { assert: async () => undefined },
      skill: { list: async () => ({ data: [] }), transform: async () => undefined },
      tool: {
        hook: async () => undefined,
        transform: async (apply: (editor: unknown) => void) => apply({ namespace: () => undefined, add: (tool: Tool) => { tools.set(tool.name, tool); } }),
      },
      // The host calls a model transform once its providers are resolved, which can be after setup returns.
      model: { transform: async (apply: (editor: { list: () => unknown[] }) => void) => { modelsEditor = apply; } },
      // Like the host: a transform runs when registered and again on reload.
      agent: {
        transform: async (apply: (editor: unknown) => void) => {
          rebuild = () => apply({ update: (id: string, change: (agent: Record<string, unknown>) => void) => { agents[id] = {}; change(agents[id]!); } });
          rebuild();
        },
        reload: async () => { reloads.push("agent"); rebuild!(); },
      },
    };
    cleanup = await plugin.setup(context as never);
    // Before the host reports any model nothing is pinned.
    expect(agents["pathlight-tracer"]).toMatchObject({ mode: "subagent" });
    expect(agents["pathlight-tracer"]!.model).toBeUndefined();

    list = [host("claude-sonnet-4-6", true, 15), host("claude-sonnet-5-5", true, 10), host("claude-sonnet-5", false, 10), host("claude-opus-5-5", true, 25)];
    modelsEditor!({ list: () => list });
    await delay(20);
    expect(reloads).toEqual(["agent"]);
    expect(agents["pathlight-tracer"]!.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" });
    const reported = JSON.parse((await tools.get("models")!.execute({}, {})).content) as { tracer: { ref: string; source: string; tested: boolean }; usable: { model: string }[] };
    expect(reported.tracer).toMatchObject({ ref: "anthropic/claude-sonnet-5-5", source: "sonnet", tested: true });
    expect(reported.usable.map(item => item.model).sort()).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-5-5"]);
  } finally {
    await cleanup?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);

test("the tracer agent's rules deny everything but reading and a few commands, and its prompt is the Claude agent's body", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pathlight-opencode-agent2-"));
  const agents: Record<string, Record<string, unknown>> = {};
  let cleanup: void | (() => Promise<void> | void) = undefined;
  try {
    const context = {
      location: { directory: workspace }, options: { tracerModel: "anthropic/claude-sonnet-5-5" },
      session: { get: async () => ({ location: { directory: workspace } }) }, permission: { assert: async () => undefined },
      skill: { list: async () => ({ data: [] }), transform: async () => undefined },
      tool: { hook: async () => undefined, transform: async (apply: (editor: unknown) => void) => apply({ namespace: () => undefined, add: () => undefined }) },
      model: { transform: async () => undefined },
      agent: { transform: async (apply: (editor: unknown) => void) => apply({ update: (id: string, change: (agent: Record<string, unknown>) => void) => { agents[id] = {}; change(agents[id]!); } }), reload: async () => undefined },
    };
    cleanup = await plugin.setup(context as never);
    const agent = agents["pathlight-tracer"]!;
    // The last matching rule wins in OpenCode, so the deny-all rule comes first and nothing after it writes.
    const rules = agent.permissions as { action: string; resource: string; effect: string }[];
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rules.filter(rule => rule.effect === "allow").map(rule => `${rule.action}:${rule.resource}`)).toEqual(["read:*", "grep:*", "glob:*", "shell:pathlight *", "shell:git log*", "shell:git show*", "shell:ls*"]);
    expect(rules.some(rule => rule.action === "edit" && rule.effect === "allow")).toBe(false);
    expect(agent.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" });
    expect(String(agent.system)).toContain("pathlight flow add");
    expect(String(agent.system)).not.toContain("model: sonnet");
  } finally {
    await cleanup?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);
