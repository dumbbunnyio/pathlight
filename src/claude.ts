import { realpath } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { toolActivity } from "./activity";
import { io, failure } from "./effects";

const Hook = Schema.Struct({
  hook_event_name: Schema.Literals(["PreToolUse", "PostToolUse", "PostToolUseFailure"]),
  session_id: Schema.String, tool_use_id: Schema.String, tool_name: Schema.String,
  tool_input: Schema.Unknown, cwd: Schema.String,
});

export const claudeActivity = Effect.fn("Claude.fromHook")(function* (workspace: string, input: unknown) {
  const hook = yield* Schema.decodeUnknownEffect(Hook)(input);
  const root = yield* io("Claude.workspace", () => realpath(workspace));
  if ((yield* io("Claude.cwd", () => realpath(hook.cwd))) !== root) return yield* Effect.fail(failure("Claude.workspace", "Claude hook cwd does not match the activity workspace."));
  const phase = hook.hook_event_name === "PreToolUse" ? "started"
    : hook.hook_event_name === "PostToolUse" ? "completed" : "failed";
  return yield* toolActivity(root, { source: "claude", session: hook.session_id }, hook.tool_use_id,
    hook.tool_name, hook.tool_input, phase);
});
