// Scores the programs the draft draws from infrastructure (plan phase-r2-workloads.md) against tests/eval/references/programs.json: per repository, the
// programs found, missed and extra, and their arrows to resources found, missed and extra. Read-only: it scans and drafts in memory.
//
//   bun tests/eval/programs.ts [--root DIR] [--json]
//
// `--root` is the folder the references' workspaces are relative to (default: the folder holding this checkout; `.cache/…` is under this checkout).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { draftOf, readManifests } from "../../src/draft";
import { isSqlResource, readInfra } from "../../src/resources";
import { isUnscannedSource, listFiles, scanWorkspace } from "../../src/scan";

const { values } = parseArgs({ options: { root: { type: "string" }, json: { type: "boolean", default: false } } });
const checkout = resolve(import.meta.dir, "..", "..");
const reference = await Bun.file(join(import.meta.dir, "references", "programs.json")).json() as {
  repos: Record<string, { workspace: string; programs: { name: string; uses: string[] }[] }>;
};
const results: Record<string, unknown> = {};
let programsFound = 0, programsExpected = 0, programsExtra = 0, arrowsFound = 0, arrowsExpected = 0, arrowsExtra = 0;
for (const [name, repo] of Object.entries(reference.repos)) {
  const workspace = repo.workspace.startsWith(".cache/") ? join(checkout, repo.workspace) : join(values.root ?? resolve(checkout, ".."), repo.workspace);
  if (!existsSync(workspace)) { results[name] = { skipped: `no workspace at ${workspace}` }; continue; }
  const draft = await Effect.runPromise(Effect.gen(function* () {
    const scan = yield* scanWorkspace(workspace);
    const { paths } = yield* listFiles(workspace);
    return draftOf(scan, yield* readManifests(workspace, paths), undefined, paths.filter(isUnscannedSource), yield* readInfra(workspace, paths));
  }));
  // Each drawn program by its name, with the resource ids its arrows reach.
  // Any SQL database is `sql` on both sides, whatever engine names the box.
  const resourceOf = new Map(draft.resources.map(item => [item.element, item.sql ? "sql" : item.id] as const));
  const drawn = new Map(draft.packages.filter(item => item.runs).flatMap(item => item.components).map(entry => [entry.title, new Set(draft.uses.filter(use => use.from === entry.id).map(use => resourceOf.get(use.to)!))] as const));
  const wanted = new Map(repo.programs.map(item => [item.name, new Set(item.uses.map(use => isSqlResource(use) ? "sql" : use))] as const));
  const missedPrograms = [...wanted.keys()].filter(key => !drawn.has(key)), extraPrograms = [...drawn.keys()].filter(key => !wanted.has(key));
  const arrows = (from: Map<string, Set<string>>) => new Set([...from].flatMap(([program, uses]) => [...uses].map(use => `${program} → ${use}`)));
  const want = arrows(wanted), got = arrows(drawn);
  const missedArrows = [...want].filter(arrow => !got.has(arrow)), extraArrows = [...got].filter(arrow => !want.has(arrow));
  programsFound += wanted.size - missedPrograms.length; programsExpected += wanted.size; programsExtra += extraPrograms.length;
  arrowsFound += want.size - missedArrows.length; arrowsExpected += want.size; arrowsExtra += extraArrows.length;
  results[name] = { programs: `${wanted.size - missedPrograms.length} of ${wanted.size}`, missedPrograms, extraPrograms, arrows: `${want.size - missedArrows.length} of ${want.size}`, missedArrows, extraArrows };
}
if (values.json) console.log(JSON.stringify({ programsFound, programsExpected, programsExtra, arrowsFound, arrowsExpected, arrowsExtra, results }, null, 2));
else {
  for (const [name, result] of Object.entries(results)) {
    const item = result as { skipped?: string; programs?: string; arrows?: string; missedPrograms?: string[]; extraPrograms?: string[]; missedArrows?: string[]; extraArrows?: string[] };
    if (item.skipped) { console.log(`${name}: skipped, ${item.skipped}`); continue; }
    console.log(`${name}: programs ${item.programs}, arrows ${item.arrows}`);
    for (const [label, list] of [["missed programs", item.missedPrograms], ["extra programs", item.extraPrograms], ["missed arrows", item.missedArrows], ["extra arrows", item.extraArrows]] as const) {
      if (list!.length) console.log(`    ${label}: ${list!.join("; ")}`);
    }
  }
  console.log(`\nprograms ${programsFound} of ${programsExpected} (${programsExtra} extra); arrows ${arrowsFound} of ${arrowsExpected} (${arrowsExtra} extra)`);
}
