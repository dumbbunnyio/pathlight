import { realpath } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { type ActivityConfig, readActivityConfig } from "./activity";
import { acquireModel, invalidModel } from "./catalog";
import { crowdedAbove } from "./draft";
import { failure, io } from "./effects";
import { scannedLanguages } from "./languages";
import { entryFor, isSqlResource, programsOf, readInfra, type Program } from "./resources";
import { listFiles, scanWorkspace, type Scan } from "./scan";

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
// `line` 0: an infrastructure file names it (a secret, `depends_on`), which is read as names, not lines.
const Example = Schema.Struct({ from: Schema.String, line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)), to: Schema.String, kind: Schema.String });

/**
 * How a LikeC4 model and its file mapping compare with the imports a static scan found. Every statement is about
 * static evidence only: a relationship with no import behind it may still be real (a network call, an event, a file
 * read), and an import between two elements may be incidental. These are questions to look at, never verdicts.
 */
export const Check = Schema.Struct({
  version: Schema.Literal(1),
  basis: Schema.Literal("static"),
  project: Schema.String,
  mappings: Schema.Struct({
    total: Count,
    // Files the config's `ignore` list leaves out of "unmapped".
    ignored: Count,
    // Elements the config names as shared, and how many imports into them were left out of "imports with no relationship".
    shared: Schema.Array(Schema.String), sharedImports: Count,
    // Mappings whose glob matches no file in the workspace.
    unmatched: Schema.Array(Schema.Struct({ glob: Schema.String, element: Schema.String })),
    // Scanned source files that no mapping claims.
    unmappedFiles: Schema.Array(Schema.String),
  }),
  relationships: Schema.Array(Schema.Struct({
    source: Schema.String, target: Schema.String, title: Schema.NullOr(Schema.String),
    // supported: an import connects the two elements' files. unsupported: none was found.
    // unverifiable: the source or the target has no mapped files, so there is nothing to look at.
    status: Schema.Literals(["supported", "unsupported", "unverifiable"]),
    // A relationship describes flow or use, while an import points from the user to what it uses, so either direction
    // is evidence: "same" runs source to target, "opposite" target to source.
    direction: Schema.Literals(["same", "opposite", "both", "none"]),
    imports: Count, examples: Schema.Array(Example),
    // Judged by what infrastructure names (a program's arrow, Phase R2), not by imports.
    infra: Schema.optionalKey(Schema.Boolean),
  })),
  // Files per element, largest first. `large` marks an element holding a quarter or more of the mapped files (at least 15),
  // with the folders inside it, as a hint that it may be several things.
  size: Schema.Array(Schema.Struct({ element: Schema.String, files: Count, large: Schema.Boolean, folders: Schema.Array(Schema.Struct({ folder: Schema.String, files: Count })) })),

  // Elements with many direct children, which a reader meets side by side. A hint to group them, not a verdict.
  wide: Schema.Array(Schema.Struct({ parent: Schema.String, children: Count })),
  // The plan: elements the mapping names as designed but not built. `waiting` have no files yet; `built` now have files, so their marker can go.
  plan: Schema.Struct({ planned: Count, waiting: Schema.Array(Schema.String), built: Schema.Array(Schema.String) }),
  // `entries` are the views no navigateTo points to. A diagram normally has one, the overview.
  views: Schema.Struct({ total: Count, entries: Schema.Array(Schema.String) }),
  // Imports between two mapped elements that no relationship at that level, or above it, declares (in either direction).
  undeclared: Schema.Array(Schema.Struct({ source: Schema.String, target: Schema.String, imports: Count, examples: Schema.Array(Example) })),
  // What the code talks to (the mapping's `resources`): how many files import each one's packages. None means its evidence is gone.
  resources: Schema.Array(Schema.Struct({ element: Schema.String, packages: Schema.Array(Schema.String), files: Count, declared: Schema.Array(Schema.String) })),
  summary: Schema.Struct({ unusedResources: Count, unmatchedMappings: Count, unmappedFiles: Count, unsupported: Count, unverifiable: Count, undeclared: Count, largeElements: Count, wideGroups: Count, unlinkedViews: Count }),
});
export interface Check extends Schema.Schema.Type<typeof Check> {}

const within = (element: string, ancestor: string) => element === ancestor || element.startsWith(`${ancestor}.`);
const related = (a: string, b: string) => within(a, b) || within(b, a);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Compares a model's declared relationships and a file mapping with the imports of one tree of files (the working tree, or an older commit).
 * `check` runs it on the workspace; `diff` runs it on two trees and reports what changed.
 */
export function compareImports(config: ActivityConfig, scan: Pick<Scan, "files" | "imports"> & { readonly external?: Scan["external"] }, paths: readonly string[], declared: readonly { source: string; target: string; title: string | null }[], programs: readonly Program[] = []) {
  const shared = config.shared ?? [];
  const planned = config.planned ?? [];
  const isPlanned = (element: string) => planned.some(id => within(element, id));
  const isShared = (element: string) => shared.some(id => within(element, id));
  // The files each element is mapped to directly, and (for judging relationships) with those of everything inside it.
  const direct = new Map<string, Set<string>>(), claimed = new Map<string, Set<string>>(), unmatched: { glob: string; element: string }[] = [];
  for (const mapping of config.mappings) {
    const glob = new Bun.Glob(mapping.glob), matches = paths.filter(path => glob.match(path));
    // A planned element has no files until it is built; that is the plan, not a mapping that points nowhere.
    if (!matches.length && !isPlanned(mapping.element)) unmatched.push({ glob: mapping.glob, element: mapping.element });
    for (const path of matches) {
      direct.set(mapping.element, (direct.get(mapping.element) ?? new Set()).add(path));
      claimed.set(path, (claimed.get(path) ?? new Set()).add(mapping.element));
    }
  }
  const filesWithin = (element: string) => {
    const files = new Set<string>();
    for (const [owner, owned] of direct) if (within(owner, element)) for (const path of owned) files.add(path);
    return files;
  };
  const example = (edge: Scan["imports"][number]) => ({ from: edge.from, line: edge.line, to: edge.to, kind: edge.kind });
  type Scan = typeof scan;
  // A file the config ignores is deliberately outside the model, so what it imports is not evidence either way (a folder claimed whole also claims its tests).
  const ignores = (config.ignore ?? []).map(glob => new Bun.Glob(glob));
  const ignoredPath = (path: string) => ignores.some(glob => glob.match(path));
  const evidence = scan.imports.filter(edge => !ignoredPath(edge.from) && !ignoredPath(edge.to));
  const edgesBetween = (from: ReadonlySet<string>, to: ReadonlySet<string>) =>
    evidence.filter(edge => from.has(edge.from) && to.has(edge.to) && edge.from !== edge.to);

  // A resource is judged by the packages that lead to it (src/resources.ts), not by imports between files: a relationship to one is supported when a file
  // of its source imports one of them at run time. A package the table leads to the same entry as a listed one counts too (a new subpath of a Go module).
  const resourceOf = new Map((config.resources ?? []).map(item => [item.element, item] as const));
  const leadsTo = (resource: { packages: readonly string[] }, name: string) => resource.packages.includes(name)
    || (entryFor(name) !== undefined && resource.packages.some(listed => entryFor(listed) === entryFor(name)));
  const runtime = (scan.external ?? []).filter(item => item.kind !== "type" && !ignoredPath(item.from));
  const usesOf = (resource: { packages: readonly string[] }) => runtime.filter(item => leadsTo(resource, item.package));
  const exampleUse = (item: NonNullable<typeof scan.external>[number]) => ({ from: item.from, line: item.line, to: item.package, kind: item.kind });
  // A program's arrow to a resource (Phase R2) is judged by what its infrastructure names now: the program as read from its file today, and the uses that
  // lead to the resource's id (any SQL use to a SQL database, whatever engine the box is named after).
  const programAt = new Map((config.programs ?? []).map(item => [item.element, programs.find(found => found.source === item.source && found.name === item.name)] as const));
  const reaches = (use: { resource: string }, resource: { resource?: string }) => resource.resource !== undefined && (use.resource === resource.resource || (use.resource === "sql" && isSqlResource(resource.resource)));
  const relationships = declared.map(({ source, target, title }) => {
    const resource = resourceOf.get(target) ?? resourceOf.get(source);
    if (resource && programAt.has(source) && resourceOf.has(target)) {
      const program = programAt.get(source), uses = (program?.uses ?? []).filter(use => reaches(use, resource));
      return { source, target, title, infra: true, status: uses.length ? "supported" as const : "unsupported" as const, direction: uses.length ? "same" as const : "none" as const, imports: uses.length,
        examples: uses.slice(0, 3).map(use => ({ from: program!.file ?? program!.source, line: 0, to: use.by, kind: "infra" })) };
    }
    if (resource) {
      const user = filesWithin(resourceOf.has(target) ? source : target), uses = usesOf(resource).filter(item => user.has(item.from));
      if (!user.size) return { source, target, title, status: "unverifiable" as const, direction: "none" as const, imports: 0, examples: [] };
      return { source, target, title, status: uses.length ? "supported" as const : "unsupported" as const, direction: uses.length ? (resourceOf.has(target) ? "same" as const : "opposite" as const) : "none" as const,
        imports: uses.length, examples: uses.slice(0, 3).map(exampleUse) };
    }
    const from = filesWithin(source), to = filesWithin(target);
    if (!from.size || !to.size) return { source, target, title, status: "unverifiable" as const, direction: "none" as const, imports: 0, examples: [] };
    const forward = edgesBetween(from, to), backward = edgesBetween(to, from);
    const direction = forward.length && backward.length ? "both" as const : forward.length ? "same" as const : backward.length ? "opposite" as const : "none" as const;
    return { source, target, title, status: direction === "none" ? "unsupported" as const : "supported" as const, direction, imports: forward.length + backward.length,
      examples: [...forward, ...backward].slice(0, 3).map(example) };
  }).sort((a, b) => order(a.source, b.source) || order(a.target, b.target));

  const covered = (a: string, b: string) => declared.some(relationship => (within(a, relationship.source) && within(b, relationship.target)) || (within(b, relationship.source) && within(a, relationship.target)));
  const pairs = new Map<string, { source: string; target: string; edges: Scan["imports"][number][] }>();
  let sharedImports = 0;
  for (const edge of evidence) {
    if ([...claimed.get(edge.to) ?? []].some(isShared) && edge.from !== edge.to) { sharedImports++; continue; }
    for (const a of claimed.get(edge.from) ?? []) for (const b of claimed.get(edge.to) ?? []) {
      if (related(a, b) || covered(a, b)) continue;
      const key = `${a}\0${b}`, entry = pairs.get(key) ?? { source: a, target: b, edges: [] };
      entry.edges.push(edge);
      pairs.set(key, entry);
    }
  }
  // A file that imports a resource's package, in an element with no relationship to the resource.
  const resources = (config.resources ?? []).map(resource => {
    const uses = usesOf(resource);
    for (const use of uses) for (const a of claimed.get(use.from) ?? []) {
      if (related(a, resource.element) || covered(a, resource.element)) continue;
      const key = `${a}\0${resource.element}`, entry = pairs.get(key) ?? { source: a, target: resource.element, edges: [] };
      entry.edges.push({ from: use.from, to: use.package, line: use.line, kind: use.kind, specifier: use.package });
      pairs.set(key, entry);
    }
    // A program that names the resource now, with no arrow to it.
    for (const [element, program] of programAt) for (const use of (program?.uses ?? []).filter(candidate => reaches(candidate, resource))) {
      if (related(element, resource.element) || covered(element, resource.element)) continue;
      const key = `${element}\0${resource.element}`, entry = pairs.get(key) ?? { source: element, target: resource.element, edges: [] };
      entry.edges.push({ from: program!.file ?? program!.source, to: use.by, line: 0, kind: "import", specifier: use.by });
      pairs.set(key, entry);
    }
    return { element: resource.element, packages: [...resource.packages], files: new Set(uses.map(use => use.from)).size, declared: [...resource.declared ?? []] };
  });
  const undeclared = [...pairs.values()].sort((a, b) => order(a.source, b.source) || order(a.target, b.target))
    .map(({ source, target, edges }) => ({ source, target, imports: edges.length, examples: edges.slice(0, 3).map(example) }));
  return { direct, claimed, unmatched, filesWithin, ignoredPath, relationships, undeclared, sharedImports, resources };
}

export const checkWorkspace = Effect.fn("Check.workspace")(function* (workspace: string) {
  const root = yield* io("Check.workspace", () => realpath(workspace));
  const config = yield* readActivityConfig(root);
  const scan = yield* scanWorkspace(root);
  const { paths } = yield* listFiles(root);
  const source = yield* acquireModel(root);
  if (source.hasErrors()) return yield* Effect.fail(failure("Check.model", invalidModel(source, root)));
  const model = yield* io("LikeC4.compute", () => source.computedModel(config.project));
  const elements = new Set([...model.elements()].map(element => String(element.id)));
  for (const mapping of config.mappings) {
    if (!elements.has(mapping.element)) return yield* Effect.fail(failure("Check.mapping", `Unknown activity element '${mapping.element}'.`));
  }

  for (const id of config.shared ?? []) {
    if (!elements.has(id)) return yield* Effect.fail(failure("Check.shared", `Unknown shared element '${id}'.`));
  }
  for (const id of config.planned ?? []) {
    if (!elements.has(id)) return yield* Effect.fail(failure("Check.planned", `Unknown planned element '${id}'.`));
  }
  const shared = config.shared ?? [];
  const planned = config.planned ?? [];
  const isPlanned = (element: string) => planned.some(id => within(element, id));
  const isShared = (element: string) => shared.some(id => within(element, id));

  const declared = [...model.relationships()].map(relationship => ({
    source: String(relationship.source.id), target: String(relationship.target.id), title: relationship.title ?? null,
  }));
  for (const item of config.resources ?? []) {
    if (!elements.has(item.element)) return yield* Effect.fail(failure("Check.resources", `Unknown resource element '${item.element}'.`));
  }
  for (const item of config.programs ?? []) {
    if (!elements.has(item.element)) return yield* Effect.fail(failure("Check.programs", `Unknown program element '${item.element}'.`));
  }
  const programs = config.programs?.length ? programsOf(yield* readInfra(root, paths)) : [];
  const { direct, claimed, unmatched, filesWithin, ignoredPath, relationships, undeclared, sharedImports, resources } = compareImports(config, scan, paths, declared, programs);

  // How the mapped files are spread over the elements.
  const mappedCount = claimed.size;
  const folderOf = (files: string[]) => {
    const parts = files.map(path => path.split("/").slice(0, -1));
    let common = parts[0] ?? [];
    for (const dir of parts) { let n = 0; while (n < common.length && n < dir.length && common[n] === dir[n]) n++; common = common.slice(0, n); }
    const counts = new Map<string, number>();
    for (const dir of parts) { const key = dir.length > common.length ? [...common, dir[common.length]].join("/") : common.join("/") || "."; counts.set(key, (counts.get(key) ?? 0) + 1); }
    return [...counts].sort((a, b) => b[1] - a[1] || order(a[0], b[0])).map(([folder, files]) => ({ folder, files }));
  };
  const size = [...direct].map(([element, owned]) => {
    const large = owned.size >= 15 && owned.size / mappedCount >= 0.25;
    return { element, files: owned.size, large, folders: large ? folderOf([...owned]) : [] };
  }).sort((a, b) => b.files - a.files || order(a.element, b.element));

  // Direct children per parent over all model elements ("" is the top level). An element with a readable view of its own (one `of` it that is not a
  // declared listing) is met as the cards that view draws inside it, which may be fewer than its children: those are what is side by side.
  const children = new Map<string, number>();
  for (const id of elements) { const parent = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : ""; children.set(parent, (children.get(parent) ?? 0) + 1); }
  const listings = new Set(config.entries ?? []), drawnInside = new Map<string, number>();
  for (const view of model.views()) {
    const of = (view.$view as { viewOf?: unknown }).viewOf;
    if (of === undefined || listings.has(String(view.id))) continue;
    const cards = view.$view.nodes.filter(node => node.parent !== null && String(node.parent) === String(of)).length;
    drawnInside.set(String(of), Math.max(drawnInside.get(String(of)) ?? 0, cards));
  }
  // The draft draws at most `crowdedAbove - 1` cards inside one box, so only a view over that is too many to read.
  const wide = [...children].map(([parent, count]) => ({ parent, children: drawnInside.get(parent) ?? count })).filter(item => item.children > crowdedAbove - 1)
    .sort((a, b) => b.children - a.children || order(a.parent, b.parent));

  // Which views a person can reach by following navigateTo.
  const viewLinks = new Map<string, Set<string>>();
  for (const view of model.views()) {
    // The "Landscape" index LikeC4 adds when none is written is not part of the author's diagram.
    if (!view.$view.sourcePath) continue;
    // A flow (a journey, or a state diagram in a *.behavior.c4 file) is traced with F on the diagram, not reached by following a link.
    if ((view.$view as { _type?: string })._type === "dynamic" || /\.behavior\.(c4|likec4)$/.test(view.$view.sourcePath)) continue;
    const targets = new Set<string>();
    for (const node of view.$view.nodes) if (node.navigateTo && String(node.navigateTo) !== String(view.id)) targets.add(String(node.navigateTo));
    viewLinks.set(String(view.id), targets);
  }
  const linkedTo = new Set([...viewLinks.values()].flatMap(targets => [...targets]));
  const declaredEntries = new Set(config.entries ?? []);
  const entries = [...viewLinks.keys()].filter(id => !linkedTo.has(id) && !declaredEntries.has(id)).sort(order);

  const hasFiles = (id: string) => filesWithin(id).size > 0;
  const plan = { planned: planned.length, waiting: planned.filter(id => !hasFiles(id)).sort(order), built: planned.filter(hasFiles).sort(order) };
  const ignoredFiles = scan.files.map(file => file.path).filter(path => !claimed.has(path) && ignoredPath(path));
  const unmappedFiles = scan.files.map(file => file.path).filter(path => !claimed.has(path) && !ignoredFiles.includes(path));
  return Check.make({
    version: 1, basis: "static", project: config.project,
    mappings: { total: config.mappings.length, ignored: ignoredFiles.length, shared, sharedImports, unmatched, unmappedFiles },
    relationships, size, wide, plan, views: { total: viewLinks.size, entries }, undeclared, resources,
    summary: { unusedResources: resources.filter(item => item.packages.length && !item.files).length, unmatchedMappings: unmatched.length, unmappedFiles: unmappedFiles.length, unsupported: relationships.filter(item => item.status === "unsupported").length,
      unverifiable: relationships.filter(item => item.status === "unverifiable").length, undeclared: undeclared.length,
      largeElements: size.filter(item => item.large).length, wideGroups: wide.length, unlinkedViews: Math.max(0, entries.length - 1) },
  });
}, Effect.scoped);

/** The findings that deserve a look (everything except relationships that could not be checked, and the size notes). */
export const hasFindings = (check: Check) => check.summary.unusedResources + check.summary.unmatchedMappings + check.summary.unmappedFiles + check.summary.unsupported + check.summary.undeclared + check.summary.unlinkedViews > 0;

/** A readable report: what agrees with the code first, then what to look at, with the evidence it rests on. */
export function formatCheck(check: Check) {
  const where = (item: typeof check.undeclared[number]["examples"][number]) => `${item.from}${item.line ? `:${item.line}` : ""} → ${item.to}`;
  const lines = [`pathlight check · project ${check.project} · static evidence: imports in ${scannedLanguages} only`, ""];
  lines.push("Mapping", `  ${check.mappings.total} mappings${check.mappings.ignored ? `, ${check.mappings.ignored} source files ignored on purpose` : ""}`);
  for (const item of check.mappings.unmatched) lines.push(`  ▲ ${item.glob} (${item.element}) matches no files`);
  if (check.mappings.unmappedFiles.length) {
    const folders = new Map<string, number>();
    for (const path of check.mappings.unmappedFiles) { const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."; folders.set(folder, (folders.get(folder) ?? 0) + 1); }
    lines.push(`  ▲ ${check.mappings.unmappedFiles.length} source files map to no element:`);
    for (const [folder, count] of [...folders].sort((a, b) => b[1] - a[1] || order(a[0], b[0])).slice(0, 8)) lines.push(`      ${folder}/  ${count}`);
  } else lines.push("  ✓ every scanned source file is mapped");
  if (check.plan.planned) {
    lines.push("", "Plan");
    lines.push(`  ${check.plan.waiting.length ? "·" : "✓"} ${check.plan.built.length} of ${check.plan.planned} planned elements have files${check.plan.waiting.length ? `; not yet: ${check.plan.waiting.join(", ")}` : ""}`);
    for (const id of check.plan.built) lines.push(`  ▲ ${id} now has files: remove it from planned`);
  }
  lines.push("", `Relationships (${check.relationships.length} in the model)`);
  const label = (item: typeof check.relationships[number]) => `${item.source} → ${item.target}${item.title ? `  “${item.title}”` : ""}`;
  for (const item of check.relationships) {
    if (item.status === "supported") lines.push(`  ✓ ${label(item)}  ${item.imports} ${item.infra ? "name" : "import"}${item.imports === 1 ? "" : "s"}${item.direction === "opposite" ? " (pointing from the target)" : item.direction === "both" ? " (both ways)" : ""}, e.g. ${where(item.examples[0]!)}`);
    else if (item.status === "unsupported") lines.push(item.infra ? `  ▲ ${label(item)}  its infrastructure no longer names it (a secret, depends_on, an environment name)` : `  ▲ ${label(item)}  no import between the mapped files (it may run through a network call, an event or a file)`);
    else lines.push(`  · ${label(item)}  not checkable: an end has no mapped files`);
  }
  if (check.resources.length) {
    lines.push("", `Resources (${check.resources.length}: what the code talks to)`);
    // One only infrastructure declares is a question for whoever knows the deployment, not a finding.
    for (const item of check.resources) lines.push(item.files
      ? `  ✓ ${item.element}  ${item.files} file${item.files === 1 ? "" : "s"} import ${item.packages.join(", ")}`
      : item.packages.length ? `  ▲ ${item.element}  no file imports ${item.packages.join(", ")} any more: is it still used?`
      : `  · ${item.element}  declared in ${item.declared.join(", ")}; no code imports it`);
  }
  lines.push("", "Imports with no relationship");
  if (!check.undeclared.length) lines.push("  ✓ none");
  for (const item of check.undeclared) lines.push(`  ▲ ${item.source} → ${item.target}  ${item.imports} import${item.imports === 1 ? "" : "s"}, e.g. ${where(item.examples[0]!)}`);
  if (check.mappings.sharedImports) lines.push(`  · ${check.mappings.sharedImports} imports into shared ${check.mappings.shared.join(", ")} are not listed`);

  lines.push("", "Views");
  if (check.views.entries.length <= 1) lines.push(`  ✓ ${check.views.total} view${check.views.total === 1 ? "" : "s"}${check.views.entries[0] ? `, entered at ${check.views.entries[0]}` : ""}`);
  else lines.push(`  ▲ ${check.views.entries.length} of ${check.views.total} views have no navigateTo pointing to them: ${check.views.entries.join(", ")}. A diagram usually has one entry; link the others from it.`);

  lines.push("", "Mapping spread (hints, not verdicts)");
  const top = check.size.slice(0, 5).map(item => `${item.element} ${item.files}`).join(", ");
  lines.push(`  files per element, largest first: ${top || "none"}`);
  for (const item of check.wide) lines.push(`  ▲ ${item.parent || "the top level"} has ${item.children} boxes side by side; a view over ${crowdedAbove} is hard to read. Group related ones and give each group its own view.`);
  for (const item of check.size.filter(entry => entry.large)) lines.push(`  ▲ ${item.element} holds ${item.files} of the mapped files; inside it: ${item.folders.slice(0, 6).map(entry => `${entry.folder} ${entry.files}`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}
