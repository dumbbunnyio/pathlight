import { bg, bold, fg, type TextChunk } from "@opentui/core";

export const palette = {
  background: "#0f141b", panel: "#151d27", node: "#1b2532", border: "#526171", muted: "#93a4b5", text: "#e7eff7",
  incoming: "#68cfda", outgoing: "#e9bd70", command: "#b79cf2", grid: "#1d2835", edgeDim: "#3a4352", cardEdge: "#2b3441",
  failure: "#f08080", keycap: "#26323f", scrim: "#080b10", section: "#1b2631",
};

export type Hint = readonly [key: string, label: string];

/** A filled label, used for the mode and live badges. */
export const pill = (text: string, color: string) => bg(color)(fg(palette.background)(bold(` ${text} `)));

/** Key hints: the key in white, its meaning dim, as many as fit the width (most important first). */
export function hintChunks(hints: readonly Hint[], width: number): TextChunk[] {
  const chunks: TextChunk[] = [fg(palette.muted)(" ")];
  let used = 1;
  for (const [key, label] of hints) {
    const need = key.length + 1 + label.length + 3;
    if (used + need > width) break;
    chunks.push(fg(palette.text)(key), fg(palette.border)(` ${label}   `));
    used += need;
  }
  return chunks;
}

/** The tone and glyph of a transient notice, inferred from its wording. */
export function noticeStyle(message: string) {
  if (/error|unavailable|failed|no longer|exited|cannot|refus/i.test(message)) return { glyph: "✖", color: palette.failure };
  if (/^(no |nothing|unknown|not |needs |type a|view )|not in this view|gone|empty/i.test(message)) return { glyph: "▲", color: palette.outgoing };
  return { glyph: "●", color: palette.incoming };
}
