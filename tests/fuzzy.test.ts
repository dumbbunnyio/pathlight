import { expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "../src/fuzzy";

test("fuzzy matching needs every word's letters in order, and prefers tight, word-start matches", () => {
  expect(fuzzyScore("hlp", "hono / helper")).toBeDefined();
  expect(fuzzyScore("pleh", "hono / helper")).toBeUndefined();
  expect(fuzzyScore("hlp mid", "helper middleware")).toBeDefined();
  expect(fuzzyScore("hlp zzz", "helper middleware")).toBeUndefined();
  expect(fuzzyScore("MID", "helper middleware")).toBeDefined();
  const items = ["hono / adapter", "hono / middleware", "middleware near", "m i d d l e"];
  expect(fuzzyFilter("mid", items, item => item)).toEqual(["hono / middleware", "middleware near", "m i d d l e"]);
  expect(fuzzyFilter("zzz", items, item => item)).toEqual([]);
  expect(fuzzyFilter("  ", items, item => item)).toEqual(items);
});
