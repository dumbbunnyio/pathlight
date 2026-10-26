import { fg, type RGBA, type TextChunk } from "@opentui/core";
import { type ActivityEvent, formatAge } from "../activity";
import type { FlowMap, flowsThrough } from "../flow-view";
import { palette } from "../ui";
import { clip, nl, spinAt, wrapWords } from "./text";

/**
 * The inspector's cards, as text. Each takes what it shows and returns its rows; the viewer owns the state and the widgets. `starts` is the first
 * line of each item, so the viewer can keep the one under the cursor in view, and `lines` how many rows the card wants.
 */
export interface Card { chunks: TextChunk[]; lines: number; starts: number[] }
const lit = (chunks: TextChunk[], on: boolean, background: RGBA) => on ? chunks.map(chunk => ({ ...chunk, bg: background })) : chunks;

export interface Link { node: string; arrow: string; tone: string; label?: string | null }

/** Connects: who calls it first, then what it calls, one row each with the relationship's own words. The row under the cursor shows them in full, wrapped. */
export function connectsCard(links: readonly Link[], name: (id: string) => string, cursor: number | undefined, width: number, background: RGBA): Card {
  if (!links.length) return { chunks: [fg(palette.border)("none")], lines: 1, starts: [] };
  const nameColumn = Math.min(20, Math.max(8, ...links.map(item => name(item.node).length + 2)));
  const chunks: TextChunk[] = [], starts: number[] = [];
  let line = 0;
  links.forEach((item, index) => {
    starts.push(line);
    const here = cursor === index;
    const full = item.label?.replace(/\s+/g, " ").trim() ?? "", room = width - 2 - 2 - nameColumn;
    const expand = here && full.length > room;
    chunks.push(...lit([fg(palette.accent)(here ? "› " : "  "), fg(item.tone)(`${item.arrow} `), fg(here ? palette.text : palette.body)(clip(name(item.node), nameColumn - 1).padEnd(nameColumn)),
      fg(palette.muted)(`${expand ? "" : clip(full, room)}\n`)], here, background)); line++;
    if (expand) for (const part of wrapWords(full, width - 4).slice(0, 6)) { chunks.push({ ...fg(palette.muted)(`    ${part}\n`), bg: background }); line++; }
  });
  return { chunks, lines: Math.max(1, line), starts };
}

/** In flows: the flows this component is in, and which steps it plays. */
export function flowsCard(items: ReturnType<typeof flowsThrough>, cursor: number | undefined, width: number, background: RGBA): Card {
  const chunks = items.flatMap(({ flow, steps }, index) => {
    const here = cursor === index, at = `${steps.length > 1 ? "steps" : "step"} ${steps.join("·")}`;
    return lit([fg(palette.accent)(here ? "› " : "  "), fg(palette.purple)("◇ "), fg(here ? palette.text : palette.body)(clip(flow.title, Math.max(4, width - 4 - at.length - 1)).padEnd(Math.max(4, width - 4 - at.length))),
      fg(palette.muted)(`${at}\n`)], here, background);
  });
  return { chunks, lines: Math.max(1, items.length), starts: items.map((_, index) => index) };
}

/**
 * Steps: the flow being read, one row per step in the order it is told, with the component each lands on. `●` says the agent touched that component's
 * files (a fact from the journal, not that the step happened); the current step shows its latest call, whether the model backs it, and the function it names.
 */
export function stepsCard(flow: FlowMap, current: number, byElement: ReadonlyMap<string, ActivityEvent[]>, elementTitle: (id: string) => string, width: number, now: number, background: RGBA): Card {
  const chunks: TextChunk[] = [], starts: number[] = [], journey = flow.type === "journey";
  const indent = (count: number) => fg(palette.border)(" ".repeat(count));
  const syncLine = flow.sync.status === "none" ? "never synced" : flow.sync.status === "unknown" ? `synced at ${flow.sync.sha}, not a commit here`
    : flow.sync.status === "behind" ? `synced at ${flow.sync.sha} · files changed since` : `synced at ${flow.sync.sha} · files unchanged since`;
  chunks.push(fg(palette.purple)("◇ a reading of the code, not observed\n"), fg(flow.sync.status === "behind" || flow.sync.status === "unknown" ? palette.accent : palette.muted)(`${clip(syncLine, width)}\n`));
  let line = 2, anyTouched = false;
  flow.steps.forEach((step, index) => {
    starts.push(line);
    const here = index === current;
    const at = journey ? (step.to ? [step.to] : []) : step.elements;
    const comp = at.length ? clip(`${elementTitle(at[0]!)}${at.length > 1 ? ` +${at.length - 1}` : ""}`, 16) : "";
    const touched = at.some(element => (byElement.get(element)?.length ?? 0) > 0);
    anyTouched ||= touched;
    const titleRoom = Math.max(6, width - 2 - 3 - 1 - comp.length - 2);
    chunks.push(...lit([fg(palette.accent)(here ? "› " : "  "), fg(here ? palette.accent : palette.purple)(`${step.n}`.padStart(2) + " "),
      fg(step.mark === "bug" ? palette.failure : step.mark === "fixed" ? palette.green : here ? palette.text : palette.body)(clip(step.title, titleRoom).padEnd(titleRoom)),
      fg(palette.muted)(` ${comp}`), fg(palette.accent)(touched ? " ●" : "  "), nl], here, background)); line++;
    if (!here) return;
    const latest = at.flatMap(element => byElement.get(element) ?? []).sort((a, b) => b.time - a.time)[0];
    if (latest) {
      const glyph = latest.phase === "started" ? spinAt(now) : latest.phase === "completed" ? "✓" : "✗";
      const tone = latest.phase === "failed" ? palette.failure : latest.phase === "started" ? palette.accent : palette.green;
      const file = latest.paths[0]?.split("/").at(-1) ?? latest.tool;
      chunks.push(indent(5), fg(tone)(`${glyph} `), fg(palette.muted)(`${latest.operation === "command" ? "run" : latest.operation} `), fg(palette.body)(clip(file, Math.max(4, width - 12))), fg(palette.border)(` ${formatAge(now - latest.time)}`), nl); line++;
    }
    if (step.mark) { chunks.push(indent(5), fg(step.mark === "bug" ? palette.failure : palette.green)(step.mark === "bug" ? "✗ marked as broken in the diagram\n" : "✓ marked as fixed in the diagram\n")); line++; }
    if (step.reply) { chunks.push(indent(5), fg(palette.muted)("↩ the answer to an earlier step\n")); line++; }
    else if (step.backed === false) { chunks.push(indent(5), fg(palette.accent)("≠ "), fg(palette.muted)("no relationship in the model\n")); line++; }
    if (!step.elements.length) { chunks.push(indent(5), fg(palette.muted)("no component for this step\n")); line++; }
    if (step.call) {
      // The function this hop calls, as the file declares it (copied when the flow was written, checked by pathlight flows): a name, where, and the
      // signature wrapped to the panel. `e` opens it in the editor at its declaration; the hint goes when the name needs the room.
      const fits = step.call.name.length + 11 <= width - 8;
      chunks.push(indent(5), fg(palette.purple)("ƒ "), fg(palette.text)(clip(step.call.name, Math.max(4, width - 8))), ...(fits ? [fg(palette.accent)("  e"), fg(palette.muted)(" read it")] : []), nl); line++;
      chunks.push(indent(7), fg(palette.muted)(`${clip(`declared in ${step.call.file}`, Math.max(4, width - 7))}\n`)); line++;
      const signature = step.call.declaration.replace(/^export\s+(default\s+)?/, ""), room = Math.max(12, width - 7);
      const lines: string[] = [];
      for (const word of signature.split(" ")) {
        const last = lines.at(-1);
        if (last !== undefined && last.length + 1 + word.length <= room) lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word.length > room ? `${word.slice(0, room - 1)}…` : word);
      }
      lines.slice(0, 3).forEach((text, index) => { chunks.push(indent(7), fg(palette.body)(`${index === 2 && lines.length > 3 ? `${text.slice(0, Math.max(0, room - 1))}…` : text}\n`)); line++; });
    }
  });
  if (anyTouched) { chunks.push(fg(palette.accent)("●"), fg(palette.border)(" the agent touched its files\n")); line++; }
  if (flow.findings.length) { chunks.push(fg(palette.border)(`${flow.findings.length} to check · pathlight flows\n`)); line++; }
  return { chunks, lines: Math.max(1, line), starts };
}

/**
 * Files: the mapped files as a nested tree. Directories are dim with a trailing slash (single-child chains joined), files normal, files touched this
 * session bright with an accent dot at the right edge. Every row sits on one grid: a two-column cursor slot, then the tree. `rows` maps each line
 * to the file index it shows (-1 for a directory), so a click lands on the right file; `first` is the line the tree starts on.
 */
export function filesCard(options: { paths: readonly string[]; byPath: ReadonlyMap<string, ActivityEvent>; cursor: number | undefined; counter: boolean; empty: string; width: number; background: RGBA }) {
  const { paths, byPath, cursor, width, background } = options;
  const chunks: TextChunk[] = options.counter ? [fg(palette.accent)(`Files ${paths.length && cursor !== undefined ? cursor + 1 : 0}/${paths.length}`), nl] : [];
  const first = chunks.length ? 1 : 0, rows: number[] = [];
  type Folder = { dirs: Map<string, Folder>; files: { name: string; index: number }[] };
  const root: Folder = { dirs: new Map(), files: [] };
  paths.slice(0, 500).forEach((path, index) => {
    const parts = path.split("/"), file = parts.pop() ?? path;
    let folder = root;
    for (const part of parts) { let next = folder.dirs.get(part); if (!next) { next = { dirs: new Map(), files: [] }; folder.dirs.set(part, next); } folder = next; }
    folder.files.push({ name: file, index });
  });
  let touchedAny = false;
  const row = (prefix: string, connector: string, label: string, index: number | undefined) => {
    const recent = index === undefined ? undefined : byPath.get(paths[index] ?? ""), here = index !== undefined && cursor === index;
    const used = 2 + prefix.length + connector.length + label.length;
    if (recent) touchedAny = true;
    chunks.push(...lit([fg(palette.accent)(here ? "› " : "  "), fg(palette.border)(`${prefix}${connector}`), fg(index === undefined ? palette.muted : recent ? palette.text : palette.body)(label),
      fg(palette.muted)(" ".repeat(Math.max(1, width - used - 1))), fg(recent ? palette.accent : palette.panel)(recent ? "●" : " "), nl], here, background));
    rows.push(index ?? -1);
  };
  const walk = (folder: Folder, prefix: string, top: boolean) => {
    const items: ({ dir: string; child: Folder } | { file: string; index: number })[] = [
      ...[...folder.dirs].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, child]) => {
        let label = dir, node = child;
        while (node.files.length === 0 && node.dirs.size === 1) { const [only, next] = [...node.dirs][0]!; label += `/${only}`; node = next; }
        return { dir: label, child: node };
      }),
      ...folder.files.sort((a, b) => a.name.localeCompare(b.name)).map(file => ({ file: file.name, index: file.index }))];
    items.forEach((item, at) => {
      const last = at === items.length - 1, connector = top ? "" : last ? "└─ " : "├─ ";
      if ("dir" in item) { row(prefix, connector, `${item.dir}/`, undefined); walk(item.child, top ? "" : prefix + (last ? "   " : "│  "), false); }
      else row(prefix, connector, item.file, item.index);
    });
  };
  walk(root, "", true);
  if (!paths.length) chunks.push(fg(palette.border)(options.empty));
  else if (touchedAny) chunks.push(fg(palette.border)("● touched this session"));
  const lines = chunks.filter(chunk => chunk.text.includes("\n")).length + (paths.length && touchedAny ? 1 : 0) + (paths.length ? 0 : 1);
  return { chunks, lines, rows, first };
}
