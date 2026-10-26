import { fg, StyledText, type TextChunk } from "@opentui/core";
import type { Hint } from "../ui";
import { palette } from "../ui";
import { nl } from "./text";

/**
 * The keyboard help: four groups of keys, two columns when there is room (Diagram on the left; Inspector, Agent and Global stacked on the right).
 * The group for where the keys are right now is in the accent colour; the rest are dim. `vim` says which family selects (the other pans).
 */
export function helpContent(options: { inspector: boolean; vim: boolean; screenWidth: number; version: string }) {
  const arrows = "← ↑ ↓ →", { vim } = options;
  const groups: { name: string; active: boolean; rows: Hint[] }[] = [
    { name: "Diagram", active: !options.inspector, rows: [[vim ? "h j k l" : arrows, "select a neighbour"], [vim ? arrows : "h j k l", "pan"], ["+ -", "zoom"], ["f", "fit everything"],
      ["0", "actual size"], ["r", "centre the selection"], ["tab", "next node"], ["enter", "into a group / open a link"], ["backspace", "up to the parent"],
      ["o", "open the linked view"], ["g", "go to any view"], ["b", "back"], ["F", "trace a flow (F again: next, last one leaves)"], ["[ ]", "step through the flow"]] },
    { name: "Inspector", active: options.inspector, rows: [["i", "toggle the inspector"], ["1-4", "focus a card"], ["j k", "move / scroll"], ["space", "fold card"],
      ["PgUp PgDn", "scroll the inspector"], ["e", "browse mapped files (in a flow: read the step's function)"], ["esc", "back to diagram"]] },
    { name: "Agent", active: false, rows: [["t", "ask the agent about it"], ["m", "ask it to improve the map"], ["d", "ask it to trace a flow"], ["n", "name and note it yourself"], ["w", "jump to the agent's work, and follow it"], ["c", "what this session touched"], ["a", "follow the work"], ["s", "show or hide subagent calls"], ["p", "replay the session"]] },
    { name: "Global", active: false, rows: [["/", "search views, boxes, files"], ["T", "choose a theme"], ["?", "this help"], ["q", "quit"]] },
  ];
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
