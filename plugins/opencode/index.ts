import { Plugin } from "@opencode/plugin";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { run } from "../../src/process";
import { realpath } from "node:fs/promises";
import { toolActivity, writeActivity, type ActivityEvent } from "../../src/activity";
import { ActivitySubscriptions } from "../../src/activity-subscriptions";
import { Effect, Fiber, Queue, Stream } from "effect";
import { io } from "../../src/effects";

const Show = z.object({
  view: z.string().min(1),
  project: z.string().optional(),
  pane: z.string().regex(/^%\d+$/).describe("The user's tmux pane ID. Obtain it from their terminal context, not the background server environment."),
  socket: z.string().optional().describe("tmux server socket path, if not using the default server."),
  live: z.boolean().default(false).describe("Observe this session's tool activity. Requires c4view.activity.json in the workspace."),
}).strict();

export default Plugin.define({
  id: "visualize-work",
  async setup(ctx) {
    const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    const workspace = ctx.location.directory;
    const subscriptions = new ActivitySubscriptions();
    type SessionID = Parameters<typeof ctx.session.get>[0]["sessionID"];
    const queue = Effect.runSync(Queue.sliding<{ event: ActivityEvent; sessionID: SessionID; recording: { active: boolean } }>(128));
    const recordings = new Map<SessionID, { active: boolean }>();
    let disposed = false;
    const worker = Effect.runFork(Stream.fromQueue(queue).pipe(Stream.runForEach(pending => Effect.gen(function* () {
      if (disposed || !pending.recording.active) return;
      const session = yield* io("Plugin.session", () => ctx.session.get({ sessionID: pending.sessionID }));
      const root = yield* io("Plugin.workspace", () => realpath(workspace));
      if ((yield* io("Plugin.sessionWorkspace", () => realpath(session.location.directory))) === root) {
        yield* writeActivity(workspace, pending.event);
      }
    }).pipe(Effect.ignore))));
    const observe = (event: { sessionID: SessionID; id: string; tool: string; input: unknown }, phase: ActivityEvent["phase"]) => {
      if (disposed || !subscriptions.watching(event.sessionID) || event.tool.startsWith("c4view")) return;
      try {
        const activity = Effect.runSync(toolActivity(workspace, { source: "opencode", session: event.sessionID }, event.id, event.tool, event.input, phase));
        let recording = recordings.get(event.sessionID);
        if (!recording) { recording = { active: true }; recordings.set(event.sessionID, recording); }
        Queue.offerUnsafe(queue, { event: activity, sessionID: event.sessionID, recording });
      } catch { /* Observation must not change tool execution. */ }
    };
    const dispose = async () => {
      disposed = true; subscriptions.clear(); recordings.clear();
      await Effect.runPromise(Fiber.interrupt(worker));
    };
    try {
    await ctx.tool.hook("execute.before", event => observe(event, "started"));
    await ctx.tool.hook("execute.after", event => observe(event, event.status === "completed" ? "completed" : "failed"));
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "c4view", description: "List and open LikeC4 architecture diagrams in a tmux viewer." });
      editor.add({
        name: "stop",
        description: "Stop recording activity for this agent session. Keeps the viewer and its retained history open.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "c4view", codemode: true },
        execute: async (_input, context) => {
          subscriptions.stop(context.sessionID);
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
        options: { namespace: "c4view", codemode: true },
        execute: async (_input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID, agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "c4view_list", resources: [workspace], save: [workspace],
          });
          return { content: await Effect.runPromise(run("bun", [cli, "list", "--workspace", workspace]), { signal: context.signal }) };
        },
      });
      editor.add({
        name: "show",
        description: "Open an interactive LikeC4 diagram beside the user's tmux pane. Native nodes support mouse, keyboard, search, nested groups, and linked views. Requires an explicit parent pane ID. Set live=true to record this session's tool activity. Reuses only owned viewer panes.",
        input: z.toJSONSchema(Show),
        options: { namespace: "c4view", codemode: true },
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
              action: "c4view_show",
              resources: [`${workspace}:${request.socket ?? "default"}:${request.pane}:${request.view}`],
              save: [`${workspace}:*`],
            });
            const args = [cli, "show", request.view, "--workspace", workspace,
              "--pane", request.pane];
            if (request.project) args.push("--project", request.project);
            if (request.socket) args.push("--socket", request.socket);
            if (request.live) args.push("--session", context.sessionID, "--source", "opencode");
            const content = await Effect.runPromise(run("bun", args), { signal: context.signal });
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
