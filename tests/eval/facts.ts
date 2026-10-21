#!/usr/bin/env bun
// bun tests/eval/facts.ts --workspace DIR   (DIR must have its dependencies installed, so workspace packages resolve)
//
// Compares `pathlight scan` with an independent answer: every import specifier is found by a plain pattern match (after dropping
// comments) and resolved by oxc-resolver, a different resolver from the scanner's. Disagreements are printed so each can be read
// in the source and judged; neither side is assumed right.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ResolverFactory } from "oxc-resolver";
import { Effect } from "effect";
import { scanWorkspace } from "../../src/scan";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, out: { type: "string" } } });
const root = resolve(values.workspace!);
const scan = await Effect.runPromise(scanWorkspace(root));

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const specifier = /(?:^|[^\w.$])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const options = { extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] } };
// One resolver per (nearest tsconfig, runtime condition): the tsconfig supplies `paths` aliases such as `@/`.
const cache = new Map<string, ResolverFactory[]>();
const resolversFor = (tsconfig: string | undefined) => {
  const key = tsconfig ?? "";
  if (!cache.has(key)) cache.set(key, ["bun", "node", "workerd", "browser", "development"].map(condition => new ResolverFactory({
    ...options, conditionNames: [condition, "import", "default"], ...(tsconfig ? { tsconfig: { configFile: tsconfig, references: "auto" as const } } : {}) })));
  return cache.get(key)!;
};
const nearestTsconfig = (directory: string): string | undefined => {
  for (let at = directory; at.startsWith(root); at = dirname(at)) {
    if (existsSync(join(at, "tsconfig.json"))) return join(at, "tsconfig.json");
    if (at === root) break;
  }
  return undefined;
};

const pairs = new Set<string>();
const via = new Map<string, string>();
for (const file of scan.files) {
  const text = stripComments(readFileSync(join(root, file.path), "utf8"));
  for (const match of text.matchAll(specifier)) {
    const request = (match[1] ?? match[2])!;
    if (request.startsWith("node:") || request.startsWith("bun:")) continue;
    for (const resolver of resolversFor(nearestTsconfig(join(root, dirname(file.path))))) {
      const result = resolver.sync(join(root, dirname(file.path)), request);
      if (!result.path || result.path.includes("/node_modules/") || !result.path.startsWith(`${root}/`)) continue;
      const to = result.path.slice(root.length + 1);
      if (existsSync(join(root, to)) && to !== file.path) { pairs.add(`${file.path}\t${to}`); if (!via.has(`${file.path}\t${to}`)) via.set(`${file.path}\t${to}`, request); }
    }
  }
}
const ours = new Set(scan.imports.filter(item => item.from !== item.to).map(item => `${item.from}\t${item.to}`));
const both = [...ours].filter(pair => pairs.has(pair)).length;
const onlyOurs = [...ours].filter(pair => !pairs.has(pair)), onlyReference = [...pairs].filter(pair => !ours.has(pair));
const percent = (part: number, whole: number) => `${(100 * part / whole).toFixed(2)}%`;
process.stdout.write(`files ${scan.files.length}; scan pairs ${ours.size}; reference pairs ${pairs.size}; both ${both}\n`
  + `scan found ${percent(both, pairs.size)} of the reference (${onlyReference.length} missed)\n`
  + `reference confirms ${percent(both, ours.size)} of the scan (${onlyOurs.length} the reference does not have)\n`);
if (values.out) writeFileSync(values.out, JSON.stringify({ onlyOurs, onlyReference: onlyReference.map(pair => ({ pair, specifier: via.get(pair) })) }, null, 2));
