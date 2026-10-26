import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { Effect, Schema } from "effect";
import { draftOf, draftWorkspace, Overlay, readManifests, unreadLines } from "./draft";
import { readOverlay } from "./edit";
import { failure, io } from "./effects";
import { homeOf, overlayFile } from "./layout";
import { isUnscannedSource, listFiles, scanWorkspace } from "./scan";

/**
 * `pathlight brief`: what an agent needs to name the boxes of a draft, gathered from the code and nothing else. For each box (a package, a collection
 * or a component) it lists the files the box owns with their sizes, what it imports from and what imports it, what is inside it and any name it
 * already has. The agent still reads the code to decide what a box is for; this only saves it from guessing which files a box holds, and from
 * describing the one folder it happened to open when the box is a folder plus a loose file.
 */
export interface BriefBox {
  key: string; id: string; kind: "package" | "collection" | "component";
  /** The generated name (a folder or package name), as the viewer would show it with no overlay. */
  generated: string;
  /** The key of the box this one sits in. */
  parent?: string;
  files: { path: string; lines: number }[];
  lines: number;
  /** What the box's files offer to others, read from their `export` statements: the biggest files first, at most 40. */
  exports: { name: string; kind: string; file: string }[];
  imports: { key: string; generated: string; imports: number }[];
  importedBy: { key: string; generated: string; imports: number }[];
  /** Keys of the boxes inside this one. */
  inside: string[];
  /** Depth below the top of the diagram: 0 is a package (or a top-level component of a flat workspace). */
  depth: number;
  name?: { title?: string; note?: string; by?: "human" | "agent" };
  /** A short hash of the contents of every file the box owns: when it differs from the one recorded at the last naming, the files changed since. */
  fingerprint: string;
}

/** Where `pathlight name` records the fingerprint each box had when it was named. Ignored, regenerated state, like the journals: it is a convenience for re-naming only what changed, never a claim about the names. */
export const namedPath = join(".cache", "pathlight", "named.json");
const readNamed = (root: string) => io("Brief.named", () => readFile(join(root, namedPath), "utf8")).pipe(
  Effect.map((text): Record<string, string> | undefined => { try { const parsed: unknown = JSON.parse(text); const boxes = typeof parsed === "object" && parsed ? (parsed as { boxes?: unknown }).boxes : undefined; return typeof boxes === "object" && boxes ? Object.fromEntries(Object.entries(boxes).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined; } catch { return undefined; } }),
  Effect.catch(() => Effect.succeed(undefined)));

/**
 * What the project says about itself, for naming the box that holds the whole app: its package description, the opening of its README, and the
 * documents a person could read for more. Text the project wrote, passed on as it is (cut short); nothing here is inferred.
 */
export interface AppContext { name?: string; description?: string; readme?: string; docs: string[] }
const readmeNames = ["README.md", "README", "readme.md", "Readme.md"], docNames = ["AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md", "CONTRIBUTING.md"];
export const contextOf = Effect.fn("Brief.context")(function* (workspace: string) {
  const root = yield* io("Brief.workspace", () => realpath(workspace));
  const read = (path: string) => io("Brief.read", () => readFile(join(root, path), "utf8")).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const manifest = yield* read("package.json");
  let name: string | undefined, description: string | undefined;
  try { const parsed: unknown = JSON.parse(manifest ?? "{}"); if (typeof parsed === "object" && parsed) { const record = parsed as Record<string, unknown>; name = typeof record.name === "string" ? record.name : undefined; description = typeof record.description === "string" ? record.description : undefined; } } catch { /* no usable package.json */ }
  let readme: string | undefined;
  for (const candidate of readmeNames) { const text = yield* read(candidate); if (text) { readme = text.split("\n").slice(0, 60).join("\n").slice(0, 2_000).trim(); break; } }
  const top = yield* io("Brief.docs", () => readdir(root)).pipe(Effect.catch(() => Effect.succeed([] as string[])));
  const docs = [...docNames.filter(file => top.includes(file)), ...(yield* io("Brief.docs", () => readdir(join(root, "docs"))).pipe(Effect.catch(() => Effect.succeed([] as string[])))).filter(file => file.endsWith(".md")).sort().slice(0, 12).map(file => `docs/${file}`)];
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(readme ? { readme } : {}), docs } satisfies AppContext;
});

/**
 * Where a person or a process can start the code: what the project itself declares (package.json scripts, `bin`, `main`) and, from the import graph,
 * the source files no other file imports. Facts, not a guess about what the app does; each is shown with the box that holds the file.
 */
export interface EntryPoint { file: string; box?: string; why: string }
const notEntry = /(^|\/)(tests?|__tests__|spec|fixtures?|mocks?)\/|\.(test|spec|d|config|stories)\.[cm]?[jt]sx?$|(^|\/)(vite|vitest|jest|tsup|rollup|webpack|eslint|oxlint)[.\w-]*\.[cm]?[jt]s$/;
const scriptSkipped = /^(test|check|lint|format|fmt|build|prepare|prepublish|postinstall|typecheck|types|clean)\b/;
export const entryPointsOf = Effect.fn("Brief.entryPoints")(function* (workspace: string, boxes: readonly BriefBox[]) {
  const root = yield* io("Brief.workspace", () => realpath(workspace));
  const scan = yield* scanWorkspace(root);
  const { paths } = yield* listFiles(root);
  const sources = new Set(scan.files.map(file => file.path));
  const boxOf = new Map<string, string>();
  for (const box of [...boxes].sort((a, b) => b.depth - a.depth)) for (const file of box.files) if (!boxOf.has(file.path)) boxOf.set(file.path, box.key);
  const found = new Map<string, EntryPoint>();
  const add = (file: string, why: string) => { if (sources.has(file) && !found.has(file)) found.set(file, { file, ...(boxOf.has(file) ? { box: boxOf.get(file)! } : {}), why }); };
  for (const manifest of paths.filter(path => posix.basename(path) === "package.json" && !path.includes("node_modules/"))) {
    const directory = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
    const parsed = yield* io("Brief.manifest", () => readFile(join(root, manifest), "utf8")).pipe(Effect.map((text): unknown => { try { return JSON.parse(text); } catch { return undefined; } }), Effect.catch(() => Effect.succeed(undefined as unknown)));
    if (typeof parsed !== "object" || !parsed) continue;
    const record = parsed as Record<string, unknown>;
    const resolveIn = (reference: string) => posix.normalize(posix.join(directory, reference.replace(/^\.\//, "")));
    const scripts = typeof record.scripts === "object" && record.scripts ? Object.entries(record.scripts as Record<string, unknown>) : [];
    for (const [name, command] of scripts) {
      if (typeof command !== "string" || scriptSkipped.test(name)) continue;
      for (const word of command.split(/\s+/)) if (/\.[cm]?[jt]sx?$/.test(word) && !word.startsWith("-")) add(resolveIn(word), `script “${name}”${directory ? ` in ${directory}` : ""}`);
    }
    const bins = typeof record.bin === "string" ? [["bin", record.bin]] : typeof record.bin === "object" && record.bin ? Object.entries(record.bin as Record<string, unknown>) : [];
    for (const [name, target] of bins) if (typeof target === "string") add(resolveIn(target), `bin “${name}”`);
    for (const key of ["main", "module"]) if (typeof record[key] === "string") add(resolveIn(record[key] as string), `package ${key}`);
  }
  const imported = new Set(scan.imports.map(edge => edge.to));
  const roots = scan.files.filter(file => !imported.has(file.path) && !notEntry.test(file.path) && !found.has(file.path)).sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1)).slice(0, 12);
  for (const file of roots) add(file.path, "no other file imports it");
  return [...found.values()];
});

export function formatEntryPoints(entries: readonly EntryPoint[]) {
  if (!entries.length) return "";
  return `# Where the code can be started (declared by the project, or files nothing imports)\n${entries.map(entry => `${entry.file}${entry.box ? ` [${entry.box}]` : ""} — ${entry.why}`).join("\n")}\n\n`;
}

export function formatContext(context: AppContext) {
  if (!context.description && !context.readme && !context.docs.length) return "";
  const lines = ["# About the project (its own words, for naming the box that holds the whole app)"];
  if (context.name) lines.push(`package: ${context.name}`);
  if (context.description) lines.push(`description: ${context.description}`);
  if (context.docs.length) lines.push(`documents: ${context.docs.join(", ")}`);
  if (context.readme) lines.push("README, opening:", ...context.readme.split("\n").map(line => `  ${line}`));
  return `${lines.join("\n")}\n\n`;
}

export const briefOf = Effect.fn("Brief.of")(function* (workspace: string) {
  const root = yield* io("Brief.workspace", () => realpath(workspace));
  const scan = yield* scanWorkspace(root);
  const { paths } = yield* listFiles(root);
  const overlay = yield* readOverlay(root);
  const unread = paths.filter(isUnscannedSource);
  const draft = draftOf(scan, yield* readManifests(root, paths), overlay, unread);
  const lines = new Map([...scan.files.map(file => [file.path, file.lines] as const), ...yield* unreadLines(root, unread)]);
  const offered = new Map(scan.files.map(file => [file.path, file.exports ?? []] as const));
  const sizes = (files: readonly string[]) => files.map(path => ({ path, lines: lines.get(path) ?? 0 })).sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1));
  const boxes = new Map<string, BriefBox>();
  const byId = new Map<string, BriefBox>();
  const add = (box: BriefBox) => { boxes.set(box.key, box); byId.set(box.id, box); return box; };
  for (const item of draft.packages) {
    const parent = draft.flat ? undefined : add({ key: item.key, id: item.id, kind: "package", generated: item.title, files: [], lines: 0, exports: [], imports: [], importedBy: [], inside: [], depth: 0, fingerprint: "", ...(overlay.elements[item.key] ? { name: overlay.elements[item.key] } : {}) });
    const groups = new Map(item.groups.map(group => [group.id, add({ key: group.key, id: group.id, kind: "collection", generated: group.title, ...(parent ? { parent: parent.key } : {}), files: [], lines: 0, exports: [], imports: [], importedBy: [], inside: [], depth: 1, fingerprint: "", ...(overlay.elements[group.key] ? { name: overlay.elements[group.key] } : {}) })] as const));
    for (const component of item.components) {
      const group = component.group ? groups.get(component.group) : undefined;
      const container = group ?? parent;
      const box = add({ key: component.key, id: component.id, kind: "component", generated: component.title, ...(container ? { parent: container.key } : {}), files: sizes(component.files), lines: component.files.reduce((sum, path) => sum + (lines.get(path) ?? 0), 0), exports: [], imports: [], importedBy: [], inside: [], depth: group ? 2 : parent ? 1 : 0, fingerprint: "", ...(overlay.elements[component.key] ? { name: overlay.elements[component.key] } : {}) });
      box.exports = [...new Map(box.files.flatMap(file => (offered.get(file.path) ?? []).map(item => ({ name: item.name, kind: item.kind, file: file.path }))).reverse().map(item => [item.name, item] as const)).values()].reverse().slice(0, 40);
      container?.inside.push(box.key);
      for (let up = container; up; up = up.parent ? boxes.get(up.parent) : undefined) { up.files.push(...box.files); up.lines += box.lines; }
    }
    if (parent) parent.inside.push(...[...groups.values()].map(group => group.key));
    for (const group of groups.values()) group.files = sizes(group.files.map(file => file.path));
    if (parent) parent.files = sizes(parent.files.map(file => file.path));
  }
  for (const edge of draft.relationships) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) continue;
    from.imports.push({ key: to.key, generated: to.generated, imports: edge.imports });
    to.importedBy.push({ key: from.key, generated: from.generated, imports: edge.imports });
  }
  const digests = new Map<string, string>();
  for (const file of scan.files) digests.set(file.path, createHash("sha1").update(yield* io("Brief.hash", () => readFile(join(root, file.path))).pipe(Effect.catch(() => Effect.succeed(Buffer.alloc(0))))).digest("hex"));
  for (const box of boxes.values()) box.fingerprint = createHash("sha1").update(box.files.map(file => `${file.path}\0${digests.get(file.path) ?? ""}`).sort().join("\n")).digest("hex").slice(0, 12);
  for (const box of boxes.values()) for (const list of [box.imports, box.importedBy]) list.sort((a, b) => b.imports - a.imports || (a.key < b.key ? -1 : 1));
  return [...boxes.values()];
});

/** The boxes under the given keys (and those boxes themselves), or all of them. Children come before the boxes that hold them, so a parent can be named from what is inside it. */
export function select(boxes: readonly BriefBox[], under: readonly string[]) {
  const byKey = new Map(boxes.map(box => [box.key, box] as const));
  const missing = under.filter(key => !byKey.has(key));
  const wanted = new Set<string>();
  const take = (box: BriefBox) => { wanted.add(box.key); for (const key of box.inside) take(byKey.get(key)!); };
  for (const key of under) if (byKey.has(key)) take(byKey.get(key)!);
  const chosen = under.length ? boxes.filter(box => wanted.has(box.key)) : [...boxes];
  return { missing, boxes: chosen.sort((a, b) => b.depth - a.depth || (a.key < b.key ? -1 : 1)) };
}

/**
 * The boxes that need a name again: never named, or their files differ from what they were when `pathlight name` last recorded them. A box a person
 * named is left out (their name is a pin). `tracked` is false when nothing has been recorded yet, which is every box's case after a first naming made
 * before this record existed; then all unpinned boxes are returned, because nothing says they are current.
 */
export const changedBoxes = Effect.fn("Brief.changed")(function* (workspace: string, all: readonly BriefBox[]) {
  const root = yield* io("Brief.workspace", () => realpath(workspace));
  const named = yield* readNamed(root);
  const boxes = all.filter(box => box.name?.by !== "human" && (!named || !box.name || named[box.key] !== box.fingerprint));
  return { tracked: named !== undefined, boxes: select(boxes, []).boxes };
});

const filesShown = 12, neighboursShown = 6, insideShown = 20, exportsShown = 16;
const count = (value: number, noun: string) => `${value.toLocaleString("en")} ${noun}${value === 1 ? "" : "s"}`;
const neighbours = (items: BriefBox["imports"]) => items.slice(0, neighboursShown).map(item => `${item.key} (${item.imports})`).join(", ") + (items.length > neighboursShown ? `, +${items.length - neighboursShown} more` : "");

export function formatBrief(boxes: readonly BriefBox[], all: readonly BriefBox[] = boxes) {
  const byKey = new Map(all.map(box => [box.key, box] as const));
  const lines: string[] = [];
  for (const box of boxes) {
    lines.push(`## ${box.key}  (${box.kind}${box.parent ? ` in ${box.parent}` : ""}${box.files.length ? ` · ${count(box.files.length, "file")}, ${count(box.lines, "line")}` : ""})`);
    lines.push(`generated name: ${box.generated}`);
    if (box.files.length) lines.push(`files: ${box.files.slice(0, filesShown).map(file => `${file.path} (${file.lines})`).join(", ")}${box.files.length > filesShown ? `, +${box.files.length - filesShown} more` : ""}`);
    if (box.exports.length) lines.push(`defines: ${box.exports.slice(0, exportsShown).map(item => `${item.name}${item.kind === "const" || item.kind === "named" || item.kind === "reexport" ? "" : ` [${item.kind}]`}`).join(", ")}${box.exports.length > exportsShown ? `, +${box.exports.length - exportsShown} more` : ""}`);
    if (box.inside.length) lines.push(`inside: ${box.inside.slice(0, insideShown).map(key => { const child = byKey.get(key); const title = child?.name?.title; return title ? `${key} (“${title}”)` : key; }).join(", ")}${box.inside.length > insideShown ? `, +${box.inside.length - insideShown} more` : ""}`);
    if (box.imports.length) lines.push(`imports from: ${neighbours(box.imports)}`);
    if (box.importedBy.length) lines.push(`imported by: ${neighbours(box.importedBy)}`);
    if (box.name) lines.push(`current: ${box.name.title ? `“${box.name.title}”` : "(no title)"}${box.name.note ? ` — ${box.name.note}` : ""}${box.name.by ? ` (${box.name.by})` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface NameEntry { key: string; title?: string; note?: string }
export interface Named { saved: string[]; kept: string[]; unknown: string[]; unchanged: string[]; rebuilt: boolean }

/**
 * `pathlight name`: records what an agent worked out as names and notes for boxes, as the agent's decision (`by: "agent"`), then redraws once. It never
 * replaces a name a person wrote (`by: "human"`), refuses a key the draft has no box for, and checks lengths before touching the file; the model,
 * ids, files and arrows still come only from the code.
 */
export const nameBoxes = Effect.fn("Brief.name")(function* (workspace: string, entries: readonly NameEntry[]) {
  const root = yield* io("Brief.workspace", () => realpath(workspace));
  const current = yield* briefOf(root);
  const known = new Set(current.map(box => box.key));
  const prints = new Map(current.map(box => [box.key, box.fingerprint] as const));
  const overlay = yield* readOverlay(root);
  const elements = { ...overlay.elements };
  const saved: string[] = [], kept: string[] = [], unknown: string[] = [], unchanged: string[] = [];
  for (const entry of entries) {
    if (!known.has(entry.key)) { unknown.push(entry.key); continue; }
    const title = entry.title?.trim(), note = entry.note?.trim();
    if (!title && !note) return yield* Effect.fail(failure("Brief.name", `${entry.key}: give a --title, a --note, or both.`));
    if (elements[entry.key]?.by === "human") { kept.push(entry.key); continue; }
    const next = { ...(title ? { title } : {}), ...(note ? { note } : {}), by: "agent" as const };
    const before = elements[entry.key];
    if (before && before.title === next.title && before.note === next.note && before.by === "agent") { unchanged.push(entry.key); continue; }
    elements[entry.key] = next;
    saved.push(entry.key);
  }
  const valid = yield* Schema.decodeUnknownEffect(Overlay, { onExcessProperty: "error" })({ ...overlay, elements }).pipe(
    Effect.mapError(() => failure("Brief.invalid", "A title is at most 60 characters and a note at most 300, each one line. Nothing was written.")));
  if (saved.length) {
    yield* io("Brief.write", async () => {
      await mkdir(homeOf(root), { recursive: true });
      const target = join(homeOf(root), overlayFile), temporary = `${target}.${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`);
      await rename(temporary, target);
    });
    yield* draftWorkspace(root);
  }
  // Remember what the files were when each box was named (or confirmed as it is), so a later run can name only what changed.
  const confirmed = [...saved, ...unchanged];
  if (confirmed.length) {
    const before = (yield* readNamed(root)) ?? {};
    yield* io("Brief.record", async () => {
      await mkdir(join(root, ".cache", "pathlight"), { recursive: true });
      const target = join(root, namedPath), temporary = `${target}.${process.pid}`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, boxes: { ...before, ...Object.fromEntries(confirmed.flatMap(key => prints.has(key) ? [[key, prints.get(key)!]] : [])) } }, null, 2)}\n`);
      await rename(temporary, target);
    });
  }
  return { saved, kept, unknown, unchanged, rebuilt: saved.length > 0 } satisfies Named;
});

export function formatNamed(result: Named) {
  const lines = [result.saved.length ? `Saved ${result.saved.length} name${result.saved.length === 1 ? "" : "s"} as the agent's reading, and redrew the map.` : "Nothing new to save."];
  if (result.unchanged.length) lines.push(`${result.unchanged.length} already said exactly this.`);
  if (result.kept.length) lines.push(`Kept the names a person wrote for: ${result.kept.join(", ")}.`);
  if (result.unknown.length) lines.push(`No box has these keys (see pathlight brief): ${result.unknown.join(", ")}.`);
  return `${lines.join("\n")}\n`;
}
