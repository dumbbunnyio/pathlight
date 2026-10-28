import { fg, type RGBA, StyledText, type TextChunk } from "@opentui/core";
import { palette } from "../ui";
import { clip, describe, nl } from "./text";
import { type SectionKey, sectionOrder } from "./widgets";

/** The inspector's head for a selection: its name and kind on one row, then what the model says it is for. Nothing else repeats the header or the cards. */
export const headContent = (options: { title: string | undefined; kind: string; technology?: string | null; planned: boolean; tags: readonly string[]; description: unknown; opens: string; width: number }) => {
  const { kind, width, opens } = options;
  const titleText = options.title ?? "No selection";
  const titleShown = titleText.length + kind.length + 2 > width ? `${titleText.slice(0, Math.max(1, width - kind.length - 3))}…` : titleText;
  const title = new StyledText([fg(palette.text)(titleShown), fg(palette.muted)(`${" ".repeat(Math.max(1, width - titleShown.length - kind.length))}${kind}`)]);
  const what = [options.technology, options.planned ? "planned: no files yet" : "", ...options.tags.filter(tag => tag === "bug" || tag === "fixed")].filter(Boolean).join(" · ");
  const description = describe(options.description);
  const about = new StyledText([...(description ? [fg(palette.body)(description)] : []), ...(description && opens ? [nl] : []), ...(opens ? [fg(palette.muted)(opens)] : [])]);
  return { title, what: new StyledText([fg(palette.muted)(what || " ")]), hasWhat: what !== "", about, hasAbout: Boolean(description || opens),
    rows: 1 + (what ? 1 : 0) + (description ? Math.ceil(description.length / width) : 0) + (opens ? 1 : 0) };
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

/** A card's header: fold marker, number and name, a rule, and its count on the right. */
export const sectionHeader = (options: { open: boolean; focused: boolean; number: number; name: string; count: string; width: number }) => {
  const { open, focused, number, name, count } = options;
  const label = `${open ? "▾" : "▸"} ${number} ${name}`;
  const rule = "─".repeat(Math.max(2, options.width - 2 - label.length - count.length - 3));
  return new StyledText([fg(focused ? palette.accent : palette.border)(`${open ? "▾" : "▸"} `), fg(palette.border)(`${number} `),
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
