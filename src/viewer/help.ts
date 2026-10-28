import { fg, StyledText, type TextChunk } from "@opentui/core";
import { palette } from "../ui";
import { helpGroups, type Tier } from "./keys";
import { nl, wrapWords } from "./text";

/**
 * The keyboard help: three tiers of keys (understand it, direct it, shape the map), side by side from 100 columns and stacked below. The tier the
 * user is in (the highest one they have pressed a key of this session) is in the accent colour; the rest are dim. The rows are viewer/keys.ts's table.
 */
export function helpContent(options: { tier: Tier; vim: boolean; screenWidth: number; version: string }) {
  const groups = helpGroups(options.vim).map(group => ({ ...group, active: group.tier === options.tier }));
  const wide = options.screenWidth >= 100;
  const width = Math.min(wide ? 132 : 96, options.screenWidth - 4), inner = width - 6, gap = 3;
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
  const chunks: TextChunk[] = [];
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
  return { content: new StyledText(chunks), height, width, meta: new StyledText([fg(palette.muted)(` pathlight ${options.version} `)]) };
}
