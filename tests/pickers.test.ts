import { expect, test } from "bun:test";
import { gotoColumns, gotoContent, type Pick, splitTitle } from "../src/viewer/pickers";

const text = (content: { chunks: readonly { text: string }[] }) => content.chunks.map(chunk => chunk.text).join("");
const holder = "Mealie: self-hosted recipe manager";

test("a view's title splits at its last ` / `: the own name, then the holder; a title without one is all name", () => {
  expect(splitTitle(`${holder} / Backend translations`)).toEqual({ name: "Backend translations", holder });
  expect(splitTitle("Backend server / everything")).toEqual({ name: "everything", holder: "Backend server" });
  expect(splitTitle("Packages")).toEqual({ name: "Packages", holder: "" });
});

test("a view's row says its own name first in the text colour, the holder after it dimmed and cut first, and its node count at the right", () => {
  const rows: Pick[] = [
    { kind: "view", name: "Backend translations", holder, aliases: [], here: false, view: "a", detail: "5 nodes" },
    { kind: "view", name: "Packages", aliases: [], here: true, view: "b", detail: "2 nodes" },
  ];
  expect([gotoColumns(140), gotoColumns(100), gotoColumns(70)]).toEqual([96, 90, 60]);
  for (const screenWidth of [140, 100, 70]) {
    const { content } = gotoContent(rows, { query: "", index: 0, top: 0, rows: 2, screenWidth, viewOf: () => "" });
    const lines = text(content).split("\n");
    const inner = gotoColumns(screenWidth);
    // Every row is exactly the picker's width: nothing spills over the frame.
    for (const line of lines.slice(1, 3)) expect(line.length).toBe(inner);
    expect(lines[1]).toStartWith(" view    Backend translations Mealie");
    expect(lines[1]).toEndWith(" 5 nodes  ");
    expect(lines[2]).toEndWith(" ● here   ");
    // The own name is in the text colour, the holder in the muted one.
    const chunks = content.chunks.filter(chunk => chunk.text.trim());
    const name = chunks.find(chunk => chunk.text === "Backend translations")!, after = chunks[chunks.indexOf(name) + 1]!;
    expect(after.text.trim()).toStartWith("Mealie");
    expect(after.fg).not.toEqual(name.fg);
  }
  // Wide, the whole holder fits; narrow, it is cut and the name is not.
  expect(text(gotoContent(rows, { query: "", index: 0, top: 0, rows: 2, screenWidth: 140, viewOf: () => "" }).content)).toContain(`Backend translations ${holder}`);
  const narrow = text(gotoContent(rows, { query: "", index: 0, top: 0, rows: 2, screenWidth: 70, viewOf: () => "" }).content).split("\n")[1]!;
  expect(narrow).toContain("Backend translations Mealie");
  expect(narrow).toContain("…");
});

test("the right-hand column is as wide as its longest row needs, up to 26", () => {
  const box: Pick = { kind: "box", name: "api", aliases: [], here: false, element: "x.api", detail: "" };
  const wide = (where: string) => text(gotoContent([box], { query: "", index: 0, top: 0, rows: 1, screenWidth: 140, viewOf: () => where }).content).split("\n")[1]!;
  expect(wide("Checkout")).toEndWith(" in Checkout ");
  expect(wide("Checkout")).toMatch(/api {70,}/);
  expect(wide("A view with a very long title indeed")).toMatch(/ in A view with a very lon… $/);
});
