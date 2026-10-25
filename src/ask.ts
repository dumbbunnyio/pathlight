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
  if (!/^%\d+$/.test(pane)) return yield* Effect.fail(failure("Ask.pane", "Ask needs the viewer opened with pathlight show, which records your agent's pane."));
  const [id, command] = (yield* run("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}\t#{pane_current_command}"])).trim().split("\t");
  if (id !== pane) return yield* Effect.fail(failure("Ask.pane", `Pane ${pane} no longer exists.`));
  yield* run("tmux", ["send-keys", "-t", pane, "-l", "--", text]);
  if (submit) yield* run("tmux", ["send-keys", "-t", pane, "Enter"]);
  return command ?? pane;
});

/**
 * A request to change the map, not only to answer: the same context as a question plus the element's overlay key, and the rules the
 * agent follows (names and notes are applied, merges and splits are proposed first, a human pin is never changed).
 */
export function mapMessage(target: { title: string; id: string; key: string; files: readonly string[]; links: readonly string[] }, request: string) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const context = [
    `overlay key: ${clean(target.key)}`,
    target.files.length ? `files: ${target.files.slice(0, 8).map(clean).join(", ")}` : "",
    target.links.length ? `connects: ${target.links.slice(0, 6).map(clean).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `Improve the pathlight map for the "${clean(target.title)}" component (${clean(target.id)}): ${clean(request).slice(0, 600)} [${context}] `
    + `Read the files, answer me here, then set its name and note in .pathlight/pathlight.overlay.json with "by":"agent" and run pathlight draft. Never change an entry marked "by":"human". `
    + `If it should be merged or split, tell me and wait for my yes before editing.`;
}

/**
 * A request to trace how something works and record it as a journey. It carries what the viewer already knows (the component, its files and
 * connections) and the rules the agent follows: read the code, decide, then write it down with `pathlight flow add`, which checks it against the model.
 */
export function flowMessage(target: { title: string; id: string; files: readonly string[]; links: readonly string[] }, request: string) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const context = [
    target.files.length ? `files: ${target.files.slice(0, 8).map(clean).join(", ")}` : "",
    target.links.length ? `connects: ${target.links.slice(0, 6).map(clean).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `Trace how this works in the "${clean(target.title)}" component (${clean(target.id)}) and record it as a pathlight journey: ${clean(request).slice(0, 600)}${context ? ` [${context}]` : ""} `
    + `If you have a pathlight-tracer agent, hand the trace to it: it runs on a mid-size model, so the reading stays out of this conversation and off a larger model. Otherwise do it yourself. `
    + `Follow the pathlight-behavior skill: read the code from this component outward, confirm each hop in a file, then run pathlight flow add with the files you read and one --step per hop between components in the model. `
    + `Leave out any hop you cannot point to in the code and tell me what you could not find. Do not change product code.`;
}
