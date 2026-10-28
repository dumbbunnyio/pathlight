import { fg, StyledText, type TextChunk } from "@opentui/core";
import { palette } from "../ui";
import { helpGroups } from "./keys";
import { nl } from "./text";

/**
 * The keyboard help: four groups of keys, two columns when there is room (Diagram on the left; Inspector, Agent and Global stacked on the right).
 * The group for where the keys are right now is in the accent colour; the rest are dim. The rows are viewer/keys.ts's table.
 */
export function helpContent(options: { inspector: boolean; vim: boolean; screenWidth: number; version: string }) {
  const groups = helpGroups(options.vim).map(group => ({ ...group, active: group.name === "Diagram" ? !options.inspector : group.name === "Inspector" && options.inspector }));
  const wide = options.screenWidth >= 100;
  const width = Math.min(96, options.screenWidth - 4), inner = width - 6, column = wide ? Math.floor((inner - 4) / 2) : inner, keyWidth = 12;
  // One group as lines of chunks, each exactly `column` cells wide.
  const lines = (group: typeof groups[number]): TextChunk[][] => [
    [fg(group.active ? palette.accent : palette.muted)(group.name), fg(palette.rule)(` ${"─".repeat(Math.max(2, column - group.name.length - 1))}`)],
    ...group.rows.map(([key, label]) => {
      const text = label.slice(0, column - keyWidth);
      return [fg(palette.text)(key.padEnd(keyWidth)), fg(palette.body)(text.padEnd(column - keyWidth))];
    })];
  const stack = (items: typeof groups) => items.flatMap((group, index) => [...index ? [[fg(palette.body)(" ".repeat(column))]] : [], ...lines(group)]);
  const chunks: TextChunk[] = [];
  let height: number;
  if (wide) {
    const left = stack(groups.slice(0, 1)), right = stack(groups.slice(1));
    height = Math.max(left.length, right.length);
    for (let index = 0; index < height; index++) chunks.push(...left[index] ?? [fg(palette.body)(" ".repeat(column))], fg(palette.body)("    "), ...right[index] ?? [], nl);
  } else {
    const all = stack(groups);
    height = all.length;
    for (const line of all) chunks.push(...line, nl);
  }
  chunks.pop();
  return { content: new StyledText(chunks), height, width,
    meta: new StyledText([fg(palette.muted)(" in "), fg(palette.accent)(options.inspector ? "inspector" : "diagram"), fg(palette.muted)(` · pathlight ${options.version} `)]) };
}
