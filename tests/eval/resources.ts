// Scores the resources the draft finds against tests/eval/references/resources.json (plan phase-r-resources.md): per repository, the references found,
// missed and the boxes the draft drew that no reference lists. Read-only: it scans and drafts in memory and writes nothing into the repositories.
//
//   bun tests/eval/resources.ts [--root DIR] [--step N] [--json]
//
// `--root` is the folder the references' workspaces are relative to (default: the folder holding this checkout, where pathlight-oss-test-repos/ sits,
// and this checkout for .cache/eval/…). A reference needs `step` ≤ --step (default 1) to count as expected.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { draftOf, readManifests } from "../../src/draft";
import { readInfra } from "../../src/resources";
import { isUnscannedSource, listFiles, scanWorkspace } from "../../src/scan";

const { values } = parseArgs({ options: { root: { type: "string" }, step: { type: "string", default: "1" }, json: { type: "boolean", default: false } } });
const checkout = resolve(import.meta.dir, "..", "..");
const reference = await Bun.file(join(import.meta.dir, "references", "resources.json")).json() as {
  repos: Record<string, { workspace: string; resources: { id: string; kind: string; step: number; title: string }[]; absent: string[] }>;
};
const step = Number(values.step);
const results: Record<string, unknown> = {};
let found = 0, expected = 0, extra = 0, mistitled = 0;
for (const [name, repo] of Object.entries(reference.repos)) {
  const workspace = repo.workspace.startsWith(".cache/") ? join(checkout, repo.workspace) : join(values.root ?? resolve(checkout, ".."), repo.workspace);
  if (!existsSync(workspace)) { results[name] = { skipped: `no workspace at ${workspace}` }; continue; }
  const draft = await Effect.runPromise(Effect.gen(function* () {
    const scan = yield* scanWorkspace(workspace);
    const { paths } = yield* listFiles(workspace);
    return draftOf(scan, yield* readManifests(workspace, paths), undefined, paths.filter(isUnscannedSource), step >= 2 ? yield* readInfra(workspace, paths) : []);
  }));
  // The title each expected resource should have by this step: the last reference entry for its id at or before it.
  const wanted = new Map<string, string>();
  for (const item of repo.resources.filter(entry => entry.step <= step).sort((a, b) => a.step - b.step)) wanted.set(item.id, item.title);
  const drawn = new Map(draft.resources.map(item => [item.id, item]));
  const hits = [...wanted.keys()].filter(id => drawn.has(id)), misses = [...wanted.keys()].filter(id => !drawn.has(id));
  const extras = [...drawn.keys()].filter(id => !wanted.has(id) && !repo.resources.some(entry => entry.id === id));
  // A forbidden package that led to a box is a wrong box, whatever its id.
  const forbidden = draft.resources.filter(item => item.packages.some(pkg => repo.absent.includes(pkg))).map(item => `${item.id} (${item.packages.filter(pkg => repo.absent.includes(pkg)).join(", ")})`);
  const titles = hits.filter(id => drawn.get(id)!.title !== wanted.get(id)).map(id => `${id}: "${drawn.get(id)!.title}", expected "${wanted.get(id)}"`);
  found += hits.length; expected += wanted.size; extra += extras.length + forbidden.length; mistitled += titles.length;
  results[name] = {
    found: `${hits.length} of ${wanted.size}`, missed: misses, extra: extras, forbidden, titles,
    drawn: draft.resources.map(item => ({ id: item.id, title: item.title, kind: item.kind, files: item.files.length, packages: item.packages, ...(item.engines.length ? { engines: item.engines } : {}) })),
    uses: draft.uses.length,
  };
}
if (values.json) console.log(JSON.stringify({ step, found, expected, extra, mistitled, results }, null, 2));
else {
  for (const [name, result] of Object.entries(results)) {
    const item = result as { skipped?: string; found?: string; missed?: string[]; extra?: string[]; forbidden?: string[]; titles?: string[]; drawn?: { id: string; title: string; kind: string; files: number }[]; uses?: number };
    if (item.skipped) { console.log(`${name}: skipped, ${item.skipped}`); continue; }
    console.log(`${name}: ${item.found} found${item.missed!.length ? `; missed ${item.missed!.join(", ")}` : ""}${item.extra!.length ? `; extra ${item.extra!.join(", ")}` : ""}${item.forbidden!.length ? `; FORBIDDEN ${item.forbidden!.join(", ")}` : ""}${item.titles!.length ? `; titled ${item.titles!.join("; ")}` : ""}`);
    for (const box of item.drawn!) console.log(`    ${box.kind.padEnd(10)} ${box.title} (${box.id}, ${box.files} files)`);
    console.log(`    ${item.uses} arrows from components`);
  }
  console.log(`\nstep ${step}: ${found} of ${expected} found, ${extra} extra or forbidden, ${mistitled} titled otherwise`);
}
