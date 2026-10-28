import { fg, StyledText, type TextChunk } from "@opentui/core";
import type { Hint } from "../ui";
import { hintChunks, noticeStyle, palette, pill } from "../ui";
import { hints } from "./keys";
import { clip } from "./text";
import type { SectionKey } from "./widgets";

/** The keys a mode names in the footer: replay's position and controls, a focused card's, flow mode's, or the file filter's. Nothing in the diagram. */
export const modeHints = (options: { room: number; replay?: { playing: boolean; index: number; steps: number; turn: number; turns: number; speed: number }; section?: SectionKey;
  flow?: { title: string; step: number; steps: number }; files?: { cursor: number; count: number } }): TextChunk[] => {
  const { room, replay, flow, files } = options;
  if (replay) return [fg(palette.accent)(`${replay.playing ? "▶" : "⏸"} ${replay.index + 1}/${replay.steps}`), fg(palette.muted)(`  turn ${replay.turn + 1}/${replay.turns}  `),
    ...hintChunks(hints.replay(replay.playing, replay.speed), room - 24)];
  if (options.section) return hintChunks(hints.section[options.section] as Hint[], room);
  if (flow) return [fg(palette.purple)(`◇ ${clip(flow.title, 24)} · ${flow.step + 1}/${flow.steps}  `), ...hintChunks(hints.flow, room - 40)];
  if (files) return [fg(palette.accent)(`Files ${files.count ? files.cursor + 1 : 0}/${files.count}`), fg(palette.muted)("  type to filter  "), ...hintChunks(hints.files, room - 30)];
  return [];
};

/**
 * The footer says where you are and how to ask for help; keys are named only inside a mode that needs them. A notice has the room: the hidden-label
 * count waits until it goes, and the right-hand side is dropped when it would not fit beside the left.
 */
export const footerContent = (options: { mode: string; selected: string; message: string; hidden: number; scale: number; width: number; hints: (room: number) => TextChunk[] }) => {
  const { mode, selected, message, width } = options;
  const labelNote = message ? 0 : options.hidden, zoom = `zoom ${Math.round(16 / options.scale * 100)}%`;
  const rightText = `${labelNote ? `${labelNote} labels hidden  ·  ` : ""}${zoom}  │  ? help`;
  const room = Math.max(10, width - rightText.length - 16 - mode.length - selected.length - 4);
  const style = message ? noticeStyle(message) : undefined;
  const left = [pill(mode, palette.accent), fg(palette.muted)("  Selected: "), fg(palette.body)(selected), fg(palette.muted)("  "),
    ...(style ? [fg(style.color)(`${style.glyph} `), fg(palette.body)(message)] : options.hints(room))];
  const leftWidth = left.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const right = leftWidth + rightText.length + 2 <= width
    ? [...(labelNote ? [fg(palette.border)(`${labelNote} labels hidden  ·  `)] : []), fg(palette.muted)(zoom), fg(palette.border)("  │  "), fg(palette.muted)("? help")] : [];
  return { left: new StyledText(left), right: new StyledText(right) };
};

/** The breadcrumb's activity line, cut to the room beside the breadcrumb (an ellipsis marks the cut); dropped under 24 cells. */
export const crumbActivity = (activity: readonly TextChunk[] | undefined, available: number) => {
  const fitted: TextChunk[] = [];
  const activityWidth = activity?.reduce((sum, chunk) => sum + chunk.text.length, 0) ?? 0;
  if (activity && available >= 24) {
    let left = activityWidth > available ? available - 1 : available;
    for (const chunk of activity) { if (left <= 0) break; fitted.push(chunk.text.length <= left ? chunk : { ...chunk, text: chunk.text.slice(0, left) }); left -= chunk.text.length; }
    if (activityWidth > available) fitted.push(fg(palette.muted)("…"));
  }
  return new StyledText(fitted);
};

/** An offer when the work is in another view. */
export const workOffer = (title: string): TextChunk[] => [fg(palette.accent)("● "), fg(palette.text)(`working in ${title}`), fg(palette.muted)("  "), pill("w", palette.accent), fg(palette.muted)(" go and follow")];
