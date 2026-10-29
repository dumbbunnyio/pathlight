import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { clock, renderText, talkContent, talkHeader, talkIncludeLine } from "../src/viewer/talk-view";

const text = (lines: { text: string }[][]) => lines.map(line => line.map(chunk => chunk.text).join(""));
const plain = (content: { chunks: { text: string }[] }) => content.chunks.map(chunk => chunk.text).join("");

test("the host's text is rendered lightly: paragraphs wrap on words, list items hang, code keeps its lines on the darker ground, headings are bold", () => {
  const lines = renderText("## Where it happens\n\nCancellation goes through OrderService.cancel, which releases the courier first.\n\n- one item that is long enough to wrap onto a second line\n\n```ts\nawait courier.release(order.id) // a very long line of code that is not wrapped\n```", 30);
  expect(text(lines)).toEqual([
    "Where it happens", "",
    "Cancellation goes through", "OrderService.cancel, which", "releases the courier first.", "",
    "- one item that is long enough", "  to wrap onto a second line", "",
    "  await courier.release(order…",
  ]);
  expect(lines[0]![0]!.attributes).toBeGreaterThan(0);
  expect(lines.at(-1)![0]!.bg).toBeDefined();
  // A word longer than the column is cut across lines, never run off it.
  expect(text(renderText("see https://example.com/a/very/long/path/that/goes/on", 20)).every(line => line.length <= 20)).toBe(true);
});

test("the conversation is each message under its role and time, a blank row apart, the newest last; with none, why, wrapped", () => {
  const at = new Date(2026, 9, 29, 12, 4).getTime();
  const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
  const made = talkContent([{ id: "1", role: "you", at, text: "where?" }, { id: "2", role: "agent", at, text: long }], { width: 40, empty: "" });
  const rows = plain(made.content).split("\n");
  expect(rows.slice(0, 4)).toEqual([`you · ${clock(at)}`, "where?", "", `agent · ${clock(at)}`]);
  expect(clock(at)).toBe("12:04");
  expect(rows.at(-1)).toContain("word59");
  expect(made.lines).toBe(rows.length);
  expect(rows.every(row => row.length <= 40)).toBe(true);
  const empty = talkContent([], { width: 30, empty: "no session bound yet · the reply lands in the agent pane" });
  expect(plain(empty.content).split("\n")).toEqual(["no session bound yet · the", "reply lands in the agent pane"]);
});

test("the header names the subject, and at the right what the agent is doing, else the session", () => {
  const head = (state: Parameters<typeof talkHeader>[0]["state"], session?: string) => plain(talkHeader({ subject: "Orders", state, spin: "⠋", session, width: 56 }));
  expect(head(undefined, "claude:3f2a9c")).toMatch(/^Talk · Orders +● claude:3f2a9c$/);
  expect(head("working")).toMatch(/working ⠋$/);
  expect(head("waiting")).toMatch(/waiting for you in its pane$/);
  expect(head("done")).toMatch(/ done$/);
  expect(head(undefined)).toMatch(/○ no session$/);
  for (const state of [undefined, "working", "waiting", "done"] as const) expect(head(state, "claude:3f2a9c")).toHaveLength(56);
});

test("what goes with a question fits its column: the word include goes first, then draw it takes a second row", () => {
  const line = (width: number) => talkIncludeLine({ tab: "ask", include: [true, true, false, true], counts: [6, 3, 2], focus: -1, mapReady: true, width, background: RGBA.fromHex("#000000") });
  expect(plain(line(70).content)).toBe("include ● files 6  ● connections 3  ○ activity 2  ● draw it");
  expect(plain(line(54).content)).toBe("● files 6  ● connections 3  ○ activity 2  ● draw it");
  expect(plain(line(44).content)).toBe("● files 6  ● connections 3  ○ activity 2\n● draw it");
  expect(line(44).rows).toBe(2);
  const map = talkIncludeLine({ tab: "map", include: [], counts: [], focus: -1, mapReady: false, width: 50, background: RGBA.fromHex("#000000") });
  expect(plain(map.content)).toBe("needs a map drawn by pathlight draft");
});
