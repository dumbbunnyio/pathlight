import { fg, StyledText, type TextChunk } from "@opentui/core";
import { palette } from "../ui";
import { helpGroups, type Tier } from "./keys";
import { nl, wrapWords } from "./text";

/** What each connector colour means, in the colours themselves; the diff's pair only when a diff is loaded. */
const legendItems = (diff: boolean): [glyph: string, color: string, label: string][] => [
  ["──", palette.outgoing, "out of the selected box"], ["──", palette.incoming, "into it"], ["┈┈", palette.edgeDim, "other relationships"],
  ["──", palette.purple, "the agent's reading (a flow)"], ...(diff ? [["──", palette.green, "added since the base"], ["┈┈", palette.failure, "lost"]] as [string, string, string][] : [])];

/**
 * The keyboard help: the connector colours on one line (wrapped when narrow), then three tiers of keys (understand it, direct it, shape the map),
 * side by side from 100 columns and stacked below. The tier the user is in (the highest one they have pressed a key of this session) is in the
 * accent colour; the rest are dim. The rows are viewer/keys.ts's table.
 */
export function helpContent(options: { tier: Tier; vim: boolean; screenWidth: number; version: string; diff?: boolean }) {
  const groups = helpGroups(options.vim).map(group => ({ ...group, active: group.tier === options.tier }));
  const wide = options.screenWidth >= 100;
  // The frame is at most 100 columns: the content is its inside.
  const inner = Math.min(96, options.screenWidth - 8), gap = 3;
  const column = wide ? Math.floor((inner - gap * (groups.length - 1)) / groups.length) : inner;
  // One group as lines of chunks, each exactly `column` cells wide, its keys as wide as its longest; a label too long for its column wraps under itself.
  const lines = (group: typeof groups[number]): TextChunk[][] => {
    const keyWidth = Math.max(...group.rows.map(([key]) => key.length)) + 2;
    return [
      [fg(group.active ? palette.accent : palette.muted)(group.name), fg(palette.rule)(` ${"─".repeat(Math.max(2, column - group.name.length - 1))}`)],
      ...group.rows.flatMap(([key, label]) => wrapWords(label, column - keyWidth).map((text, index) =>
        [fg(palette.text)((index ? "" : key).padEnd(keyWidth)), fg(palette.body)(text.padEnd(column - keyWidth))]))];
  };
  const blank = () => [fg(palette.body)(" ".repeat(column))];
  // The legend fills the tiers' width, items kept whole, two spaces apart.
  const full = wide ? column * groups.length + gap * (groups.length - 1) : inner;
  const legend: { chunks: TextChunk[]; used: number }[] = [];
  for (const [glyph, color, label] of legendItems(options.diff ?? false)) {
    const size = glyph.length + 1 + label.length, line = legend.at(-1);
    const item = [fg(color)(glyph), fg(palette.body)(` ${label}`)];
    if (line && line.used + 2 + size <= full) { line.chunks.push(fg(palette.body)("  "), ...item); line.used += 2 + size; }
    else legend.push({ chunks: item, used: size });
  }
  const chunks: TextChunk[] = legend.flatMap(line => [...line.chunks, fg(palette.body)(" ".repeat(Math.max(0, full - line.used))), nl]);
  chunks.push(fg(palette.body)(" ".repeat(full)), nl);
  let height: number;
  if (wide) {
    const columns = groups.map(lines);
    height = Math.max(...columns.map(list => list.length));
    for (let index = 0; index < height; index++) chunks.push(...columns.flatMap((list, at) => [...at ? [fg(palette.body)(" ".repeat(gap))] : [], ...list[index] ?? blank()]), nl);
  } else {
    const all = groups.flatMap((group, index) => [...index ? [blank()] : [], ...lines(group)]);
    height = all.length;
    for (const line of all) chunks.push(...line, nl);
  }
  chunks.pop();
  height += legend.length + 1;
  return { content: new StyledText(chunks), height, width: inner, meta: new StyledText([fg(palette.muted)(` pathlight ${options.version} `)]) };
}
