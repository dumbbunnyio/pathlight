#!/usr/bin/env bun
// bun tests/eval/facts-go.ts --workspace DIR [--out FILE]
//
// Compares the Go half of `pathlight scan` with `go list -json ./...`, the Go tool's own account of each package's imports, at the level the Go tool
// answers: package to package (folder to folder) within the module. The scan's file-to-file records are collapsed to their folders; the reference is
// each package's Imports, TestImports and XTestImports filtered to the module's own path. `go list` evaluates build constraints and the scan does not,
// so a file excluded by its tags (IgnoredGoFiles) is an expected class of disagreement and is listed, not hidden. Run without network or writes:
// GOFLAGS=-mod=readonly and GOPROXY=off, with -e so a dependency that is not downloaded does not stop the listing (imports come from the source).
// Needs `go` (1.26 at /usr/local/go/bin/go on the machine this was written on); skips when it is absent.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { scanWorkspace } from "../../src/scan";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, out: { type: "string" } } });
const root = resolve(values.workspace!);
const goBinary = [Bun.which("go"), "/usr/local/go/bin/go"].find(path => path && existsSync(path));
if (!goBinary) { process.stdout.write("go is not installed: skipped\n"); process.exit(0); }

const scan = await Effect.runPromise(scanWorkspace(root));
interface Package { Dir: string; ImportPath: string; Module?: { Path: string; Dir: string }; Imports?: string[]; TestImports?: string[]; XTestImports?: string[]; IgnoredGoFiles?: string[]; GoFiles?: string[] }
const packages: Package[] = [];
for (const goMod of [...new Bun.Glob("**/go.mod").scanSync({ cwd: root })].filter(path => !/(^|\/)(vendor|node_modules)\//.test(path))) {
  const child = Bun.spawnSync([goBinary, "list", "-e", "-json", "./..."], { cwd: resolve(root, dirname(goMod)), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GOFLAGS: "-mod=readonly", GOPROXY: "off", GOTOOLCHAIN: "local" } });
  // `go list -json` prints one JSON object after another.
  const text = child.stdout.toString();
  for (let start = 0, depth = 0, inString = false, index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) { if (char === "\\") index++; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === "{") { if (depth++ === 0) start = index; }
    else if (char === "}" && --depth === 0) packages.push(JSON.parse(text.slice(start, index + 1)) as Package);
  }
}

const folder = (path: string) => { const rel = relative(root, path); return rel === "" ? "." : rel; };
const byImportPath = new Map(packages.map(item => [item.ImportPath, folder(item.Dir)] as const));
const pairs = new Set<string>(), via = new Map<string, string>(), ignored: string[] = [];
for (const item of packages) {
  const from = folder(item.Dir);
  for (const file of item.IgnoredGoFiles ?? []) ignored.push(posix.join(from, file));
  for (const imported of [...item.Imports ?? [], ...item.TestImports ?? [], ...item.XTestImports ?? []]) {
    const to = byImportPath.get(imported);
    if (to === undefined || to === from) continue;
    const pair = `${from}\t${to}`;
    pairs.add(pair);
    if (!via.has(pair)) via.set(pair, imported);
  }
}
const ours = new Set<string>(), ourVia = new Map<string, string>();
for (const item of scan.imports) {
  if (!item.from.endsWith(".go")) continue;
  const from = posix.dirname(item.from), to = posix.dirname(item.to);
  if (from === to) continue;
  const pair = `${from}\t${to}`;
  ours.add(pair);
  if (!ourVia.has(pair)) ourVia.set(pair, `${item.from}:${item.line} ${item.specifier}`);
}
const both = [...ours].filter(pair => pairs.has(pair)).length;
const onlyOurs = [...ours].filter(pair => !pairs.has(pair)).sort(), onlyReference = [...pairs].filter(pair => !ours.has(pair)).sort();
const percent = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(2)}%` : "n/a";
process.stdout.write(`go packages ${packages.length}; go files the scan read ${scan.files.filter(file => file.language === "go").length}; files go list leaves out by build constraints ${ignored.length}\n`
  + `scan package pairs ${ours.size}; reference package pairs ${pairs.size}; both ${both}\n`
  + `scan found ${percent(both, pairs.size)} of the reference (${onlyReference.length} missed)\n`
  + `reference confirms ${percent(both, ours.size)} of the scan (${onlyOurs.length} the reference does not have)\n`);
for (const [label, list, source] of [["only the scan", onlyOurs, ourVia], ["only the reference", onlyReference, via]] as const) {
  if (!list.length) continue;
  process.stdout.write(`${label}:\n${list.slice(0, 20).map(pair => `  ${pair.replace("\t", " -> ")}  [${source.get(pair)}]`).join("\n")}${list.length > 20 ? `\n  … and ${list.length - 20} more` : ""}\n`);
}
if (ignored.length) process.stdout.write(`excluded by build constraints (read by the scan): ${ignored.slice(0, 10).join(", ")}${ignored.length > 10 ? ", …" : ""}\n`);
if (values.out) writeFileSync(values.out, JSON.stringify({ ignored, onlyOurs: onlyOurs.map(pair => ({ pair, specifier: ourVia.get(pair) })),
  onlyReference: onlyReference.map(pair => ({ pair, specifier: via.get(pair) })) }, null, 2));
