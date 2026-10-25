import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { draftOf, draftWorkspace, Overlay, readManifests } from "./draft";
import { readOverlay } from "./edit";
import { failure, io } from "./effects";
import { homeOf, overlayFile } from "./layout";
import { listFiles, scanWorkspace } from "./scan";

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
  imports: { key: string; generated: string; imports: number }[];
  importedBy: { key: string; generated: string; imports: number }[];
  /** Keys of the boxes inside this one. */
  inside: string[];
  /** Depth below the top of the diagram: 0 is a package (or a top-level component of a flat workspace). */
  depth: number;
  name?: { title?: string; note?: string; by?: "human" | "agent" };
}

export const briefOf = Effect.fn("Brief.of")(function* (workspace: string) {
  const root = yield* io("Brief.workspace", () => realpath(workspace));
  const scan = yield* scanWorkspace(root);
  const { paths } = yield* listFiles(root);
  const overlay = yield* readOverlay(root);
  const draft = draftOf(scan, yield* readManifests(root, paths), overlay);
  const lines = new Map(scan.files.map(file => [file.path, file.lines] as const));
  const sizes = (files: readonly string[]) => files.map(path => ({ path, lines: lines.get(path) ?? 0 })).sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1));
  const boxes = new Map<string, BriefBox>();
  const byId = new Map<string, BriefBox>();
  const add = (box: BriefBox) => { boxes.set(box.key, box); byId.set(box.id, box); return box; };
  for (const item of draft.packages) {
    const parent = draft.flat ? undefined : add({ key: item.key, id: item.id, kind: "package", generated: item.title, files: [], lines: 0, imports: [], importedBy: [], inside: [], depth: 0, ...(overlay.elements[item.key] ? { name: overlay.elements[item.key] } : {}) });
    const groups = new Map(item.groups.map(group => [group.id, add({ key: group.key, id: group.id, kind: "collection", generated: group.title, ...(parent ? { parent: parent.key } : {}), files: [], lines: 0, imports: [], importedBy: [], inside: [], depth: 1, ...(overlay.elements[group.key] ? { name: overlay.elements[group.key] } : {}) })] as const));
    for (const component of item.components) {
      const group = component.group ? groups.get(component.group) : undefined;
      const container = group ?? parent;
      const box = add({ key: component.key, id: component.id, kind: "component", generated: component.title, ...(container ? { parent: container.key } : {}), files: sizes(component.files), lines: component.files.reduce((sum, path) => sum + (lines.get(path) ?? 0), 0), imports: [], importedBy: [], inside: [], depth: group ? 2 : parent ? 1 : 0, ...(overlay.elements[component.key] ? { name: overlay.elements[component.key] } : {}) });
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

const filesShown = 12, neighboursShown = 6, insideShown = 20;
const count = (value: number, noun: string) => `${value.toLocaleString("en")} ${noun}${value === 1 ? "" : "s"}`;
const neighbours = (items: BriefBox["imports"]) => items.slice(0, neighboursShown).map(item => `${item.key} (${item.imports})`).join(", ") + (items.length > neighboursShown ? `, +${items.length - neighboursShown} more` : "");

export function formatBrief(boxes: readonly BriefBox[], all: readonly BriefBox[] = boxes) {
  const byKey = new Map(all.map(box => [box.key, box] as const));
  const lines: string[] = [];
  for (const box of boxes) {
    lines.push(`## ${box.key}  (${box.kind}${box.parent ? ` in ${box.parent}` : ""}${box.files.length ? ` · ${count(box.files.length, "file")}, ${count(box.lines, "line")}` : ""})`);
    lines.push(`generated name: ${box.generated}`);
    if (box.files.length) lines.push(`files: ${box.files.slice(0, filesShown).map(file => `${file.path} (${file.lines})`).join(", ")}${box.files.length > filesShown ? `, +${box.files.length - filesShown} more` : ""}`);
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
  const known = new Set((yield* briefOf(root)).map(box => box.key));
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
  return { saved, kept, unknown, unchanged, rebuilt: saved.length > 0 } satisfies Named;
});

export function formatNamed(result: Named) {
  const lines = [result.saved.length ? `Saved ${result.saved.length} name${result.saved.length === 1 ? "" : "s"} as the agent's reading, and redrew the map.` : "Nothing new to save."];
  if (result.unchanged.length) lines.push(`${result.unchanged.length} already said exactly this.`);
  if (result.kept.length) lines.push(`Kept the names a person wrote for: ${result.kept.join(", ")}.`);
  if (result.unknown.length) lines.push(`No box has these keys (see pathlight brief): ${result.unknown.join(", ")}.`);
  return `${lines.join("\n")}\n`;
}
