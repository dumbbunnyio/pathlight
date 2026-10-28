import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { countsLine, headContent, pinnedLines, sectionHeader, splitDescription } from "../src/viewer/inspector-view";
import { type KeyMode, keyAction } from "../src/viewer/keys";
import { numberedCards } from "../src/viewer/widgets";
import { palette } from "../src/ui";

test("a drafted description splits into the note and the scan's counts; a person's description is all words", () => {
  expect(splitDescription("Claude skill scripts. · 6 files, 419 lines", "Claude skill scripts.")).toEqual({ words: "Claude skill scripts.", counts: "6 files, 419 lines" });
  expect(splitDescription("6 files, 419 lines", undefined)).toEqual({ words: "", counts: "6 files, 419 lines" });
  expect(splitDescription("5 Go files, 1,952 lines, not read by the scan: its connections are not drawn", undefined).words).toBe("");
  expect(splitDescription("mealie: 485 files, 54,815 lines", undefined).counts).toBe("mealie: 485 files, 54,815 lines");
  expect(splitDescription("Owns stock levels and reservations.", undefined)).toEqual({ words: "Owns stock levels and reservations.", counts: "" });
});

test("the counts line counts the files e lists, and says how many the scan read", () => {
  expect(countsLine("6 files, 419 lines", 14)).toBe("14 files · 6 read, 419 lines");
  expect(countsLine("14 files, 419 lines", 14)).toBe("14 files, 419 lines");
  expect(countsLine("5 Go files, 1,952 lines, not read by the scan: its connections are not drawn", 7)).toBe("7 files · 5 Go, 1,952 lines, not read by the scan: its connections are not drawn");
  expect(countsLine("mealie: 485 files, 54,815 lines", 485)).toBe("485 files, 54,815 lines");
  expect(countsLine("6 files, 419 lines", 0)).toBe("6 files, 419 lines");
});

test("a long title keeps the agent's mark before the kind, and drops both only when neither fits", () => {
  const row = (title: string, width: number, by?: "agent" | "human") => headContent({ title, kind: "component", by, planned: false, tags: [], description: "", mapped: 0, opens: "", width }).title.chunks.map(chunk => chunk.text).join("");
  expect(row("Optional integrations", 42, "agent")).toBe(`Optional integrations${" ".repeat(4)}component · agent`);
  expect(row("Optional integrations", 38, "agent")).toBe(`Optional integrations${" ".repeat(12)}agent`);
  expect(row("Optional integrations", 38)).toBe(`Optional integrations${" ".repeat(8)}component`);
  expect(row("Optional integrations", 26, "agent")).toBe("Optional integrations");
});

test("with nothing selected the head says what the app is, in the body colour under No selection; with a selection it is the selection's", () => {
  const head = (title: string | undefined) => headContent({ title, kind: title ? "component" : "", planned: false, tags: [], description: { txt: "Records calls. · 6 files, 419 lines" }, note: "Records calls.",
    mapped: 6, opens: "", width: 40, app: "A team wiki: a React client and a Koa server that share a document model." });
  const none = head(undefined);
  expect(none.title.chunks.map(chunk => chunk.text).join("").trim()).toBe("No selection");
  expect(none.about.chunks.map(chunk => chunk.text).join("")).toBe("A team wiki: a React client and a Koa\nserver that share a document model.");
  expect(none.rows).toBe(3);
  expect(head("Activity").about.chunks.map(chunk => chunk.text).join("")).toBe("Records calls.\n6 files, 419 lines");
});

test("until the user selects or asks, the question field offers the first question about the box the view opens on", () => {
  const field = (first: boolean, width = 40) => pinnedLines({ width, files: 3, session: false, replay: false, title: "Backend API and services", canAsk: true, background: RGBA.fromInts(0, 0, 0, 255), first })
    .ask.chunks.map(chunk => chunk.text).join("");
  expect(field(true, 60)).toBe(`› ${"how does Backend API and services work?".padEnd(57)}t`);
  expect(field(false, 60)).toBe(`› ${"ask about Backend API and services…".padEnd(57)}t`);
  expect(field(true)).toBe(`› ${"how does Backend API and services…".padEnd(37)}t`);
});

test("each card's header shows the key that focuses it, and the keys and the numbers agree with Now hidden and shown and in a flow", () => {
  const text = (styled: ReturnType<typeof sectionHeader>) => styled.chunks.map(chunk => chunk.text).join("");
  expect(text(sectionHeader({ open: true, focused: false, number: 1, name: "Now", count: "7", width: 40 }))).toMatch(/^▾ 1 Now ─+ 7$/);
  expect(text(sectionHeader({ open: false, focused: false, number: 4, name: "Files", count: "3", width: 40 }))).toMatch(/^▸ 4 Files ─+ 3$/);
  // The number is dim on a folded card and in the accent on the focused one, like the name.
  const number = (open: boolean, focused: boolean) => sectionHeader({ open, focused, number: 2, name: "Connects", count: "", width: 40 }).chunks[1]!;
  expect(number(true, false).text).toBe("2 ");
  expect(number(true, false).fg?.equals(RGBA.fromHex(palette.body))).toBe(true);
  expect(number(false, false).fg?.equals(RGBA.fromHex(palette.muted))).toBe(true);
  expect(number(true, true).fg?.equals(RGBA.fromHex(palette.accent))).toBe(true);
  // A hidden card takes no number; Files, hidden until asked for, is always the last.
  expect(numberedCards(["activity", "connections", "flows"])).toEqual(["activity", "connections", "flows", "files"]);
  expect(numberedCards(["connections"])).toEqual(["connections", "files"]);
  expect(numberedCards(["activity", "steps"])).toEqual(["activity", "steps", "files"]);
  const mode = (cards: KeyMode["cards"], flow = false): KeyMode => ({ layer: "main", askContext: false, replay: false, fileMode: false, focusSection: undefined, flow, listMode: false, cards, vim: true });
  const key = (digit: string, cards: KeyMode["cards"], flow = false) => keyAction({ name: digit, sequence: digit, ctrl: false, meta: false, shift: false }, mode(cards, flow));
  for (const shown of [["activity", "connections", "flows"], ["connections"], ["activity", "steps"], ["steps"]] as const) {
    const cards = numberedCards(shown);
    cards.forEach((card, index) => expect(key(String(index + 1), cards, shown.includes("steps" as never))).toEqual({ type: "focus", section: card }));
    expect(key(String(cards.length + 1), cards)).toEqual({ type: "idle" });
  }
});
