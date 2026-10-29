import { fg, type RGBA, StyledText, type createCliRenderer } from "@opentui/core";
import { Effect } from "effect";
import { askMessage, flowMessage, isHowQuestion, mapMessage, sendToPane } from "../ask";
import type { Message } from "../conversation";
import { readEntry, readKeys, saveElement } from "../edit";
import { borderHints, palette } from "../ui";
import { hints } from "./keys";
import { type TalkState, type TalkTab, talkContent, talkHeader, talkHint, talkIncludeLine, talkTabs, talkTabsLine } from "./talk-view";
import { nl, spinAt } from "./text";
import type { createWidgets } from "./widgets";

/** What the talk needs of a node. */
export interface AskTarget { id: unknown; title: string; modelRef?: unknown }
type Widgets = ReturnType<typeof createWidgets>;

/** What the conversation shows when the talk draws: the messages read from the host's file, why there are none, and what the agent is doing. */
export interface TalkConversation { messages: readonly Message[]; empty: string; state: TalkState }

/**
 * The talk, the column's second face: `t` asks a question or tells the agent what to change, `m` asks it to improve the map, `d` to trace a flow.
 * The first request of a talk carries the selected box's context exactly as `src/ask.ts` builds it (the tabs and toggles show until then); every
 * later one is the typed text alone. Both are typed into the agent's own pane and submitted there, and the agent's replies are read back from the
 * host's conversation file by the viewer. After a send the keys go back to the diagram and the talk stays showing; a reply never moves anything.
 * `n` is the person's own name and note for a box, in a modal (two steps, no agent). Map editing needs the element's overlay key, which
 * `pathlight draft` records; a hand-written model has none.
 */
export function createAskDialog<Target extends AskTarget>(options: {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>; widgets: Pick<Widgets, "talk" | "naming" | "nameInput" | "namePrompt" | "nameRow" | "nameColumns">; workspace: string; parent: string | undefined;
  selected: () => Target | undefined; context: (target: Target) => { files: string[]; links: string[]; activity: string[] }; relevant: (target: Target) => Effect.Effect<string[]>;
  live: () => { bound: boolean; label: string }; conversation: () => TalkConversation;
  say: (message: string) => void; update: () => void; run: (effect: Effect.Effect<void>) => unknown; opening: () => void;
  /** A request went to the agent; `drawing` when it asks for a journey to be recorded (`t` with `draw it`, or `d`). */
  asked: (drawing: boolean) => void; background: RGBA;
}) {
  const { renderer, workspace } = options, { talk, naming, nameInput, namePrompt, nameRow, nameColumns } = options.widgets;
  const tell = (message: string) => { options.say(message); options.update(); };
  // A talk exists from `t`, `m` or `d` until Esc closes it; `fresh` until its first request is sent (the tabs and toggles show until then).
  let current: { tab: TalkTab; fresh: boolean } | undefined;
  let showing = false, wide = false, focus: "field" | "toggles" | "none" = "none", toggle = 0, replied = false;
  // What to send with a question: files, connections, activity, and whether to draw the answer. `draw it` follows the question (on for a
  // how-question) until the user flips it. `offered` is the first question, shown as the placeholder and sent by Enter alone.
  const include = [true, true, false, false];
  let drawFlipped: boolean | undefined, offered = "", keys = new Map<string, string>();
  let tabSpans: { from: number; to: number }[] = [], includeSpans: { from: number; to: number }[] = [];
  const typedOrOffered = () => talk.input.plainText.trim() || (current?.fresh ? offered : "");
  const drawing = () => drawFlipped ?? isHowQuestion(typedOrOffered());
  const keyOf = (target: Target | undefined) => target ? keys.get(String(target.modelRef ?? "")) ?? keys.get(String(target.id)) : undefined;
  const placeholders: Record<TalkTab, string> = { ask: "Ask how something works, or tell it what to change", map: "What should it work out, or what should it be called?",
    flow: "What should it trace? (for example: what happens when someone places an order)" };

  /** The talk's rows, drawn for the column as it is now: `width` is the room inside it, `height` its rows. */
  const render = (width: number, height: number) => {
    for (const widget of [talk.head, talk.scroll, talk.rule, talk.row, talk.hint]) widget.visible = showing;
    talk.tabs.visible = talk.include.visible = showing && Boolean(current?.fresh);
    if (!showing || !current) return;
    const target = options.selected(), conversation = options.conversation(), live = options.live();
    talk.head.content = talkHeader({ subject: target?.title, state: conversation.state, spin: spinAt(Date.now()), session: live.bound ? live.label : undefined, width });
    const made = talkContent(conversation.messages, { width: width - 1, empty: conversation.empty });
    talk.text.content = made.content; talk.text.height = made.lines;
    const mapReady = Boolean(keyOf(target));
    if (current.fresh) {
      const tabs = talkTabsLine({ tab: current.tab, mapReady });
      talk.tabs.content = tabs.content; tabSpans = tabs.spans;
      if (current.tab === "ask") include[3] = drawing();
      const context = target ? options.context(target) : { files: [], links: [], activity: [] };
      const line = talkIncludeLine({ tab: current.tab, include, counts: [context.files.length, context.links.length, context.activity.length], focus: focus === "toggles" ? toggle : -1, mapReady, width, background: options.background });
      talk.include.content = line.content; talk.include.height = line.rows; includeSpans = line.spans;
    }
    talk.rule.content = new StyledText([fg(palette.rule)("─".repeat(Math.max(1, width)))]);
    talk.input.placeholder = current.fresh ? offered || placeholders[current.tab] : "reply…";
    talk.prompt.fg = focus === "field" ? palette.accent : palette.border;
    // Three rows, growing to a third of the column, then scrolling.
    const rows = Math.max(3, Math.min(Math.max(3, Math.floor(height / 3)), talk.input.virtualLineCount));
    if (talk.input.height !== rows) { talk.input.height = rows; talk.row.height = rows; }
    talk.hint.content = talkHint({ focused: focus === "field", toggles: focus === "toggles", fresh: current.fresh, wide, width });
  };
  const focusOn = (next: typeof focus) => {
    focus = next;
    if (next === "field") talk.input.focus(); else talk.input.blur();
    options.update();
  };
  talk.tabs.onMouseDown = event => {
    const column = event.x - talk.tabs.x, index = tabSpans.findIndex(span => column >= span.from && column < span.to);
    if (current?.fresh && index >= 0) { current.tab = talkTabs[index]!; options.update(); }
  };
  talk.include.onMouseDown = event => {
    // On two rows, the second holds only `draw it`.
    const column = event.x - talk.include.x, row = event.y - talk.include.y;
    const index = row > 0 ? includeSpans.length - 1 : includeSpans.findIndex((span, at) => at < (talk.include.height > 1 ? 3 : 4) && column >= span.from && column < span.to);
    if (current?.fresh && current.tab === "ask" && index >= 0) { flip(index); toggle = index; focusOn("toggles"); }
  };
  talk.row.onMouseDown = () => { if (showing) focusOn("field"); };
  const flip = (index: number) => { if (index === 3) drawFlipped = !drawing(); else include[index] = !include[index]; };
  // A new talk: the tabs again, the field empty, the keys in it.
  const begin = (tab: TalkTab, offer = "") => {
    current = { tab, fresh: true }; showing = true; replied = false; drawFlipped = undefined; offered = offer; toggle = 0;
    talk.input.setText(""); options.opening();
    options.run(readKeys(workspace).pipe(Effect.tap(found => Effect.sync(() => { keys = found; options.update(); })), Effect.catch(() => Effect.void)));
    options.say(""); focusOn("field");
  };
  const needsPane = (what: string) => { if (options.parent) return false; tell(`${what} needs the viewer opened with pathlight show, which knows your agent's pane`); return true; };
  // The text is made once the relevant files are known (the scan's imports are read on the first request).
  const sent = (target: Target, text: (files: string[]) => string, done: string) => options.run(options.relevant(target).pipe(
    Effect.flatMap(files => sendToPane(options.parent!, text(files), true)),
    Effect.tap(() => Effect.sync(() => tell(done))),
    Effect.catch(error => Effect.sync(() => tell(error.message)))));

  // `n`: the person's own name and note, in the modal.
  let naming_: { key: string; target: Target; step: "name" | "note"; title: string; note: string } | undefined;
  const renderName = () => {
    if (!naming_) return;
    naming.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)(naming_.step === "name" ? "Name" : "Note"), fg(palette.muted)(" ")]);
    naming.content.content = new StyledText([fg(palette.muted)("about".padEnd(8)), fg(palette.text)(naming_.target.title), fg(palette.purple)(`  ${naming_.target.id}`), nl,
      fg(palette.muted)(naming_.step === "name" ? "step 1 of 2" : "step 2 of 2 · empty clears it")]);
    namePrompt.fg = palette.accent;
    naming.foot.content = new StyledText(borderHints(hints.askSave(naming_.step === "name")));
    naming.meta.content = new StyledText([fg(palette.muted)(" ")]);
    renderer.requestRender();
  };
  const finishName = () => { naming_ = undefined; nameInput.blur(); naming.close(); options.update(); };
  naming.dismiss = finishName;

  return {
    render,
    /** Whether the column shows the talk; whether a talk exists (`i` flips to it); whether it is widened. */
    get showing() { return showing; }, get exists() { return current !== undefined; }, get wide() { return wide; },
    get fresh() { return Boolean(current?.fresh); },
    /** Where the talk's keys are: its field, the toggles, or nowhere (the diagram has them). */
    get focus() { return showing ? focus : "none" as const; },
    /** The field's cursor is on its first row: Up from there reaches the toggles. */
    get atTop() { return talk.input.visualCursor.visualRow === 0; },
    /** A reply arrived while the node face showed: the one word `replied` until the talk is shown again. */
    get replied() { return replied; },
    noteReply() { if (!showing) replied = true; },
    /** `t`: the field of the talk there is (same subject, no tabs once sent), else a new talk on its first tab, offering `offer`. */
    ask(offer = "") {
      if (needsPane("Ask")) return;
      if (current) { showing = true; replied = false; focusOn("field"); return; }
      if (options.selected()) begin("ask", offer);
    },
    /** `m` and `d` always begin a new talk on their tab. */
    map() { if (!needsPane("Changing the map") && options.selected()) begin("map"); },
    trace() { if (!needsPane("Tracing a flow") && options.selected()) begin("flow"); },
    tab(by: number) { if (current?.fresh) { current.tab = talkTabs[(talkTabs.indexOf(current.tab) + by + talkTabs.length) % talkTabs.length]!; if (focus === "toggles" && current.tab !== "ask") focus = "field"; options.update(); } },
    toToggles() { if (current?.fresh && current.tab === "ask") focusOn("toggles"); },
    toField() { focusOn("field"); },
    choose(by: number) { toggle = (toggle + by) % include.length; options.update(); },
    toggle() { flip(toggle); options.update(); },
    /** Esc in the field hands the keys to the diagram; the talk stays showing. */
    blur() { focusOn("none"); },
    /** Esc with the keys on the diagram: a widened talk narrows, else the talk closes and the node face returns. */
    back() { if (wide) { wide = false; options.update(); return; } current = undefined; showing = false; focusOn("none"); },
    /** `i` with a talk: between the node face and the talk, keeping it. */
    flip() { showing = !showing; if (showing) replied = false; focusOn("none"); },
    widen() { if (showing) { wide = !wide; options.update(); } else tell("z widens the talk: t, m or d opens it"); },
    scroll(by: number) { talk.scroll.scrollBy(by * Math.max(1, talk.scroll.viewport.height - 1)); },
    /** The question typed so far changed: `draw it` may follow it. */
    typed() { options.update(); },
    /** Enter in the field: the first request with its context, or the typed text alone. An empty field sends nothing (the offered question counts). */
    send() {
      const target = options.selected(), parent = options.parent, text = typedOrOffered();
      if (!current || !parent || !text) return;
      if (!current.fresh) {
        const typed = talk.input.plainText;
        talk.input.setText(""); focusOn("none");
        options.run(sendToPane(parent, typed, true).pipe(Effect.tap(() => Effect.sync(() => tell("Sent to the agent pane · the reply shows here"))),
          Effect.catch(error => Effect.sync(() => tell(error.message)))));
        return;
      }
      if (!target) return;
      const context = options.context(target), tab = current.tab;
      if (tab === "map") {
        // The keys are read again here: Enter can come before the read the talk started when it opened.
        const talking = current;
        options.run(readKeys(workspace).pipe(Effect.catch(() => Effect.succeed(keys)), Effect.flatMap(found => Effect.sync(() => {
          keys = found;
          const key = keyOf(target);
          if (!key) { tell("Only a model made by pathlight draft can be edited here; edit your model file instead"); return; }
          talking.fresh = false; talk.input.setText(""); focusOn("none");
          sent(target, files => mapMessage({ title: target.title, id: String(target.id), key, files, links: context.links }, text), `Asked the agent to improve ${target.title} · the reply shows here`);
        }))));
        return;
      }
      if (tab === "flow") {
        current.fresh = false; talk.input.setText(""); focusOn("none"); options.asked(true);
        sent(target, files => flowMessage({ title: target.title, id: String(target.id), files, links: context.links }, text), `Asked the agent to trace a flow from ${target.title} · F shows it once it is written`);
        return;
      }
      const [withFiles, withLinks, withActivity] = include, draw = drawing();
      const live = options.live(), session = live.bound ? live.label : "the agent";
      current.fresh = false; talk.input.setText(""); focusOn("none"); options.asked(draw);
      sent(target, files => askMessage({ title: target.title, id: String(target.id), files: withFiles ? files : [], links: withLinks ? context.links : [], activity: withActivity ? context.activity : [] }, text, draw),
        `Asked ${session} about ${target.title} · ${live.bound ? "the reply shows here" : "reply lands in the agent pane"}${draw ? " · F shows the path once it is recorded" : ""}`);
    },
    get naming() { return naming_ !== undefined; },
    beginName() {
      const target = options.selected();
      if (!target) return;
      options.run(readKeys(workspace).pipe(Effect.flatMap(found => {
        const key = found.get(String(target.modelRef ?? "")) ?? found.get(String(target.id));
        if (!key) return Effect.sync(() => tell("Only a model made by pathlight draft can be edited here; edit your model file instead"));
        return readEntry(workspace, key).pipe(Effect.flatMap(entry => Effect.sync(() => {
          naming_ = { key, target, step: "name", title: target.title, note: entry?.note ?? "" };
          options.opening();
          nameInput.placeholder = "Name"; nameInput.setText(entry?.title ?? target.title); nameInput.gotoBufferEnd(); nameInput.height = 3; nameRow.height = 3;
          naming.open(nameColumns(), 6); nameInput.focus(); renderName(); options.say(""); options.update();
        })));
      }), Effect.catch(error => Effect.sync(() => tell(error.message)))));
    },
    finishName,
    /** Enter in the naming modal: the name, then the note, then saved as the person's own. */
    nameNext() {
      if (!naming_) return;
      const text = nameInput.plainText.trim();
      if (naming_.step === "name") {
        naming_.title = text; naming_.step = "note";
        nameInput.setText(naming_.note); nameInput.gotoBufferEnd(); nameInput.placeholder = "A line about what it is for"; renderName(); return;
      }
      const { key, title, target } = naming_, generated = target.title;
      finishName(); tell("Saving the name and rebuilding the map…");
      options.run(saveElement(workspace, key, { title, note: text }, generated).pipe(
        Effect.tap(() => Effect.sync(() => tell("Saved as yours · the map is rebuilding"))),
        Effect.catch(error => Effect.sync(() => tell(error.message)))));
    },
  };
}
