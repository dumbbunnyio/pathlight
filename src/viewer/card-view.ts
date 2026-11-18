import { fg, RGBA, StyledText, type TextChunk } from "@opentui/core";
import type { ActivityEvent } from "../activity";
import { resourceKinds } from "../resources";
import { palette } from "../ui";
import { cardTag, isActive, operationState, outcomeMs } from "./activity-view";
import { clip, fade, labelTitle, nl } from "./text";

/** A card drawn with dashes: the preview of a connection's other end, or a planned element with no files yet. */
export const dashed = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "┄", vertical: "┆", topT: "┬", bottomT: "┴", leftT: "├", rightT: "┤", cross: "┼" };

/**
 * The word on a box's first row: how many boxes are inside it, for a box that opens a view (a package on the overview too); what a resource is
 * (`database`, `queue`, from its kind tag: src/resources.ts), on its box and on an instance of it where it runs; nothing on any other leaf, and no other kind word anywhere (`component`, `folder`,
 * `package` told the reader nothing). Counted from every view's boxes, so it is the boxes there are to see.
 */
export const insideWords = (view: { id: unknown; nodes: readonly { id: unknown; modelRef?: unknown; navigateTo?: unknown; children: readonly unknown[]; kind?: unknown; tags?: readonly unknown[] | null }[] }, boxes: ReadonlySet<string>,
  /** The elements that are resources: a deployment view's instance of one (kind `instance`, the element's tags) says what its element says. */
  resources: ReadonlySet<string> = new Set(),
  /** Every view's node ids: a closed frame of a deployment view is no model element, so what is inside it is counted by its own id. */
  ids: ReadonlySet<string> = new Set()) => {
  const words = new Map<string, string>();
  for (const node of view.nodes) {
    const resource = String(node.kind) === "resource" || (String(node.kind) === "instance" && resources.has(String(node.modelRef)));
    const kind = resource ? resourceKinds.find(word => node.tags?.some(tag => String(tag) === word)) : undefined;
    if (kind) { words.set(String(node.id), kind); continue; }
    // A program the infrastructure runs (Phase R2) says what it is, as a resource does.
    if (String(node.kind) === "container" && !node.children.length) { words.set(String(node.id), "container"); continue; }
    // So does a plain service where it runs: the draft tags it `container` (not the closed card of a whole repository, not "N other services").
    if (String(node.kind) === "service" && !node.children.length && node.tags?.some(tag => String(tag) === "container")) { words.set(String(node.id), "container"); continue; }
    if (node.children.length || !node.navigateTo || String(node.navigateTo) === String(view.id)) continue;
    const ref = String(node.modelRef), count = node.modelRef ? [...boxes].filter(box => box.startsWith(`${ref}.`)).length : [...ids].filter(id => id.startsWith(`${String(node.id)}.`)).length;
    if (count) words.set(String(node.id), `[${count.toLocaleString("en")}]`);
  }
  return words;
};

/** What a card is to the viewer at this moment. */
export interface CardFacts {
  /** `word`: what its first row says on the left (`[36]`, see `insideWords`), or nothing. */
  title: string; word: string; group: boolean; tags: readonly string[];
  /** Whether leaf cards spend their first row on the word and status: the view decides, so it is on every card or none. */
  header: boolean;
  related: ActivityEvent[]; now: number;
  selected: boolean; neighbour: boolean; previewed: boolean; flashing: boolean;
  /** Planned in the mapping and with no files yet; in the agent's plan; observed outside a plan that is set. */
  unbuilt: boolean; planned: boolean; offPlan: boolean;
  /** Flow mode: the steps it plays (none off the path), and whether a flow is being read at all. */
  numbers: readonly number[] | undefined; flow: boolean;
  width: number; height: number;
}

/**
 * How a card looks: its border colour and dashes, the text in its top border (a group's title; a leaf's observed tag) and a leaf's label (the word and
 * status on the first row when the view has that row, then the title, with any spare rows blank beneath it). Selection and the panel cursor's target take the accent; neighbours are a step brighter; a running call
 * pulses the accent; a card off the flow's path steps back.
 */
export function cardLook(card: CardFacts) {
  const { related, now, group } = card;
  const reads = related.filter(event => event.operation === "read").length, edits = related.filter(event => event.operation === "edit").length;
  const runs = related.filter(event => event.operation === "command").length;
  const counts = [reads && `r${reads}`, edits && `e${edits}`, runs && `c${runs}`, card.offPlan && "off plan"].filter(Boolean).join(" ");
  const active = related.filter(isActive);
  const recent = related.find(event => now - event.time <= outcomeMs);
  const state = operationState(active, recent);
  let border: string | RGBA = group ? palette.rule : palette.cardEdge;
  if (card.neighbour) border = group ? palette.border : palette.edgeDim;
  if (card.planned) border = palette.purple;
  // A behaviour view marks a state the agent found broken (#bug) or since repaired (#fixed).
  if (card.tags.includes("bug")) border = palette.failure; else if (card.tags.includes("fixed")) border = palette.green;
  if (state === "failed") border = palette.failure;
  if (card.previewed || card.selected || card.flashing) border = palette.accent;
  const offPath = card.flow && !group && !card.numbers;
  if (card.numbers && !card.selected && !card.flashing && state !== "failed") border = palette.purple;
  if (offPath && !card.selected) border = fade(border, 0.5);
  if (active.length && !card.selected) {
    const pulse = RGBA.fromHex(palette.accent), brightness = 0.55 + 0.45 * (1 + Math.sin(now / 220)) / 2;
    pulse.r *= brightness; pulse.g *= brightness; pulse.b *= brightness;
    border = pulse;
  }
  const dashes = (card.previewed && !card.selected) || card.unbuilt ? dashed : undefined;
  const bright = card.selected || card.neighbour || card.previewed;
  if (group) {
    // The border draws no title wider than its room (two corners, a cell either side), and a frame's title is often a file path: the name is clipped
    // so the state and the counts after it stay whole.
    const after = `${state ? ` [${state}]` : card.unbuilt ? " [planned]" : ""}${counts ? ` ·${counts}` : ""}`, room = card.width - 4;
    const title = after.length < room ? `${clip(card.title, room - after.length)}${after}` : clip(`${card.title}${after}`, room);
    return { border, dashes, title, titleColor: undefined, label: undefined };
  }
  // First line: the word (dim) on the left and observed activity (dim) on the right; then the title.
  const { width, height } = card;
  const rows = height - 2, textWidth = Math.max(4, width - 4);
  const stateText = card.unbuilt ? "[planned]" : "";
  const tag = cardTag(related, now);
  // A narrow card keeps just the glyph, so the state is still there when the words do not fit.
  const title = !tag ? undefined : width >= tag.text.length + 6 ? ` ${tag.text} ` : width >= 7 ? ` ${tag.text.slice(0, tag.text.indexOf(" ") > 0 ? tag.text.indexOf(" ") : 1)} ` : undefined;
  const statusText = [stateText, counts].filter(Boolean).join(" ");
  const kindText = card.word.length + (statusText ? statusText.length + 1 : 0) < textWidth ? card.word : "";
  const header = card.header && rows >= 2;
  const gap = Math.max(1, textWidth - kindText.length - statusText.length);
  const first: TextChunk[] = header ? [fg(palette.muted)(kindText.slice(0, Math.max(0, textWidth - statusText.length - 1))),
    fg(palette.muted)(statusText ? " ".repeat(gap) : ""), ...(stateText ? [fg(palette.muted)(stateText), fg(palette.muted)(counts ? ` ${counts}` : "")] : [fg(palette.muted)(counts)]), nl] : [];
  const label = new StyledText([...first, fg(offPath ? palette.border : bright ? palette.text : palette.body)(labelTitle(card.title, textWidth, Math.max(1, rows - (header ? 1 : 0)), false))]);
  return { border, dashes, title, titleColor: tag?.color, label };
}
