import { Effect } from "effect";
import { failure } from "./effects";
import { run } from "./process";

/** A question whose answer is a path through components: it is drawn as well as answered, unless the user turns `draw it` off. */
export const isHowQuestion = (question: string) =>
  /^\s*(how\b|where (does|do|is|are)\b|what happens\b|what calls\b|which (path|way)\b|trace\b|walk me through\b|follow\b)/i.test(question);

/**
 * The files a request names, at most six, by relevance rather than alphabetically: the component's files that import from or are imported by its
 * neighbours' files (most such imports first; type-only imports do not count), then the entry file its description names (`Entry is app/index.tsx.`),
 * else none. Eight alphabetical files told the agent nothing about where to start.
 */
export function relevantFiles(options: { files: readonly string[]; neighbours: readonly string[]; imports: readonly { from: string; to: string; kind?: string }[]; description?: string }) {
  const own = new Set(options.files), near = new Set(options.neighbours), weight = new Map<string, number>();
  for (const { from, to, kind } of options.imports) {
    if (kind === "type") continue;
    const mine = own.has(from) && near.has(to) ? from : own.has(to) && near.has(from) ? to : undefined;
    if (mine) weight.set(mine, (weight.get(mine) ?? 0) + 1);
  }
  const ranked = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([file]) => file);
  const entry = /\bentry(?: point)? is `?([\w@./[\]-]+\.\w+)`?/i.exec(options.description ?? "")?.[1];
  const picked = ranked.slice(0, 6);
  return entry && own.has(entry) && !picked.includes(entry) ? [...picked.slice(0, 5), entry] : picked;
}

/**
 * One line for the agent's prompt: the question first, then the context the viewer already knows about the component, then what to do with it. `t`
 * both asks and tells, so the line carries two rules. A question whose answer is a path (`draw`) is recorded as a journey as well as answered, so it
 * appears on the map; an instruction declares the elements it will touch (`pathlight plan`, a `#planned` element for anything new) before the first
 * edit, so the map shows where the work is going before it lights up. Who records the journey is the skill's business, not this line's: a tracer
 * handed this text must not read a hand-off as addressed to it.
 */
export function askMessage(target: { title: string; id: string; files: readonly string[]; links: readonly string[]; activity?: readonly string[] }, question: string, draw = false) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const context = [
    target.files.length ? `files: ${target.files.slice(0, 6).map(clean).join(", ")}` : "",
    target.links.length ? `connects: ${target.links.slice(0, 6).map(clean).join(", ")}` : "",
    target.activity?.length ? `recent: ${target.activity.slice(0, 5).map(clean).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  const id = clean(target.id);
  return `About the "${clean(target.title)}" component (${id}): ${clean(question).slice(0, 600)}${context ? ` [${context}]` : ""} `
    + (draw ? `Answer here, and also record the path as a pathlight journey (pathlight flow add, as the pathlight skill says) so it appears on the map and F walks it. ` : "")
    + `If this asks you to change the code, before editing any file run pathlight plan ${id} with the ids of whatever else the change will reach, and add a #planned element with its mapping for anything new; run pathlight plan with no ids when done.`;
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
    target.files.length ? `files: ${target.files.slice(0, 6).map(clean).join(", ")}` : "",
    target.links.length ? `connects: ${target.links.slice(0, 6).map(clean).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `Improve the pathlight map for the "${clean(target.title)}" component (${clean(target.id)}): ${clean(request).slice(0, 600)} [${context}] `
    + `Read the files, answer me here, then set its name and note in .pathlight/pathlight.overlay.json with "by":"agent" and run pathlight draft. Never change an entry marked "by":"human". `
    + `If it should be merged or split, tell me and wait for my yes before editing.`;
}

/**
 * A request to trace how something works and record it as a journey. It carries what the viewer already knows (the component, its files and
 * connections) and the rules the agent follows: read the code, decide, then write it down with `pathlight flow add`, which checks it against the model.
 * It is the tracer's brief: handing it to a tracer is the skill's instruction to the conversation, never a sentence here (tracers read it as theirs).
 */
export function flowMessage(target: { title: string; id: string; files: readonly string[]; links: readonly string[] }, request: string) {
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const context = [
    target.files.length ? `files: ${target.files.slice(0, 6).map(clean).join(", ")}` : "",
    target.links.length ? `connects: ${target.links.slice(0, 6).map(clean).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `Trace how this works in the "${clean(target.title)}" component (${clean(target.id)}) and record it as a pathlight journey: ${clean(request).slice(0, 600)}${context ? ` [${context}]` : ""} `
    + `Follow the pathlight-behavior skill: read the code from this component outward, confirm each hop in a file, then run pathlight flow add with the files you read and one --step per hop between components in the model (a hop you confirmed over HTTP, a websocket or a spawned process is written FROM -> TO over http: EVENT). `
    + `Leave out any hop you cannot point to in the code and tell me what you could not find. Do not change product code.`;
}
