import { expect, test } from "bun:test";
import { badgeContent, reviewBadge, staleBadge } from "../src/viewer/header";

const stale = { version: 1 as const, time: 0, unmapped: 3, unmatched: 0, unsupported: 0, undeclared: 0 };
const text = (chunks: { text: string }[]) => chunks.map(chunk => chunk.text).join("");

test("new dependencies and an out-of-date check are one badge, shortened detail first", () => {
  expect(text(reviewBadge(2, stale, 200))).toBe("▲ 2 new dependencies · 3 files not in the model · c review ");
  expect(text(reviewBadge(2, stale, 50))).toBe("▲ 2 new dependencies · out of date · c review ");
  expect(text(reviewBadge(1, stale, 32))).toBe("▲ 1 new dependency · c review ");
  expect(text(reviewBadge(2, stale, 12))).toBe("▲ c review ");
  expect(reviewBadge(2, stale, 5)).toEqual([]);
});

test("in sync says what it covers when most of the source is in languages the scan does not read", () => {
  const clean = { version: 1 as const, time: 0, unmapped: 0, unmatched: 0, unsupported: 0, undeclared: 0 };
  expect(text(staleBadge({ ...clean, read: 5, unread: 435 }, 80, 60_000))).toBe("✓ in sync · TS/JS only ");
  expect(text(staleBadge({ ...clean, read: 5, unread: 435 }, 20, 60_000))).toBe("✓ TS/JS only ");
  expect(text(staleBadge({ ...clean, read: 5, unread: 435 }, 14, 60_000))).toBe("✓ TS/JS only ");
  // Mostly read, or an old stamp that does not say: as before.
  expect(text(staleBadge({ ...clean, read: 500, unread: 10 }, 80, 60_000))).toBe("✓ in sync ");
  expect(text(staleBadge(clean, 80, 60_000))).toBe("✓ in sync ");
});

// Say nothing when nothing is wrong: a clean check has no age, the session no id; the age stays where it matters, on an out-of-date check.
test("a clean check and a live session say only that", () => {
  const clean = { version: 1 as const, time: 0, unmapped: 0, unmatched: 0, unsupported: 0, undeclared: 0 };
  expect(text(staleBadge(clean, 80, 3_600_000))).toBe("✓ in sync ");
  expect(text(staleBadge(stale, 80, 60_000))).toBe("▲ out of date: 3 files not in the model · checked 1m ago ");
  const badge = badgeContent({ width: 140, replay: false, live: "claude:6323de6a", bound: true, watching: true, busy: false, open: 0, stale: clean, now: 0 });
  expect(typeof badge === "string" ? badge : badge.chunks.map(chunk => chunk.text).join("")).toBe("✓ in sync ● live ");
});
