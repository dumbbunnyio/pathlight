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
 * The scan's counts as the head shows them, counting the same files `e` lists: `14 files, 419 lines`, or `14 files · 6 read, 419 lines` when the
 * scan read fewer of them, or `7 files · 5 Go, …` when they are in a language it does not read. A package's name before the counts is left out
 * (beside another package's title it read as that package's counts).
 */
export const countsLine = (counts: string, mapped: number) => {
  const text = counts.replace(/^[^\s:]+: (?=\d)/, "");
  const plain = /^(\d[\d,]*) files?, (.*)$/.exec(text);
  if (plain && mapped) { const read = Number(plain[1]!.replace(/,/g, "")); return read === mapped ? `${mapped} ${mapped === 1 ? "file" : "files"}, ${plain[2]}` : `${mapped} files · ${plain[1]} read, ${plain[2]}`; }
  const language = /^(\d[\d,]*) ([A-Z][\w#+-]*) files?, (.*)$/.exec(text);
  if (language && mapped && Number(language[1]!.replace(/,/g, "")) !== mapped) return `${mapped} files · ${language[1]} ${language[2]}, ${language[3]}`;
  return text;
};

/**
 * The inspector's head for a selection: its name and kind on one row (with `· agent` when the agent wrote its name and note), then the words about
 * it in the body colour, then the scan's counts on their own dim line, never joined with a `·`. Wrapped on words.
 */
export const headContent = (options: { title: string | undefined; kind: string; by?: "agent" | "human"; technology?: string | null; planned: boolean; tags: readonly string[];
  description: unknown; note?: string; mapped: number; opens: string; width: number }) => {
  const { width, opens } = options;
  const kind = options.kind && options.by === "agent" ? `${options.kind} · agent` : options.kind;
  const titleText = options.title ?? "No selection";
  // A long title keeps the room: the kind goes before the title is cut.
  const showKind = titleText.length + kind.length + 2 <= width ? kind : "";
  const titleShown = clip(titleText, width);
  const title = new StyledText([fg(palette.text)(titleShown), fg(palette.muted)(showKind ? `${" ".repeat(Math.max(1, width - titleShown.length - showKind.length))}${showKind}` : "")]);
  const what = [options.technology, options.planned ? "planned: no files yet" : "", ...options.tags.filter(tag => tag === "bug" || tag === "fixed")].filter(Boolean).join(" · ");
  const { words, counts } = splitDescription(describe(options.description), options.note);
  const lines = [...(words ? wrapWords(words, width).map(line => ({ line, color: palette.body })) : []),
    ...(counts ? wrapWords(countsLine(counts, options.mapped), width).map(line => ({ line, color: palette.muted })) : []),
    ...(opens ? [{ line: opens, color: palette.muted }] : [])];
  const about = new StyledText(lines.flatMap((entry, index) => [...(index ? [nl] : []), fg(entry.color)(entry.line)]));
  return { title, what: new StyledText([fg(palette.muted)(what || " ")]), hasWhat: what !== "", about, hasAbout: lines.length > 0,
    rows: 1 + (what ? 1 : 0) + lines.length };
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

/** A card's header: fold marker and name, a rule, and its count on the right. The key that focuses it is in `?`, not here (it read as a count). */
export const sectionHeader = (options: { open: boolean; focused: boolean; name: string; count: string; width: number }) => {
  const { open, focused, name, count } = options;
  const label = `${open ? "▾" : "▸"} ${name}`;
  const rule = "─".repeat(Math.max(2, options.width - 2 - label.length - count.length - 3));
  return new StyledText([fg(focused ? palette.accent : palette.border)(`${open ? "▾" : "▸"} `),
    fg(focused ? palette.accent : palette.body)(name), fg(palette.rule)(` ${rule} `), fg(palette.muted)(count)]);
};

/** Under the cards, always the same two lines: what is one key away, then the question field. */
export const pinnedLines = (options: { width: number; files: number; session: boolean; replay: boolean; title: string | undefined; canAsk: boolean; background: RGBA }) => {
  const { width } = options;
  const action = (key: string, text: string) => [fg(palette.body)(key), fg(palette.muted)(` ${text}   `)];
  const actions = new StyledText([fg(palette.rule)("─".repeat(width)), nl,
    ...(options.files ? action("e", `files ${options.files}`) : []), ...(options.session ? action("c", "session") : []), ...(options.replay ? action("p", "replay") : [])]);
  const askLabel = clip(options.title !== undefined ? `ask about ${options.title}…` : "ask…", width - 6);
  const ask = new StyledText([fg(palette.accent)("› "), fg(options.canAsk ? palette.muted : palette.border)(askLabel.padEnd(width - 3)), fg(palette.body)("t")].map(chunk => ({ ...chunk, bg: options.background })));
  return { actions, ask };
};

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
