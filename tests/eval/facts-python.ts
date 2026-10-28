#!/usr/bin/env bun
// bun tests/eval/facts-python.ts --workspace DIR [--out FILE] [--python "uv run --python 3.14 --no-project python"]
//
// Compares the Python half of `pathlight scan` with an independent answer: tests/eval/facts_python.py, where CPython's own `ast` finds the import
// statements and `importlib.machinery.PathFinder` resolves them with the project's roots as the search path. It reads none of the scanner's code.
// Both disagreement lists are printed (and written with --out) so each can be read in the source; neither side is assumed right.
//
// The reference parses with the interpreter it runs on, so run it on the Python version the project declares (`requires-python`): an older `ast`
// cannot read newer syntax (Mealie needs 3.14 for `except A, B:`), and a file it cannot parse is listed rather than guessed.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { scanWorkspace } from "../../src/scan";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, out: { type: "string" }, python: { type: "string", default: "python3" } } });
const root = resolve(values.workspace!);
const scan = await Effect.runPromise(scanWorkspace(root));
const child = Bun.spawnSync([...values.python!.split(" "), "-I", resolve(import.meta.dir, "facts_python.py"), root], { stdout: "pipe", stderr: "pipe" });
if (child.exitCode !== 0) throw new Error(`facts_python.py failed: ${child.stderr.toString()}`);
const reference = JSON.parse(child.stdout.toString()) as { roots: string[]; pairs: [string, string, string][]; errors: [string, string][] };

const pairs = new Set<string>(), via = new Map<string, string>();
for (const [from, to, specifier] of reference.pairs) { const pair = `${from}\t${to}`; pairs.add(pair); if (!via.has(pair)) via.set(pair, specifier); }
const ours = new Set(scan.imports.filter(item => item.from.endsWith(".py") && item.from !== item.to).map(item => `${item.from}\t${item.to}`));
const ourVia = new Map<string, string>(scan.imports.map(item => [`${item.from}\t${item.to}`, `${item.specifier} (line ${item.line}, ${item.kind})`] as const));
const both = [...ours].filter(pair => pairs.has(pair)).length;
const onlyOurs = [...ours].filter(pair => !pairs.has(pair)).sort(), onlyReference = [...pairs].filter(pair => !ours.has(pair)).sort();
const percent = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(2)}%` : "n/a";
process.stdout.write(`python files ${scan.files.filter(file => file.language === "python").length}; roots ${reference.roots.map(item => item || ".").join(", ")}; files the reference could not parse ${reference.errors.length}\n`
  + `scan pairs ${ours.size}; reference pairs ${pairs.size}; both ${both}\n`
  + `scan found ${percent(both, pairs.size)} of the reference (${onlyReference.length} missed)\n`
  + `reference confirms ${percent(both, ours.size)} of the scan (${onlyOurs.length} the reference does not have)\n`);
for (const [label, list, source] of [["only the scan", onlyOurs, ourVia], ["only the reference", onlyReference, via]] as const) {
  if (!list.length) continue;
  process.stdout.write(`${label}:\n${list.slice(0, 20).map(pair => `  ${pair.replace("\t", " -> ")}  [${source.get(pair)}]`).join("\n")}${list.length > 20 ? `\n  … and ${list.length - 20} more` : ""}\n`);
}
if (values.out) writeFileSync(values.out, JSON.stringify({ errors: reference.errors,
  onlyOurs: onlyOurs.map(pair => ({ pair, specifier: ourVia.get(pair) })), onlyReference: onlyReference.map(pair => ({ pair, specifier: via.get(pair) })) }, null, 2));
