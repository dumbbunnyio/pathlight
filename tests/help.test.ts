import { expect, test } from "bun:test";
import { helpContent } from "../src/viewer/help";
import { type Action, helpGroups, type KeyMode, type KeyPress, keyAction, tierOf } from "../src/viewer/keys";

const press = (name: string, sequence = name.length === 1 ? name : "", extra: Partial<KeyPress> = {}): KeyPress => ({ name, sequence, ctrl: false, meta: false, shift: false, ...extra });
const main: KeyMode = { layer: "main", askContext: false, replay: false, fileMode: false, focusSection: undefined, flow: false, listMode: false, cards: ["activity", "connections", "files"], vim: true };
const text = (content: ReturnType<typeof helpContent>["content"]) => content.chunks.map(chunk => chunk.text).join("");

test("? names three tiers, in the order a user goes through them", () => {
  expect(helpGroups(true).map(group => group.name)).toEqual(["Understand it", "Direct it", "Shape the map"]);
  expect(helpGroups(true).map(group => group.tier)).toEqual([1, 2, 3]);
});

test("every action a key has on the diagram, in a flow, in the node list or in a focused card is in exactly one tier; t is in the first two", () => {
  // A mode's own keys (replay, the file filter, a card's tab and enter) are named in the footer while it is on, not in `?`.
  const footerOnly = new Set<Action["type"]>(["replayExit", "replayStep", "replayHome", "replayEnd", "replayTurn", "replayToggle", "replaySpeed",
    "endFiles", "fileMove", "refreshFiles", "fileOpen", "sectionEnter", "idle", "pass", "swallow"]);
  const names = ["tab", "return", "backspace", "escape", "space", "pageup", "pagedown", "left", "right", "up", "down", "+", "-", "=",
    ..."abcdefghijklmnopqrstuvwxyz".split(""), ..."0123456789".split("")];
  const presses = [...names.map(name => press(name)), ...[..."FT?/[]"].map(sequence => press(sequence === "T" ? "t" : sequence, sequence, { shift: sequence === "T" || sequence === "F" })),
    press("tab", "", { shift: true }), press("l", "L", { shift: true })];
  const modes: KeyMode[] = [main, { ...main, vim: false }, { ...main, flow: true }, { ...main, listMode: true }, { ...main, focusSection: "connections" }];
  const seen = new Set<Action["type"]>();
  for (const mode of modes) for (const key of presses) { const action = keyAction(key, mode); if (action && !footerOnly.has(action.type)) seen.add(action.type); }
  const listed = helpGroups(true).flatMap(group => group.rows.flatMap(row => row[2].map(does => ({ does, tier: group.tier }))));
  for (const does of seen) {
    const tiers = listed.filter(entry => entry.does === does).map(entry => entry.tier);
    expect(tiers, does).toEqual(does === "ask" ? [1, 2] : [expect.any(Number)]);
  }
  // Nothing is listed that no key does.
  for (const { does } of listed) expect(seen.has(does), does).toBe(true);
  expect(tierOf({ type: "ask" })).toBe(1);
  expect(tierOf({ type: "follow" })).toBe(2);
  expect(tierOf({ type: "trace" })).toBe(3);
  expect(tierOf({ type: "replayStep", by: 1 })).toBeUndefined();
});

test("from 100 columns the tiers stand side by side; below that they stack, and the accent follows the tier the user is in", () => {
  const wide = helpContent({ tier: 1, vim: true, screenWidth: 100, version: "0" });
  const first = text(wide.content).split("\n")[0]!;
  expect(first).toMatch(/^Understand it ─+ +Direct it ─+ +Shape the map ─+$/);
  for (const line of text(wide.content).split("\n")) expect(line.length).toBe(first.length);
  expect(wide.width).toBeLessThanOrEqual(96);
  const narrow = helpContent({ tier: 1, vim: true, screenWidth: 80, version: "0" });
  const rows = text(narrow.content).split("\n");
  expect(rows.filter(line => /^(Understand it|Direct it|Shape the map) ─/.test(line))).toHaveLength(3);
  expect(rows.findIndex(line => line.startsWith("Direct it"))).toBeGreaterThan(rows.findIndex(line => line.startsWith("Understand it")));
  expect(narrow.height).toBe(rows.length);
  const accent = (tier: 1 | 2 | 3) => helpContent({ tier, vim: true, screenWidth: 140, version: "0" }).content.chunks.filter(chunk => /^(Understand it|Direct it|Shape the map)$/.test(chunk.text));
  for (const tier of [1, 2, 3] as const) {
    const heads = accent(tier);
    expect(heads.filter(chunk => chunk.fg?.equals(heads[tier - 1]!.fg!))).toHaveLength(1);
  }
});

test("tab moves through what is on screen: into the inspector and through its cards, a step in a flow, and never another box", () => {
  const tab = press("tab", ""), back = press("tab", "", { shift: true });
  expect(keyAction(tab, main)).toEqual({ type: "sectionTab", by: 1 });
  expect(keyAction(back, main)).toEqual({ type: "sectionTab", by: -1 });
  expect(keyAction(tab, { ...main, focusSection: "connections" })).toEqual({ type: "sectionTab", by: 1 });
  expect(keyAction(back, { ...main, focusSection: "files" })).toEqual({ type: "sectionTab", by: -1 });
  expect(keyAction(tab, { ...main, listMode: true })).toEqual({ type: "sectionTab", by: 1 });
  // In a flow it is ] and [, from the diagram or a card, and [ ] still work.
  for (const focusSection of [undefined, "steps", "activity"] as const) {
    expect(keyAction(tab, { ...main, flow: true, focusSection })).toEqual({ type: "flowStep", by: 1 });
    expect(keyAction(back, { ...main, flow: true, focusSection })).toEqual({ type: "flowStep", by: -1 });
  }
  expect(keyAction(press("]"), { ...main, flow: true })).toEqual({ type: "flowStep", by: 1 });
  expect(keyAction(press("["), { ...main, flow: true })).toEqual({ type: "flowStep", by: -1 });
  // Esc still leaves a card; the file filter keeps tab for its rows.
  expect(keyAction(press("escape", ""), { ...main, focusSection: "connections" })).toEqual({ type: "sectionLeave" });
  expect(keyAction(tab, { ...main, fileMode: true })).toEqual({ type: "fileMove", by: 1, page: false });
  expect(helpGroups(true)[0]!.rows.slice(0, 2).map(row => `${row[0]}  ${row[1]}`)).toEqual(["click, h j k l  select a box, a neighbour", "tab  through the inspector, in a flow: next step"]);
  expect(helpGroups(false)[0]!.rows[0]![0]).toBe("click, ← ↑ ↓ →");
});

test("h j k l stay on their side: in a focused card left and right do nothing, and only esc, tab and the numbers leave", () => {
  for (const name of ["h", "l", "left", "right"]) expect(keyAction(press(name), { ...main, focusSection: "connections" }), name).toEqual({ type: "swallow" });
  expect(keyAction(press("1"), { ...main, focusSection: "connections" })).toEqual({ type: "focus", section: "activity" });
  expect(helpGroups(true).flatMap(group => group.rows).find(row => row[0] === "1–4")?.[1]).toBe("focus a card, esc or tab leaves");
});
