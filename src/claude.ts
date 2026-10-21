import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { Effect, Schema } from "effect";
import { toolActivity, turnActivity } from "./activity";
import { io, failure } from "./effects";

const Prompt = Schema.Struct({ hook_event_name: Schema.Literal("UserPromptSubmit"), session_id: Schema.String, cwd: Schema.String });
const Hook = Schema.Struct({
  hook_event_name: Schema.Literals(["PreToolUse", "PostToolUse", "PostToolUseFailure"]),
  session_id: Schema.String, tool_use_id: Schema.String, tool_name: Schema.String,
  tool_input: Schema.Unknown, cwd: Schema.String,
  // Present only on calls made inside a subagent. `agent_type` can be empty, and `agent_id` alone is enough to say it was not the conversation itself.
  agent_id: Schema.optionalKey(Schema.String), agent_type: Schema.optionalKey(Schema.String),
});

/** A short label for a subagent's calls, safe for the journal; undefined when the call was the conversation's own. */
const agentLabel = (hook: { agent_id?: string; agent_type?: string }) => {
  if (hook.agent_id === undefined && hook.agent_type === undefined) return undefined;
  return (hook.agent_type ?? "").replace(/[^\w./:@ -]/g, "-").slice(0, 64).trim() || "subagent";
};

/** Claude reports a subagent handing its report back as a tool call of its own. It touches no files and says nothing about the architecture, so it is not recorded. */
export const claudeIgnores = (input: unknown) => typeof input === "object" && input !== null && "tool_name" in input && input.tool_name === "SubagentHandback";

export const claudeActivity = Effect.fn("Claude.fromHook")(function* (workspace: string, input: unknown) {
  const prompt = yield* Schema.decodeUnknownEffect(Prompt)(input).pipe(Effect.option);
  const hook = prompt._tag === "Some" ? { ...prompt.value, hook_event_name: "UserPromptSubmit" as const } : yield* Schema.decodeUnknownEffect(Hook)(input);
  const root = yield* io("Claude.workspace", () => realpath(workspace));
  // A session may `cd` into a subdirectory; anything outside the workspace is still rejected.
  const cwd = yield* io("Claude.cwd", () => realpath(hook.cwd));
  const within = relative(root, cwd);
  if (within === ".." || within.startsWith("../") || isAbsolute(within)) return yield* Effect.fail(failure("Claude.workspace", "Claude hook cwd does not match the activity workspace."));
  if (hook.hook_event_name === "UserPromptSubmit") return yield* turnActivity({ source: "claude", session: hook.session_id });
  const phase = hook.hook_event_name === "PreToolUse" ? "started"
    : hook.hook_event_name === "PostToolUse" ? "completed" : "failed";
  return yield* toolActivity(root, { source: "claude", session: hook.session_id }, hook.tool_use_id,
    hook.tool_name, hook.tool_input, phase, cwd, agentLabel(hook));
});
