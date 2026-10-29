import { fg, type RGBA, type TextChunk } from "@opentui/core";
import { type ActivityConfig, type ActivityEvent, activityRows, formatAge } from "../activity";
import { palette } from "../ui";
import { nl, spinAt } from "./text";

/** A call is running if it started and has not been heard from for at most 30 s; after that it is unconfirmed, not running. */
export const isActive = (event: ActivityEvent) => event.phase === "started" && Date.now() - event.time <= 30_000;

/** What a node's mapped activity is doing right now: a running tool, or how a call that just ended finished. */
export const operationState = (active: ActivityEvent[], recent: ActivityEvent | undefined) => active.length ? active.some(event => event.operation === "edit") ? "edit" : active.some(event => event.operation === "read") ? "read" : "run"
  : recent?.phase === "failed" ? "failed" : recent?.phase === "completed" ? "done" : "";

/** How long a finished call stays on its card: long enough to notice a failure after looking away. */
export const outcomeMs = 30_000;

/** The tag in a card's top border: what a tool is doing to it now, or how the last call ended. Journal facts only: `done` is not `passing`. */
export const cardTag = (related: ActivityEvent[], now: number): { text: string; color: string } | undefined => {
  const running = related.filter(isActive);
  if (running.length) {
    if (running.some(event => event.operation === "edit")) return { text: "■ edit", color: palette.accent };
    if (running.some(event => event.operation === "read")) return { text: "◦ read", color: palette.incoming };
    return { text: `▸ ${spinAt(now)}`, color: palette.command };
  }
  const newest = related[0];
  if (newest && now - newest.time <= outcomeMs) {
    if (newest.phase === "failed") return { text: "✗ failed", color: palette.failure };
    if (newest.phase === "completed") return { text: "✓ done", color: palette.green };
  }
  // A call that started and never reported: not running as far as anyone knows, and not known to have finished.
  return related.some(event => event.phase === "started" && now - event.time > 30_000 && now - event.time <= 300_000) ? { text: "~ no result", color: palette.muted } : undefined;
};

/**
 * "Now": what the selected component's own mapped files saw, newest first, three rows with repeats collapsed. The work elsewhere is the header's
 * line, `w`, `a` and `c`. With no session, no mapping or nothing observed it says so in one line.
 */
export function nowCard(options: { error: string; bound: boolean; following: boolean; config: ActivityConfig | undefined; events: ActivityEvent[]; element: string;
  width: number; now: number; flashes: ReadonlyMap<string, number>; background: RGBA }): { chunks: TextChunk[]; lines: number } {
  const note = (text: string, tone: string = palette.border) => ({ chunks: [fg(tone)(text)], lines: 1 });
  const { config, now, width } = options;
  if (options.error) return note(options.error, palette.failure);
  if (!options.bound && !options.following) return note("○ no live session · model only");
  if (!config) return note("no file mapping · run pathlight init");
  if (!options.bound) return note("waiting for a session");
  const mine = activityRows(options.events, config, now, 64).filter(row => row.elements.includes(options.element));
  if (!mine.length) return note("nothing observed here yet");
  const collapsed: { row: (typeof mine)[number]; count: number; calls: string[] }[] = [];
  for (const row of mine) {
    const same = collapsed.find(entry => entry.row.operation === row.operation && entry.row.target === row.target && entry.row.agent === row.agent);
    if (same) { same.count++; same.calls.push(row.call); } else collapsed.push({ row, count: 1, calls: [row.call] });
  }
  const chunks: TextChunk[] = [];
  const shown = collapsed.slice(0, 3);
  for (const { row, count, calls } of shown) {
    const glyph = row.state === "started" ? spinAt(now) : row.state === "completed" ? "✓" : row.state === "failed" ? "✗" : "~";
    const glyphTone = row.state === "failed" ? palette.failure : row.state === "started" ? palette.accent : row.state === "completed" ? palette.green : palette.muted;
    const op = (row.operation === "command" ? "run" : row.operation).padEnd(5);
    const first = row.paths[0]?.split("/").at(-1) ?? row.target;
    const extra = `${row.paths.length > 1 ? ` +${row.paths.length - 1}` : ""}${count > 1 ? ` ×${count}` : ""}${row.agent ? ` ·${row.agent.slice(0, 12)}` : ""}`;
    const age = formatAge(row.age);
    // Fixed grid: glyph (2) · op (5) · file + count · time, right aligned.
    const room = Math.max(4, width - 2 - 5 - age.length - 1);
    const shownFile = first.length + extra.length > room ? `${first.slice(0, Math.max(1, room - extra.length - 1))}…` : first;
    const gap = Math.max(1, width - 2 - 5 - shownFile.length - extra.length - age.length);
    const line: TextChunk[] = [fg(glyphTone)(`${glyph} `), fg(row.state === "started" ? palette.accent : palette.muted)(op), fg(palette.body)(shownFile), fg(palette.border)(extra), fg(palette.border)(`${" ".repeat(gap)}${age}`), nl];
    const flashing = calls.some(call => (options.flashes.get(call) ?? 0) > now);
    chunks.push(...(flashing ? line.map(chunk => ({ ...chunk, bg: options.background })) : line));
  }
  const earlier = collapsed.length - shown.length;
  if (earlier > 0) chunks.push(fg(palette.border)(`${earlier} earlier · `), fg(palette.muted)("c"), fg(palette.border)(" session\n"));
  return { chunks, lines: shown.length + (earlier > 0 ? 1 : 0) };
}

/**
 * The session summary (`c`): what the retained journal says the agent did, as observed counts, never a claim about outcomes. `size` is the room its
 * content needs, as columns and rows.
 */
export function sessionSummary(options: { session: string | undefined; config: ActivityConfig | undefined; events: ActivityEvent[]; elementTitle: (id: string) => string;
  screenWidth: number; ruleWidth: number; now: number }): { chunks: TextChunk[]; size: [number, number] } {
  const { config, now, elementTitle } = options;
  if (!options.session || !config) return { chunks: [fg(palette.muted)("Not bound to an agent session. Start the viewer with --follow or --session.")], size: [76, 1] };
  if (!options.events.length) return { chunks: [fg(palette.muted)("No calls recorded yet.")], size: [56, 1] };
  const rows = activityRows(options.events, config, now, 128);
  const width = Math.max(30, Math.floor(options.screenWidth * 0.8) - 8);
  const byComponent = new Map<string, { reads: number; edits: number; commands: number; last: number }>();
  const edited = new Map<string, { count: number; element?: string }>();
  for (const row of rows) {
    for (const element of row.elements) {
      const entry = byComponent.get(element) ?? { reads: 0, edits: 0, commands: 0, last: Infinity };
      if (row.operation === "read") entry.reads++; else if (row.operation === "edit") entry.edits++; else if (row.operation === "command") entry.commands++;
      entry.last = Math.min(entry.last, row.age);
      byComponent.set(element, entry);
    }
    if (row.operation === "edit") for (const path of row.paths) edited.set(path, { count: (edited.get(path)?.count ?? 0) + 1, element: edited.get(path)?.element ?? row.elements[0] });
  }
  const oldest = Math.max(...rows.map(row => row.age));
  const title = options.session, right = `${rows.length} calls over ${formatAge(oldest)}`;
  const chunks = [fg(palette.text)(title), fg(palette.border)(` ${"─".repeat(Math.max(2, options.ruleWidth - title.length - right.length - 2))} `), fg(palette.muted)(right), nl, nl,
    fg(palette.muted)("components touched"), nl];
  for (const [element, entry] of [...byComponent].sort((a, b) => a[1].last - b[1].last).slice(0, 8)) {
    const name = elementTitle(element).padEnd(24).slice(0, 24);
    chunks.push(fg(palette.muted)("  ● "), fg(palette.text)(name), fg(palette.incoming)(`r${entry.reads}`.padEnd(5)), fg(palette.outgoing)(`e${entry.edits}`.padEnd(5)),
      fg(palette.command)(`c${entry.commands}`.padEnd(6)), fg(palette.muted)(formatAge(entry.last)), nl);
  }
  if (!byComponent.size) chunks.push(fg(palette.muted)("  none mapped"), nl);
  chunks.push(nl, fg(palette.muted)("files edited"), nl);
  const files = [...edited].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  for (const [path, info] of files) {
    const room = width - 30;
    chunks.push(fg(palette.outgoing)("  ■ "), fg(info.element ? palette.text : palette.failure)((path.length > room ? `…${path.slice(-(room - 1))}` : path).padEnd(Math.min(room, 40))),
      fg(palette.muted)(`×${info.count}  ${info.element ? elementTitle(info.element) : "not in the model"}`), nl);
  }
  if (!files.length) chunks.push(fg(palette.muted)("  no edits observed"), nl);
  chunks.push(nl, fg(palette.border)("Counts come from the retained calls, not totals. Commands show files they name."));
  return { chunks, size: [Math.min(96, options.screenWidth - 10), chunks.filter(chunk => chunk.text.includes("\n")).length + 1] };
}

/** The header's one activity line: "now" while a tool runs, "last" once it has an outcome, then what it did, to which file, in which component. */
export function ticker(config: ActivityConfig | undefined, events: ActivityEvent[], elementTitle: (id: string) => string, now: number): TextChunk[] | undefined {
  if (!config) return undefined;
  const [row] = activityRows(events, config, now, 1);
  if (!row || row.age > 120_000) return undefined;
  const running = row.state === "started";
  const verb = row.operation === "command" ? "run" : row.operation;
  const glyph = running ? (row.operation === "edit" ? "■" : row.operation === "read" ? "◦" : spinAt(now)) : row.state === "completed" ? "✓" : row.state === "failed" ? "✗" : "~";
  const tone = row.state === "failed" ? palette.failure : running ? (row.operation === "edit" ? palette.accent : row.operation === "read" ? palette.incoming : palette.command) : row.state === "completed" ? palette.green : palette.muted;
  const outcome = row.state === "failed" ? " failed" : row.state === "unconfirmed" ? ", no result" : "";
  return [fg(palette.border)(running ? "now  " : "last "), fg(tone)(`${glyph} `), fg(running ? tone : palette.body)(verb), fg(palette.body)(` ${row.target}`), fg(row.state === "failed" ? palette.failure : palette.muted)(outcome), fg(palette.muted)(" "),
    ...(row.agent ? [fg(palette.muted)(`[${row.agent.slice(0, 16)}] `)] : []),
    ...(row.elements.length ? [fg(palette.border)("in "), fg(palette.body)(row.elements.map(elementTitle).join(", ")), fg(palette.muted)(" ")] : []), fg(palette.border)(running && row.age < 1000 ? "" : formatAge(row.age))];
}
