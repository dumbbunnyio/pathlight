#!/usr/bin/env bun
// bun tests/eval/facts.ts --workspace DIR   (DIR must have its dependencies installed, so workspace packages resolve)
//
// Compares `pathlight scan` with an independent answer: every import specifier is found by a plain pattern match (after dropping
// comments) and resolved by oxc-resolver, a different resolver from the scanner's. Disagreements are printed so each can be read
// in the source and judged; neither side is assumed right.
//
// Like the scan, the reference follows each imported name through re-exports (`export * from`, `export { a as b } from`) to the file that
// declares it. It does so with its own patterns and oxc-resolver, not the scanner's tokenizer or `throughReexports`, so the two can disagree.
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

// What a statement takes: `"*"` for `export *`, a list of { imported, exported } names, or nothing (a namespace, side-effect or dynamic import,
// which stays on the file it names).
type Names = "*" | { imported: string; exported: string }[] | undefined;
const clauseOf = /^[^\w.$]?(import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']/;
const bracedOf = (braces: string) => braces.split(",").map(part => part.trim().replace(/^type\s+/, "")).filter(Boolean)
  .map(part => { const [imported, exported] = part.split(/\s+as\s+/); return { imported: imported!.replace(/^["']|["']$/g, ""), exported: (exported ?? imported)!.replace(/^["']|["']$/g, "") }; });
function namesOf(statement: string): { reexport: boolean; names: Names } {
  const clause = clauseOf.exec(statement);
  if (!clause) return { reexport: false, names: undefined };
  const [, keyword, taken] = clause, reexport = keyword === "export", text = taken!.trim();
  if (reexport) {
    if (text === "*") return { reexport, names: "*" };
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(text);
    if (namespace) return { reexport, names: [{ imported: "*", exported: namespace[1]! }] };
    const braces = /^\{([\s\S]*)\}$/.exec(text);
    return { reexport, names: braces ? bracedOf(braces[1]!) : undefined };
  }
  if (/\*\s+as\s/.test(text)) return { reexport, names: undefined };
  const braces = /\{([\s\S]*)\}/.exec(text), local = text.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
  const names = [...(local ? [{ imported: "default", exported: local }] : []), ...(braces ? bracedOf(braces[1]!) : [])];
  return { reexport, names: names.length ? names : undefined };
}
// The names a file declares itself; `export { a }` of a local or imported binding counts, as it does for the scan.
const declaration = /(?:^|[^\w.$])export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const\s+enum|const|let|var|interface|type|enum|namespace|module)\s+([\w$]+)/g;
const localList = /(?:^|[^\w.$])export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;
const declaredBy = (text: string) => new Set([
  ...[...text.matchAll(declaration)].map(match => match[1]!),
  ...[...text.matchAll(localList)].flatMap(match => bracedOf(match[1]!).map(name => name.exported)),
  ...(/(?:^|[^\w.$])export\s+default\b/.test(text) ? ["default"] : []),
]);

interface Statement { from: string; to: string; request: string; reexport: boolean; names: Names }
const statements: Statement[] = [];
const declared = new Map<string, Set<string>>();
for (const file of scan.files) {
  const text = stripComments(readFileSync(join(root, file.path), "utf8"));
  declared.set(file.path, declaredBy(text));
  for (const match of text.matchAll(specifier)) {
    const request = (match[1] ?? match[2])!;
    if (request.startsWith("node:") || request.startsWith("bun:")) continue;
    const { reexport, names } = match[1] ? namesOf(match[0]) : { reexport: false, names: undefined };
    const reached = new Set<string>();
    for (const resolver of resolversFor(nearestTsconfig(join(root, dirname(file.path))))) {
      const result = resolver.sync(join(root, dirname(file.path)), request);
      if (!result.path || result.path.includes("/node_modules/") || !result.path.startsWith(`${root}/`)) continue;
      const to = result.path.slice(root.length + 1);
      // A file's import of itself is no pair, but `export * as Self from "./self.js"` still offers the name.
      if (existsSync(join(root, to)) && !reached.has(to)) { reached.add(to); statements.push({ from: file.path, to, request, reexport, names }); }
    }
  }
}
// Re-export lines each file offers, then each name followed through them to the file that declares it.
const offers = new Map<string, Statement[]>();
for (const statement of statements) if (statement.reexport && statement.names) offers.set(statement.from, [...offers.get(statement.from) ?? [], statement]);
const seen = new Map<string, string | undefined>();
function declarer(file: string, name: string, depth: number): string | undefined {
  if (declared.get(file)?.has(name)) return file;
  const key = `${file}\0${name}`;
  if (seen.has(key)) return seen.get(key);
  seen.set(key, undefined);
  let found: string | undefined;
  for (const offer of depth < 16 ? offers.get(file) ?? [] : []) {
    if (offer.names === "*") found = name === "default" ? undefined : declarer(offer.to, name, depth + 1);
    else {
      const named = offer.names!.find(entry => entry.exported === name);
      if (named) found = named.imported === "*" ? offer.to : declarer(offer.to, named.imported, depth + 1) ?? offer.to;
    }
    if (found) break;
  }
  seen.set(key, found);
  return found;
}
const pairs = new Set<string>();
const via = new Map<string, string>();
for (const statement of statements) {
  const followed = statement.reexport || !Array.isArray(statement.names) || !offers.has(statement.to) ? [statement.to]
    : [...new Set(statement.names.map(name => declarer(statement.to, name.imported, 0) ?? statement.to))];
  for (const to of followed) {
    if (to === statement.from) continue;
    const pair = `${statement.from}\t${to}`;
    pairs.add(pair);
    if (!via.has(pair)) via.set(pair, statement.request);
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
