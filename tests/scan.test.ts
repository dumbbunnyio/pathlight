import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { importsOf } from "../src/scan-imports";
import { Scan, readScan, scanWorkspace } from "../src/scan";
import { run } from "./effects";

const kinds = (source: string) => importsOf(source).map(({ specifier, kind, line }) => `${kind} ${specifier} @${line}`);

test("importsOf reads every static import form with its line, and ignores text that only looks like one", () => {
  expect(kinds(`import a from "./a.js";
import type { T } from "./types";
import { type U, v } from "./mixed";
import { type X, type Y } from "./only-types";
import * as ns from './ns';
import def, { named } from "./def";
import "./side-effect";
export * from "./star";
export * as grouped from "./grouped";
export { x } from "./named";
export type { Shape } from "./shape";
export type * from "./all-types";
import fs = require("./equals");
const lazy = await import("./lazy");
const old = require("./old");
import {
  multi,
  line,
} from "./multi";
`)).toEqual([
    "import ./a.js @1", "type ./types @2", "import ./mixed @3", "type ./only-types @4", "import ./ns @5", "import ./def @6", "import ./side-effect @7",
    "reexport ./star @8", "reexport ./grouped @9", "reexport ./named @10", "type ./shape @11", "type ./all-types @12", "require ./equals @13",
    "dynamic ./lazy @14", "require ./old @15", "import ./multi @16",
  ]);
  expect(kinds(`// import a from "./commented";
/* import b from "./block"; */
const s = "import c from './in-string'";
const t = \`import d from "./in-template" \${await import("./in-template-expression")}\`;
const r = /import e from "x"/;
const divided = 4 / 2; import real from "./real";
const dynamic = await import(name);
const meta = import.meta.url;
const obj = { import: 1, require: 2 }; obj.require("./method");
`)).toEqual(["import ./real @6"]);
});

test("importsOf reads an import whose list of names runs to hundreds of lines (generated code does this)", () => {
  const names = Array.from({ length: 1500 }, (_, n) => `  Name${n},`).join("\n");
  expect(kinds(`import { Effect } from "effect";\nimport type {\n${names}\n} from "../api/api.js";\nimport { Next } from "./next";\n`)).toEqual([
    "import effect @1", "type ../api/api.js @2", "import ./next @1504",
  ]);
});

test("importsOf agrees with Bun's own scanner on this repository's value imports", async () => {
  const files = (await run("git", ["ls-files", "src", "plugins", "tests"])).split("\n").filter((path: string) => /\.(ts|tsx|js|mjs)$/.test(path));
  expect(files.length).toBeGreaterThan(30);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const path of files) {
    const source = await readFile(path, "utf8");
    const ours = new Set(importsOf(source).filter(item => item.kind !== "type").map(item => item.specifier));
    const bun = new Set(transpiler.scanImports(source.replace(/^#!.*/, "")).map(item => item.path));
    expect([path, [...ours].sort()]).toEqual([path, [...bun].sort()]);
  }
});

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

test("scan resolves relative, aliased and workspace-package imports and reports what it could not read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-scan-"));
  try {
    await write(directory, {
      "tsconfig.json": `{ // comments and trailing commas are allowed
        "compilerOptions": { "paths": { "@app/*": ["src/*"], "#config": ["src/config.ts"], }, },
      }`,
      "src/main.ts": `import { a } from "./a.js";
import type { Shape } from "./shapes";
import { util } from "./lib";
import { cfg } from "#config";
import { thing } from "@app/deep/thing";
import { sdk } from "@acme/sdk";
import { helper } from "@acme/sdk/helper";
import { gone } from "./missing";
import { effect } from "effect/Schema";
import { readFile } from "node:fs/promises";
import { other } from "@/not-configured";
import styles from "./style.css";
export * from "./a";
const lazy = import("./a.js?raw");
`,
      "src/a.ts": `export const a = 1;\n`,
      "src/shapes.ts": `export type Shape = {};\n`,
      "src/lib/index.ts": `export const util = 1;\n`,
      "src/config.ts": `export const cfg = 1;\n`,
      "src/deep/thing.ts": `import { a } from "../a";\nexport const thing = a;\n`,
      "src/style.css": "body {}\n",
      "packages/sdk/package.json": JSON.stringify({ name: "@acme/sdk", main: "./dist/index.js", exports: { ".": { import: "./dist/index.mjs" }, "./helper": "./dist/helper.mjs" } }),
      "packages/sdk/src/index.ts": `import { helper } from "./helper";\nexport const sdk = helper;\n`,
      "packages/sdk/src/helper.ts": `export const helper = 1;\n`,
      "tools/script.py": "import os\n",
      "node_modules/pkg/index.js": `import "./hidden";\n`,
      "notes.md": "# not source\n",
    });
    // A symlink is not a regular file: it is neither listed nor followed.
    await symlink(join(directory, "src/a.ts"), join(directory, "src/linked.ts"));
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.coverage).toEqual({ listing: "walk", files: 8, imports: 12, external: 2, unresolved: 2, skipped: 0, unscanned: [{ extension: ".py", files: 1 }] });
    expect(scan.files.map(file => file.path)).toEqual(["packages/sdk/src/helper.ts", "packages/sdk/src/index.ts", "src/a.ts", "src/config.ts", "src/deep/thing.ts",
      "src/lib/index.ts", "src/main.ts", "src/shapes.ts"]);
    expect(scan.imports.filter(item => item.from === "src/main.ts").map(item => `${item.line} ${item.kind} ${item.to}`)).toEqual([
      "1 import src/a.ts", "2 type src/shapes.ts", "3 import src/lib/index.ts", "4 import src/config.ts", "5 import src/deep/thing.ts",
      "6 import packages/sdk/src/index.ts", "7 import packages/sdk/src/helper.ts", "12 import src/style.css", "13 reexport src/a.ts", "14 dynamic src/a.ts",
    ]);
    expect(scan.imports.find(item => item.from === "src/deep/thing.ts")).toMatchObject({ to: "src/a.ts", line: 1 });
    expect(scan.imports.find(item => item.from === "packages/sdk/src/index.ts")).toMatchObject({ to: "packages/sdk/src/helper.ts" });
    expect(scan.external.map(item => `${item.from}:${item.line}:${item.package}`)).toEqual(["src/main.ts:9:effect", "src/main.ts:10:node:fs/promises"]);
    expect(scan.unresolved.map(item => `${item.line} ${item.specifier} ${item.reason}`)).toEqual(["8 ./missing not-found", "11 @/not-configured alias-not-configured"]);
    // The same tree gives the same text.
    expect(JSON.stringify(await Effect.runPromise(scanWorkspace(directory)))).toBe(JSON.stringify(scan));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scan follows package.json `imports` (#name) to every runtime variant a package names and keeps the rest unresolved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-scan-imports-"));
  try {
    await write(directory, {
      "package.json": JSON.stringify({ name: "app", imports: {
        "#db": { bun: "./src/db.bun.ts", node: "./src/db.node.ts", default: "./src/db.default.ts" },
        "#plain": "./src/plain.ts",
        "#lib/*": "./src/lib/*.ts",
      } }),
      "src/main.ts": `import { db } from "#db";\nimport { plain } from "#plain";\nimport { x } from "#lib/x";\nimport { nope } from "#nowhere";\nimport { fs } from "node:fs";\n`,
      "src/db.bun.ts": "export const db = 1;\n", "src/db.node.ts": "export const db = 2;\n", "src/db.default.ts": "export const db = 3;\n",
      "src/plain.ts": "export const plain = 1;\n", "src/lib/x.ts": "export const x = 1;\n",
      // A nested package.json with no `imports` governs its own files: the root mapping does not reach it.
      "inner/package.json": JSON.stringify({ name: "inner" }),
      "inner/main.ts": `import { plain } from "#plain";\n`,
    });
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.imports.filter(item => item.from === "src/main.ts").map(item => `${item.line} ${item.to}`)).toEqual([
      "1 src/db.bun.ts", "1 src/db.default.ts", "1 src/db.node.ts", "2 src/plain.ts", "3 src/lib/x.ts",
    ]);
    expect(scan.unresolved.map(item => `${item.from}:${item.line} ${item.specifier} ${item.reason}`)).toEqual([
      "inner/main.ts:1 #plain alias-not-configured", "src/main.ts:4 #nowhere alias-not-configured"]);
    expect(JSON.stringify(await Effect.runPromise(scanWorkspace(directory)))).toBe(JSON.stringify(scan));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scan follows a workspace package's exports map, explicit entries before `*` patterns, and every runtime condition it names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-scan-exports-"));
  try {
    await write(directory, {
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", exports: {
        "./button": "./src/actions/button/button.tsx",
        "./*": "./src/components/*.tsx",
        "./i18n/*": "./src/i18n/*.ts",
        "./store": { bun: "./src/store.bun.ts", node: "./src/store.node.ts", default: "./src/store.ts" },
      } }),
      "packages/ui/src/actions/button/button.tsx": "export const Button = 1;\n",
      "packages/ui/src/components/button.tsx": "export const Wrong = 1;\n",
      "packages/ui/src/components/card.tsx": "export const Card = 1;\n",
      "packages/ui/src/i18n/en.ts": "export const en = 1;\n",
      "packages/ui/src/store.bun.ts": "export const s = 1;\n", "packages/ui/src/store.node.ts": "export const s = 2;\n", "packages/ui/src/store.ts": "export const s = 3;\n",
      "app/main.ts": `import { Button } from "@acme/ui/button";\nimport { Card } from "@acme/ui/card";\nimport { en } from "@acme/ui/i18n/en";\nimport { s } from "@acme/ui/store";\nimport { gone } from "@acme/ui/gone";\n`,
    });
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.imports.filter(item => item.from === "app/main.ts").map(item => `${item.line} ${item.to}`)).toEqual([
      "1 packages/ui/src/actions/button/button.tsx", "2 packages/ui/src/components/card.tsx", "3 packages/ui/src/i18n/en.ts",
      "4 packages/ui/src/store.bun.ts", "4 packages/ui/src/store.node.ts", "4 packages/ui/src/store.ts",
    ]);
    expect(scan.unresolved.map(item => `${item.line} ${item.specifier} ${item.reason}`)).toEqual(["5 @acme/ui/gone package-entry-not-found"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("in a git repository scan leaves out ignored files, and the CLI writes JSON the schema accepts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-scan-git-"));
  try {
    await write(directory, {
      ".gitignore": "generated/\n",
      "src/index.ts": `import { made } from "../generated/made";\nimport { kept } from "./kept";\n`,
      "src/kept.ts": `export const kept = 1;\n`,
      "generated/made.ts": `export const made = 1;\n`,
    });
    await run("git", ["-C", directory, "init", "--quiet"]);
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.coverage.listing).toBe("git");
    expect(scan.files.map(file => file.path)).toEqual(["src/index.ts", "src/kept.ts"]);
    expect(scan.imports.map(item => `${item.from} -> ${item.to}`)).toEqual(["src/index.ts -> src/kept.ts"]);
    expect(scan.unresolved.map(item => item.specifier)).toEqual(["../generated/made"]);

    const out = join(directory, "scan.json");
    await run(process.execPath, [resolve("src/cli.ts"), "scan", "--workspace", directory, "--out", out]);
    const written = await Effect.runPromise(readScan(out));
    expect(written.imports).toEqual(scan.imports);
    const printed = await run(process.execPath, [resolve("src/cli.ts"), "scan", "--workspace", directory]);
    expect(Schema.decodeUnknownSync(Scan)(JSON.parse(printed)).coverage.files).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
