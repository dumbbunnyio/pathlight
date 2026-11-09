import type { StyledText, TextChunk } from "@opentui/core";

/**
 * The page draws the same words as the terminal: the pure functions in `src/viewer/` run here, with no renderer, and their chunks become spans.
 * A span is a run of text with one color (and a background, for a pill or a cursor row); `\n` inside a span ends a line. The functions are given
 * the page's own width in cells, so the terminal's wrapping and clipping are the page's too; `unlimited` is for text nothing should cut.
 */
import type { Span } from "./wire";

export type { Span } from "./wire";

/** Wide enough that no line is wrapped or clipped for the terminal. */
export const unlimited = 100_000;

const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
const hex = (color: TextChunk["fg"]) => color ? `#${channel(color.r)}${channel(color.g)}${channel(color.b)}` : undefined;

export const spansOf = (text: StyledText | readonly TextChunk[]): Span[] => {
  const chunks = "chunks" in text ? text.chunks : text;
  const spans: Span[] = [];
  for (const chunk of chunks) {
    if (!chunk.text) continue;
    const fg = hex(chunk.fg), bg = hex(chunk.bg), bold = ((chunk.attributes ?? 0) & 1) === 1;
    const last = spans.at(-1);
    if (last && last.fg === fg && last.bg === bg && Boolean(last.bold) === bold) last.text += chunk.text;
    else spans.push({ text: chunk.text, ...(fg ? { fg } : {}), ...(bg ? { bg } : {}), ...(bold ? { bold } : {}) });
  }
  // Padding the terminal adds to fill a row is layout, not words.
  const last = spans.at(-1);
  if (last) last.text = last.text.replace(/[ \t]+$/, "");
  return spans.filter(span => span.text !== "");
};
