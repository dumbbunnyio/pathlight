import { expect, test } from "bun:test";
import { countsLine, headContent, splitDescription } from "../src/viewer/inspector-view";

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
