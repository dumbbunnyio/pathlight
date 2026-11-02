import { bg, bold, fg, StyledText, type TextChunk } from "@opentui/core";
import type { Message } from "../conversation";
import { keyName, palette } from "../ui";
import { clip, nl, wrapWords } from "./text";

/** The talk's three kinds of request, in the order its tabs stand. */
export type TalkTab = "ask" | "map" | "flow";
export const talkTabs: readonly TalkTab[] = ["ask", "map", "flow"];
const tabNames: Record<TalkTab, string> = { ask: "Ask", map: "Improve the map", flow: "Trace a journey" };

/** What the talk's state line can say; `undefined` says nothing (idle for long, or no session). */
export type TalkState = "working" | "waiting" | "done" | undefined;

/** A time as the person's clock shows it. */
export const clock = (at: number) => { const date = new Date(at); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };

/** Words wrapped to `room`, a word longer than the room cut across lines (a path or a link must not run off the column). */
const wrap = (text: string, room: number) => wrapWords(text, room).flatMap(line => line.length <= room ? [line] : line.match(new RegExp(`.{1,${Math.max(1, room)}}`, "g")) ?? [line]);

/**
 * The host's text, lightly: paragraphs wrapped on words, list items kept with a hanging indent, fenced code indented on the dimmer background and
 * never wrapped, `#` headings bold. Nothing else is interpreted (inline code, emphasis and links stay as written).
 */
export const renderText = (text: string, width: number): TextChunk[][] => {
  const lines: TextChunk[][] = [];
  let fence = false, blank = false;
  const push = (line: TextChunk[]) => { lines.push(line); blank = false; };
  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) { push([bg(palette.background)(fg(palette.body)(clip(`  ${raw}`, width).padEnd(width)))]); continue; }
    if (!raw.trim()) { if (lines.length && !blank) { lines.push([]); blank = true; } continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim());
    if (heading) { for (const line of wrap(heading[1]!, width)) push([bold(fg(palette.text)(line))]); continue; }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const lead = `${item[1]!.slice(0, 6)}${item[2]} `;
      wrap(item[3]!, Math.max(8, width - lead.length)).forEach((line, index) => push([fg(palette.body)(`${index ? " ".repeat(lead.length) : lead}${line}`)]));
      continue;
    }
    for (const line of wrap(raw.trim(), width)) push([fg(palette.body)(line)]);
  }
  while (lines.length && !lines.at(-1)!.length) lines.pop();
  return lines;
};

/**
 * The conversation as the talk shows it: each message under `you · 12:04` or `agent · 12:04`, a blank row apart, oldest first, so the newest is at the bottom;
 * the person's own words stand apart, `you` in the accent color and the text one column in; `agent` is in the agent's color (the one journeys and
 * `← agent` use), its text at the left edge. With
 * nothing to show, one dim line saying why (`empty`), and nothing invented.
 */
export const talkContent = (messages: readonly Message[], options: { width: number; empty: string }) => {
  const width = Math.max(10, options.width);
  if (!messages.length) { const lines = wrapWords(options.empty, width); return { content: new StyledText([fg(palette.muted)(lines.join("\n"))]), lines: lines.length }; }
  const rows: TextChunk[][] = [];
  for (const message of messages) {
    // A blank row between messages: a code block or a list must not run into the next one's label.
    if (rows.length) rows.push([]);
    const yours = message.role === "you";
    rows.push([fg(yours ? palette.accent : palette.purple)(message.role), fg(palette.border)(` · ${clock(message.at)}`)]);
    rows.push(...(yours ? renderText(message.text, width - 1).map(row => [fg(palette.body)(" "), ...row]) : renderText(message.text, width)));
  }
  return { content: new StyledText(rows.flatMap((row, index) => [...index ? [nl] : [], ...row])), lines: rows.length };
};

/** The talk's first line: whom the next request is about, and at the right what the agent is doing, else which session it is. */
export const talkHeader = (options: { subject: string | undefined; state: TalkState; spin: string; session: string | undefined; width: number }) => {
  const right = options.state === "working" ? `working ${options.spin}` : options.state === "waiting" ? "waiting for you in its pane" : options.state === "done" ? "done"
    : options.session ? `● ${options.session}` : "○ no session";
  const tone = options.state === "working" ? palette.accent : options.state === "waiting" ? palette.outgoing : options.state === "done" ? palette.muted
    : options.session ? palette.incoming : palette.border;
  const left = clip(`Talk · ${options.subject ?? "nothing selected"}`, Math.max(6, options.width - right.length - 2));
  return new StyledText([fg(palette.text)("Talk"), fg(palette.muted)(left.slice(4)), fg(palette.muted)(" ".repeat(Math.max(1, options.width - left.length - right.length))), fg(tone)(right)]);
};

/** The tabs, shown until the talk's first request is sent: the one chosen in the text colour, the others muted, the map's dimmer when the box has no overlay key. */
export const talkTabsLine = (options: { tab: TalkTab; mapReady: boolean }) => {
  const chunks: TextChunk[] = [];
  const spans: { from: number; to: number }[] = [];
  let column = 0;
  talkTabs.forEach((tab, index) => {
    if (index) { chunks.push(fg(palette.muted)("   ")); column += 3; }
    const name = tabNames[tab];
    chunks.push(fg(tab === options.tab ? palette.text : tab === "map" && !options.mapReady ? palette.border : palette.muted)(name));
    spans.push({ from: column, to: column + name.length });
    column += name.length;
  });
  return { content: new StyledText(chunks), spans };
};

/**
 * Under the tabs: for a question, whom it is about, and ` · records a journey` while it will be drawn (a how-question), the one thing it writes;
 * for the map and the trace, one line on what the agent will do.
 */
export const talkIncludeLine = (options: { tab: TalkTab; subject: string | undefined; drawing: boolean; mapReady: boolean; width: number }) => {
  const width = Math.max(10, options.width);
  if (options.tab !== "ask") {
    const text = options.tab === "map" ? options.mapReady ? "it reads the files, then edits the overlay" : "needs a map drawn by pathlight draft"
      : "it reads the code, then records a journey you can trace with F";
    const lines = wrapWords(text, width);
    return { content: new StyledText([fg(palette.muted)(lines.join("\n"))]), rows: lines.length };
  }
  // `▸ about Agent adapters · records a journey`: the glyph and `about` muted, the box's title in the body color, the tail muted.
  const tail = options.drawing ? " · records a journey" : "", lead = "▸ about ";
  const subject = clip(options.subject ?? "nothing selected", Math.max(1, width - lead.length - tail.length));
  return { content: new StyledText([fg(palette.muted)(lead), fg(options.subject ? palette.body : palette.muted)(subject), ...(tail ? [fg(palette.muted)(tail)] : [])]), rows: 1 };
};

/** The last line of the talk: the keys that matter where the keys are. */
export const talkHint = (options: { focused: boolean; fresh: boolean; wide: boolean; width: number }) => {
  const keys: [string, string][] = options.focused ? [["enter", "send"], ["alt+enter", "line"], ...(options.fresh ? [["tab", "kind"]] as [string, string][] : []), ["esc", "diagram"]]
    : [["t", "reply"], ["z", options.wide ? "narrower" : "wider"], ["i", "node"], [keyName("esc"), "close"]];
  const chunks: TextChunk[] = [];
  let used = 0;
  for (const [key, does] of keys) {
    const size = key.length + 1 + does.length + 3;
    if (used + size > options.width + 3) break;
    chunks.push(fg(palette.body)(key), fg(palette.muted)(` ${does}   `));
    used += size;
  }
  return new StyledText(chunks);
};
