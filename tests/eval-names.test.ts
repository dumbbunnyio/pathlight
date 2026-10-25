import { expect, test } from "bun:test";
import { formatNameScores, passes, scoreNames, type NameReference } from "./eval/name-score";
import type { Overlay } from "../src/draft";

const reference: NameReference = {
  repo: "demo", commit: "abc",
  elements: {
    "packages/web": { concepts: [["web", "site"], ["catalog", "models"]] },
    "packages/core": { concepts: [["schema", "validate"], ["generate", "api"]], forbidden: ["database"] },
    "packages/sdk": { concepts: [["client"]] },
  },
};
const overlay: Overlay = {
  version: 1,
  elements: {
    "packages/web": { title: "Website", note: "Renders the catalog as a web page", by: "agent" },
    "packages/core": { title: "Core", note: "Validates the schema and keeps a database of models", by: "agent" },
    "packages/misc": { note: "Something", by: "agent" },
  },
};

test("a note is scored on the concepts it says, a phrase the code contradicts, and whether the box has a note at all", () => {
  const keys = ["packages/web", "packages/core", "packages/sdk", "packages/misc", "packages/other"];
  const report = scoreNames({ keys, overlay, reference });
  expect(report).toMatchObject({ total: 5, noted: 3 });
  const [web, core, sdk] = report.entries;
  expect(web).toMatchObject({ key: "packages/web", written: true, concepts: 2, hit: 2, forbidden: [] });
  expect(passes(web!)).toBe(true);
  expect(core).toMatchObject({ hit: 1, forbidden: ["database"], missed: [["generate", "api"]] });
  expect(passes(core!)).toBe(false);
  expect(sdk).toMatchObject({ written: false, hit: 0 });
  expect(passes(sdk!)).toBe(false);
  const text = formatNameScores(report, "demo");
  expect(text).toContain("coverage: 3 of 5 boxes have a note");
  expect(text).toContain("✓ packages/web");
  expect(text).toContain("says “database”");
  expect(text).toContain("✗ packages/sdk  no note");
  expect(text).toContain("1 of 3 described boxes pass");
});

test("no overlay at all scores every described box as unwritten", () => {
  const report = scoreNames({ keys: ["packages/web"], overlay: undefined, reference });
  expect(report.noted).toBe(0);
  expect(report.entries.every(entry => !entry.written)).toBe(true);
});
