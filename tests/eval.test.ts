import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { draftWorkspace } from "../src/draft";
import { type Reference, crowdedAbove, formatScore, scoreWorkspace } from "./eval/score";

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const manifest = (name: string, extra: object = {}) => JSON.stringify({ name, main: "src/index.ts", ...extra });

// app depends on lib, lib on base: the layering the reference states.
const layered = {
  "package.json": JSON.stringify({ name: "layered", private: true }),
  "packages/app/package.json": manifest("@x/app"), "packages/app/src/index.ts": `import { lib } from "@x/lib";\nexport const app = lib;\n`,
  "packages/lib/package.json": manifest("@x/lib"), "packages/lib/src/index.ts": `import { base } from "@x/base";\nexport const lib = base;\n`,
  "packages/base/package.json": manifest("@x/base"), "packages/base/src/index.ts": `export const base = 1;\n`,
};
const reference: Reference = {
  repo: "layered", commit: "test",
  assertions: [
    { kind: "edge", from: "app", to: "lib", basis: "stated", source: "docs", quote: "app uses lib" },
    { kind: "edge", from: "lib", to: "base", basis: "stated", source: "docs", quote: "lib uses base" },
    { kind: "no-edge", from: "base", to: "app", basis: "stated", source: "docs", quote: "base never uses app" },
    { kind: "no-edge", from: "lib", to: "app", basis: "stated", source: "docs", quote: "lib never uses app" },
  ],
};

const withDraft = async (files: Record<string, string>, body: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-eval-"));
  try {
    await write(directory, files);
    await Effect.runPromise(draftWorkspace(directory));
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const score = (directory: string) => Effect.runPromise(scoreWorkspace(directory, reference));
/** Removes `from -> to` and the tag block that follows it. */
const dropRelationship = (model: string, from: string, to: string) => model.replace(new RegExp(`  ${from.replace(".", "\\.")} -> ${to.replace(".", "\\.")} '[^']*'( \\{[^}]*\\})?\\n`), "");

test("a draft of a clean layered workspace scores perfectly and every stated rule holds", async () => {
  await withDraft(layered, async directory => {
    const result = await score(directory);
    expect(result.files).toMatchObject({ eligible: 3, claimed: 3, coverage: 1 });
    expect(result.edges).toMatchObject({ declared: 2, supported: 2, unsupported: 0, precision: 1 });
    expect(result.pairs).toMatchObject({ undeclared: 0, recall: 1 });
    expect(result.assertions).toMatchObject({ total: 4, passed: 4, failures: [] });
    expect(formatScore(result, "layered")).toContain("4 of 4 stated rules hold");
  });
}, 60_000);

// The scorer is only worth trusting if it notices each kind of damage, so each is planted here on purpose.
test("planted defect: a missing relationship lowers recall and fails the rule that needs it", async () => {
  await withDraft(layered, async directory => {
    const path = join(directory, "pathlight.model.c4");
    await writeFile(path, dropRelationship(await readFile(path, "utf8"), "app.root", "lib.root"));
    const result = await score(directory);
    expect(result.pairs.undeclared).toBe(1);
    expect(result.pairs.recall).toBeLessThan(1);
    expect(result.assertions.failures.map(item => `${item.assertion.kind} ${item.assertion.from}->${item.assertion.to}`)).toEqual(["edge app->lib"]);
    expect(result.edges.precision).toBe(1);
  });
}, 60_000);

test("planted defect: an invented relationship lowers precision and breaks a rule that forbids it", async () => {
  await withDraft(layered, async directory => {
    const path = join(directory, "pathlight.model.c4");
    const model = await readFile(path, "utf8");
    await writeFile(path, model.replace("\n}\n\nviews {", "\n  base.root -> app.root 'invented'\n}\n\nviews {"));
    const result = await score(directory);
    expect(result.edges.unsupported).toBe(1);
    expect(result.edges.precision).toBeLessThan(1);
    expect(result.assertions.failures.map(item => `${item.assertion.kind} ${item.assertion.from}->${item.assertion.to}`)).toEqual(["no-edge base->app"]);
    expect(result.pairs.recall).toBe(1);
  });
}, 60_000);

test("planted defect: a dropped file mapping lowers coverage", async () => {
  await withDraft(layered, async directory => {
    const path = join(directory, "pathlight.activity.json");
    const config = JSON.parse(await readFile(path, "utf8")) as { mappings: { glob: string; element: string }[] };
    await writeFile(path, JSON.stringify({ ...config, mappings: config.mappings.filter(item => item.element !== "base.root") }));
    const result = await score(directory);
    expect(result.files).toMatchObject({ eligible: 3, claimed: 2 });
    expect(result.files.coverage).toBeCloseTo(2 / 3);
  });
}, 60_000);

test("a draft keeps readable views within the limit, and the scorer counts a crowded one when the cap is undone by hand", async () => {
  const files: Record<string, string> = { "package.json": JSON.stringify({ name: "wide" }) };
  for (let n = 0; n < 36; n++) for (const file of ["a", "b", "c"]) files[`src/f${String(n).padStart(2, "0")}/${file}.ts`] = `export const ${file}${n} = 1;\n`;
  await withDraft(files, async directory => {
    const drafted = await score(directory);
    expect(drafted.views.crowded).toBe(0);
    expect(drafted.views.maxNodes).toBeLessThanOrEqual(crowdedAbove);
    // The complete listing is declared, so its 36 boxes are not held against the draft.
    expect(drafted.views.listings).toBe(1);
    // Planted defect: take the cap off the overview, so it shows all 36 components.
    const path = join(directory, "pathlight.model.c4");
    await writeFile(path, (await readFile(path, "utf8")).replace("    exclude * where tag is #minor\n", ""));
    const damaged = await score(directory);
    expect(damaged.views.maxNodes).toBe(36);
    expect(damaged.views.crowded).toBe(1);
  });
}, 60_000);
