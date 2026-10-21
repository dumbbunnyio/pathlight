import { Plugin } from "@opencode/plugin";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { run } from "../../src/process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { toolActivity, turnActivity, writeActivity, type ActivityEvent } from "../../src/activity";
import { ActivitySubscriptions } from "../../src/activity-subscriptions";
import { Effect, Fiber, Queue, Stream } from "effect";
import { io } from "../../src/effects";

const Show = z.object({
  view: z.string().min(1),
  project: z.string().optional(),
  pane: z.string().regex(/^%\d+$/).describe("The user's tmux pane ID. Obtain it from their terminal context, not the background server environment."),
  socket: z.string().optional().describe("tmux server socket path, if not using the default server."),
  live: z.boolean().default(false).describe("Observe this session's tool activity. Requires pathlight.activity.json in the workspace."),
}).strict();

export default Plugin.define({
  id: "pathlight",
  async setup(ctx) {
    const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    const workspace = ctx.location.directory;
    const subscriptions = new ActivitySubscriptions();
    type SessionID = Parameters<typeof ctx.session.get>[0]["sessionID"];
    // OpenCode brands these strings; the host validates the entry when it is added.
    type SkillInfo = Parameters<Parameters<Parameters<typeof ctx.skill.transform>[0]>[0]["add"]>[0];
    // `record: true` in the plugin's options is the workspace-wide opt-in (what `pathlight init` writes, the counterpart of installing the Claude hooks):
    // every root session in this workspace is recorded without a `live` request. Subagent sessions are never aggregated, and `pathlight_stop` still stops one.
    const record = ctx.options?.record === true;
    const stopped = new Set<SessionID>();
    const eligibility = new Map<SessionID, { inWorkspace: boolean; root: boolean }>();
    const queue = Effect.runSync(Queue.sliding<{ event: ActivityEvent; sessionID: SessionID; recording: { active: boolean }; auto: boolean }>(128));
    const recordings = new Map<SessionID, { active: boolean }>();
    let disposed = false;
    const worker = Effect.runFork(Stream.fromQueue(queue).pipe(Stream.runForEach(pending => Effect.gen(function* () {
      if (disposed || !pending.recording.active) return;
      let known = eligibility.get(pending.sessionID);
      if (!known) {
        const session = yield* io("Plugin.session", () => ctx.session.get({ sessionID: pending.sessionID }));
        const root = yield* io("Plugin.workspace", () => realpath(workspace));
        known = { inWorkspace: (yield* io("Plugin.sessionWorkspace", () => realpath(session.location.directory))) === root, root: session.parentID === undefined };
        eligibility.set(pending.sessionID, known);
      }
      if (known.inWorkspace && (known.root || !pending.auto)) yield* writeActivity(workspace, pending.event);
    }).pipe(Effect.ignore))));
    const enqueue = (sessionID: SessionID, make: () => ActivityEvent) => {
      const watched = subscriptions.watching(sessionID);
      if (disposed || !(watched || record && !stopped.has(sessionID))) return;
      try {
        let recording = recordings.get(sessionID);
        if (!recording) { recording = { active: true }; recordings.set(sessionID, recording); }
        Queue.offerUnsafe(queue, { event: make(), sessionID, recording, auto: !watched });
      } catch { /* Observation must not change tool execution. */ }
    };
    const observe = (event: { sessionID: SessionID; id: string; tool: string; input: unknown }, phase: ActivityEvent["phase"]) => {
      if (event.tool.startsWith("pathlight")) return;
      enqueue(event.sessionID, () => Effect.runSync(toolActivity(workspace, { source: "opencode", session: event.sessionID }, event.id, event.tool, event.input, phase)));
    };
    // A new run of a session is a new turn. Only the fact is recorded, never the prompt.
    const listening = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: listening.signal })) {
          if (event.type !== "session.execution.started") continue;
          const sessionID = (event.data as { sessionID: SessionID }).sessionID;
          enqueue(sessionID, () => Effect.runSync(turnActivity({ source: "opencode", session: sessionID })));
        }
      } catch { /* Turn markers are optional: replay falls back to pauses between calls. */ }
    })();
    const dispose = async () => {
      disposed = true; listening.abort(); subscriptions.clear(); recordings.clear(); stopped.clear(); eligibility.clear();
      await Effect.runPromise(Fiber.interrupt(worker));
    };
    try {
    // The pathlight skills (shared with the Claude plugin) are offered to the agent unless the workspace already has one of the same name (`pathlight init` copies them for hosts without this plugin).
    try {
      const folder = fileURLToPath(new URL("../claude/skills/", import.meta.url));
      const present = (await ctx.skill.list()).data;
      for (const name of await readdir(folder)) {
        const file = `${folder}${name}/SKILL.md`;
        const text = await readFile(file, "utf8").catch(() => undefined);
        if (text === undefined || present.some(skill => skill.id === name || skill.name === name)) continue;
        const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
        await ctx.skill.transform(editor => editor.add({ id: name, name, ...(description ? { description } : {}), path: file, content: text.replace(/^---\n[\s\S]*?\n---\n/, "") } as SkillInfo));
      }
    } catch { /* The skills are a convenience; the tools and recording do not depend on them. */ }
    await ctx.tool.hook("execute.before", event => observe(event, "started"));
    await ctx.tool.hook("execute.after", event => observe(event, event.status === "completed" ? "completed" : "failed"));
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "pathlight", description: "List and open LikeC4 architecture diagrams in a tmux viewer." });
      editor.add({
        name: "stop",
        description: "Stop recording activity for this agent session. Keeps the viewer and its retained history open.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "pathlight", codemode: true },
        execute: async (_input, context) => {
          subscriptions.stop(context.sessionID);
          stopped.add(context.sessionID);
          const recording = recordings.get(context.sessionID);
          if (recording) recording.active = false;
          recordings.delete(context.sessionID);
          return { content: "Activity recording stopped for this session. Any in-flight metadata write may finish." };
        },
      });
      editor.add({
        name: "list",
        description: "List LikeC4 projects and view IDs in this workspace before choosing a diagram to show.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "pathlight", codemode: true },
        execute: async (_input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID, agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "pathlight_list", resources: [workspace], save: [workspace],
          });
          return { content: await Effect.runPromise(run("bun", [cli, "list", "--workspace", workspace]), { signal: context.signal }) };
        },
      });
      editor.add({
        name: "show",
        description: "Open an interactive LikeC4 diagram beside the user's tmux pane. Native nodes support mouse, keyboard, search, nested groups, and linked views. Requires an explicit parent pane ID. Set live=true to record this session's tool activity. Reuses only owned viewer panes.",
        input: z.toJSONSchema(Show),
        options: { namespace: "pathlight", codemode: true },
        execute: async (input, context) => {
          const request = Show.parse(input);
          const ticket = request.live ? subscriptions.begin(context.sessionID) : undefined;
          try {
            if (request.live) {
              const session = await ctx.session.get({ sessionID: context.sessionID });
              if (await realpath(session.location.directory) !== await realpath(workspace)) {
                throw new Error("Live activity must use the session's own workspace.");
              }
            }
            await ctx.permission.assert({
              sessionID: context.sessionID, agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
              action: "pathlight_show",
              resources: [`${workspace}:${request.socket ?? "default"}:${request.pane}:${request.view}`],
              save: [`${workspace}:*`],
            });
            const args = [cli, "show", request.view, "--workspace", workspace,
              "--pane", request.pane];
            if (request.project) args.push("--project", request.project);
            if (request.socket) args.push("--socket", request.socket);
            if (request.live) args.push("--session", context.sessionID, "--source", "opencode");
            const content = await Effect.runPromise(run("bun", args), { signal: context.signal });
            if (request.live) stopped.delete(context.sessionID);
            if (ticket && !subscriptions.complete(context.sessionID, ticket)) {
              return { content: `${content}\nActivity attachment was superseded or stopped; recording was not enabled by this request.` };
            }
            return { content };
          } catch (error) {
            if (ticket) subscriptions.fail(context.sessionID, ticket);
            throw error;
          }
        },
      });
    });
    return dispose;
    } catch (error) { await dispose(); throw error; }
  },
});
