import type { Hint } from "../ui";
import type { SectionKey } from "./widgets";

/** A key as OpenTUI reports it. */
export interface KeyPress { name: string; sequence: string; ctrl: boolean; meta: boolean; shift: boolean; option?: boolean }
export type Direction = "left" | "right" | "up" | "down";

/** Where the keys go: the modal on top, if any, else the diagram with whatever mode it is in. */
export interface KeyMode {
  layer: "visit" | "ask" | "picker" | "goto" | "summary" | "help" | "main";
  /** In the ask dialog: whether the context toggles (not the question) have the keys. */
  askContext: boolean;
  replay: boolean; fileMode: boolean; focusSection: SectionKey | undefined; flow: boolean; listMode: boolean;
  /** `h j k l` select when true (arrows pan); `v` swaps them. */
  vim: boolean;
}

/**
 * Every action a key can ask for. The viewer performs them; this file only decides which one a key means where it was pressed.
 * `idle` swallows the key and redraws; `pass` leaves the key to the focused input (the file filter) and redraws.
 */
export type Action =
  | { type: "stop" } | { type: "swallow" } | { type: "idle" } | { type: "pass" }
  | { type: "askCancel" } | { type: "askTab" } | { type: "askChoose"; by: 1 | 2 } | { type: "askToggle" } | { type: "askSend" }
  | { type: "themeCancel" } | { type: "themeKeep" } | { type: "themeMove"; to: "up" | "down" | "pageup" | "pagedown" | "home" | "end" }
  | { type: "gotoClose" } | { type: "gotoGo" } | { type: "gotoMove"; by: -1 | 1 } | { type: "gotoPage"; by: -1 | 1 } | { type: "gotoHome" } | { type: "gotoEnd" }
  | { type: "gotoClear" } | { type: "gotoErase" } | { type: "gotoType"; text: string }
  | { type: "summaryClose" } | { type: "reviewMove"; by: -1 | 1 } | { type: "decide"; verdict: "accepted" | "rejected" } | { type: "reviewRead" }
  | { type: "helpClose" } | { type: "helpSwap" }
  | { type: "replayExit" } | { type: "replayStep"; by: -1 | 1 } | { type: "replayHome" } | { type: "replayEnd" } | { type: "replayTurn"; by: -1 | 1 }
  | { type: "replayToggle" } | { type: "replaySpeed" }
  | { type: "focus"; section: SectionKey }
  | { type: "sectionLeave" } | { type: "sectionTab"; by: -1 | 1 } | { type: "sectionFold" } | { type: "sectionMove"; by: -1 | 1 } | { type: "sectionEnter" }
  | { type: "cycleFlow" } | { type: "flowStep"; by: -1 | 1 } | { type: "exitFlow" }
  | { type: "search" } | { type: "back" } | { type: "open"; enter: boolean } | { type: "parent" } | { type: "views" } | { type: "themes" }
  | { type: "ask" } | { type: "map" } | { type: "trace" } | { type: "name" } | { type: "session" } | { type: "replay" } | { type: "work" } | { type: "swap" }
  | { type: "listMove"; by: -1 | 1 } | { type: "traverse"; direction: Direction }
  | { type: "endFiles" } | { type: "fileMove"; by: -1 | 1; page: boolean } | { type: "refreshFiles" } | { type: "fileOpen" }
  | { type: "help" } | { type: "inspector" } | { type: "scrollInspector"; by: -1 | 1 } | { type: "subagents" } | { type: "follow" } | { type: "files" }
  | { type: "nextNode"; by: -1 | 1 } | { type: "zoom"; by: -1 | 1 } | { type: "pan"; direction: Direction } | { type: "fit" } | { type: "actualSize" } | { type: "centre" };

const directions: Record<string, Direction> = { h: "left", j: "down", k: "up", l: "right", left: "left", down: "down", up: "up", right: "right" };

/** What a key means where it was pressed; undefined leaves it to the focused input untouched. */
export function keyAction(key: KeyPress, mode: KeyMode): Action | undefined {
  if (key.ctrl && key.name === "c") return { type: "stop" };
  if (mode.layer === "visit") return { type: "swallow" };
  if (mode.layer === "ask") {
    if (key.name === "escape") return { type: "askCancel" };
    if (key.name === "tab") return { type: "askTab" };
    if (mode.askContext) {
      if (key.name === "left" || key.name === "h") return { type: "askChoose", by: 2 };
      if (key.name === "right" || key.name === "l") return { type: "askChoose", by: 1 };
      if (key.name === "space" || key.sequence === " ") return { type: "askToggle" };
      return { type: "swallow" };
    }
    if (key.name === "return" && !key.meta && !key.option && !key.shift) return { type: "askSend" };
    return undefined;
  }
  if (mode.layer === "picker") {
    if (key.name === "escape" || key.sequence === "T") return { type: "themeCancel" };
    if (key.name === "return") return { type: "themeKeep" };
    if (key.name === "up" || key.name === "k") return { type: "themeMove", to: "up" };
    if (key.name === "down" || key.name === "j") return { type: "themeMove", to: "down" };
    if (key.name === "pageup" || key.name === "pagedown" || key.name === "home" || key.name === "end") return { type: "themeMove", to: key.name };
    return { type: "swallow" };
  }
  if (mode.layer === "goto") {
    if (key.name === "escape") return { type: "gotoClose" };
    if (key.name === "return") return { type: "gotoGo" };
    if (key.name === "up" || (key.ctrl && key.name === "p")) return { type: "gotoMove", by: -1 };
    if (key.name === "down" || (key.ctrl && key.name === "n")) return { type: "gotoMove", by: 1 };
    if (key.name === "pageup") return { type: "gotoPage", by: -1 };
    if (key.name === "pagedown") return { type: "gotoPage", by: 1 };
    if (key.name === "home") return { type: "gotoHome" };
    if (key.name === "end") return { type: "gotoEnd" };
    if (key.ctrl && key.name === "u") return { type: "gotoClear" };
    if (key.name === "backspace") return { type: "gotoErase" };
    if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") return { type: "gotoType", text: key.sequence };
    return { type: "swallow" };
  }
  if (mode.layer === "summary") {
    if (key.name === "escape" || key.name === "c" || key.sequence === "?") return { type: "summaryClose" };
    if (key.name === "j" || key.name === "down") return { type: "reviewMove", by: 1 };
    if (key.name === "k" || key.name === "up") return { type: "reviewMove", by: -1 };
    if (key.name === "y") return { type: "decide", verdict: "accepted" };
    if (key.name === "n") return { type: "decide", verdict: "rejected" };
    if (key.name === "e") return { type: "reviewRead" };
    return { type: "swallow" };
  }
  if (mode.layer === "help") {
    if (key.name === "escape" || key.sequence === "?") return { type: "helpClose" };
    if (key.name === "v" && !key.ctrl) return { type: "helpSwap" };
    return { type: "swallow" };
  }
  const plain = !key.ctrl && !key.meta;
  if (plain && mode.replay) {
    if (key.name === "escape" || key.name === "p") return { type: "replayExit" };
    if (key.name === "right") return { type: "replayStep", by: 1 };
    if (key.name === "left") return { type: "replayStep", by: -1 };
    if (key.name === "home") return { type: "replayHome" };
    if (key.name === "end") return { type: "replayEnd" };
    if (key.sequence === "]") return { type: "replayTurn", by: 1 };
    if (key.sequence === "[") return { type: "replayTurn", by: -1 };
    if (key.name === "space" || key.sequence === " ") return { type: "replayToggle" };
    if (key.name === "s") return { type: "replaySpeed" };
  }
  const files = mode.fileMode;
  if (!files && plain && /^[1-4]$/.test(key.sequence)) return { type: "focus", section: (["activity", mode.flow ? "steps" : "connections", "files", "flows"] as const)[Number(key.sequence) - 1] ?? "activity" };
  if (mode.focusSection && !files) {
    if (key.name === "escape") return { type: "sectionLeave" };
    if (key.name === "tab") return { type: "sectionTab", by: key.shift ? -1 : 1 };
    if (key.name === "space" || key.sequence === " ") return { type: "sectionFold" };
    if (key.name === "up" || key.name === "k") return { type: "sectionMove", by: -1 };
    if (key.name === "down" || key.name === "j") return { type: "sectionMove", by: 1 };
    if ((key.name === "left" || key.name === "h") && !key.shift) return { type: "sectionLeave" };
    if ((key.name === "right" || key.name === "l") && !key.shift) return { type: "swallow" };
    if (key.name === "return") return { type: "sectionEnter" };
  }
  if (!files && key.sequence === "F") return { type: "cycleFlow" };
  if (!files && mode.flow && plain) {
    if (key.sequence === "]") return { type: "flowStep", by: 1 };
    if (key.sequence === "[") return { type: "flowStep", by: -1 };
    if (key.name === "escape") return { type: "exitFlow" };
  }
  if (!files) {
    if (key.sequence === "/") return { type: "search" };
    if (key.name === "b") return { type: "back" };
    if (key.name === "o" || key.name === "return") return { type: "open", enter: key.name === "return" };
    if (key.name === "backspace") return { type: "parent" };
    if (key.name === "g" && !key.ctrl && !key.shift) return { type: "views" };
    if (key.name === "t" && !key.ctrl && key.sequence === "T") return { type: "themes" };
    const agent = ({ t: "ask", m: "map", d: "trace", n: "name", c: "session", p: "replay", w: "work", v: "swap" } as const)[key.name as "t"];
    if (agent && !key.ctrl) return { type: agent };
  }
  const direction = directions[key.name];
  if (!files && mode.listMode && ["up", "down", "j", "k"].includes(key.name)) return { type: "listMove", by: key.name === "up" || key.name === "k" ? -1 : 1 };
  if (!files && direction && (key.name.length === 1) === mode.vim && !key.shift) return { type: "traverse", direction };
  if (!files && key.name === "q") return { type: "stop" };
  if (files) {
    if (key.name === "escape") return { type: "endFiles" };
    if (["up", "down", "tab", "pageup", "pagedown"].includes(key.name)) return { type: "fileMove", by: key.name === "up" || key.name === "pageup" || key.name === "tab" && key.shift ? -1 : 1, page: key.name === "pageup" || key.name === "pagedown" };
    if (key.ctrl && key.name === "r") return { type: "refreshFiles" };
    if (key.name === "return") return { type: "fileOpen" };
    return { type: "pass" };
  }
  if (key.sequence === "?") return { type: "help" };
  if (key.name === "i") return { type: "inspector" };
  if (key.name === "pageup" || key.name === "pagedown") return { type: "scrollInspector", by: key.name === "pageup" ? -1 : 1 };
  if (key.name === "s") return { type: "subagents" };
  if (key.name === "a") return { type: "follow" };
  if (key.name === "e") return { type: "files" };
  if (key.name === "tab") return { type: "nextNode", by: key.shift ? -1 : 1 };
  if (key.name === "+" || key.name === "=" || key.sequence === "+") return { type: "zoom", by: 1 };
  if (key.name === "-" || key.sequence === "-") return { type: "zoom", by: -1 };
  if (direction) return { type: "pan", direction };
  if (key.name === "f") return { type: "fit" };
  if (key.name === "0") return { type: "actualSize" };
  if (key.name === "r") return { type: "centre" };
  return { type: "idle" };
}

/** A row of the keyboard help: the keys, what they do, and the actions they stand for (so a test can check every action is listed once). */
export type HelpRow = readonly [key: string, label: string, does: readonly Action["type"][]];
export type Tier = 1 | 2 | 3;

/**
 * The keyboard help in three tiers, named for how far along the user is with this codebase: everyone starts by understanding it, then directs the
 * agent, then shapes the map. `t` is in the first two (asking and telling are one key). `vim` says which family selects (the other pans).
 */
export const helpGroups = (vim: boolean): { name: "Understand it" | "Direct it" | "Shape the map"; tier: Tier; rows: HelpRow[] }[] => {
  const arrows = "← ↑ ↓ →";
  return [
    { name: "Understand it", tier: 1, rows: [["tab, click", "select a box", ["nextNode"]], [vim ? "h j k l" : arrows, "select a neighbour", ["traverse", "listMove"]],
      ["enter, o", "into a group, open a link", ["open"]], ["backspace", "up to the parent", ["parent"]], ["t", "ask how something works", ["ask"]],
      ["F", "step through a flow", ["cycleFlow"]], ["[ ]", "steps, esc leaves", ["flowStep", "exitFlow"]], ["?", "this help", ["help"]]] },
    { name: "Direct it", tier: 2, rows: [["t", "tell it what to change", ["ask"]], ["c", "session and review", ["session"]],
      ["a", "follow the work", ["follow"]], ["w", "jump to the agent's work", ["work"]], ["e", "files (in a flow: its code)", ["files"]],
      ["/", "search views, boxes, files", ["search"]], ["g", "go to any view", ["views"]], ["b", "back", ["back"]], ["i", "inspector", ["inspector"]],
      ["f", "fit everything", ["fit"]], ["0  + -", "actual size, zoom", ["actualSize", "zoom"]], ["r", "centre the selection", ["centre"]], [vim ? arrows : "h j k l", "pan", ["pan"]]] },
    { name: "Shape the map", tier: 3, rows: [["d", "ask it to trace a flow", ["trace"]], ["m", "ask it to improve the map", ["map"]], ["n", "name and note it yourself", ["name"]],
      ["p", "replay the session", ["replay"]], ["s", "subagent calls", ["subagents"]], ["T", "choose a theme", ["themes"]],
      ["1–4", "focus a card, esc leaves", ["focus", "sectionLeave"]], ["j k", "move in the card", ["sectionMove"]], ["space", "fold the card", ["sectionFold"]],
      ["PgUp PgDn", "scroll the inspector", ["scrollInspector"]], ["v", "swap hjkl and arrows", ["swap"]], ["q", "quit", ["stop"]]] },
  ];
};

/** The tier a key's action belongs to, for the accent in `?`; `t` counts as the first (it asks before it tells). Undefined for a mode's own keys. */
export const tierOf = (action: Action): Tier | undefined => {
  const tiers = helpGroups(true).flatMap(group => group.rows.flatMap(row => row[2].map(does => [does, group.tier] as const)));
  return tiers.find(([does]) => does === action.type)?.[1];
};

/** The footer's keys for each mode that names them, and the hints on the modals' borders. */
export const hints = {
  section: {
    steps: [["↑↓", "step"], ["enter", "show"], ["tab", "next"], ["1–4", "card"], ["space", "fold"], ["esc", "diagram"]],
    flows: [["↑↓", "move"], ["enter", "trace on the diagram"], ["tab", "next"], ["1–4", "card"], ["space", "fold"], ["esc", "diagram"]],
    connections: [["↑↓", "move"], ["enter", "show in diagram"], ["tab", "next"], ["1–4", "card"], ["space", "fold"], ["esc", "diagram"]],
    files: [["↑↓", "move"], ["enter", "open"], ["tab", "next"], ["1–4", "card"], ["space", "fold"], ["esc", "diagram"]],
    activity: [["↑↓", "scroll"], ["tab", "next"], ["1–4", "card"], ["space", "fold"], ["esc", "diagram"]],
  } satisfies Record<SectionKey, Hint[]>,
  replay: (playing: boolean, speed: number): Hint[] => [["space", playing ? "pause" : "play"], ["←→", "step"], ["[ ]", "turn"], ["s", `${speed}x`], ["esc", "exit"]],
  flow: [["[ ]", "step"], ["F", "next flow"], ["esc", "exit"]] as Hint[],
  files: [["enter", "open"], ["ctrl+r", "refresh"], ["esc", "back"]] as Hint[],
  help: [["esc", "close"], ["v", "swap hjkl and arrows"]] as Hint[],
  review: [["j k", "move"], ["e", "read it"], ["y", "accept"], ["n", "reject"], ["esc", "close"]] as Hint[],
  close: [["esc", "close"]] as Hint[],
  goto: [["type", "search"], ["↑↓", "choose"], ["enter", "go"], ["esc", "close"]] as Hint[],
  themes: [["↑↓", "preview"], ["enter", "keep"], ["esc", "cancel"]] as Hint[],
  askSend: [["enter", "send"], ["alt+enter", "new line"], ["esc", "cancel"]] as Hint[],
  askSave: (next: boolean): Hint[] => [["enter", next ? "next" : "save"], ["esc", "cancel"]],
  askQuestion: [["enter", "send"], ["alt+enter", "new line"], ["tab", "context"], ["esc", "cancel"]] as Hint[],
  askContext: [["← →", "choose"], ["space", "toggle"], ["tab", "back to question"], ["esc", "cancel"]] as Hint[],
};
