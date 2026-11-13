// Scores "Where it runs" (plan phase-7-deployment.md) against tests/eval/references/deployment.json: per repository, the frames found, missed and extra
// (and any the reference says must not appear), the resource instances right, missed and extra, and the services tied to code right, wrong and untied.
// Wrong ties must be 0. Read-only: it scans and drafts in memory.
//
//   bun tests/eval/deployment.ts [--root DIR] [--step N] [--json]
//
// `--root` is the folder the references' workspaces are relative to (default: the folder holding this checkout; `.cache/…` is under this checkout).
// `--step N` expects only the frames the plan's steps 1 to N draw (extras are counted whatever their step). The draft's `runs` is what the mapping
// carries (decision 8): one entry per service a frame runs, `{ target, name, elements, by }`, where `elements` are the boxes it is an instance of (a
// resource's element, or code boxes) and empty for a plain service: `runsOf` in src/draft.ts.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { type Draft, draftOf, readManifests, runsOf } from "../../src/draft";
import { readInfra } from "../../src/resources";
import { isUnscannedSource, listFiles, scanWorkspace } from "../../src/scan";

interface Service { name: string; runs: "code" | "resource"; code?: string[]; resource?: string; rung?: 1 | 2 | 3 | null; untied?: true; forbidden?: string[]; optional?: true; by: string }
interface Frame { target: string; format: string; step: number; services: Service[] }
interface Repo { workspace: string; frames: Frame[]; optional?: string[]; mustNotAppear: string[]; outOfScope: string[] }
export interface RunEntry { readonly target: string; readonly name: string; readonly elements: readonly string[]; readonly by?: string }

const { values } = parseArgs({ options: { root: { type: "string" }, step: { type: "string" }, json: { type: "boolean", default: false } } });
const step = values.step ? Number(values.step) : Infinity;
const checkout = resolve(import.meta.dir, "..", "..");
const reference = await Bun.file(join(import.meta.dir, "references", "deployment.json")).json() as { repos: Record<string, Repo> };

const under = (path: string, folder: string) => folder === "." || path === folder || path.startsWith(`${folder}/`);
const inside = (target: string, list: readonly string[]) => list.some(item => under(target, item));

/** Each code box of the draft (a package, an opened folder, a group, a component) with the files it holds. */
function boxesOf(draft: Draft) {
  const boxes = new Map<string, string[]>();
  const add = (id: string, files: readonly string[]) => { if (id) boxes.set(id, [...boxes.get(id) ?? [], ...files]); };
  for (const item of draft.packages) {
    for (const component of item.components) {
      add(component.id, component.files);
      // Every enclosing id: the package, an opened folder, a group (`pkg.small.helpers` sits in `pkg.small`, which is no box; it is harmless).
      const parts = component.id.split(".");
      for (let at = 1; at < parts.length; at++) add(parts.slice(0, at).join("."), component.files);
    }
    add(item.id, item.components.flatMap(component => component.files));
  }
  return boxes;
}

const totals = { framesExpected: 0, framesFound: 0, framesExtra: 0, forbidden: 0, instancesExpected: 0, instancesRight: 0, instancesExtra: 0, tiesExpected: 0, tiesRight: 0, tiesPartial: 0, tiesWrong: 0, tiesUntied: 0, untiedHeld: 0, untiedExpected: 0 };
const results: Record<string, unknown> = {};
for (const [name, repo] of Object.entries(reference.repos)) {
  const workspace = repo.workspace.startsWith(".cache/") ? join(checkout, repo.workspace) : join(values.root ?? resolve(checkout, ".."), repo.workspace);
  if (!existsSync(workspace)) { results[name] = { skipped: `no workspace at ${workspace}` }; continue; }
  const draft = await Effect.runPromise(Effect.gen(function* () {
    const scan = yield* scanWorkspace(workspace);
    const { paths } = yield* listFiles(workspace);
    return draftOf(scan, yield* readManifests(workspace, paths), undefined, paths.filter(isUnscannedSource), yield* readInfra(workspace, paths));
  }));
  const runs: readonly RunEntry[] = runsOf(draft);
  const boxes = boxesOf(draft);
  const resourceOf = new Map(draft.resources.map(item => [item.element, item.sql ? "sql" : item.id] as const));
  const allFiles = [...new Set([...boxes.values()].flat())];
  /** The smallest box holding every file under a folder: the box a careful person would point at when the draft has not opened that folder. */
  const nearest = (folder: string) => {
    const wanted = allFiles.filter(file => under(file, folder));
    if (!wanted.length) return undefined;
    return [...boxes].filter(([, files]) => wanted.every(file => files.includes(file))).sort((a, b) => a[1].length - b[1].length)[0]?.[0];
  };
  /** A drawn box answers a folder when all its files are in it, or it is that folder's nearest box. */
  const answers = (box: string, folder: string) => { const files = boxes.get(box) ?? []; return (files.length > 0 && files.every(file => under(file, folder))) || nearest(folder) === box; };

  const frames = repo.frames.filter(frame => frame.step <= step);
  const drawnTargets = [...new Set(runs.map(entry => entry.target))];
  const expected = new Set(frames.map(frame => frame.target)), known = new Set(repo.frames.map(frame => frame.target));
  const missedFrames = frames.map(frame => frame.target).filter(target => !drawnTargets.includes(target));
  const forbidden = drawnTargets.filter(target => inside(target, repo.mustNotAppear));
  const extraFrames = drawnTargets.filter(target => !expected.has(target) && !known.has(target) && !(repo.optional ?? []).includes(target) && !forbidden.includes(target));
  totals.framesExpected += expected.size; totals.framesFound += expected.size - missedFrames.length; totals.framesExtra += extraFrames.length; totals.forbidden += forbidden.length;

  const instances = { right: 0, missed: [] as string[], extra: [] as string[] };
  const ties = { right: [] as string[], partial: [] as string[], wrong: [] as string[], untied: [] as string[], beyond: [] as string[], held: 0, heldExpected: 0 };
  for (const frame of frames) {
    const drawn = runs.filter(entry => entry.target === frame.target);
    // Resource instances: by service name first, then by resource among what is left.
    const wanted = frame.services.filter(service => service.runs === "resource");
    const left = drawn.filter(entry => entry.elements.length === 1 && resourceOf.has(entry.elements[0]!));
    const take = (match: (entry: RunEntry) => boolean) => { const at = left.findIndex(match); return at < 0 ? undefined : left.splice(at, 1)[0]; };
    const unmatched: Service[] = [];
    for (const service of wanted) {
      const entry = take(entry => entry.name === service.name);
      if (!entry) { unmatched.push(service); continue; }
      if (resourceOf.get(entry.elements[0]!) === service.resource) { if (!service.optional) instances.right++; }
      else instances.extra.push(`${frame.target}#${entry.name} is ${resourceOf.get(entry.elements[0]!)}, not ${service.resource}`);
    }
    for (const service of unmatched) {
      const entry = take(entry => resourceOf.get(entry.elements[0]!) === service.resource);
      if (service.optional) continue;
      if (entry) instances.right++; else instances.missed.push(`${frame.target}#${service.name} (${service.resource})`);
    }
    for (const entry of left) if (!frame.services.some(service => service.optional && service.name === entry.name)) instances.extra.push(`${frame.target}#${entry.name} (${resourceOf.get(entry.elements[0]!)})`);
    totals.instancesExpected += wanted.filter(service => !service.optional).length;

    // Ties: a service that runs code, by its name.
    for (const service of frame.services.filter(item => item.runs === "code")) {
      const label = `${frame.target}#${service.name}`;
      const elements = drawn.find(entry => entry.name === service.name)?.elements.filter(element => !resourceOf.has(element)) ?? [];
      const strays = drawn.find(entry => entry.name === service.name)?.elements.filter(element => resourceOf.has(element)) ?? [];
      const expectTie = !service.untied && service.rung != null;
      if (expectTie) totals.tiesExpected++;
      // An image-only service is held untied where it is drawn (as a plain box) with no tie; one that is not drawn at all is not held, only absent.
      const framed = drawn.length > 0, present = drawn.some(entry => entry.name === service.name);
      if (service.untied && framed) { ties.heldExpected++; totals.untiedExpected++; }
      if (!elements.length && !strays.length) {
        if (service.untied && framed && present) { ties.held++; totals.untiedHeld++; }
        else if (expectTie) { ties.untied.push(label); totals.tiesUntied++; }
        continue;
      }
      const code = service.code ?? [];
      const wrong = service.untied || strays.length > 0 || elements.some(element => !boxes.has(element) || !code.some(folder => answers(element, folder)) || (service.forbidden ?? []).some(folder => answers(element, folder)));
      if (wrong) { ties.wrong.push(`${label} → ${[...elements, ...strays].join(", ")}`); totals.tiesWrong++; continue; }
      // Covered: the folder's nearest box is drawn, or the drawn boxes together hold every file under it (a flat draft's `.` needs them all).
      const covered = code.every(folder => {
        if (elements.includes(nearest(folder) ?? "\0")) return true;
        const held = new Set(elements.filter(element => answers(element, folder)).flatMap(element => boxes.get(element) ?? []));
        return allFiles.filter(file => under(file, folder)).every(file => held.has(file));
      });
      // A tie no rung was expected to make (a Procfile in its package's folder) is reported, not scored.
      if (covered && !expectTie) ties.beyond.push(label);
      else if (covered) { ties.right.push(label); totals.tiesRight++; }
      else { ties.partial.push(`${label} → ${elements.join(", ")}`); totals.tiesPartial++; }
    }
  }
  // Every other tie is wrong: a code box on a service the reference does not list as running code (a proxy, a tool, a resource service), in any
  // frame, expected or not. Without this a tie by image name in an optional or extra frame would go uncounted.
  const codeServices = new Set(repo.frames.flatMap(frame => frame.services.filter(service => service.runs === "code").map(service => `${frame.target}\0${service.name}`)));
  for (const entry of runs) {
    const tied = entry.elements.filter(element => !resourceOf.has(element));
    if (tied.length && !codeServices.has(`${entry.target}\0${entry.name}`)) { ties.wrong.push(`${entry.target}#${entry.name} → ${tied.join(", ")} (not a code service in the reference)`); totals.tiesWrong++; }
  }
  totals.instancesRight += instances.right; totals.instancesExtra += instances.extra.length;
  results[name] = {
    frames: `${expected.size - missedFrames.length} of ${expected.size}`, missedFrames, extraFrames, forbidden,
    instances: `${instances.right} of ${frames.flatMap(frame => frame.services).filter(service => service.runs === "resource" && !service.optional).length}`, missedInstances: instances.missed, extraInstances: instances.extra,
    ties: { right: ties.right.length, partial: ties.partial, wrong: ties.wrong, untied: ties.untied, beyond: ties.beyond, held: `${ties.held} of ${ties.heldExpected}` },
  };
}

if (values.json) console.log(JSON.stringify({ step: Number.isFinite(step) ? step : "all", totals, results }, null, 2));
else {
  for (const [name, result] of Object.entries(results)) {
    const item = result as { skipped?: string; frames?: string; instances?: string; missedFrames?: string[]; extraFrames?: string[]; forbidden?: string[]; missedInstances?: string[]; extraInstances?: string[]; ties?: { right: number; partial: string[]; wrong: string[]; untied: string[]; beyond: string[]; held: string } };
    if (item.skipped) { console.log(`${name}: skipped, ${item.skipped}`); continue; }
    console.log(`${name}: frames ${item.frames}, instances ${item.instances}, ties right ${item.ties!.right}, wrong ${item.ties!.wrong.length}, untied ${item.ties!.untied.length}, image-only held untied ${item.ties!.held}`);
    for (const [label, list] of [["missed frames", item.missedFrames], ["extra frames", item.extraFrames], ["FORBIDDEN frames", item.forbidden], ["missed instances", item.missedInstances], ["extra instances", item.extraInstances], ["WRONG ties", item.ties!.wrong], ["partial ties", item.ties!.partial], ["untied", item.ties!.untied], ["tied beyond the rungs", item.ties!.beyond]] as const) {
      if (list!.length) console.log(`    ${label}: ${list!.join("; ")}`);
    }
  }
  console.log(`\nframes ${totals.framesFound} of ${totals.framesExpected} (${totals.framesExtra} extra, ${totals.forbidden} forbidden); instances ${totals.instancesRight} of ${totals.instancesExpected} (${totals.instancesExtra} extra); ties ${totals.tiesRight} of ${totals.tiesExpected} (${totals.tiesWrong} wrong, ${totals.tiesPartial} partial, ${totals.tiesUntied} untied); image-only held untied ${totals.untiedHeld} of ${totals.untiedExpected}`);
}
