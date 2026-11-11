#!/usr/bin/env bun
// bun tests/eval/facts-uses.ts --workspace DIR [--out FILE]
//
// Measures the scan's "types only" reading of TypeScript imports against TypeScript itself. TypeScript removes an import at emit when nothing in the
// file uses its bindings as values (`verbatimModuleSyntax` off), so a statement the emit drops is types only to the compiler. Each tsconfig in the
// workspace is emitted with the project's own `tsc` into a temporary folder outside the workspace, with `emitDecoratorMetadata` off (that option turns
// a decorated member's annotation into a value, which is the compiler's artifact, not a use in the code). Statements written as type imports
// (`import type`, every binding `type`) are left out of the counts: both sides agree on them by construction.
//
// Only statements the scan resolves to a file of the workspace are counted (they are the ones that draw arrows). Imports are read from the source
// and from the emitted file with Babel's parser, not with the scanner's tokenizer. A disagreement is listed with its file and line to be read.
//
// - precision: of the statements the scan reads as types only, the share the emit also dropped; a miss here can hide a real arrow.
// - recall: of the statements the emit dropped, the share the scan reads as types only. A statement the scan keeps because a member is called
//   through a local annotated with the imported type (`(db: Db) => db.query()`) is kept on purpose (docs/scan.md, "Uses") and counted apart.
//
// Go, when the workspace has a go.mod: `tests/eval/facts_uses_go` type-checks the workspace with go/types (standard library only, offline) and says,
// per file and imported workspace package, whether any use is not in a type position (a composite literal's type and an embedded field count as
// values). The scan's records from that file to that package's files are compared, by the same two measures. Test files are left out (the helper
// does not type-check them).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSync } from "@babel/core";
import { Effect } from "effect";
import { scanWorkspace, type Scan } from "../../src/scan";
import { frontEndFor } from "../../src/languages";
import { carriesCode } from "../../src/uses";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, out: { type: "string" }, show: { type: "string", default: "40" } } });
const root = resolve(values.workspace!);
const tsc = join(import.meta.dir, "../../node_modules/.bin/tsc");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pathlight-facts-uses-"));

interface Statement { line: number; specifier: string; bindings: string[]; typeOnly: boolean; imported: Map<string, string> }
/** Import statements with bindings, by Babel: line, specifier, value bindings, and whether the statement is written as types only. */
const statementsOf = (code: string, filename: string): Statement[] | undefined => {
  try {
    const ast = parseSync(code, { filename, babelrc: false, configFile: false, sourceType: "module",
      parserOpts: { plugins: ["typescript", ...(/\.(tsx|jsx|js)$/.test(filename) ? ["jsx" as const] : []), "decorators-legacy"], errorRecovery: true } });
    const found: Statement[] = [];
    for (const node of (ast as { program: { body: { type: string; importKind?: string; loc: { start: { line: number } }; source?: { value: string }; specifiers?: { type: string; importKind?: string; local: { name: string }; imported?: { name?: string; value?: string } }[] }[] } } | null)?.program.body ?? []) {
      if (node.type !== "ImportDeclaration" || !node.specifiers?.length) continue;
      const values_ = node.importKind === "type" ? [] : node.specifiers.filter(item => item.importKind !== "type" && item.importKind !== "typeof");
      const imported = new Map(values_.map(item => [item.local.name, item.type === "ImportDefaultSpecifier" ? "default" : item.type === "ImportNamespaceSpecifier" ? "*" : item.imported?.name ?? item.imported?.value ?? item.local.name] as const));
      found.push({ line: node.loc.start.line, specifier: node.source!.value, bindings: values_.map(item => item.local.name), typeOnly: !values_.length, imported });
    }
    return found;
  } catch { return undefined; }
};

try {
  const listed = (await Bun.$`git -C ${root} ls-files -- ${"*tsconfig.json"}`.quiet().text()).split("\n").filter(path => path && !path.includes("node_modules/"));
  const emitted = new Map<string, string>();
  for (const [index, config] of listed.entries()) {
    const out = join(scratch, String(index));
    await Bun.$`${tsc} -p ${join(root, config)} --noEmit false --outDir ${out} --rootDir ${root} --declaration false --declarationMap false --sourceMap false --noEmitOnError false --verbatimModuleSyntax false --emitDecoratorMetadata false --composite false --incremental false --emitDeclarationOnly false`.quiet().nothrow();
    for (const file of (await Bun.$`find ${out} -type f`.quiet().nothrow().text()).split("\n").filter(path => /\.(m|c)?jsx?$/.test(path))) {
      const source = relative(out, file).replace(/\.(m|c)?jsx?$/, "");
      if (!emitted.has(source)) emitted.set(source, file);
    }
  }
  const scan = await Effect.runPromise(scanWorkspace(root));
  const resolved = new Set(scan.imports.map(item => `${item.from}\0${item.line}\0${item.specifier}`));
  const counts = { statements: 0, files: 0, scanTypes: 0, both: 0, emitDropped: 0, through: 0, typeImports: 0, unparsed: 0, unused: 0 };
  // Per name: a value binding the emit kept or dropped, against the scan's uses of that name. A namespace binding is types only when all its members are.
  const names = { total: 0, scanTypes: 0, dropped: 0, both: 0, unused: 0, through: 0 };
  const falseNames: string[] = [], missedNames: string[] = [];
  const falseTypes: string[] = [], missedTypes: string[] = [], through: string[] = [];
  for (const file of scan.files.filter(item => item.language === "typescript" || item.language === "javascript")) {
    const stem = file.path.replace(/\.(m|c)?(t|j)sx?$/, "");
    const out = emitted.get(stem);
    if (!out || file.path.endsWith(".d.ts")) continue;
    const text = readFileSync(join(root, file.path), "utf8");
    const before = statementsOf(text, file.path), after = statementsOf(readFileSync(out, "utf8"), out);
    if (!before || !after) { counts.unparsed++; continue; }
    counts.files++;
    const refs = frontEndFor(file.path)!.imports(text, file.path);
    for (const statement of before) {
      if (!resolved.has(`${file.path}\0${statement.line}\0${statement.specifier}`)) continue;
      if (statement.typeOnly) { counts.typeImports++; continue; }
      const ref = refs.find(item => item.line === statement.line && item.specifier === statement.specifier && !item.reexport);
      if (!ref) continue;
      counts.statements++;
      const kept = new Set(after.filter(item => item.specifier === statement.specifier).flatMap(item => item.bindings));
      for (const local of statement.bindings) {
        const imported = statement.imported.get(local)!;
        const mine = (ref.uses ?? []).filter(use => imported === "*" ? true : use.imported === imported && (use.name === local || use.name.startsWith(`${local}.`)));
        const nameDropped = !kept.has(local), nameTypes = mine.length > 0 && mine.every(use => use.how === "types");
        names.total++;
        if (!mine.length) { names.unused++; if (!nameDropped) missedNames.push(`${file.path}:${statement.line} ${local}: no uses read, tsc keeps it`); continue; }
        if (nameTypes) names.scanTypes++;
        if (nameDropped) names.dropped++;
        if (nameTypes && nameDropped) names.both++;
        if (nameTypes && !nameDropped) falseNames.push(`${file.path}:${statement.line} ${local}`);
        if (!nameTypes && nameDropped) {
          if (mine.every(use => use.how === "types" || (use.how === "calls" && use.name.includes(".")))) names.through++;
          else missedNames.push(`${file.path}:${statement.line} ${local}: ${mine.map(use => `${use.name} ${use.how}`).join(", ")}`);
        }
      }
      const dropped = !after.some(item => item.specifier === statement.specifier && item.bindings.some(name => statement.bindings.includes(name)));
      const scanTypes = !carriesCode(ref);
      const where = `${file.path}:${statement.line} ${statement.specifier} {${statement.bindings.join(", ")}} scan: ${(ref.uses ?? []).map(use => `${use.name} ${use.how}`).join(", ") || "no uses"}`;
      if (scanTypes) counts.scanTypes++;
      if (dropped) counts.emitDropped++;
      if (scanTypes && dropped) counts.both++;
      if (scanTypes && !dropped) falseTypes.push(where);
      if (!scanTypes && dropped) {
        const throughOnly = (ref.uses ?? []).every(use => use.how === "types" || (use.how === "calls" && use.name.includes(".")));
        if (throughOnly && (ref.uses ?? []).some(use => use.how === "calls")) { counts.through++; through.push(where); }
        else missedTypes.push(where);
      }
    }
  }
  const percent = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(2)}%` : "n/a";
  const show = Number(values.show);
  const goLines: string[] = [];
  if ((await Bun.$`git -C ${root} ls-files -- ${"*go.mod"}`.quiet().nothrow().text()).trim() && Bun.which("go")) {
    const output = await Bun.$`go run ${join(import.meta.dir, "facts_uses_go/main.go")} ${root}`.env({ ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local", GOPROXY: "off" }).quiet().nothrow().text();
    const facts = output.split("\n").filter(Boolean).map(line => JSON.parse(line) as { file: string; dir: string; value: boolean });
    const records = new Map<string, Scan["imports"][number][]>();
    for (const item of scan.imports) if (item.from.endsWith(".go")) { const key = `${item.from}\0${item.to.includes("/") ? item.to.slice(0, item.to.lastIndexOf("/")) : "."}`; records.set(key, [...records.get(key) ?? [], item]); }
    const go = { pairs: 0, scanTypes: 0, typesOnly: 0, both: 0, through: 0, missing: 0 };
    const falseGo: string[] = [], missedGo: string[] = [];
    for (const fact of facts) {
      const mine = records.get(`${fact.file}\0${fact.dir}`);
      if (!mine) { go.missing++; continue; }
      go.pairs++;
      const scanTypes = !mine.some(carriesCode);
      const uses = [...new Set(mine.flatMap(item => (item.uses ?? []).map(use => `${use.name} ${use.how}`)))].join(", ");
      if (scanTypes) go.scanTypes++;
      if (!fact.value) go.typesOnly++;
      if (scanTypes && !fact.value) go.both++;
      if (scanTypes && fact.value) falseGo.push(`${fact.file} → ${fact.dir}: ${uses}`);
      if (!scanTypes && !fact.value) {
        if (mine.flatMap(item => item.uses ?? []).every(use => use.how === "types" || (use.how === "calls" && use.name.includes(".")))) go.through++;
        else missedGo.push(`${fact.file} → ${fact.dir}: ${uses}`);
      }
    }
    goLines.push("", `Go (go/types): file-to-package pairs ${go.pairs} (${go.missing} the scan has no record for); scan types only ${go.scanTypes}; go/types types only ${go.typesOnly}; both ${go.both}`,
      `Go precision: ${percent(go.both, go.scanTypes)}; Go recall: ${percent(go.both, go.typesOnly - go.through)} (${go.through} kept as calls through a typed local)`,
      `  scan types only, go/types finds a value use (${falseGo.length}):`, ...falseGo.slice(0, show).map(item => `    ${item}`),
      `  go/types types only, scan keeps (${missedGo.length}):`, ...missedGo.slice(0, show).map(item => `    ${item}`));
  }
    const lines = [
    `pathlight facts-uses · ${root}`,
    `tsconfigs emitted: ${listed.length}; files compared: ${counts.files}${counts.unparsed ? `, not parsed: ${counts.unparsed}` : ""}`,
    `statements with value bindings that resolve in the workspace: ${counts.statements} (plus ${counts.typeImports} written as type imports, not counted)`,
    `scan reads types only: ${counts.scanTypes}; tsc dropped: ${counts.emitDropped}; both: ${counts.both}`,
    `precision (scan types only, tsc dropped too): ${percent(counts.both, counts.scanTypes)}`,
    `recall (tsc dropped, scan types only): ${percent(counts.both, counts.emitDropped - counts.through)} of ${counts.emitDropped - counts.through}, with ${counts.through} kept on purpose as calls through a typed local`,
    `names with value bindings: ${names.total}; no use read: ${names.unused}; scan types only: ${names.scanTypes}; tsc dropped: ${names.dropped}; both: ${names.both}`,
    `names precision: ${percent(names.both, names.scanTypes)}; names recall: ${percent(names.both, names.dropped - names.through)} (${names.through} kept as calls through a typed local)`,
    "", `names the scan reads as types only that tsc keeps (${falseNames.length}):`, ...falseNames.slice(0, show).map(item => `  ${item}`),
    "", `names tsc drops that the scan keeps, or keeps with no use read (${missedNames.length}):`, ...missedNames.slice(0, show).map(item => `  ${item}`),
    "", `scan says types only, tsc kept (${falseTypes.length}):`, ...falseTypes.slice(0, show).map(item => `  ${item}`),
    "", `tsc dropped, scan keeps (${missedTypes.length}):`, ...missedTypes.slice(0, show).map(item => `  ${item}`),
    "", `calls through a typed local (${through.length}):`, ...through.slice(0, Math.min(show, 10)).map(item => `  ${item}`),
    ...goLines,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ counts, names, falseTypes, missedTypes, through, falseNames, missedNames }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
