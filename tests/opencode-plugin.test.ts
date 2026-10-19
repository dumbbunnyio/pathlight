import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import plugin from "../plugins/opencode/index";
import { readActivity, run } from "./effects";

type Tool = { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> };

test("the OpenCode plugin registers its tools, asks permission, opens a viewer, and records only after a live request until stopped", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pathlight-opencode-"));
  const socket = join("/tmp", `c4o-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const hooks = new Map<string, (event: unknown) => unknown>();
  const tools = new Map<string, Tool>();
  const permissions: { action: string }[] = [];
  let cleanup: void | (() => Promise<void> | void) = undefined;
  try {
    await cp("tests/fixtures/viewer", workspace, { recursive: true });
    await writeFile(join(workspace, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer",
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
    expect([...tools.keys()].sort()).toEqual(["list", "show", "stop"]);
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
    await cleanup?.();
    await tmux("kill-server").catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
}, 90_000);
