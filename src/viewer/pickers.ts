import { bg, fg, StyledText, type TextChunk } from "@opentui/core";
import { type Candidate, search as rankSearch } from "../search";
import type { Palette } from "../ui";
import { borderHints, palette } from "../ui";
import { type Action, hints } from "./keys";
import { nl } from "./text";
import type { WhereView } from "./where";
import type { createWidgets } from "./widgets";

/** One row of the picker: a view, a box or a mapped file, and where it is. */
export type Pick = Candidate & { view?: string; element?: string; path?: string; detail: string };

/**
 * What `/` searches (every view, box and mapped file in the project) or `g` (only the views). It does not infer links between views.
 * Files the mapping puts outside the picture (tests, generated code) are not offered, and neither is a file that is a box of its own.
 */
export const pickCandidates = (options: { views: ReadonlyMap<string, WhereView>; current: WhereView; mode: "all" | "views"; files: ReadonlyMap<string, readonly string[]>; ignore: readonly string[] }): Pick[] => {
  const current = String(options.current.id);
  const views: Pick[] = [...options.views].filter(([, entry]) => entry.nodes.length).map(([id, entry]) =>
    ({ kind: "view", name: String(entry.title ?? id), aliases: [id], here: id === current, view: id, detail: `${entry.nodes.length} nodes` }));
  if (options.mode === "views") return views;
  const present = new Set(options.current.nodes.map(node => String(node.modelRef)));
  const titles = new Map<string, string>();
  for (const entry of options.views.values()) for (const node of entry.nodes) if (node.modelRef && !titles.has(String(node.modelRef))) titles.set(String(node.modelRef), node.title);
  const boxes: Pick[] = [...titles].map(([element, title]) =>
    ({ kind: "box", name: title, aliases: [element, element.split(".").at(-1)!], here: present.has(element), element, detail: "" }));
  const outside = options.ignore.map(glob => new Bun.Glob(glob));
  const mapped: Pick[] = [...options.files].filter(([element]) => titles.has(element)).flatMap(([element, paths]) => paths
    .filter(path => path.slice(path.lastIndexOf("/") + 1) !== titles.get(element) && !outside.some(glob => glob.match(path)))
    .map(path => ({ kind: "file" as const, name: path.slice(path.lastIndexOf("/") + 1), aliases: [path], here: present.has(element), element, path, detail: titles.get(element)! })));
  return [...views.filter(item => !item.here), ...boxes, ...mapped];
};

/** The picker's inside: as wide as before the frame was made thin, so its rows read the same. */
const gotoColumns = (screenWidth: number) => Math.min(74, screenWidth - 10);

/** The picker's list, `rows` of it from `top`, with the query line on top. `viewOf` names the view a box elsewhere opens in. */
export const gotoContent = (entries: readonly Pick[], options: { query: string; index: number; top: number; rows: number; screenWidth: number; viewOf: (element: string) => string }) => {
  const { index, top, rows } = options;
  const inner = gotoColumns(options.screenWidth), contextWidth = Math.min(26, Math.floor(inner / 3)), nameWidth = Math.max(10, inner - 1 - 5 - 1 - contextWidth - 1);
  const fit = (text: string, width: number) => text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text.padEnd(width);
  const chunks: TextChunk[] = [fg(palette.incoming)(" › "), fg(palette.text)(options.query), fg(palette.incoming)("▏"), nl];
  if (!entries.length) chunks.push(fg(palette.muted)(" Nothing matches"), nl);
  entries.slice(top, top + rows).forEach((entry, offset) => {
    const cursor = top + offset === index, shade = bg(cursor ? palette.pick : palette.panel);
    // What the row says on the right: where it is. A row in the view you are in carries a dot; one elsewhere says which view it opens.
    const where = entry.kind === "view" ? (entry.here ? "● here" : entry.detail)
      : entry.here ? `● ${entry.kind === "file" ? entry.detail : "here"}` : entry.kind === "file" ? entry.detail : `in ${options.viewOf(entry.element!)}`;
    const dir = entry.kind === "file" ? ` ${entry.path!.slice(0, entry.path!.lastIndexOf("/") + 1)}` : "";
    const name = fit(entry.name + (dir.trim() ? dir : ""), nameWidth);
    chunks.push(shade(fg(palette.muted)(` ${entry.kind.padEnd(5)}`)), shade(fg(palette.text)(name.slice(0, Math.min(entry.name.length, nameWidth)))),
      shade(fg(palette.muted)(name.slice(Math.min(entry.name.length, nameWidth)))), shade(fg(entry.here ? palette.incoming : palette.muted)(` ${fit(where, contextWidth)} `)), nl);
  });
  return { content: new StyledText(chunks), meta: new StyledText([fg(palette.muted)(` ${entries.length ? `${top + 1}–${Math.min(entries.length, top + rows)} of ${entries.length}` : "0"} `)]) };
};

/** The theme picker's rows: the current theme dotted, where each came from, and a swatch of its colours. */
export const themeContent = (names: readonly string[], options: { index: number; top: number; rows: number; base: string; mode: string; source: (name: string) => string; preview: (name: string) => Palette | undefined }) => {
  const chunks: TextChunk[] = [];
  names.slice(options.top, options.top + options.rows).forEach((name, offset) => {
    const index = options.top + offset, cursor = index === options.index, current = name === options.base, base = cursor ? palette.pick : palette.panel;
    const preview = options.preview(name);
    chunks.push(bg(base)(fg(current ? palette.accent : palette.muted)(current ? " ● " : "   ")), bg(base)(fg(palette.text)(` ${name.padEnd(24).slice(0, 24)}`)),
      bg(base)(fg(palette.muted)(` ${{ user: "yours   ", terminal: "terminal", bundled: "        " }[options.source(name)] ?? "        "} `)),
      ...(preview ? [preview.accent, preview.incoming, preview.green, preview.failure, preview.purple].map(color => bg(base)(fg(color)("██"))) : []), bg(base)(fg(palette.muted)(" ")), nl);
  });
  chunks.pop();
  return { content: new StyledText(chunks), meta: new StyledText([fg(palette.muted)(` ${options.index + 1}/${names.length} · ${options.mode} `)]) };
};

/**
 * The picker as a dialog: `/` (`all`) or `g` (`views`) opens it, typing narrows the list (search.ts ranks it) and the list scrolls inside its frame,
 * which is the list plus the query line, the border and a blank row above and below, kept inside the terminal and fairly compact.
 */
export function createGotoPicker(options: {
  screen: { readonly width: number; readonly height: number }; widget: ReturnType<typeof createWidgets>["goto"]; candidates: (mode: "all" | "views") => Pick[];
  viewOf: (element: string) => string; go: (pick: Pick) => void; update: () => void;
}) {
  const { screen, widget } = options;
  let index = 0, top = 0, query = "", items: Pick[] = [];
  const entries = () => rankSearch(query, items);
  const rowsFor = (count: number) => Math.max(1, Math.min(count, 18, screen.height - 2 - 5));
  const render = () => {
    const list = entries();
    const rows = rowsFor(Math.max(1, list.length));
    index = Math.min(index, Math.max(0, list.length - 1));
    if (index < top) top = index;
    if (index >= top + rows) top = index - rows + 1;
    top = Math.max(0, Math.min(top, Math.max(0, list.length - rows)));
    const made = gotoContent(list, { query, index, top, rows, screenWidth: screen.width, viewOf: options.viewOf });
    widget.content.content = made.content; widget.meta.content = made.meta;
    widget.foot.content = new StyledText(borderHints(hints.goto));
    widget.place(gotoColumns(screen.width), rows + 1 + (list.length ? 0 : 1));
  };
  return {
    render,
    begin(mode: "all" | "views") {
      query = ""; top = 0; items = options.candidates(mode);
      widget.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)(mode === "views" ? "Go to view" : "Search"), fg(palette.muted)(" ")]);
      index = mode === "views" ? Math.max(0, entries().findIndex(item => item.here)) : 0;
      widget.open(gotoColumns(screen.width), 4); render(); options.update();
    },
    /** A paste is text for the query, not keys. */
    paste(text: string) { query = (query + text.replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, 256); index = 0; render(); },
    key(action: Action) {
      const list = entries();
      switch (action.type) {
        case "gotoClose": widget.close(); options.update(); return;
        case "gotoGo": { const entry = list[index]; if (entry) options.go(entry); return; }
        case "gotoMove": index = list.length ? (index + action.by + list.length) % list.length : 0; break;
        case "gotoPage": { const page = rowsFor(list.length); index = action.by < 0 ? Math.max(0, index - page) : Math.min(Math.max(0, list.length - 1), index + page); break; }
        case "gotoHome": index = 0; break;
        case "gotoEnd": index = Math.max(0, list.length - 1); break;
        case "gotoClear": query = ""; index = 0; break;
        case "gotoErase": query = query.slice(0, -1); index = 0; break;
        case "gotoType": query += action.text; index = 0; break;
        default: return;
      }
      render();
    },
  };
}
