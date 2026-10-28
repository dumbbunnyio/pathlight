import { fg, RGBA } from "@opentui/core";
import { palette } from "../ui";

/** A line break inside styled text (its colour never shows). */
export const nl = fg(palette.text)("\n");
export const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const spinAt = (now: number) => spinner[Math.floor(now / 100) % spinner.length]!;

/** `text` cut to `room` cells, an ellipsis marking the cut. */
export const clip = (text: string, room: number) => room <= 0 ? "" : text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

/** Words packed into lines of at most `room` cells (a word longer than that is a line of its own). */
export const wrapWords = (text: string, room: number) => {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= room) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word);
  }
  return lines;
};

/**
 * A card's title as it fits, wrapped on words onto as many lines as the card has rows for. Never show a fragment: if a word cannot fit the node's
 * width the title is one line ending in an ellipsis; if the words need more lines than there are, the last line ends in one (the observed state
 * keeps its own line).
 */
export const labelTitle = (title: string, width: number, rows: number, status: boolean) => {
  const textWidth = Math.max(3, width), room = Math.max(1, rows - (status ? 1 : 0));
  const lines = wrapWords(title, textWidth);
  if (lines.some(line => line.length > textWidth)) return title.length > textWidth ? `${title.slice(0, textWidth - 1)}…` : title;
  if (lines.length <= room) return lines.join("\n");
  return [...lines.slice(0, room - 1), clip(lines.slice(room - 1).join(" "), textWidth)].join("\n");
};

/** LikeC4's own description, flattened to one line of plain text: the model is the single source of what a component is for. */
export const describe = (description: unknown) => {
  const raw = description as { txt?: string; md?: string } | null | undefined;
  const text = (raw?.txt ?? raw?.md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  return text.length > 420 ? `${text.slice(0, 419)}…` : text;
};

export const easeOut = (t: number) => 1 - (1 - t) ** 3;
const rgba = (color: string | RGBA) => typeof color === "string" ? RGBA.fromHex(color) : color;
/** `from` moved `amount` of the way to `to`. */
export const mix = (from: string | RGBA, to: string | RGBA, amount: number) => {
  const a = rgba(from), b = rgba(to);
  return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount, 1);
};
/** A colour faded towards the background: 1 is the colour, 0 the background. */
export const fade = (color: string | RGBA, amount: number) => mix(palette.background, color, amount);
