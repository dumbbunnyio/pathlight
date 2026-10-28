import { fg, type RGBA, StyledText, type TextChunk, type createCliRenderer } from "@opentui/core";
import { Effect } from "effect";
import { askMessage, flowMessage, mapMessage, sendToPane } from "../ask";
import { readEntry, readKeys, saveElement } from "../edit";
import { borderHints, palette } from "../ui";
import { hints } from "./keys";
import { nl } from "./text";
import type { createWidgets } from "./widgets";

/** What the dialog needs of a node. */
export interface AskTarget { id: unknown; title: string; modelRef?: unknown }
type Widgets = ReturnType<typeof createWidgets>;

/**
 * The dialog for asking the agent about a node, typed with the component's context into the agent's own tmux pane: `t` asks a question (with
 * files, connections and activity as toggles, Tab moving between the question and them); `m` asks the agent to improve the map; `d` to trace a
 * flow; `n` is the person's own name and note (two steps, no agent). Map editing needs the element's overlay key, which `pathlight draft`
 * records; a hand-written model has none.
 */
export function createAskDialog<Target extends AskTarget>(options: {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>; widgets: Pick<Widgets, "ask" | "askInput" | "askPrompt" | "askRow">; workspace: string; parent: string | undefined;
  selected: () => Target | undefined; context: (target: Target) => { files: string[]; links: string[]; activity: string[] }; live: () => { bound: boolean; label: string };
  say: (message: string) => void; update: () => void; run: (effect: Effect.Effect<void>) => unknown; opening: () => void; background: RGBA;
}) {
  const { renderer, workspace } = options, { ask, askInput, askPrompt, askRow } = options.widgets;
  const tell = (message: string) => { options.say(message); options.update(); };
  let asking: Target | undefined;
  // What to send with the question: files, connections, activity.
  const include = [true, true, false];
  let mode: "ask" | "map" | "flow" | "name" | "note" = "ask", editKey = "", editTitle = "", noteDraft = "";
  let focus = -1, spans: { from: number; to: number }[] = [];
  const render = () => {
    if (!asking) return;
    if (mode !== "ask") {
      const names = { map: "Ask the agent to improve the map", flow: "Ask the agent to trace a flow", name: "Name", note: "Note" } as const;
      ask.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)(names[mode]), fg(palette.muted)(" ")]);
      ask.content.content = new StyledText([fg(palette.muted)("about".padEnd(8)), fg(palette.text)(asking.title), fg(palette.purple)(`  ${asking.id}`), nl, fg(palette.muted)(mode === "map" ? "it reads the files, then edits the overlay" : mode === "flow" ? "it reads the code, then records a journey you can trace with F" : mode === "name" ? "step 1 of 2" : "step 2 of 2 · empty clears it")]);
      askPrompt.fg = palette.accent;
      ask.foot.content = new StyledText(borderHints(mode === "map" || mode === "flow" ? hints.askSend : hints.askSave(mode === "name")));
      ask.meta.content = new StyledText([fg(palette.muted)(" ")]);
      renderer.requestRender();
      return;
    }
    ask.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)("Ask the agent"), fg(palette.muted)(" ")]);
    const context = options.context(asking), counts = [context.files.length, context.links.length, context.activity.length], names = ["files", "connections", "activity"];
    const chunks: TextChunk[] = [fg(palette.muted)("about".padEnd(8)), fg(palette.text)(asking.title), fg(palette.purple)(`  ${asking.id}`), nl, fg(palette.muted)("include".padEnd(8))];
    let column = 8;
    spans = [];
    names.forEach((name, index) => {
      const on = include[index], focused = focus === index;
      const paint = (chunk: TextChunk) => focused ? { ...chunk, bg: options.background } : chunk;
      const text = `${on ? "●" : "○"} ${name} ${counts[index]}`;
      if (index) { chunks.push(fg(palette.muted)("   ")); column += 3; }
      chunks.push(paint(fg(on ? palette.accent : palette.border)(on ? "● " : "○ ")), paint(fg(on ? palette.body : palette.border)(`${name} `)), paint(fg(palette.border)(String(counts[index]))));
      spans.push({ from: column, to: column + text.length });
      column += text.length;
    });
    ask.content.content = new StyledText(chunks);
    askPrompt.fg = focus < 0 ? palette.accent : palette.border;
    ask.foot.content = new StyledText(borderHints(focus < 0 ? hints.askQuestion : hints.askContext));
    const live = options.live();
    ask.meta.content = new StyledText([fg(live.bound ? palette.incoming : palette.muted)(" ● "), fg(palette.border)(`${live.label} `)]);
    renderer.requestRender();
  };
  const focusOn = (index: number) => { focus = index; if (index < 0) askInput.focus(); else askInput.blur(); render(); };
  ask.content.onMouseDown = event => {
    const column = event.x - ask.content.x;
    if (event.y - ask.content.y !== 1) return;
    const index = spans.findIndex(span => column >= span.from && column < span.to);
    if (index >= 0) { include[index] = !include[index]; focusOn(index); }
  };
  const open = (target: Target, next: typeof mode, text: string, placeholder: string) => {
    asking = target; mode = next; options.opening();
    askInput.placeholder = placeholder;
    askInput.setText(text); askInput.gotoBufferEnd(); askInput.height = 1; askRow.height = 3;
    ask.open(Math.min(76, renderer.width - 4), 10);
    focusOn(-1); options.say(""); options.update();
  };
  const withKey = (target: Target, then: (key: string) => Effect.Effect<void>) =>
    options.run(readKeys(workspace).pipe(
      Effect.flatMap(keys => {
        const key = keys.get(String(target.modelRef ?? "")) ?? keys.get(String(target.id));
        return key ? then(key) : Effect.sync(() => tell("Only a model made by pathlight draft can be edited here; edit your model file instead"));
      }),
      Effect.catch(() => Effect.void)));
  const finish = () => { asking = undefined; mode = "ask"; askInput.blur(); ask.close(); options.update(); };
  const sent = (text: string, done: string) => options.run(sendToPane(options.parent!, text, true).pipe(
    Effect.tap(() => Effect.sync(() => tell(done))),
    Effect.catch(error => Effect.sync(() => tell(error.message)))));
  ask.dismiss = finish;
  return {
    get asking() { return asking; },
    get focus() { return focus; },
    finish,
    tab() { if (mode === "ask") focusOn(focus < 0 ? 0 : -1); },
    choose(by: number) { focusOn((focus + by) % 3); },
    toggle() { include[focus] = !include[focus]; render(); },
    beginAsk() {
      if (!options.parent) { tell("Ask needs the viewer opened with pathlight show, which knows your agent's pane"); return; }
      const target = options.selected();
      if (target) open(target, "ask", "", "What do you want to know about it?");
    },
    beginMap() {
      if (!options.parent) { tell("Changing the map needs the viewer opened with pathlight show, which knows your agent's pane"); return; }
      const target = options.selected();
      if (target) withKey(target, key => Effect.sync(() => { editKey = key; open(target, "map", "", "What should it work out, or what should it be called?"); }));
    },
    beginFlow() {
      if (!options.parent) { tell("Tracing a flow needs the viewer opened with pathlight show, which knows your agent's pane"); return; }
      const target = options.selected();
      if (target) open(target, "flow", "", "What should it trace? (for example: what happens when someone places an order)");
    },
    beginName() {
      const target = options.selected();
      if (target) withKey(target, key => readEntry(workspace, key).pipe(Effect.flatMap(entry => Effect.sync(() => {
        editKey = key; editTitle = target.title; noteDraft = entry?.note ?? "";
        open(target, "name", entry?.title ?? target.title, "Name");
      })), Effect.catch(error => Effect.sync(() => tell(error.message)))));
    },
    /** The question and the chosen context go to the agent's pane and are submitted there; an empty question sends nothing. */
    send() {
      const target = asking, parent = options.parent, question = askInput.plainText.trim();
      if (target && mode === "name") { editTitle = question; mode = "note"; askInput.setText(noteDraft); askInput.gotoBufferEnd(); askInput.placeholder = "A line about what it is for"; render(); return; }
      if (target && mode === "note") {
        const key = editKey, entry = { title: editTitle, note: question }, generated = target.title;
        finish(); tell("Saving the name and rebuilding the map…");
        options.run(saveElement(workspace, key, entry, generated).pipe(
          Effect.tap(() => Effect.sync(() => tell("Saved as yours · the map is rebuilding"))),
          Effect.catch(error => Effect.sync(() => tell(error.message)))));
        return;
      }
      if (!target || !parent || !question) return;
      const context = options.context(target);
      if (mode === "flow") {
        const text = flowMessage({ title: target.title, id: String(target.id), files: context.files, links: context.links }, question);
        finish(); sent(text, `Asked the agent to trace a flow from ${target.title} · F shows it once it is written`);
        return;
      }
      if (mode === "map") {
        const text = mapMessage({ title: target.title, id: String(target.id), key: editKey, files: context.files, links: context.links }, question);
        finish(); sent(text, `Asked the agent to improve ${target.title} · it replies in the agent pane`);
        return;
      }
      const text = askMessage({ title: target.title, id: String(target.id), files: include[0] ? context.files : [], links: include[1] ? context.links : [], activity: include[2] ? context.activity : [] }, question);
      const live = options.live(), session = live.bound ? live.label : "the agent";
      finish(); sent(text, `Asked ${session} about ${target.title} · reply lands in the agent pane`);
    },
  };
}
