import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
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
    expect(check.mappings).toEqual({ total: 6, ignored: 0, unmatched: [{ glob: "src/exporter.ts", element: "exporter" }], unmappedFiles: ["src/stray.ts"] });
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
    expect(check.summary).toEqual({ unmatchedMappings: 1, unmappedFiles: 1, unsupported: 1, unverifiable: 3, undeclared: 1 });
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

test("this repository's own model and mapping stay consistent with its code", async () => {
  // A new source file must be mapped to a component (or ignored on purpose), and a dependency between components must be declared.
  const output = await run(process.execPath, [resolve("src/cli.ts"), "check", "--workspace", ".", "--strict"]);
  expect(output).toContain("every scanned source file is mapped");
  expect(output).toContain("Imports with no relationship\n  ✓ none");
}, 60_000);
