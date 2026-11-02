import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { caveatLine, headContent, hiddenLine, opensLine, pinnedLines, sectionHeader, splitDescription } from "../src/viewer/inspector-view";
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

test("the head keeps one caveat from the scan's counts, only when the scan read fewer of the box's files than e lists", () => {
  expect(caveatLine("6 files, 419 lines", 14)).toBe("6 of 14 files read by the scan");
  expect(caveatLine("14 files, 419 lines", 14)).toBe("");
  expect(caveatLine("5 Go files, 1,952 lines, not read by the scan: its connections are not drawn", 7)).toBe("5 Go files not read by the scan");
  expect(caveatLine("mealie: 485 files, 54,815 lines", 485)).toBe("");
  expect(caveatLine("6 files, 419 lines", 0)).toBe("");
});

test("the head's title row names no kind; the agent's mark stays while it fits beside the title", () => {
  const row = (title: string, width: number, by?: "agent" | "human") => headContent({ title, by, planned: false, tags: [], description: "", mapped: 0, opens: "", width }).title.chunks.map(chunk => chunk.text).join("");
  expect(row("Optional integrations", 42, "agent")).toBe(`Optional integrations${" ".repeat(16)}agent`);
  expect(row("Optional integrations", 42)).toBe("Optional integrations");
  expect(row("Optional integrations", 26, "agent")).toBe("Optional integrations");
});

// A Mealie-shaped description: the agent's note, then the draft's counts. The head shows the note, and the counts only as a caveat when the scan read
// fewer files than are mapped; never the line count.
test("a drafted box's head is its note, and the counts only as a caveat", () => {
  const about = (mapped: number) => headContent({ title: "Backend API and services", by: "agent", planned: false, tags: [], description: { txt: "FastAPI app with routes and services. · 485 files, 54,815 lines" },
    note: "FastAPI app with routes and services.", mapped, opens: "", width: 60 }).about.chunks.map(chunk => chunk.text).join("");
  expect(about(485)).toBe("FastAPI app with routes and services.");
  expect(about(500)).toBe("FastAPI app with routes and services.\n485 of 500 files read by the scan");
  expect(about(500)).not.toContain("lines");
});

test("with nothing selected the head says what the app is, in the body colour under No selection; with a selection it is the selection's", () => {
  const head = (title: string | undefined) => headContent({ title, planned: false, tags: [], description: { txt: "Records calls. · 6 files, 419 lines" }, note: "Records calls.",
    mapped: 6, opens: "", width: 40, app: "A team wiki: a React client and a Koa server that share a document model." });
  const none = head(undefined);
  expect(none.title.chunks.map(chunk => chunk.text).join("").trim()).toBe("No selection");
  expect(none.about.chunks.map(chunk => chunk.text).join("")).toBe("A team wiki: a React client and a Koa\nserver that share a document model.");
  expect(none.rows).toBe(3);
  expect(head("Activity").about.chunks.map(chunk => chunk.text).join("")).toBe("Records calls.");
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
  const mode = (cards: KeyMode["cards"], flow = false): KeyMode => ({ layer: "main", replay: false, fileMode: false, focusSection: undefined, flow, listMode: false, cards, vim: true });
  const key = (digit: string, cards: KeyMode["cards"], flow = false) => keyAction({ name: digit, sequence: digit, ctrl: false, meta: false, shift: false }, mode(cards, flow));
  for (const shown of [["activity", "connections", "flows"], ["connections"], ["activity", "steps"], ["steps"]] as const) {
    const cards = numberedCards(shown);
    cards.forEach((card, index) => expect(key(String(index + 1), cards, shown.includes("steps" as never))).toEqual({ type: "focus", section: card }));
    expect(key(String(cards.length + 1), cards)).toEqual({ type: "idle" });
  }
});

test("a box that opens a view the draft thinned says how many smaller boxes that view leaves out, and names no key", () => {
  expect(hiddenLine("7 smaller ones are not shown here; internal_all lists everything.")).toBe("7 smaller boxes are not drawn in its view");
  expect(hiddenLine("1 smaller one is not shown here; internal_all lists everything.")).toBe("1 smaller box is not drawn in its view");
  expect(hiddenLine("")).toBe("");
});

test("a box whose children are drawn here and that opens a view says what o opens, drawn as an action with the key in the body color", () => {
  const head = headContent({ title: "Commerce", planned: false, tags: [], description: { txt: "4 files, 120 lines" }, mapped: 4,
    opens: [opensLine("Checkout"), hiddenLine("2 smaller ones are not shown here")].join("\n"), width: 50 });
  const chunks = head.about.chunks.filter(chunk => chunk.text !== "\n");
  expect(chunks.map(chunk => chunk.text)).toEqual(["o", " opens Checkout", "2 smaller boxes are not drawn in its view"]);
  expect(chunks.map(chunk => chunk.fg)).toEqual([RGBA.fromHex(palette.body), RGBA.fromHex(palette.muted), RGBA.fromHex(palette.muted)]);
  expect(head.rows).toBe(3);
});
