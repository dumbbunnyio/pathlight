import { bg, fg, type TextChunk } from "@opentui/core";

export const palette = {
  // Three text levels (bright, normal, dim) plus a dimmer one for rules and tree glyphs; one accent; cyan for incoming and "live".
  background: "#0e1116", panel: "#11151b",
  text: "#eef1f5", body: "#c9d0da", muted: "#7d8796", border: "#4f5866", rule: "#2b3441",
  accent: "#e8b45a", incoming: "#6fcad6", outgoing: "#e8b45a", purple: "#7466b0", green: "#86c48b", failure: "#e07a7a",
  grid: "#1a2029", hot: "#1a212b", pick: "#294052", edgeDim: "#3a4352", cardEdge: "#2b3441", keycap: "#26323f", scrim: "#080b10", node: "#0e1116", section: "#11151b", command: "#7d8796",
};

/** Terminals that do not advertise 24-bit colour get every palette entry snapped to the nearest xterm-256 colour, so what is drawn is what the terminal shows. */
export const trueColor = (env: Record<string, string | undefined> = process.env) => {
  const override = env.PATHLIGHT_COLORS;
  if (override) return override !== "256";
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") || /direct|truecolor/i.test(env.TERM ?? "");
};
const cube = [0, 95, 135, 175, 215, 255];
export const nearest256 = (hex: string) => {
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const step = (value: number) => cube.reduce((best, level, index) => Math.abs(level - value) < Math.abs(cube[best]! - value) ? index : best, 0);
  const cubed = rgb.map(value => cube[step(value)]!);
  const mean = Math.round(rgb.reduce((sum, value) => sum + value, 0) / 3), grey = Math.min(238, Math.max(8, Math.round((mean - 8) / 10) * 10 + 8));
  const distance = (colour: number[]) => colour.reduce((sum, value, index) => sum + (value - rgb[index]!) ** 2, 0);
  const pick = distance([grey, grey, grey]) < distance(cubed) ? [grey, grey, grey] : cubed;
  return `#${pick.map(value => value.toString(16).padStart(2, "0")).join("")}`;
};
export type Palette = { -readonly [Key in keyof typeof palette]: string };

/**
 * Installs a palette in place (the object is shared, so everything that reads it sees the change). Without 24-bit colour every entry is
 * snapped to xterm-256, and the panel must still read one step above the canvas. Entries are then made distinct (a blue step of one is
 * invisible) so a drawn colour maps back to exactly one role when the theme changes again.
 */
export const setPalette = (next: Palette, snap = !trueColor()) => {
  const keys = Object.keys(palette) as (keyof Palette)[];
  const used = new Set<string>();
  for (const key of keys) {
    let value = snap ? nearest256(next[key]) : next[key].toLowerCase();
    if (snap && key === "panel" && value === palette.background) value = "#1c1c1c";
    while (used.has(value)) value = `${value.slice(0, 5)}${(parseInt(value.slice(5), 16) + (parseInt(value.slice(5), 16) === 255 ? -1 : 1)).toString(16).padStart(2, "0")}`;
    used.add(value);
    palette[key] = value;
  }
};
setPalette({ ...palette });

export type Hint = readonly [key: string, label: string];

/** A filled label, used for the mode and live badges. */
export const pill = (text: string, color: string) => bg(color)(fg(palette.background)(` ${text} `));

/** Key hints: the key in white, its meaning dim, as many as fit the width (most important first). */
export function hintChunks(hints: readonly Hint[], width: number): TextChunk[] {
  const chunks: TextChunk[] = [fg(palette.muted)(" ")];
  let used = 1;
  for (const [key, label] of hints) {
    const need = key.length + 1 + label.length + 2;
    if (used + need > width) break;
    chunks.push(fg(palette.text)(key), fg(palette.muted)(` ${label}  `));
    used += need;
  }
  return chunks;
}

/** Key hints set into a modal's bottom border: key bright, label dim, two spaces between pairs, a space at each end. */
export function borderHints(hints: readonly Hint[]): TextChunk[] {
  const chunks: TextChunk[] = [fg(palette.muted)(" ")];
  hints.forEach(([key, label], index) => chunks.push(fg(palette.text)(key), fg(palette.muted)(index < hints.length - 1 ? ` ${label}  ` : ` ${label} `)));
  return chunks;
}

/** The tone and glyph of a transient notice, inferred from its wording. */
export function noticeStyle(message: string) {
  if (/^asked /i.test(message)) return { glyph: "✓", color: palette.green };
  if (/error|unavailable|failed|no longer|exited|cannot|refus/i.test(message)) return { glyph: "✖", color: palette.failure };
  if (/^(no |nothing|unknown|not |needs |type a|view )|not in this view|gone|empty/i.test(message)) return { glyph: "▲", color: palette.outgoing };
  return { glyph: "●", color: palette.incoming };
}
