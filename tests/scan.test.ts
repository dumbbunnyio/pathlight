import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { exportsOf, importsOf } from "../src/scan-imports";
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

test("a specifier ending in a slash names the folder's index file, as `.` and `..` do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-scan-slash-"));
  try {
    for (const [path, text] of Object.entries({
      "a/index.ts": "export const x = 1;\n",
      "a/b/index.ts": "export const y = 1;\n",
      "a/b/c.ts": "import { y } from './';\nimport { x } from '../';\nimport { x as x2 } from '..';\nimport { y as y2 } from '.';\n",
      "index.ts": "import { x } from './a/';\nexport const z = x;\n",
    })) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), text);
    }
    const scan = await Effect.runPromise(scanWorkspace(directory));
    expect(scan.unresolved).toEqual([]);
    expect(scan.imports.map(item => `${item.from}:${item.line} ${item.specifier} -> ${item.to}`).sort()).toEqual([
      "a/b/c.ts:1 ./ -> a/b/index.ts", "a/b/c.ts:2 ../ -> a/index.ts", "a/b/c.ts:3 .. -> a/index.ts", "a/b/c.ts:4 . -> a/b/index.ts", "index.ts:1 ./a/ -> a/index.ts",
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("exportsOf lists what a file offers: declarations, defaults, named and re-exported names, and nothing from text that only looks like an export", () => {
  const names = (source: string) => exportsOf(source).map(item => `${item.kind} ${item.name}`);
  expect(names(`export const a = 1, b = 2;
export let c = 3;
export async function load() {}
export function* gen() {}
export class Foo extends Bar {}
export abstract class Base {}
export interface Shape {}
export type Id = string;
export enum Color { Red }
export const enum Flag { On }
export declare const decl: number;
export namespace Space {}
export default class Main {}
`)).toEqual(["const a", "const c", "function load", "function gen", "class Foo", "class Base", "interface Shape", "type Id", "enum Color", "enum Flag", "const decl", "namespace Space", "default default (Main)"]);
  expect(names(`export default function () {}`)).toEqual(["default default"]);
  expect(names(`export default async function handler() {}`)).toEqual(["default default (handler)"]);
  expect(names(`const x = 1, y = 2;\nexport { x, y as z, type T };\nexport type { U, V as W };`)).toEqual(["named x", "named z", "named T", "type U", "type W"]);
  expect(names(`export { a, b as c } from "./m";\nexport * from "./all";\nexport * as ns from "./n";\nexport type { T } from "./t";`)).toEqual(["reexport a", "reexport c", "reexport ns", "reexport T"]);
  expect(names("// export const nope = 1;\nconst text = `export function inside() {}`;\nobj.export = 1;\nconst s = 'export const quoted';")).toEqual([]);
  expect(exportsOf(Array.from({ length: 200 }, (_, index) => `export const n${index} = 1;`).join("\n"), 10)).toHaveLength(10);
});

test("an import of a package's entry file is followed through its re-exports to the files that declare what it takes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-reexports-"));
  try {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/lib/package.json": JSON.stringify({ name: "lib", main: "src/index.ts" }),
      // A barrel: everything comes from elsewhere, through `export *`, an alias, a default, a nested barrel and a namespace.
      "packages/lib/src/index.ts": `export * from "./renderer";\nexport { Box as Container, default as Theme } from "./box";\nexport * from "./widgets";\nexport * as colors from "./colors";\nexport type { Size } from "./size";\nexport const version = 1;\n`,
      "packages/lib/src/renderer.ts": `export function render() {}\n`,
      "packages/lib/src/box.ts": `export class Box {}\nexport default {};\n`,
      "packages/lib/src/widgets/index.ts": `export { Input } from "./input";\n`,
      "packages/lib/src/widgets/input.ts": `export const Input = 1;\n`,
      "packages/lib/src/colors.ts": `export const red = 1;\n`,
      "packages/lib/src/size.ts": `export interface Size { width: number }\n`,
      "packages/app/package.json": JSON.stringify({ name: "app" }),
      "packages/app/src/main.ts": `import { render, Container, Input, colors, version } from "lib";\nimport type { Size } from "lib";\nimport * as everything from "lib";\nexport const main = [render, Container, Input, colors, version, everything];\n`,
    };
    for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); }
    const scan = await Effect.runPromise(scanWorkspace(directory));
    const from = (line: number) => scan.imports.filter(item => item.from === "packages/app/src/main.ts" && item.line === line).map(item => item.to).sort();
    // Named imports land where each name is declared; `version` is declared in the barrel itself, and `colors` is the module `export * as` offers.
    expect(from(1)).toEqual(["packages/lib/src/box.ts", "packages/lib/src/colors.ts", "packages/lib/src/index.ts", "packages/lib/src/renderer.ts", "packages/lib/src/widgets/input.ts"]);
    expect(from(2)).toEqual(["packages/lib/src/size.ts"]);
    // A namespace import takes the whole module: it stays on the file it named.
    expect(from(3)).toEqual(["packages/lib/src/index.ts"]);
    // The barrel's own re-exports are kept as they are.
    expect(scan.imports.filter(item => item.from === "packages/lib/src/index.ts").map(item => item.to).sort()).toEqual([
      "packages/lib/src/box.ts", "packages/lib/src/colors.ts", "packages/lib/src/renderer.ts", "packages/lib/src/size.ts", "packages/lib/src/widgets/index.ts"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
