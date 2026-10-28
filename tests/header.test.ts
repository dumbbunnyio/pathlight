import { expect, test } from "bun:test";
import { reviewBadge } from "../src/viewer/header";

const stale = { version: 1 as const, time: 0, unmapped: 3, unmatched: 0, unsupported: 0, undeclared: 0 };
const text = (chunks: { text: string }[]) => chunks.map(chunk => chunk.text).join("");

test("new dependencies and an out-of-date check are one badge, shortened detail first", () => {
  expect(text(reviewBadge(2, stale, 200))).toBe("▲ 2 new dependencies · 3 files not in the model · c review ");
  expect(text(reviewBadge(2, stale, 50))).toBe("▲ 2 new dependencies · out of date · c review ");
  expect(text(reviewBadge(1, stale, 32))).toBe("▲ 1 new dependency · c review ");
  expect(text(reviewBadge(2, stale, 12))).toBe("▲ c review ");
  expect(reviewBadge(2, stale, 5)).toEqual([]);
});
