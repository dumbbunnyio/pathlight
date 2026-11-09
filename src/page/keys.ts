import type { Direction } from "../web/wire";

/**
 * The keys, as the terminal's table means them (src/viewer/keys.ts, `keyAction` in the main layer with `h j k l` panning and the arrows
 * selecting), for the features the page has: select a neighbor, into a box, the view it opens, back, up, fit, zoom, pan, the inspector and `?`.
 * The rest arrive with their features. `?` lists exactly these (session.ts `pageActions`).
 */
export type PageAction =
  | { type: "traverse"; direction: Direction } | { type: "listMove"; by: -1 | 1 }
  | { type: "open" } | { type: "openView" } | { type: "back" } | { type: "parent" }
  | { type: "help" } | { type: "helpClose" } | { type: "inspector" }
  | { type: "fit" } | { type: "actualSize" } | { type: "zoom"; by: -1 | 1 } | { type: "pan"; direction: Direction };

const arrows: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const vim: Record<string, Direction> = { h: "left", j: "down", k: "up", l: "right" };

export const pageKey = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mode: { help: boolean; overlay: boolean; list: boolean }): PageAction | undefined => {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const key = event.key;
  if (mode.help) return key === "Escape" || key === "?" ? { type: "helpClose" } : undefined;
  if (mode.overlay && key === "Escape") return { type: "inspector" };
  if (key === "b") return { type: "back" };
  if (key === "Enter") return { type: "open" };
  if (key === "o" && !event.shiftKey) return { type: "openView" };
  if (key === "Backspace") return { type: "parent" };
  if (mode.list && ["ArrowUp", "ArrowDown", "j", "k"].includes(key)) return { type: "listMove", by: key === "ArrowUp" || key === "k" ? -1 : 1 };
  if (arrows[key] && !event.shiftKey) return { type: "traverse", direction: arrows[key]! };
  if (key === "?") return { type: "help" };
  if (key === "i") return { type: "inspector" };
  if (key === "+" || key === "=") return { type: "zoom", by: 1 };
  if (key === "-") return { type: "zoom", by: -1 };
  if (vim[key]) return { type: "pan", direction: vim[key]! };
  if (key === "f") return { type: "fit" };
  if (key === "0") return { type: "actualSize" };
  return undefined;
};
