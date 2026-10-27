import { fg, type RGBA, type TextChunk } from "@opentui/core";
import type { ReviewItem } from "../review";
import { palette } from "../ui";
import { clip, nl } from "./text";

/**
 * The review at the top of the session summary (`c`): each dependency the code gained since `base` that the model has no relationship for, one row
 * each with an import that makes it, and the person's verdict once given. `drawnLater` says accepted pairs wait for the map to be redrawn (a drafted map).
 */
export function reviewSection(items: readonly ReviewItem[], options: { base: string; cursor: number; width: number; title: (id: string) => string; drawnLater: boolean; background: RGBA }): { chunks: TextChunk[]; lines: number } {
  if (!items.length) return { chunks: [], lines: 0 };
  const { width } = options, open = items.filter(item => !item.verdict).length;
  const heading = `New dependencies since ${options.base}`, right = open ? `${open} to decide` : "all decided";
  const chunks: TextChunk[] = [fg(palette.text)(heading), fg(palette.border)(` ${"─".repeat(Math.max(2, width - heading.length - right.length - 2))} `), fg(open ? palette.accent : palette.muted)(right), nl];
  let lines = 1;
  items.forEach((item, index) => {
    const here = index === options.cursor;
    const glyph = item.verdict === "accepted" ? "✓" : item.verdict === "rejected" ? "✗" : "▲";
    const tone = item.verdict === "accepted" ? palette.green : item.verdict === "rejected" ? palette.failure : palette.accent;
    const pair = `${options.title(item.source)} → ${options.title(item.target)}`;
    const state = item.verdict === "accepted" ? (options.drawnLater ? "accepted · drawn once the rest are decided" : "accepted · asked the agent to add it")
      : item.verdict === "rejected" ? "rejected · still in the code" : `${item.imports} import${item.imports === 1 ? "" : "s"}`;
    const row = [fg(palette.accent)(here ? "› " : "  "), fg(tone)(`${glyph} `), fg(here ? palette.text : palette.body)(clip(pair, Math.max(8, width - 4 - state.length - 2)).padEnd(Math.max(8, width - 4 - state.length - 2))),
      fg(palette.muted)(`  ${state}`), nl];
    chunks.push(...(here ? row.map(chunk => ({ ...chunk, bg: options.background })) : row)); lines++;
    if (here && item.example) { chunks.push(fg(palette.border)(`    ${clip(`${item.example.from}:${item.example.line} imports ${item.example.to}`, width - 4)}`), nl); lines++; }
  });
  chunks.push(nl); lines++;
  return { chunks, lines };
}
