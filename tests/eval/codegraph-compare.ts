// bun tests/eval/codegraph-compare.ts WORKSPACE [OUTDIR]   (WORKSPACE has .codegraph/codegraph.db from `codegraph init`; the dependencies need not be installed)
// Compares file-to-file import pairs: pathlight scan, the independent resolver of tests/eval/facts.ts, and CodeGraph by edge kind. Writes OUTDIR/disagree.json for reading.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ResolverFactory } from "oxc-resolver";
import { Effect } from "effect";
import { scanWorkspace } from "../../src/scan";

const root = resolve(process.argv[2]!);
const scan = await Effect.runPromise(scanWorkspace(root));
const files = new Set(scan.files.map(file => file.path));
const isTest = (path: string) => /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path);

// Oracle: the same independent method as tests/eval/facts.ts.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const specifier = /(?:^|[^\w.$])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const options = { extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"], extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".jsx": [".tsx", ".jsx"], ".mjs": [".mts", ".mjs"], ".cjs": [".cts", ".cjs"] } };
const cache = new Map<string, ResolverFactory>();
const resolverFor = (tsconfig?: string) => { const key = tsconfig ?? ""; if (!cache.has(key)) cache.set(key, new ResolverFactory({ ...options, conditionNames: ["import", "default"], ...(tsconfig ? { tsconfig: { configFile: tsconfig, references: "auto" as const } } : {}) })); return cache.get(key)!; };
const nearest = (directory: string) => { for (let at = directory; at.startsWith(root); at = dirname(at)) { if (existsSync(join(at, "tsconfig.json"))) return join(at, "tsconfig.json"); if (at === root) break; } return undefined; };
const oracle = new Set<string>();
for (const file of scan.files) {
  const text = stripComments(readFileSync(join(root, file.path), "utf8"));
  for (const match of text.matchAll(specifier)) {
    const request = (match[1] ?? match[2])!;
    if (request.startsWith("node:") || request.startsWith("bun:")) continue;
    const result = resolverFor(nearest(join(root, dirname(file.path)))).sync(join(root, dirname(file.path)), request);
    if (!result.path || result.path.includes("/node_modules/") || !result.path.startsWith(`${root}/`)) continue;
    const to = result.path.slice(root.length + 1);
    if (existsSync(join(root, to)) && to !== file.path) oracle.add(`${file.path}\t${to}`);
  }
}
const ours = new Set(scan.imports.filter(item => item.from !== item.to).map(item => `${item.from}\t${item.to}`));

// CodeGraph: file pairs from its database, by edge kind.
const db = new Database(join(root, ".codegraph/codegraph.db"), { readonly: true });
const rows = db.query(`select e.kind as kind, s.file_path as sf, t.file_path as tf from edges e join nodes s on s.id = e.source join nodes t on t.id = e.target where s.file_path != t.file_path and e.kind != 'contains'`).all() as { kind: string; sf: string; tf: string }[];
const byKind = new Map<string, Set<string>>();
for (const row of rows) { if (!byKind.has(row.kind)) byKind.set(row.kind, new Set()); byKind.get(row.kind)!.add(`${row.sf}\t${row.tf}`); }
const cgImports = byKind.get("imports") ?? new Set<string>();
const cgAll = new Set(rows.map(row => `${row.sf}\t${row.tf}`));
const cgFiles = new Set((db.query("select file_path from nodes where kind = 'file'").all() as { file_path: string }[]).map(row => row.file_path));

const universe = (set: Set<string>, keep: (path: string) => boolean) => new Set([...set].filter(pair => { const [a, b] = pair.split("\t") as [string, string]; return files.has(a) && files.has(b) && keep(a) && keep(b); }));
const report = (label: string, keep: (path: string) => boolean) => {
  const truth = universe(oracle, keep);
  const line = (name: string, set: Set<string>) => {
    const mine = universe(set, keep);
    const both = [...mine].filter(pair => truth.has(pair)).length;
    return `${name.padEnd(22)} pairs ${String(mine.size).padStart(5)}  found ${(100 * both / truth.size).toFixed(1).padStart(5)}% of the oracle (${truth.size - both} missed)  oracle confirms ${(100 * both / mine.size).toFixed(1).padStart(5)}% (${mine.size - both} not in the oracle)`;
  };
  console.log(`\n${label}: ${[...files].filter(keep).length} files, oracle ${truth.size} pairs`);
  console.log(line("pathlight scan", ours));
  console.log(line("codegraph imports", cgImports));
  console.log(line("codegraph all kinds", cgAll));
  for (const [kind, set] of byKind) if (kind !== "imports") console.log(line(`  codegraph ${kind}`, set));
};
report("all files", () => true);
report("non-test files", path => !isTest(path));
console.log(`\ncodegraph indexed ${cgFiles.size} files; the scan lists ${files.size}; in both ${[...cgFiles].filter(path => files.has(path)).length}`);
console.log("files the scan has and codegraph does not:", [...files].filter(path => !cgFiles.has(path)).slice(0, 8));
console.log("files codegraph has and the scan does not:", [...cgFiles].filter(path => !files.has(path)).slice(0, 8));
// Disagreements for reading.
const keep = (path: string) => !isTest(path);
const truth = universe(oracle, keep), mineScan = universe(ours, keep), mineCg = universe(cgImports, keep), mineCgAll = universe(cgAll, keep);
writeFileSync(join(process.argv[3] ?? "/tmp", "disagree.json"), JSON.stringify({
  scanMissed: [...truth].filter(pair => !mineScan.has(pair)), scanExtra: [...mineScan].filter(pair => !truth.has(pair)),
  cgMissed: [...truth].filter(pair => !mineCg.has(pair)), cgExtra: [...mineCg].filter(pair => !truth.has(pair)),
  cgAllMissed: [...truth].filter(pair => !mineCgAll.has(pair)), cgAllExtra: [...mineCgAll].filter(pair => !truth.has(pair)),
}, null, 1));
