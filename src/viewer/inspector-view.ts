import { fg, type RGBA, StyledText, type TextChunk } from "@opentui/core";
import { palette } from "../ui";
import { clip, describe, nl, wrapWords } from "./text";
import { type SectionKey, sectionOrder } from "./widgets";

/**
 * A drafted element's description is the note (when there is one) and the scan's counts, joined with ` · `. The two are kinds of truth that must
 * not read as one paragraph: the note is the agent's or a person's reading, the counts are what the scan found. A description that is not the
 * draft's shape (a model a person wrote) is all words.
 */
export const splitDescription = (description: string, note: string | undefined) => {
  if (note && description.startsWith(`${note} · `)) return { words: note, counts: description.slice(note.length + 3) };
  if (note && description === note) return { words: note, counts: "" };
  const counts = /^(?:[^\s:]+: )?(?:\d[\d,]* (?:[A-Z][\w#+-]* )?(?:files?|folders?)\b)/.test(description);
  return counts ? { words: "", counts: description } : { words: description, counts: "" };
};

/**
 * The one line of the scan's counts the head keeps: a caveat, when the scan read fewer of the box's files than `e` lists (`6 of 14 files read by the
 * scan`) or read none of them because of their language (`5 Go files not read by the scan`). File and line counts are not shown: `e files N` says
 * the count, and lines of code tell a reader nothing about a box. A package's name before the counts is left out.
 */
export const caveatLine = (counts: string, mapped: number) => {
  const text = counts.replace(/^[^\s:]+: (?=\d)/, "");
  const plain = /^(\d[\d,]*) files?, /.exec(text);
  if (plain) { const read = Number(plain[1]!.replace(/,/g, "")); return mapped && read < mapped ? `${plain[1]} of ${mapped} files read by the scan` : ""; }
  const language = /^(\d[\d,]*) ([A-Z][\w#+-]*) files?, .*not read by the scan/.exec(text);
  return language ? `${language[1]} ${language[2]} ${language[1] === "1" ? "file" : "files"} not read by the scan` : "";
};

/**
 * The inspector's head for a selection: its name on one row (with `agent` on the right when the agent wrote its name and note), then the words
 * about it in the body colour, then at most one dim caveat line from the scan, then what `o` opens drawn as an action. No kind word and no counts.
 * Wrapped on words. With nothing selected it says what the app is (`app`: the note of the box the view is about, else the model's first top-level
 * box) under `No selection`.
 */
export const headContent = (options: { title: string | undefined; by?: "agent" | "human"; technology?: string | null; planned: boolean; tags: readonly string[];
  description: unknown; note?: string; mapped: number; opens: string; width: number; app?: string }) => {
  const { width, opens } = options;
  const titleText = options.title ?? "No selection";
  // A long title keeps the room: the agent's mark (whose reading the words are) goes before the title is cut.
  const mark = options.by === "agent" && titleText.length + "agent".length + 2 <= width ? "agent" : "";
  const titleShown = clip(titleText, width);
  const title = new StyledText([fg(palette.text)(titleShown), fg(palette.muted)(mark ? `${" ".repeat(Math.max(1, width - titleShown.length - mark.length))}${mark}` : "")]);
  const what = [options.technology, options.planned ? "planned: no files yet" : "", ...options.tags.filter(tag => tag === "bug" || tag === "fixed")].filter(Boolean).join(" · ");
  const { words, counts } = options.title === undefined ? { words: options.app ?? "", counts: "" } : splitDescription(describe(options.description), options.note);
  const caveat = counts ? caveatLine(counts, options.mapped) : "";
  // `o opens X` is an action, drawn as `e files 3` is: the key in the body colour.
  const action = (line: string): TextChunk[] => line.startsWith("o opens ") ? [fg(palette.body)("o"), fg(palette.muted)(line.slice(1))] : [fg(palette.muted)(line)];
  const lines: TextChunk[][] = [...(words ? wrapWords(words, width).map(line => [fg(palette.body)(line)]) : []),
    ...(caveat ? wrapWords(caveat, width).map(line => [fg(palette.muted)(line)]) : []),
    ...opens.split("\n").filter(Boolean).flatMap(text => wrapWords(text, width).map((line, index) => index ? [fg(palette.muted)(line)] : action(line)))];
  const about = new StyledText(lines.flatMap((entry, index) => [...(index ? [nl] : []), ...entry]));
  return { title, what: new StyledText([fg(palette.muted)(what || " ")]), hasWhat: what !== "", about, hasAbout: lines.length > 0,
    rows: 1 + (what ? 1 : 0) + lines.length };
};

/**
 * The muted line under a box whose children this view draws and that also opens a view: Enter goes into the children, `o` opens the view. Only
 * then: on a leaf the two keys do the same, and the line would be noise.
 */
export const opensLine = (title: string) => `o opens ${title}`;

/**
 * The muted line under a box that opens a view: how many smaller boxes that view leaves out, when the draft's description of it says so (`7 smaller
 * ones are not shown here; …`), since a view's own description is never shown. Nothing when it leaves none out.
 */
/** An element the mapping names as planned and that has no files yet (nor does anything inside it): designed, not built. */
export const isWaiting = (planned: readonly string[], files: ReadonlyMap<string, readonly string[]>, ref: string) =>
  planned.some(id => ref === id || ref.startsWith(`${id}.`))
    && !(files.get(ref)?.length) && ![...files].some(([element, paths]) => element.startsWith(`${ref}.`) && paths.length);

/** With nothing selected the head says what the app is: the note of the box the view is about, else of the model's first top-level box. */
export const appNoteOf = (all: readonly { modelRef?: unknown; description?: unknown }[], viewOf: unknown, notes: ReadonlyMap<string, { note?: string | undefined }>) => {
  const subject = viewOf !== undefined ? String(viewOf) : all.map(node => String(node.modelRef ?? "")).find(ref => ref && !ref.includes("."));
  if (!subject) return "";
  const node = all.find(entry => String(entry.modelRef) === subject);
  return notes.get(subject)?.note ?? (node ? splitDescription(describe(node.description), undefined).words : "");
};

/**
 * What the head says a selected box opens: `o opens X` when its children are drawn here and it also opens a view, then how many boxes that view
 * leaves out. Nothing for a box that opens no view, or only this one.
 */
export const opensOf = (selected: { navigateTo?: unknown; children: readonly unknown[] } | undefined, diagram: { id: unknown; nodes: readonly { id: unknown }[] },
  target: { title?: unknown; description?: unknown } | undefined) => {
  const linked = selected?.navigateTo && String(selected.navigateTo) !== String(diagram.id);
  const both = linked && selected.children.some(child => diagram.nodes.some(node => node.id === child));
  return [both ? opensLine(String(target?.title ?? selected.navigateTo)) : "", linked ? hiddenLine(describe(target?.description)) : ""].filter(Boolean).join("\n");
};

export const hiddenLine = (viewDescription: string) => {
  const hidden = /\b(\d[\d,]*) smaller ones? (?:is|are) not shown\b/.exec(viewDescription)?.[1];
  return hidden ? `${hidden} smaller ${hidden === "1" ? "box is" : "boxes are"} not drawn in its view` : "";
};

/** Each card's share of the inspector, as `layoutSections` applies it. */
export interface Allotment { visible: boolean; height: number; marginTop: number; contentVisible: boolean; bodyRows: number }

/**
 * Every open card gets what its content needs, capped at a fair share; whatever a short card leaves over goes to the long ones. When the inspector is
 * too short for every open card, cards fold automatically (never ones the user touched); with a session attached the work is what is being watched,
 * so activity is the last card to fold.
 */
export const allotSections = (options: { total: number; headRows: number; shown: readonly SectionKey[]; open: (key: SectionKey) => boolean; contentRows: Record<SectionKey, number>; touched: ReadonlySet<SectionKey>; watching: boolean }) => {
  const { total, headRows, shown: order, contentRows, touched } = options;
  const autoFolded = new Set<SectionKey>();
  let active = order.filter(options.open);
  const wants = (key: SectionKey) => 1 + Math.max(1, contentRows[key]);
  const allot = (keys: SectionKey[], compact: boolean) => {
    const closed = order.length - keys.length;
    let remaining = total - headRows - (compact ? 0 : order.length) - closed;
    const result = new Map<SectionKey, number>();
    const ordered = [...keys].sort((a, b) => wants(a) - wants(b));
    ordered.forEach((key, index) => {
      const give = Math.max(2, Math.min(wants(key), Math.floor(remaining / (ordered.length - index))));
      result.set(key, give); remaining -= give;
    });
    return { result, remaining };
  };
  for (const drop of (options.watching ? ["files", "flows", "connections", "activity"] : ["activity", "files", "flows", "connections"]) as SectionKey[]) {
    if (active.length <= 1 || [...allot(active, false).result].every(([key, rows]) => rows >= Math.min(4, wants(key)))) break;
    if (active.includes(drop) && !touched.has(drop)) { active = active.filter(key => key !== drop); autoFolded.add(drop); }
  }
  const roomy = allot(active, false);
  const compact = active.length > 0 && [...roomy.result].some(([key, rows]) => rows < Math.min(3, wants(key)));
  const plan = compact ? allot(active, true) : roomy;
  const ultra = compact && total - headRows - (order.length - active.length) < 3;
  const cards = {} as Record<SectionKey, Allotment>;
  for (const key of sectionOrder) {
    const isActive = active.includes(key), shown = order.includes(key);
    const rows = ultra ? Math.max(3, total - headRows) : plan.result.get(key) ?? 1;
    cards[key] = { visible: shown && (isActive || !ultra), height: !shown ? 0 : isActive ? rows : 1, marginTop: !shown || compact ? 0 : 1, contentVisible: isActive,
      bodyRows: Math.max(1, (isActive ? rows : 0) - 1) };
  }
  return { cards, autoFolded };
};

/**
 * A card's header: fold marker, the number that focuses it and its name, a rule, and its count on the right. The number is dim while the card is
 * folded and in the accent when it is focused.
 */
export const sectionHeader = (options: { open: boolean; focused: boolean; number: number | undefined; name: string; count: string; width: number }) => {
  const { open, focused, name, count } = options;
  const number = options.number === undefined ? "" : `${options.number} `;
  const label = `${open ? "▾" : "▸"} ${number}${name}`;
  const rule = "─".repeat(Math.max(2, options.width - 2 - label.length - count.length - 3));
  return new StyledText([fg(focused ? palette.accent : palette.border)(`${open ? "▾" : "▸"} `), fg(focused ? palette.accent : open ? palette.body : palette.muted)(number),
    fg(focused ? palette.accent : palette.body)(name), fg(palette.rule)(` ${rule} `), fg(palette.muted)(count)]);
};

/**
 * Under the cards, always the same two lines: what is one key away, then the question field. Until the user has selected something or asked once
 * (`first`), the field offers the first question itself: `how does <title> work?`, which `t` opens already typed.
 */
export const pinnedLines = (options: { width: number; files: number; session: boolean; replay: boolean; title: string | undefined; canAsk: boolean; background: RGBA }) => {
  const { width } = options;
  const action = (key: string, text: string) => [fg(palette.body)(key), fg(palette.muted)(` ${text}   `)];
  const actions = new StyledText([fg(palette.rule)("─".repeat(width)), nl,
    ...(options.files ? action("e", `files ${options.files}`) : []), ...(options.session ? action("c", "session") : []), ...(options.replay ? action("p", "replay") : [])]);
  // The question `t` offers, the same the talk's field shows as ghost text, so the line and the field agree.
  const askLabel = clip(options.title === undefined ? "ask…" : firstQuestion(options.title), width - 6);
  const ask = new StyledText([fg(palette.accent)("› "), fg(options.canAsk ? palette.muted : palette.border)(askLabel.padEnd(width - 3)), fg(palette.body)("t")].map(chunk => ({ ...chunk, bg: options.background })));
  return { actions, ask };
};

/** The question offered about a box: the pinned line under the cards and the talk's ghost text (see `suggestion` in talk-view.ts). */
export const firstQuestion = (title: string) => `how does ${title} work?`;

/** Under 80 columns the diagram does not fit: a plain list of nodes, indented by level, with the observed state or the kind on the right. */
export const nodeListContent = (nodes: readonly { id: unknown; title: string; kind?: unknown; level: number; children: readonly unknown[] }[], options: { selected: unknown; width: number; state: (index: number) => string | undefined; background: RGBA }) => {
  const chunks: TextChunk[] = [];
  nodes.forEach((node, index) => {
    const on = node.id === options.selected, indent = "  ".repeat(Math.min(node.level, 4));
    const kind = node.kind ? String(node.kind) : "", group = node.children.length > 0;
    const room = Math.max(1, options.width - 3 - indent.length);
    const title = node.title.length > room ? `${node.title.slice(0, Math.max(0, room - 1))}…` : node.title;
    const rest = Math.max(0, room - title.length - 1);
    const paint = (chunk: TextChunk) => on ? { ...chunk, bg: options.background } : chunk;
    const state = options.state(index);
    const tag = state ? `[${state}]` : kind;
    const tagColor = state === "failed" ? palette.failure : state && state !== "done" ? palette.accent : palette.border;
    chunks.push(paint(fg(palette.accent)(on ? " › " : "   ")), paint(fg(palette.muted)(indent)), paint(fg(on ? palette.text : group ? palette.muted : palette.body)(title)),
      paint(fg(tagColor)(tag && rest > tag.length ? ` ${tag}`.padStart(rest + 1) : " ".repeat(rest + 1))));
    if (index < nodes.length - 1) chunks.push(nl);
  });
  return new StyledText(chunks);
};
