import { expect, test } from "bun:test";
import { fuzzyScore } from "../src/fuzzy";

test("fuzzy matching needs every word's letters in order, and prefers tight, word-start matches", () => {
  expect(fuzzyScore("hlp", "hono / helper")).toBeDefined();
  expect(fuzzyScore("pleh", "hono / helper")).toBeUndefined();
  expect(fuzzyScore("hlp mid", "helper middleware")).toBeDefined();
  expect(fuzzyScore("hlp zzz", "helper middleware")).toBeUndefined();
  expect(fuzzyScore("MID", "helper middleware")).toBeDefined();
  // A tight, word-start match scores higher than letters scattered across the text.
  expect(fuzzyScore("mid", "middleware")!).toBeGreaterThan(fuzzyScore("mid", "m i d d l e")!);
});
