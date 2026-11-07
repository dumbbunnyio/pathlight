import type { StyledText, TextChunk } from "@opentui/core";

/**
 * The page draws the same words as the terminal: the pure functions in `src/viewer/` run here, with no renderer, and their chunks become spans.
 * A span is a run of text with one color; `\n` inside a span ends a line. The functions are given a width the page never reaches, so the terminal's
 * own wrapping and clipping stay out of it: the page wraps by pixels.
 */
export interface Span { text: string; fg?: string; bold?: boolean }

/** Wide enough that no line is wrapped or clipped for the terminal. */
export const unlimited = 100_000;

const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
const hex = (color: TextChunk["fg"]) => color ? `#${channel(color.r)}${channel(color.g)}${channel(color.b)}` : undefined;

export const spansOf = (text: StyledText | readonly TextChunk[]): Span[] => {
  const chunks = "chunks" in text ? text.chunks : text;
  const spans: Span[] = [];
  for (const chunk of chunks) {
    if (!chunk.text) continue;
    const fg = hex(chunk.fg), bold = ((chunk.attributes ?? 0) & 1) === 1;
    const last = spans.at(-1);
    if (last && last.fg === fg && Boolean(last.bold) === bold) last.text += chunk.text;
    else spans.push({ text: chunk.text, ...(fg ? { fg } : {}), ...(bold ? { bold } : {}) });
  }
  // Padding the terminal adds to fill a row is layout, not words.
  const last = spans.at(-1);
  if (last) last.text = last.text.replace(/[ \t]+$/, "");
  return spans.filter(span => span.text !== "");
};
