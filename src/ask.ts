import { Effect } from "effect";
import { failure } from "./effects";
import { run } from "./process";

/** One line for the agent's prompt: the question first, then the context the viewer already knows about the component. */
export function askMessage(target: { title: string; id: string; files: readonly string[]; links: readonly string[]; activity?: readonly string[] }, question: string) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const context = [
    target.files.length ? `files: ${target.files.slice(0, 6).map(clean).join(", ")}` : "",
    target.links.length ? `connects: ${target.links.slice(0, 6).map(clean).join(", ")}` : "",
    target.activity?.length ? `recent: ${target.activity.slice(0, 5).map(clean).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `About the "${clean(target.title)}" component (${clean(target.id)}): ${clean(question).slice(0, 600)}${context ? ` [${context}]` : ""}`;
}

/**
 * Types text into the harness's own tmux pane. The pane is the one the viewer was opened beside; it is verified to
 * still exist, and the text is sent literally so it cannot be read as key names. Without `submit` the user presses
 * Enter themselves, so a half-written prompt is never sent by surprise.
 */
export const sendToPane = Effect.fn("Ask.send")(function* (pane: string, text: string, submit: boolean) {
  if (!/^%\d+$/.test(pane)) return yield* Effect.fail(failure("Ask.pane", "Ask needs the viewer opened with c4view show, which records your agent's pane."));
  const [id, command] = (yield* run("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}\t#{pane_current_command}"])).trim().split("\t");
  if (id !== pane) return yield* Effect.fail(failure("Ask.pane", `Pane ${pane} no longer exists.`));
  yield* run("tmux", ["send-keys", "-t", pane, "-l", "--", text]);
  if (submit) yield* run("tmux", ["send-keys", "-t", pane, "Enter"]);
  return command ?? pane;
});
