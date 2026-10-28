import { fg, RGBA, StyledText, type TextChunk } from "@opentui/core";
import type { ActivityEvent } from "../activity";
import { palette } from "../ui";
import { cardTag, isActive, operationState, outcomeMs } from "./activity-view";
import { fade, labelTitle, nl } from "./text";

/** A card drawn with dashes: the preview of a connection's other end, or a planned element with no files yet. */
export const dashed = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "┄", vertical: "┆", topT: "┬", bottomT: "┴", leftT: "├", rightT: "┤", cross: "┼" };

/** What a card is to the viewer at this moment. */
export interface CardFacts {
  title: string; kind: string; group: boolean; tags: readonly string[];
  related: ActivityEvent[]; now: number;
  selected: boolean; neighbour: boolean; previewed: boolean; flashing: boolean;
  /** Planned in the mapping and with no files yet; in the agent's plan; observed outside a plan that is set. */
  unbuilt: boolean; planned: boolean; offPlan: boolean;
  /** Flow mode: the steps it plays (none off the path), and whether a flow is being read at all. */
  numbers: readonly number[] | undefined; flow: boolean;
  width: number; height: number;
}

/**
 * How a card looks: its border colour and dashes, the text in its top border (a group's title; a leaf's observed tag) and a leaf's label (the kind and
 * status on the first row, then the title). Selection and the panel cursor's target take the accent; neighbours are a step brighter; a running call
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
  if (group) return { border, dashes, title: `${card.title}${state ? ` [${state}]` : card.unbuilt ? " [planned]" : ""}${counts ? ` ·${counts}` : ""}`, titleColor: undefined, label: undefined };
  // First line: the kind (dim) on the left and observed activity (dim) on the right; then the title.
  const { width, height } = card;
  const rows = height - 2, textWidth = Math.max(4, width - 4);
  const stateText = card.unbuilt ? "[planned]" : "";
  const tag = cardTag(related, now);
  // A narrow card keeps just the glyph, so the state is still there when the words do not fit.
  const title = !tag ? undefined : width >= tag.text.length + 6 ? ` ${tag.text} ` : width >= 7 ? ` ${tag.text.slice(0, tag.text.indexOf(" ") > 0 ? tag.text.indexOf(" ") : 1)} ` : undefined;
  const statusText = [stateText, counts].filter(Boolean).join(" ");
  const kindText = card.kind.length + (statusText ? statusText.length + 1 : 0) < textWidth ? card.kind : "";
  const header = rows >= 2 && (statusText || (kindText && kindText.length < textWidth));
  const gap = Math.max(1, textWidth - kindText.length - statusText.length);
  const first: TextChunk[] = header ? [fg(palette.muted)(kindText.slice(0, Math.max(0, textWidth - statusText.length - 1))),
    fg(palette.muted)(statusText ? " ".repeat(gap) : ""), ...(stateText ? [fg(palette.muted)(stateText), fg(palette.muted)(counts ? ` ${counts}` : "")] : [fg(palette.muted)(counts)]), nl] : [];
  const label = new StyledText([...first, fg(offPath ? palette.border : bright ? palette.text : palette.body)(labelTitle(card.title, textWidth, Math.max(1, rows - (header ? 1 : 0)), false))]);
  return { border, dashes, title, titleColor: tag?.color, label };
}
