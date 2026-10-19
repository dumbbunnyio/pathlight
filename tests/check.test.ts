import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { overviewId } from "../src/catalog";
import { Check, checkWorkspace, formatCheck, hasFindings } from "../src/check";
import { run } from "./effects";

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const mapping = (mappings: [string, string][], ignore?: string[]) => JSON.stringify({ version: 1, project: "viewer", mappings: mappings.map(([glob, element]) => ({ glob, element })), ...ignore ? { ignore } : {} });
const summarize = (check: Check) => check.relationships.map(item => `${item.source}>${item.target} ${item.status} ${item.direction} ${item.imports}`);

test("check compares the model and mapping with the scan: evidence either way, unverifiable ends, undeclared imports, unmatched globs and unmapped files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-check-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await write(directory, {
      "pathlight.activity.json": mapping([["src/plugin.ts", "plugin"], ["src/activity.ts", "activity"], ["src/launcher.ts", "launcher"], ["src/viewer.ts", "viewer"],
        ["src/catalog.ts", "catalog"], ["src/exporter.ts", "exporter"]]),
      "src/plugin.ts": `import { a } from "./activity";\nexport const p = a;\n`,
      "src/activity.ts": `export const a = 1;\n`,
      "src/launcher.ts": `import { v } from "./viewer";\nexport const l = v;\n`,
      // The model draws activity -> viewer; the import points the other way, which still counts as evidence.
      "src/viewer.ts": `import { a } from "./activity";\nexport const v = a;\n`,
      // Not in the model: catalog -> launcher.
      "src/catalog.ts": `import { l } from "./launcher";\nexport const c = l;\n`,
      "src/stray.ts": `export const s = 1;\n`,
    });
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.mappings).toEqual({ total: 6, ignored: 0, shared: [], sharedImports: 0, unmatched: [{ glob: "src/exporter.ts", element: "exporter" }], unmappedFiles: ["src/stray.ts"] });
    expect(summarize(check)).toEqual([
      "activity>viewer supported opposite 1",
      "catalog>exporter unverifiable none 0",
      "exporter>viewer unverifiable none 0",
      "launcher>exporter unverifiable none 0",
      "launcher>viewer supported same 1",
      "plugin>activity supported same 1",
      "plugin>launcher unsupported none 0",
    ]);
    expect(check.relationships.find(item => item.source === "activity")!.examples).toEqual([{ from: "src/viewer.ts", line: 1, to: "src/activity.ts", kind: "import" }]);
    expect(check.undeclared).toEqual([{ source: "catalog", target: "launcher", imports: 1, examples: [{ from: "src/catalog.ts", line: 1, to: "src/launcher.ts", kind: "import" }] }]);
    expect(check.summary).toEqual({ unmatchedMappings: 1, unmappedFiles: 1, unsupported: 1, unverifiable: 3, undeclared: 1, largeElements: 0, wideGroups: 0, unlinkedViews: 0 });
    expect(hasFindings(check)).toBe(true);

    const text = formatCheck(check);
    expect(text).toContain("▲ src/exporter.ts (exporter) matches no files");
    expect(text).toContain("✓ activity → viewer  “Updates component activity”  1 import (pointing from the target), e.g. src/viewer.ts:1 → src/activity.ts");
    expect(text).toContain("▲ plugin → launcher  “Opens a view”  no import between the mapped files");
    expect(text).toContain("· catalog → exporter  “Selects diagram”  not checkable: an end has no mapped files");
    expect(text).toContain("▲ catalog → launcher  1 import, e.g. src/catalog.ts:1 → src/launcher.ts");

    // The CLI prints the same facts as JSON the schema accepts; --strict turns findings into a failing exit status.
    const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), "check", "--workspace", directory, ...args]);
    expect(Schema.decodeUnknownSync(Check)(JSON.parse(await cli("--json"))).summary).toEqual(check.summary);
    await expect(cli("--strict")).rejects.toThrow();
    await cli();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a relationship on a group is supported by imports between files mapped to what is inside it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-check-nested-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await write(directory, {
      "model.c4": `specification { element component }
model {
  api = component 'API' {
    auth = component 'Auth'
    users = component 'Users'
  }
  store = component 'Store'
  api -> store 'Reads and writes'
}
views { view live { include * autoLayout LeftRight } }
`,
      "pathlight.activity.json": mapping([["src/auth.ts", "api.auth"], ["src/users.ts", "api.users"], ["src/store.ts", "store"]], ["src/vendored/**"]),
      "src/vendored/lib.ts": `export const lib = 1;\n`,
      "src/auth.ts": `import { u } from "./users";\nexport const a = u;\n`,
      "src/users.ts": `import { s } from "./store";\nexport const u = s;\n`,
      "src/store.ts": `export const s = 1;\n`,
    });
    const check = await Effect.runPromise(checkWorkspace(directory));
    expect(summarize(check)).toEqual(["api>store supported same 1"]);
    // auth -> users is neither declared nor implied by api -> store; users -> store is covered by it.
    expect(check.undeclared.map(item => `${item.source}>${item.target}`)).toEqual(["api.auth>api.users"]);
    expect(check.mappings.unmappedFiles).toEqual([]);
    expect(check.mappings.ignored).toBe(1);
    expect(formatCheck(check)).toContain("3 mappings, 1 source files ignored on purpose");
    expect(formatCheck(check)).toContain("✓ every scanned source file is mapped");

    // An unknown element in the mapping is an error, not a finding.
    await write(directory, { "pathlight.activity.json": mapping([["src/auth.ts", "api.missing"]]) });
    await expect(Effect.runPromise(checkWorkspace(directory))).rejects.toThrow("Unknown activity element 'api.missing'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("shared elements need no relationship, a big element shows what is inside it, and views nothing links to are reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-check-health-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const big = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`src/big/${index < 10 ? "core" : "extra"}/f${index}.ts`, `export const f${index} = 1;\n`]));
    await write(directory, {
      "model.c4": `specification { element component }
model {
  big = component 'Big'
  small = component 'Small'
  types = component 'Types'
}
views {
  view overview { include big, small, types
    include big with { navigateTo detail }
    autoLayout LeftRight }
  view detail { include big, small autoLayout LeftRight }
  view orphan { include types autoLayout LeftRight }
}
`,
      "pathlight.activity.json": mapping([["src/big/**", "big"], ["src/small.ts", "small"], ["src/types.ts", "types"]]),
      ...big,
      "src/small.ts": `import { T } from "./types";\nexport const s: T = 1;\n`,
      "src/types.ts": `export type T = number;\n`,
      "src/big/core/f0.ts": `import type { T } from "../../types";\nexport const f0: T = 1;\n`,
    });
    // Without `shared`, the imports into types are undeclared relationships.
    let check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.undeclared.map(item => `${item.source}>${item.target}`)).toEqual(["big>types", "small>types"]);
    expect(check.mappings.sharedImports).toBe(0);
    // 16 of the 18 mapped files sit in one element, and the report says where inside it.
    expect(check.size.map(item => `${item.element} ${item.files} ${item.large}`)).toEqual(["big 16 true", "small 1 false", "types 1 false"]);
    expect(check.size[0]!.folders).toEqual([{ folder: "src/big/core", files: 10 }, { folder: "src/big/extra", files: 6 }]);
    expect(check.summary.largeElements).toBe(1);
    expect(formatCheck(check)).toContain("▲ big holds 16 of the mapped files; inside it: src/big/core 10, src/big/extra 6");
    // overview links to detail; nothing links to overview or orphan, so two entries and one view too many.
    expect(check.views).toEqual({ total: 3, entries: ["orphan", "overview"] });
    expect(check.summary.unlinkedViews).toBe(1);
    expect(hasFindings(check)).toBe(true);
    // LikeC4's generated "Landscape" index is not one of the author's views, and `open` prefers a written view to it.
    expect(String(await Effect.runPromise(overviewId(directory)))).toBe("overview");
    expect(formatCheck(check)).toContain("2 of 3 views have no navigateTo pointing to them: orphan, overview");

    await write(directory, { "pathlight.activity.json": JSON.stringify({ version: 1, project: "viewer", shared: ["types"], mappings: [
      { glob: "src/big/**", element: "big" }, { glob: "src/small.ts", element: "small" }, { glob: "src/types.ts", element: "types" }] }) });
    check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.undeclared).toEqual([]);
    expect(check.mappings).toMatchObject({ shared: ["types"], sharedImports: 2 });
    expect(formatCheck(check)).toContain("2 imports into shared types are not listed");

    await write(directory, { "pathlight.activity.json": JSON.stringify({ version: 1, project: "viewer", shared: ["nope"], mappings: [{ glob: "src/types.ts", element: "types" }] }) });
    await expect(Effect.runPromise(checkWorkspace(directory))).rejects.toThrow("Unknown shared element 'nope'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("an element with many direct children is reported as wide, and grouping them clears it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-check-wide-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const flat = Array.from({ length: 10 }, (_, index) => `  part${index} = component 'Part ${index}'`).join("\n");
    const grouped = ["a", "b"].map(name => `  ${name} = component '${name}' {\n${Array.from({ length: 5 }, (_, index) => `    p${index} = component 'P${index}'`).join("\n")}\n  }`).join("\n");
    const model = (body: string) => `specification { element component }\nmodel {\n  system = component 'System' {\n${body}\n  }\n}\nviews { view live { include system.* autoLayout LeftRight } }\n`;
    await write(directory, { "model.c4": model(flat), "pathlight.activity.json": mapping([]) });
    let check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.wide).toEqual([{ parent: "system", children: 10 }]);
    expect(check.summary.wideGroups).toBe(1);
    expect(formatCheck(check)).toContain("▲ system has 10 elements side by side; 3 to 7 per level reads better.");
    await write(directory, { "model.c4": model(grouped) });
    check = await Effect.runPromise(checkWorkspace(directory));
    expect(check.wide).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("this repository's own model and mapping stay consistent with its code", async () => {
  // A new source file must be mapped to a component (or ignored on purpose), and a dependency between components must be declared.
  const output = await run(process.execPath, [resolve("src/cli.ts"), "check", "--workspace", ".", "--strict"]);
  expect(output).toContain("every scanned source file is mapped");
  expect(output).toContain("Imports with no relationship\n  ✓ none");
}, 60_000);
