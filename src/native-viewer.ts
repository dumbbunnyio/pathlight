import { type Renderable, BoxRenderable, FrameBufferRenderable, InputRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable, StyledText, type TextChunk, fg, bg, RGBA, createCliRenderer } from "@opentui/core";
import { THREE } from "@opentui/three";
import { SplitPaneRenderable } from "opentui-split";
import { Effect, FiberSet, Schedule } from "effect";
import { watch } from "node:fs";
import { type View, acquireModel, validateActivityMapping } from "./catalog";
import { type ActivityBinding, type ActivityEvent, activityRows, formatAge, latestBinding, readActivity, readActivityConfig } from "./activity";
import { nodeFiles } from "./node-files";
import { openEditor } from "./editor";
import { askMessage, sendToPane } from "./ask";
import pkg from "../package.json" with { type: "json" };
import { basename } from "node:path";
import { type Hint, borderHints, hintChunks, noticeStyle, palette, pill } from "./ui";
import { rasterize, routeEdges, type Route } from "./routes";
import { attempt, failure, hasCode, io } from "./effects";
import { writeReady } from "./ready";

export const viewNative = Effect.fn("Native.view")(function* (options: { view: View; activity?: ActivityBinding; follow?: boolean; parent?: string; ready?: string }) {
const view = options.view;
let binding = options.activity;
const following = options.follow === true;
const loadedConfig = yield* readActivityConfig(view.workspace).pipe(
  Effect.catchIf(error => !binding && !following && hasCode(error, "ENOENT"), () => Effect.succeed(undefined)));
let config = binding || following || loadedConfig?.project === view.project ? loadedConfig : undefined;
if (config) yield* validateActivityMapping(view, config);
let fileError = "";
let files = yield* nodeFiles(view.workspace, config).pipe(Effect.catch(error => Effect.sync(() => {
  fileError = error.message; return new Map<string, string[]>();
})));
let diagrams = yield* Effect.gen(function* () {
  const source = yield* acquireModel(view.workspace);
  const model = yield* io("LikeC4.layout", () => source.layoutedModel(view.project));
  return new Map([...model.views()].map(entry => [String(entry.id), entry.$view]));
}).pipe(Effect.scoped);
const getDiagram = (id: string) => {
  const next = diagrams.get(id);
  if (!next) throw new Error(`Unknown linked view '${id}'.`);
  if (!next.nodes.length) throw new Error(`View '${id}' has no nodes.`);
  return next;
};
let diagram = yield* attempt("Native.scene", () => getDiagram(view.id));
let rules = config?.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) })) ?? [];
if (!process.stdin.isTTY || !process.stdout.isTTY) return yield* Effect.fail(failure("Native.terminal", "The native viewer needs a terminal. Use pathlight show to open a tmux pane."));
const renderer = yield* Effect.acquireRelease(io("Native.renderer", () => createCliRenderer({ exitOnCtrlC: false, exitSignals: [], consoleMode: "disabled", targetFps: 30, backgroundColor: palette.background })),
  renderer => io("Native.close", async () => { renderer.destroy(); await renderer.closed; }).pipe(Effect.orDie));
const stopped = Promise.withResolvers<void>();
const stop = () => stopped.resolve();
const displayed = Promise.withResolvers<void>();
let painted = false, closing = false;
let renderError: unknown;
let drawing: Promise<void> | undefined;
let refreshing = false;
const resources: { dispose(): void }[] = [];
yield* Effect.addFinalizer(() => io("Native.graphics.close", async () => {
  closing = true; renderer.pause(); await drawing?.catch(() => {});
  for (const resource of resources) resource.dispose();
}).pipe(Effect.orDie));
const runTask = yield* FiberSet.makeRuntime<never>();
  const topBar = new BoxRenderable(renderer, { height: 3, flexShrink: 0, border: ["bottom"], borderColor: palette.border, paddingLeft: 1, paddingRight: 1 });
  const row = () => new BoxRenderable(renderer, { height: 1, width: "100%", flexShrink: 0, flexDirection: "row", justifyContent: "space-between" });
  const headingText = new TextRenderable(renderer, { selectable: false, height: 1, fg: palette.text, wrapMode: "none" });
  const badgeText = new TextRenderable(renderer, { selectable: false, height: 1, fg: palette.muted, wrapMode: "none" });
  const heading = row();
  heading.add(headingText); heading.add(badgeText);
  const breadcrumb = new TextRenderable(renderer, { selectable: false, height: 1, fg: palette.muted, wrapMode: "none" });
  const crumbHint = new TextRenderable(renderer, { selectable: false, height: 1, fg: palette.muted, wrapMode: "none" });
  const breadcrumbRow = row();
  breadcrumbRow.add(breadcrumb); breadcrumbRow.add(crumbHint);
  topBar.add(heading); topBar.add(breadcrumbRow);
  const searchInput = new InputRenderable(renderer, { flexGrow: 1, maxLength: 256,
    placeholder: "Search nodes in this view", backgroundColor: palette.panel, textColor: palette.text, focusedBackgroundColor: palette.panel });
  const searchPrompt = new TextRenderable(renderer, { selectable: false, content: " / ", fg: palette.incoming, wrapMode: "none", flexShrink: 0 });
  const searchRow = new BoxRenderable(renderer, { height: 1, width: "100%", flexShrink: 0, flexDirection: "row", visible: false, backgroundColor: palette.panel });
  searchRow.add(searchPrompt); searchRow.add(searchInput);
  topBar.insertBefore(searchRow, breadcrumbRow);
  const body = new SplitPaneRenderable(renderer, { flexGrow: 1, flexBasis: 0, minHeight: 1, direction: "horizontal",
    gutterOptions: { color: palette.border } });
  const viewport = new BoxRenderable(renderer, { minHeight: 1, overflow: "hidden" });
  const canvas = new FrameBufferRenderable(renderer, { position: "absolute", left: 0, top: 0, width: renderer.width, height: Math.max(1, renderer.height - 7) });
  const inspector = new BoxRenderable(renderer, { width: 38, flexShrink: 0, border: false,
    paddingLeft: 1, paddingRight: 1, backgroundColor: palette.panel });
  // Every layer of a scroll box paints its own background; set them all so no cell falls back to the terminal default.
  const surface = { backgroundColor: palette.panel, rootOptions: { backgroundColor: palette.panel }, wrapperOptions: { backgroundColor: palette.panel },
    viewportOptions: { backgroundColor: palette.panel }, contentOptions: { backgroundColor: palette.panel } };
  const inspectorScroll = new ScrollBoxRenderable(renderer, { ...surface, flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true, verticalScrollbarOptions: { showArrows: false, trackOptions: { foregroundColor: palette.edgeDim, backgroundColor: palette.panel } } });
  const inspectorTitle = new TextRenderable(renderer, { selectable: false, bg: palette.panel, height: 1, flexShrink: 0, fg: palette.text, wrapMode: "none" });
  const inspectorHead = new TextRenderable(renderer, { selectable: false, bg: palette.panel, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  const inspectorId = new TextRenderable(renderer, { selectable: false, bg: palette.panel, flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  const relations = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "word" });
  const filesText = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "none" });
  const activityText = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  // Numbered, collapsible sections: each is a lighter block on the panel, with a bar on its left edge when focused.
  type SectionKey = "overview" | "connections" | "files" | "activity";
  const thin = { showArrows: false, trackOptions: { foregroundColor: palette.edgeDim, backgroundColor: palette.panel } };
  const makeSection = (number: number, name: string, children: Renderable[]) => {
    const box = new BoxRenderable(renderer, { id: `section-${name.toLowerCase()}`, backgroundColor: palette.panel, width: "100%", height: 8, flexShrink: 0, flexDirection: "column", marginTop: 1 });
    const header = new TextRenderable(renderer, { selectable: false, bg: palette.panel, height: 1, flexShrink: 0, fg: palette.text, wrapMode: "none" });
    // Every card is the same height; whatever does not fit scrolls inside it, behind a hairline scrollbar.
    const content = new ScrollBoxRenderable(renderer, { ...surface, flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true, paddingLeft: 4, verticalScrollbarOptions: thin });
    for (const child of children) content.add(child);
    box.add(header); box.add(content);
    return { number, name, box, header, content, open: true };
  };
  const sections = {
    overview: makeSection(1, "Overview", [inspectorId]),
    connections: makeSection(2, "Connections", [relations]),
    files: makeSection(3, "Files", [filesText]),
    activity: makeSection(4, "Activity", [activityText]),
  };
  const sectionOrder: SectionKey[] = ["overview", "connections", "files", "activity"];
  // Which section (if any) owns the movement keys. Undefined means the diagram does.
  let focusSection: SectionKey | undefined;
  const cursor: Record<SectionKey, number> = { overview: 0, connections: 0, files: 0, activity: 0 };
  let connectionItems: string[] = [];
  let fileLines: number[] = [];
  let activityItems: { element: string; from: number; to: number }[] = [];
  const hot = RGBA.fromHex(palette.hot), rowBackground = hot;
  const contentRows: Record<SectionKey, number> = { overview: 4, connections: 4, files: 4, activity: 4 };
  const highlight = (chunks: TextChunk[], from: number, to: number) => chunks.map((chunk, index) => index >= from && index < to ? { ...chunk, bg: hot } : chunk);
  for (const child of [inspectorTitle, inspectorHead, ...sectionOrder.map(key => sections[key].box)]) inspectorScroll.add(child);
  inspector.add(inspectorScroll);
  // One bottom row: the mode badge (the only filled block on screen), then key hints or a short-lived notice; zoom and version on the right.
  const statusLeft = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 1, flexGrow: 1, fg: palette.muted, wrapMode: "none" });
  const statusRight = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  const footer = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", paddingRight: 1 });
  footer.add(statusLeft); footer.add(statusRight);
  // A modal is one 1-column rounded frame over a dimmed backdrop. Its title, metadata and key hints are set into the border rows
  // (small panel-coloured texts laid over the border), so there is no separate header or footer.
  const makeModal = (color: string, titleChunks: TextChunk[]) => {
    const modal = { dismiss: () => {}, get visible() { return panel.visible; } };
    const scrim = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 19000, visible: false,
      backgroundColor: RGBA.fromValues(0.02, 0.03, 0.04, 0.8), onMouse(event) { event.preventDefault(); event.stopPropagation(); if (event.type === "down") modal.dismiss(); } });
    const panel = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 60, height: 10, border: true, borderStyle: "rounded", borderColor: color,
      backgroundColor: palette.panel, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, zIndex: 20000, visible: false, flexDirection: "column" });
    const onBorder = (options: { left?: number; right?: number; top?: number; bottom?: number }, initial?: TextChunk[]) => {
      const text = new TextRenderable(renderer, { selectable: false, wrapMode: "none", flexShrink: 0, fg: palette.muted });
      const box = new BoxRenderable(renderer, { position: "absolute", height: 1, flexDirection: "row", backgroundColor: palette.panel, ...options });
      box.add(text); box.visible = false;
      const set = (value: StyledText | string) => { text.content = value; box.visible = true; };
      if (initial) set(new StyledText([fg(palette.muted)(" "), ...initial, fg(palette.muted)(" ")]));
      return { box, set content(value: StyledText | string) { set(value); } };
    };
    const title = onBorder({ left: 1, top: -1 }, titleChunks), meta = onBorder({ right: 1, top: -1 }), foot = onBorder({ left: 1, bottom: -1 });
    const content = new TextRenderable(renderer, { selectable: false, fg: palette.body, wrapMode: "none", flexShrink: 0 });
    for (const child of [content, title.box, meta.box, foot.box]) panel.add(child);
    // `height` is the whole frame: its content rows plus the border and one blank row of padding top and bottom.
    const place = (width: number, height: number) => {
      const w = Math.max(20, Math.min(width, renderer.width - 2)), h = Math.max(5, Math.min(height, renderer.height - 2));
      panel.width = w; panel.height = h;
      panel.left = Math.floor((renderer.width - w) / 2); panel.top = Math.max(0, Math.floor((renderer.height - h) / 2));
    };
    return Object.assign(modal, { scrim, panel, content, meta, foot, place,
      open(width: number, height: number) { place(width, height); scrim.visible = panel.visible = true; },
      close() { scrim.visible = panel.visible = false; } });
  };
  const help = makeModal(palette.edgeDim, [fg(palette.accent)("◆ "), fg(palette.text)("Keyboard shortcuts")]);
  const summary = makeModal(palette.edgeDim, [fg(palette.text)("This session")]);
  const ask = makeModal(palette.accent, [fg(palette.text)("Ask the agent")]);
  const goto = makeModal(palette.edgeDim, [fg(palette.text)("Go to view")]);
  // The question: a field one step darker than the modal that grows to four rows, then scrolls. Enter sends, Alt+Enter adds a line.
  const askRows = () => Math.min(4, Math.max(1, askInput.virtualLineCount));
  const askInput = new TextareaRenderable(renderer, { flexGrow: 1, height: 1, wrapMode: "word", placeholder: "What do you want to know about it?", placeholderColor: palette.border,
    backgroundColor: palette.background, textColor: palette.text, focusedBackgroundColor: palette.background, focusedTextColor: palette.text,
    cursorColor: palette.accent, cursorStyle: { style: "block", blinking: false },
    keyBindings: [{ name: "return", meta: true, action: "newline" }, { name: "return", shift: true, action: "newline" }],
    onContentChange: () => fitAsk() });
  const askPrompt = new TextRenderable(renderer, { selectable: false, content: "›", fg: palette.accent, wrapMode: "none", flexShrink: 0, width: 1, marginRight: 1 });
  const askRow = new BoxRenderable(renderer, { height: 3, width: "100%", flexShrink: 0, flexDirection: "row", backgroundColor: palette.background, marginTop: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1 });
  askRow.add(askPrompt); askRow.add(askInput);
  ask.panel.add(askRow);
  const fitAsk = () => {
    const rows = askRows();
    if (askInput.height === rows) return;
    askInput.height = rows; askRow.height = rows + 2;
    if (ask.visible) ask.place(Math.min(76, renderer.width - 4), rows + 9);
    renderer.requestRender();
  };
  const searchShield = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 3, width: "100%", height: 1,
    zIndex: 10000, visible: false, shouldFill: false, onMouse(event) { event.preventDefault(); event.stopPropagation(); searchInput.focus(); } });
  // The narrow-terminal view: every node as a row (indented by depth), the selection marked; it replaces the diagram.
  const listSurface = { backgroundColor: palette.background, rootOptions: { backgroundColor: palette.background }, wrapperOptions: { backgroundColor: palette.background },
    viewportOptions: { backgroundColor: palette.background }, contentOptions: { backgroundColor: palette.background } };
  const nodeList = new ScrollBoxRenderable(renderer, { ...listSurface, position: "absolute", left: 0, top: 0, width: "100%", height: "100%", visible: false, scrollX: false, scrollY: true,
    verticalScrollbarOptions: { showArrows: false, trackOptions: { foregroundColor: palette.edgeDim, backgroundColor: palette.background } } });
  const nodeListText = new TextRenderable(renderer, { selectable: false, bg: palette.background, width: "100%", flexShrink: 0, fg: palette.body, wrapMode: "none" });
  nodeList.add(nodeListText);
  viewport.add(canvas); viewport.add(nodeList); body.addPane(viewport, Math.max(1, renderer.width - 39), 36); body.addPane(inspector, 38, 28);
  resources.push({ dispose() { if (!inspector.parent) inspector.destroyRecursively(); } });
  for (const child of [topBar, body, footer, searchShield, help.scrim, help.panel, summary.scrim, summary.panel, ask.scrim, ask.panel, goto.scrim, goto.panel]) renderer.root.add(child);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  let centerX = diagram.bounds.x + diagram.bounds.width / 2;
  let centerY = diagram.bounds.y + diagram.bounds.height / 2;
  let scale = 16;
  let selected = diagram.nodes[0];
  type Visit = { view: string; selected: string | undefined; x: number; y: number; scale: number };
  const history: Visit[] = [];
  let pendingReload: { diagrams: typeof diagrams; config: typeof config; files: typeof files; fileError: string; notice: string } | undefined;
  let pendingVisit: { diagram: ReturnType<typeof getDiagram>; restore?: Visit } | undefined;
  let search: { before: Visit; matches: typeof diagram.nodes; index: number } | undefined;
  let dirty = true;
  let redrawAfterResize = false;
  let targetX = centerX, targetY = centerY, targetScale = scale;
  let animating = false;
  let fileMode = false, fileCursor = 0, editorActive = false;
  let fileQuery = "";
  const selectedPaths = () => {
    const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
    const paths = [...files.get(String(selected?.modelRef ?? "")) ?? []].sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.localeCompare(b));
    return fileMode ? paths.filter(path => path.toLowerCase().includes(fileQuery.trim().toLowerCase())) : paths;
  };
  let inspectorPreference: "auto" | "open" | "closed" = "auto";
  let layoutKey = "";
  let mounted: "none" | "docked" | "overlay" = "docked", overlayGeometry = "";
  // Under 80 columns the diagram does not fit: a plain list of nodes replaces it.
  let listMode = false;
  let events: ActivityEvent[] = [];
  let byElement = new Map<string, ActivityEvent[]>();
  let byPath = new Map<string, ActivityEvent>();
  let followCamera = false, followPaused = false, followSelecting = false, focusedCall = "", followSince = 0, lastSignature = "", lastPaint = 0;
  // Anything the user does to the selection or camera while follow is on pauses it, so the viewer never fights them.
  const pauseFollow = () => { if (followCamera && !followPaused && !followSelecting) { followPaused = true; message = "Follow paused · a to resume"; } };
  // Which key family moves the selection; the other family pans. `v` swaps them.
  let vimTraverses = true;
  const selectKeys = () => vimTraverses ? "h j k l" : "Arrows";
  // Four groups of keys, two columns when there is room (Diagram on the left; Inspector, Agent and Global stacked on the right).
  // The group for where the keys are right now is in the accent colour; the rest are dim.
  const helpContent = () => {
    const arrows = "← ↑ ↓ →";
    const groups: { name: string; active: boolean; rows: Hint[] }[] = [
      { name: "Diagram", active: !focusSection, rows: [[vimTraverses ? "h j k l" : arrows, "select a neighbour"], [vimTraverses ? arrows : "h j k l", "pan"], ["+ -", "zoom"], ["f", "fit everything"],
        ["0", "actual size"], ["r", "centre the selection"], ["tab", "next node"], ["enter", "into a group / open a link"], ["backspace", "up to the parent"],
        ["o", "open the linked view"], ["g", "go to any view"], ["b", "back"]] },
      { name: "Inspector", active: !!focusSection, rows: [["i", "toggle the inspector"], ["1-4", "focus a section"], ["j k", "move / scroll"], ["space", "fold section"],
        ["PgUp PgDn", "scroll the inspector"], ["e", "browse mapped files"], ["esc", "back to diagram"]] },
      { name: "Agent", active: false, rows: [["t", "ask the agent about it"], ["w", "jump to the agent's work"], ["c", "what this session touched"], ["a", "follow the work"]] },
      { name: "Global", active: false, rows: [["/", "search this view"], ["?", "this help"], ["q", "quit"]] },
    ];
    const wide = renderer.width >= 100;
    const width = Math.min(96, renderer.width - 4), inner = width - 6, column = wide ? Math.floor((inner - 4) / 2) : inner, keyWidth = 12;
    // One group as lines of chunks, each exactly `column` cells wide.
    const lines = (group: typeof groups[number]): TextChunk[][] => [
      [fg(group.active ? palette.accent : palette.muted)(group.name), fg(palette.rule)(` ${"─".repeat(Math.max(2, column - group.name.length - 1))}`)],
      ...group.rows.map(([key, label]) => {
        const text = label.slice(0, column - keyWidth);
        return [fg(palette.text)(key.padEnd(keyWidth)), fg(palette.body)(text.padEnd(column - keyWidth))];
      })];
    const stack = (items: typeof groups) => items.flatMap((group, index) => [...index ? [[fg(palette.body)(" ".repeat(column))]] : [], ...lines(group)]);
    const chunks: TextChunk[] = [];
    let height: number;
    if (wide) {
      const left = stack(groups.slice(0, 1)), right = stack(groups.slice(1));
      height = Math.max(left.length, right.length);
      for (let index = 0; index < height; index++) chunks.push(...left[index] ?? [fg(palette.body)(" ".repeat(column))], fg(palette.body)("    "), ...right[index] ?? [], nl);
    } else {
      const all = stack(groups);
      height = all.length;
      for (const line of all) chunks.push(...line, nl);
    }
    chunks.pop();
    return { content: new StyledText(chunks), height, width,
      meta: new StyledText([fg(palette.muted)(" in "), fg(palette.accent)(focusSection ? "inspector" : "diagram"), fg(palette.muted)(" ")]) };
  };
  const showHelp = () => {
    const guide = helpContent();
    help.content.content = guide.content; help.meta.content = guide.meta;
    help.foot.content = new StyledText(borderHints([["esc", "close"], ["v", "swap hjkl and arrows"]]));
    if (help.visible) help.place(guide.width, guide.height + 4); else help.open(guide.width, guide.height + 4);
  };
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const isActive = (event: ActivityEvent) => event.phase === "started" && Date.now() - event.time <= 30_000;
  const operationColor = (_operation: ActivityEvent["operation"]) => palette.muted;
  const mix = (from: string | RGBA, to: string | RGBA, amount: number) => {
    const a = typeof from === "string" ? RGBA.fromHex(from) : from, b = typeof to === "string" ? RGBA.fromHex(to) : to;
    return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount, 1);
  };
  // A call seen for the first time flashes: its node's border and its activity row take the accent for a moment.
  const nodeFlashes = new Map<string, number>(), rowFlashes = new Map<string, number>(), seenCalls = new Set<string>();
  let calmLoaded = false, wasFlashing = false;
  const flashes = nodeFlashes;
  const noteCalls = () => {
    const stamp = Date.now() + 600;
    for (const event of events) {
      if (seenCalls.has(event.call)) continue;
      seenCalls.add(event.call);
      if (!calmLoaded) continue;
      rowFlashes.set(event.call, stamp);
      for (const rule of rules) if (event.paths.some(path => rule.match.match(path))) nodeFlashes.set(rule.element, stamp);
    }
    calmLoaded = true;
  };
  const anyFlash = () => { const now = Date.now(); return [...nodeFlashes.values(), ...rowFlashes.values()].some(until => until > now); };
  const indexEvents = () => {
    byElement = new Map();
    byPath = new Map();
    for (const event of events) for (const path of event.paths) if (!byPath.has(path) || event.time > (byPath.get(path)?.time ?? 0)) byPath.set(path, event);
    for (const event of events) {
      for (const element of new Set(rules.filter(rule => event.paths.some(path => rule.match.match(path))).map(rule => rule.element))) {
        byElement.set(element, [...byElement.get(element) ?? [], event]);
      }
    }
  };
  const liveLabel = () => binding ? `${binding.source}:${binding.session.slice(0, 8)}` : "waiting for a session";
  const headingContent = () => new StyledText([fg(palette.accent)("◆ "), fg(palette.muted)("pathlight"), fg(palette.border)(" / "), fg(palette.text)(diagram.title ?? String(diagram.id))]);
  // Right-hand: the live session when there is one (a spinner replaces the dot while a tool runs), otherwise nothing.
  const badgeContent = () => {
    if (!binding && !following) return "";
    const busy = events.some(isActive);
    return new StyledText([fg(binding ? palette.incoming : palette.muted)(`${busy ? spinner[Math.floor(Date.now() / 100) % spinner.length] : "●"} live`), fg(palette.border)(` ${liveLabel()} `)]);
  };
  let activityError = "";
  const layout = () => {
    const side = renderer.width >= 120;
    listMode = renderer.width < 80;
    const visible = inspectorPreference === "open" || inspectorPreference === "auto" && side;
    // Wide terminals dock the inspector beside the diagram; narrower ones show it as an overlay on the right, toggled with `i`.
    const mount: typeof mounted = !visible ? "none" : side ? "docked" : "overlay";
    if (mount === "overlay") {
      const width = Math.min(renderer.width - 2, Math.max(38, Math.floor(renderer.width * 0.5)));
      const geometry = `${width}/${body.y}/${body.height}`;
      if (geometry !== overlayGeometry) { overlayGeometry = geometry; inspector.width = width; inspector.left = renderer.width - width; inspector.top = body.y; inspector.height = Math.max(3, body.height); }
    }
    const key = `${side}/${mount}`;
    if (key === layoutKey) return;
    layoutKey = key;
    body.direction = "horizontal";
    for (const key of sectionOrder) if (!touched.has(key)) sections[key].open = true;
    if (mounted === "docked") body.remove(inspector);
    else if (mounted === "overlay") renderer.root.remove(inspector);
    mounted = mount;
    inspector.visible = visible;
    if (mount === "docked") {
      inspector.position = "relative"; inspector.border = false; inspector.left = 0; inspector.top = 0; inspector.height = "auto";
      body.addPane(inspector);
    } else if (mount === "overlay") {
      inspector.position = "absolute"; inspector.border = ["left"]; inspector.borderColor = palette.border; inspector.zIndex = 15000;
      overlayGeometry = "";
      renderer.root.add(inspector);
    }
    const total = renderer.width;
    const panelSize = Math.min(64, Math.max(38, Math.floor(renderer.width * 0.30)));
    body.minSizes = mount === "docked" ? [36, 28] : [1];
    body.sizes = mount === "docked" ? [Math.max(1, total - panelSize - 1), panelSize] : [total];
  };
  let message = "", lastToast = "";
  // One border per node: a leaf is a rounded outline whose inside is painted in the canvas colour (so grid dots do not show through);
  // a group is an outline with a title and no fill.
  const mountNodes = () => diagram.nodes.map(node => {
    const z = node.level + 1;
    const group = node.children.length > 0;
    const box = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 1, height: 1,
      border: true, borderStyle: "rounded", borderColor: group ? palette.rule : palette.cardEdge, shouldFill: !group, backgroundColor: palette.background, zIndex: z,
      justifyContent: "center", title: group ? node.title : undefined, titleColor: palette.muted });
    const label = new TextRenderable(renderer, { selectable: false, fg: palette.body, wrapMode: "word", content: group ? "" : node.title, marginLeft: 1, marginRight: 1 });
    box.add(label); viewport.add(box);
    return { node, box, label, rect: { x: 0, y: 0, width: 1, height: 1 } };
  });
  // Orthogonal routes between the same nodes LikeC4 connects, found once per layout (see routes.ts).
  const computeRoutes = (): Route[] => routeEdges(diagram.nodes.map(node => ({ id: String(node.id), x: node.x, y: node.y, width: node.width, height: node.height, children: node.children.map(String) })),
    diagram.edges.map(edge => ({ source: String(edge.source), target: String(edge.target), points: edge.points })));
  let nodeObjects = mountNodes();
  let routes = computeRoutes();
  let previousWidth = 0, previousHeight = 0;
  let initialFit = true, stableLayoutFrames = 0;
  // The diagram stays fitted and centred through load and resize until the user pans or zooms (`f` fits again).
  let autoFit = true;
  // One-time "draw-on" when the first view opens: nodes bloom left to right, connectors extend source to target.
  const revealMs = 600;
  let revealStart: number | undefined;
  const revealProgress = () => initialFit ? 0 : revealStart === undefined ? 1 : Math.min(1, (Date.now() - revealStart) / revealMs);
  const easeOut = (t: number) => 1 - (1 - t) ** 3;
  const fade = (color: string | RGBA, amount: number) => {
    const c = typeof color === "string" ? RGBA.fromHex(color) : color, b = RGBA.fromHex(palette.background);
    return RGBA.fromValues(b.r + (c.r - b.r) * amount, b.g + (c.g - b.g) * amount, b.b + (c.b - b.b) * amount, 1);
  };
  const cellAspect = () => {
    const resolution = renderer.resolution;
    return resolution && resolution.width > 0 && resolution.height > 0
      ? (resolution.width / renderer.width) / (resolution.height / renderer.height) : 0.5;
  };
  const projected = (x: number, y: number) => {
    const p = new THREE.Vector3(x, -y, 10).project(camera);
    return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
  };
  const nl = fg(palette.text)("\n");
  // Section bodies are indented four columns (under the label); the panel has one column of padding each side and one for a scrollbar.
  const bodyWidth = () => Math.max(16, inspector.width - 2 - 4 - 1);
  const innerWidth = bodyWidth;
  const section = (title: string, tone: string, right = "") => [fg(tone)(title), fg(palette.border)(` ${"─".repeat(Math.max(2, innerWidth() - title.length - right.length - 2))} `), fg(palette.muted)(right)];
  const elementTitle = (id: string) => diagram.nodes.find(node => String(node.modelRef) === id)?.title ?? id.split(".").at(-1) ?? id;
  // Which element each rendered line of the activity list belongs to, so a click can select its node.
  let activityTargets: (string | undefined)[] = [];
  // Every open card gets an equal share of the inspector's height; a folded card is a padded header.
  let headRows = 2;
  const bodyRows: Record<SectionKey, number> = { overview: 4, connections: 4, files: 4, activity: 4 };
  const resetInspectorScroll = () => { inspectorScroll.scrollTo(0); for (const key of sectionOrder) sections[key].content.scrollTo(0); };
  // Sections folded automatically because the inspector is too short for every open card (never ones the user touched).
  const autoFolded = new Set<SectionKey>();
  const isOpen = (key: SectionKey) => sections[key].open && !autoFolded.has(key);
  const layoutSections = () => {
    const total = inspectorScroll.viewport.height;
    if (total <= 0) return;
    autoFolded.clear();
    let active = sectionOrder.filter(key => sections[key].open);
    const wants = (key: SectionKey) => 1 + Math.max(1, contentRows[key]);
    // Each open section gets what its content needs, capped at a fair share; whatever a short section leaves over goes to the long ones.
    const allot = (keys: SectionKey[], compact: boolean) => {
      const closed = sectionOrder.length - keys.length;
      let remaining = total - headRows - (compact ? 0 : sectionOrder.length) - closed;
      const result = new Map<SectionKey, number>();
      const ordered = [...keys].sort((a, b) => wants(a) - wants(b));
      ordered.forEach((key, index) => {
        const give = Math.max(2, Math.min(wants(key), Math.floor(remaining / (ordered.length - index))));
        result.set(key, give); remaining -= give;
      });
      return { result, remaining };
    };
    // With a session attached the work is what is being watched, so activity is the last card to fold.
    for (const drop of (binding || following ? ["files", "connections", "overview", "activity"] : ["overview", "activity", "files", "connections"]) as SectionKey[]) {
      if (active.length <= 1 || [...allot(active, false).result.values()].every(rows => rows >= 4)) break;
      if (active.includes(drop) && !touched.has(drop)) { active = active.filter(key => key !== drop); autoFolded.add(drop); }
    }
    const roomy = allot(active, false);
    const compact = active.length > 0 && [...roomy.result.values()].some(rows => rows < 3);
    const plan = compact ? allot(active, true) : roomy;
    const ultra = compact && total - headRows - (sectionOrder.length - active.length) < 3;
    for (const key of sectionOrder) {
      const entry = sections[key], isActive = active.includes(key);
      const rows = ultra ? Math.max(3, total - headRows) : plan.result.get(key) ?? 1;
      entry.box.visible = isActive || !ultra;
      entry.box.height = isActive ? rows : 1;
      entry.box.marginTop = compact ? 0 : 1;
      entry.content.visible = isActive;
      bodyRows[key] = Math.max(1, (isActive ? rows : 0) - 1);
    }
  };
  // Keep a line of a card's scrolling body in view.
  const followLine = (key: SectionKey, line: number) => {
    const box = sections[key].content, rows = Math.min(bodyRows[key], box.viewport.height > 0 ? box.viewport.height : bodyRows[key]);
    if (rows <= 0) return;
    if (line < box.scrollTop) box.scrollTo(line); else if (line >= box.scrollTop + rows) box.scrollTo(line - rows + 1);
  };
  const activityContent = () => {
    activityTargets = []; activityItems = [];
    const note = (text: string, tone: string = palette.border) => { contentRows.activity = 1; return new StyledText([fg(tone)(text)]); };
    if (activityError) return note(activityError, palette.failure);
    if (!binding && !following) return note("No session attached — run /pathlight in your agent");
    if (!config) return note(`No activity mappings for ${view.project} — run pathlight init`);
    if (!binding) return note("No activity yet");
    const now = Date.now();
    const rows = activityRows(events, config, now, 64);
    const mapped = rows.filter(row => row.elements.length);
    if (!mapped.length) return note(rows.length ? `${rows.length} calls, none mapped to a component` : "No activity yet");
    const groups = new Map<string, typeof mapped>();
    for (const row of mapped) groups.set(row.elements[0] ?? "", [...groups.get(row.elements[0] ?? "") ?? [], row]);
    const width = bodyWidth();
    const spin = spinner[Math.floor(now / 100) % spinner.length] ?? "●";
    const chunks: TextChunk[] = [];
    let lines = 0;
    for (const [element, group] of [...groups].slice(0, 4)) {
      let lineStart = chunks.length;
      const inView = diagram.nodes.some(node => String(node.modelRef) === element);
      const here = element === String(selected?.modelRef ?? "");
      chunks.push(fg(here ? palette.accent : palette.border)("● "), fg(palette.text)(elementTitle(element)), ...(inView ? [] : [fg(palette.border)("  other view")]), nl);
      activityTargets.push(element); activityItems.push({ element, from: lineStart, to: chunks.length }); lines++;
      const collapsed: { row: (typeof group)[number]; count: number; calls: string[] }[] = [];
      for (const row of group) {
        const same = collapsed.find(entry => entry.row.operation === row.operation && entry.row.target === row.target);
        if (same) { same.count++; same.calls.push(row.call); } else collapsed.push({ row, count: 1, calls: [row.call] });
      }
      const visibleRows = collapsed.slice(0, 3);
      for (const [at, { row, count, calls }] of visibleRows.entries()) {
        lineStart = chunks.length;
        const glyph = row.state === "started" ? spin : row.state === "completed" ? "✓" : row.state === "failed" ? "✗" : "?";
        const glyphTone = row.state === "failed" ? palette.failure : row.state === "started" ? palette.accent : row.state === "completed" ? palette.green : palette.muted;
        const op = (row.operation === "command" ? "run" : row.operation).padEnd(5);
        const first = row.paths[0]?.split("/").at(-1) ?? row.target;
        const extra = `${row.paths.length > 1 ? ` +${row.paths.length - 1}` : ""}${count > 1 ? ` ×${count}` : ""}`;
        const age = formatAge(row.age);
        // Fixed grid: branch (3) · glyph (2) · op (5) · file + count · time, right aligned.
        const room = Math.max(4, width - 3 - 2 - 5 - age.length - 1);
        const shownFile = first.length + extra.length > room ? `${first.slice(0, Math.max(1, room - extra.length - 1))}…` : first;
        const gap = Math.max(1, width - 3 - 2 - 5 - shownFile.length - extra.length - age.length);
        const line: TextChunk[] = [fg(palette.border)(`${at === visibleRows.length - 1 ? "└─" : "├─"} `), fg(glyphTone)(`${glyph} `), fg(palette.muted)(op), fg(palette.body)(shownFile),
          fg(palette.border)(extra), fg(palette.border)(`${" ".repeat(gap)}${age}`), nl];
        const flashing = calls.some(call => (rowFlashes.get(call) ?? 0) > now);
        chunks.push(...(flashing ? line.map(chunk => ({ ...chunk, bg: rowBackground })) : line));
        activityTargets.push(element); activityItems.push({ element, from: lineStart, to: chunks.length }); lines++;
      }
    }
    const hidden = rows.length - mapped.length;
    // Edits to files no component claims show where the mapping has a gap.
    const gaps = [...new Set(rows.filter(row => !row.elements.length && row.operation === "edit").flatMap(row => row.paths))];
    if (gaps.length) {
      chunks.push(nl, fg(palette.accent)("no component"), fg(palette.muted)(`  ${gaps.length} edited file${gaps.length > 1 ? "s" : ""}\n`)); lines += 2;
      for (const path of gaps.slice(0, 3)) { chunks.push(fg(palette.border)("✎ "), fg(palette.body)(`${path.length > width - 4 ? `…${path.slice(-(width - 5))}` : path}\n`)); lines++; }
    }
    if (hidden > 0) { chunks.push(fg(palette.border)(`+${hidden} unmapped call${hidden > 1 ? "s" : ""}`)); lines++; }
    cursor.activity = Math.min(cursor.activity, Math.max(0, activityItems.length - 1));
    const item = focusSection === "activity" ? activityItems[cursor.activity] : undefined;
    contentRows.activity = lines;
    return new StyledText(item ? highlight(chunks, item.from, item.to) : chunks);
  };
  // What the retained journal says the agent did: observed counts only, never a claim about outcomes.
  const summaryContent = () => {
    summary.place(60, 5);
    if (!binding || !config) return new StyledText([fg(palette.muted)("Not bound to an agent session. Start the viewer with --follow or --session.")]);
    if (!events.length) return new StyledText([fg(palette.muted)("No calls recorded yet.")]);
    const now = Date.now();
    const rows = activityRows(events, config, now, 128);
    const width = Math.max(30, Math.floor(renderer.width * 0.8) - 8);
    const byComponent = new Map<string, { reads: number; edits: number; commands: number; last: number }>();
    const edited = new Map<string, { count: number; element?: string }>();
    for (const row of rows) {
      for (const element of row.elements) {
        const entry = byComponent.get(element) ?? { reads: 0, edits: 0, commands: 0, last: Infinity };
        if (row.operation === "read") entry.reads++; else if (row.operation === "edit") entry.edits++; else if (row.operation === "command") entry.commands++;
        entry.last = Math.min(entry.last, row.age);
        byComponent.set(element, entry);
      }
      if (row.operation === "edit") for (const path of row.paths) edited.set(path, { count: (edited.get(path)?.count ?? 0) + 1, element: edited.get(path)?.element ?? row.elements[0] });
    }
    const oldest = Math.max(...rows.map(row => row.age));
    const chunks = [...section(`${binding.source}:${binding.session.slice(0, 8)}`, palette.text, `${rows.length} calls over ${formatAge(oldest)}`), nl, nl,
      fg(palette.muted)("components touched"), nl];
    for (const [element, entry] of [...byComponent].sort((a, b) => a[1].last - b[1].last).slice(0, 8)) {
      const name = elementTitle(element).padEnd(24).slice(0, 24);
      chunks.push(fg(palette.muted)("  ● "), fg(palette.text)(name), fg(palette.incoming)(`r${entry.reads}`.padEnd(5)), fg(palette.outgoing)(`e${entry.edits}`.padEnd(5)),
        fg(palette.command)(`c${entry.commands}`.padEnd(6)), fg(palette.muted)(formatAge(entry.last)), nl);
    }
    if (!byComponent.size) chunks.push(fg(palette.muted)("  none mapped"), nl);
    chunks.push(nl, fg(palette.muted)("files edited"), nl);
    const files = [...edited].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    for (const [path, info] of files) {
      const room = width - 30;
      chunks.push(fg(palette.outgoing)("  ✎ "), fg(info.element ? palette.text : palette.failure)((path.length > room ? `…${path.slice(-(room - 1))}` : path).padEnd(Math.min(room, 40))),
        fg(palette.muted)(`×${info.count}  ${info.element ? elementTitle(info.element) : "no component"}`), nl);
    }
    if (!files.length) chunks.push(fg(palette.muted)("  no edits observed"), nl);
    chunks.push(nl, fg(palette.border)("Counts come from the retained calls, not totals. Commands show files they name."));
    summary.place(Math.min(100, renderer.width - 6), chunks.filter(chunk => chunk.text.includes("\n")).length + 4);
    return new StyledText(chunks);
  };
  const tickerContent = () => {
    if (!binding || !config) return undefined;
    const [row] = activityRows(events, config, Date.now(), 1);
    if (!row || row.age > 120_000) return undefined;
    const label = row.state === "started" ? (row.operation === "command" ? "run" : row.operation) : row.state === "completed" ? "done" : row.state === "failed" ? "failed" : "unconfirmed";
    const tone = row.state === "failed" ? palette.failure : row.state === "started" ? palette.accent : palette.muted;
    return [fg(tone)("● "), fg(tone)(label), fg(palette.body)(` ${row.target} `), fg(palette.border)("→ "), fg(row.elements.length ? palette.muted : palette.border)(row.elements.join(", ") || "unmapped"), fg(palette.border)(` · ${formatAge(row.age)}`)];
  };
  // A faint grid fixed to the diagram's coordinates: panning and zooming read as camera motion.
  const paintGrid = () => {
    let step = 32;
    while (step / scale < 7) step *= 2;
    const halfWidth = viewport.width * scale / 2, halfHeight = viewport.height * scale / cellAspect() / 2;
    const dot = RGBA.fromHex(palette.grid), bg = RGBA.fromHex(palette.background);
    for (let wx = Math.floor((centerX - halfWidth) / step) * step; wx <= centerX + halfWidth; wx += step) {
      for (let wy = Math.floor((centerY - halfHeight) / step) * step; wy <= centerY + halfHeight; wy += step) {
        const p = projected(wx, wy), x = Math.floor(p.x), y = Math.floor(p.y);
        if (x >= 0 && y >= 0 && x < viewport.width && y < viewport.height) canvas.frameBuffer.setCell(x, y, "·", dot, bg);
      }
    }
  };
  // Never show a fragment: if a word cannot fit the node's width, or the wrapped title plus status line cannot fit its
  // height, the title becomes one line ending in an ellipsis (the observed state keeps its own line).
  const labelTitle = (title: string, width: number, rows: number, status: boolean) => {
    const textWidth = Math.max(3, width);
    const widest = Math.max(...title.split(/\s+/).map(word => word.length));
    const tooTall = Math.ceil(title.length / textWidth) + (status ? 1 : 0) > Math.max(1, rows);
    return (widest > textWidth || tooTall) && title.length > textWidth ? `${title.slice(0, textWidth - 1)}…` : title;
  };
  // LikeC4's own description, flattened: the model is the single source of what a component is for.
  const describe = (node: typeof selected) => {
    const raw = node?.description as { txt?: string; md?: string } | null | undefined;
    const text = (raw?.txt ?? raw?.md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
    return text.length > 420 ? `${text.slice(0, 419)}…` : text;
  };
  // What a node's mapped activity is doing right now: a running tool, or how a call that just ended finished.
  const operationState = (active: ActivityEvent[], recent: ActivityEvent | undefined) => active.length ? active.some(event => event.operation === "edit") ? "edit" : active.some(event => event.operation === "read") ? "read" : "run"
    : recent?.phase === "failed" ? "failed" : recent?.phase === "completed" ? "done" : "";
  let listSelected = "";
  const renderNodeList = () => {
    const chunks: TextChunk[] = [];
    const width = Math.max(10, viewport.width - 2);
    diagram.nodes.forEach((node, index) => {
      const on = node.id === selected?.id, indent = "  ".repeat(Math.min(node.level, 4));
      const kind = node.kind ? String(node.kind) : "", group = node.children.length > 0;
      const room = Math.max(1, width - 3 - indent.length);
      const title = node.title.length > room ? `${node.title.slice(0, Math.max(0, room - 1))}…` : node.title;
      const rest = Math.max(0, room - title.length - 1);
      const paint = (chunk: TextChunk) => on ? { ...chunk, bg: hot } : chunk;
      const related = byElement.get(String(node.modelRef)) ?? [], now = Date.now();
      const state = operationState(related.filter(isActive), related.find(event => now - event.time <= 5000));
      const tag = state ? `[${state}]` : kind;
      const tagColor = state === "failed" ? palette.failure : state && state !== "done" ? palette.accent : palette.border;
      chunks.push(paint(fg(palette.accent)(on ? " › " : "   ")), paint(fg(palette.muted)(indent)), paint(fg(on ? palette.text : group ? palette.muted : palette.body)(title)),
        paint(fg(tagColor)(tag && rest > tag.length ? ` ${tag}`.padStart(rest + 1) : " ".repeat(rest + 1))));
      if (index < diagram.nodes.length - 1) chunks.push(nl);
    });
    nodeListText.content = new StyledText(chunks);
    const index = diagram.nodes.findIndex(node => node.id === selected?.id), signature = `${diagram.id}/${selected?.id}`;
    if (signature !== listSelected && index >= 0) {
      listSelected = signature;
      const top = nodeList.scrollTop, height = nodeList.viewport.height;
      if (index < top) nodeList.scrollTo(index); else if (index >= top + height) nodeList.scrollTo(index - height + 1);
    }
  };
  const update = () => {
    layout();
    canvas.visible = !listMode; nodeList.visible = listMode;
    if (listMode) renderNodeList();
    headingText.content = headingContent(); badgeText.content = badgeContent();
    breadcrumb.content = search ? new StyledText([fg(palette.accent)(`Search ${search.matches.length ? search.index + 1 : 0}/${search.matches.length}`), fg(palette.muted)(" · Enter keep · Esc cancel")])
      : `${renderer.width >= 100 ? `${basename(view.workspace)} · ` : ""}${view.project}/${diagram.id} · ${diagram.nodes.length} nodes · ${diagram.edges.length} relationships · back ${history.length}`;
    crumbHint.visible = true;
    searchShield.visible = !!search;
    searchShield.height = Math.max(1, renderer.height - 5);
    const worldWidth = Math.max(1, viewport.width) * scale;
    const worldHeight = Math.max(1, viewport.height) * scale / cellAspect();
    camera.left = -worldWidth / 2; camera.right = worldWidth / 2;
    camera.top = worldHeight / 2; camera.bottom = -worldHeight / 2;
    camera.position.set(centerX, -centerY, 1000); camera.lookAt(centerX, -centerY, 0);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    let hidden = 0;
    const now = Date.now();
    const previewed = focusSection === "connections" ? connectionItems[cursor.connections] : undefined;
    const dashed = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "┄", vertical: "┆", topT: "┬", bottomT: "┴", leftT: "├", rightT: "┤", cross: "┼" };
    for (const entry of nodeObjects) {
      const group = entry.node.children.length > 0, id = String(entry.node.id);
      const related = byElement.get(String(entry.node.modelRef)) ?? [];
      const reads = related.filter(event => event.operation === "read").length, edits = related.filter(event => event.operation === "edit").length;
      const runs = related.filter(event => event.operation === "command").length;
      const counts = [reads && `r${reads}`, edits && `e${edits}`, runs && `c${runs}`].filter(Boolean).join(" ");
      const active = related.filter(isActive);
      const recent = related.find(event => now - event.time <= 5000);
      const state = operationState(active, recent);
      const isSelected = id === String(selected?.id);
      const neighbour = diagram.edges.some(edge => (edge.target === selected?.id && edge.source === entry.node.id) || (edge.source === selected?.id && edge.target === entry.node.id));
      const flashing = (flashes.get(String(entry.node.modelRef)) ?? 0) > now;
      // Selection and the panel cursor's target take the accent; neighbours are a step brighter; a running call or a fresh update pulses the accent.
      let border: string | RGBA = group ? palette.rule : palette.cardEdge;
      if (neighbour) border = group ? palette.border : palette.edgeDim;
      if (state === "failed") border = palette.failure;
      if (previewed === id || isSelected || flashing) border = palette.accent;
      if (active.length && !isSelected) {
        const pulse = RGBA.fromHex(palette.accent), brightness = 0.55 + 0.45 * (1 + Math.sin(now / 220)) / 2;
        pulse.r *= brightness; pulse.g *= brightness; pulse.b *= brightness;
        border = pulse;
      }
      entry.box.borderColor = border;
      entry.box.customBorderChars = previewed === id && !isSelected ? dashed : undefined;
      entry.box.backgroundColor = palette.background;
      const origin = projected(entry.node.x, entry.node.y);
      const end = projected(entry.node.x + entry.node.width, entry.node.y + entry.node.height);
      let left = Math.round(origin.x), top = Math.round(origin.y), right = Math.max(left + 3, Math.round(end.x)), bottom = Math.max(top + 3, Math.round(end.y));
      // At low zoom a card can land on its group's border row and hide the title: keep it inside the group's frame.
      const container = diagram.nodes.find(node => node.id === entry.node.parent);
      if (container) {
        const a = projected(container.x, container.y), b = projected(container.x + container.width, container.y + container.height);
        left = Math.max(left, Math.round(a.x) + 1); top = Math.max(top, Math.round(a.y) + 1);
        right = Math.max(left + 3, Math.min(right, Math.round(b.x) - 1)); bottom = Math.max(top + 3, Math.min(bottom, Math.round(b.y) - 1));
      }
      const width = right - left, height = bottom - top;
      entry.box.left = left; entry.box.top = top;
      entry.box.width = width; entry.box.height = height;
      entry.rect = { x: left, y: top, width, height };
      const bright = isSelected || neighbour || previewed === id;
      if (group) entry.box.title = `${entry.node.title}${state ? ` [${state}]` : ""}${counts ? ` ·${counts}` : ""}`;
      else {
        // First line: the kind (dim) on the left and observed activity (dim) on the right; then the title.
        const rows = height - 2, textWidth = Math.max(4, width - 4);
        const stateText = state ? `[${state}]` : "";
        const statusText = [stateText, counts].filter(Boolean).join(" ");
        const kindFull = entry.node.kind ? String(entry.node.kind) : "";
        const kindText = kindFull.length + (statusText ? statusText.length + 1 : 0) < textWidth ? kindFull : "";
        const header = rows >= 2 && (statusText || (kindText && kindText.length < textWidth));
        const gap = Math.max(1, textWidth - kindText.length - statusText.length);
        const first: TextChunk[] = header ? [fg(palette.muted)(kindText.slice(0, Math.max(0, textWidth - statusText.length - 1))),
          fg(palette.muted)(statusText ? " ".repeat(gap) : ""), ...(stateText ? [fg(state === "failed" ? palette.failure : active.length || flashing ? palette.accent : palette.muted)(stateText), fg(palette.muted)(counts ? ` ${counts}` : "")] : [fg(palette.muted)(counts)]), nl] : [];
        entry.label.content = new StyledText([...first, fg(bright ? palette.text : palette.body)(labelTitle(entry.node.title, textWidth, Math.max(1, rows - (header ? 1 : 0)), false))]);
      }
      entry.box.visible = !listMode && end.x > 0 && end.y > 0 && origin.x < viewport.width && origin.y < viewport.height;
      const bloom = Math.min(1, Math.max(0, (easeOut(revealProgress()) - (diagram.bounds.width ? (entry.node.x - diagram.bounds.x) / diagram.bounds.width * 0.45 : 0)) / 0.55));
      if (bloom < 1) { entry.box.borderColor = fade(entry.box.borderColor, bloom); }
      entry.label.visible = !group && width >= 8 && height >= 3 && bloom >= 0.7;
      if (!group && !entry.label.visible && bloom >= 0.7) hidden++;
    }
    const paths = selectedPaths();
    inspectorTitle.content = new StyledText([fg(palette.text)(selected?.title ?? "No selection")]);
    const what = [selected?.kind, selected?.technology].filter(Boolean).join(" · ");
    inspectorHead.content = new StyledText([fg(palette.muted)(what || " ")]);
    headRows = 2;
    const parent = diagram.nodes.find(node => node.id === selected?.parent);
    const description = describe(selected);
    const observed = byElement.get(String(selected?.modelRef ?? ""))?.length ?? 0;
    const row = (key: string, value: string) => [fg(palette.border)(key.padEnd(9)), fg(palette.muted)(`${value}\n`)];
    const facts = [...row("id", String(selected?.id ?? "")), ...(parent ? row("parent", parent.title) : []), ...row("files", String(paths.length)),
      ...(binding || following ? row("events", String(observed)) : []), ...(selected?.navigateTo ? row("opens", `${selected.navigateTo}  (o)`) : [])];
    inspectorId.content = new StyledText([...(description ? [fg(palette.body)(description), nl, nl] : []), ...facts]);
    contentRows.overview = (description ? Math.ceil(description.length / bodyWidth()) + 2 : 0) + facts.filter(chunk => chunk.text.includes("\n")).length;

    const name = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const incoming = diagram.edges.filter(edge => edge.target === selected?.id);
    const outgoing = diagram.edges.filter(edge => edge.source === selected?.id);
    connectionItems = [...outgoing.map(edge => String(edge.target)), ...incoming.map(edge => String(edge.source))];
    cursor.connections = Math.min(cursor.connections, Math.max(0, connectionItems.length - 1));
    const labelRows = (label: string | null | undefined) => Math.max(1, Math.ceil(((label?.replace(/\s+/g, " ").trim().length || 22) + 4) / Math.max(8, bodyWidth())));
    const connectionLines: number[] = [];
    let connectionLine = 1;
    for (const edge of [...outgoing, ...incoming]) { connectionLines.push(connectionLine); connectionLine += 1 + labelRows(edge.label); }
    contentRows.connections = connectionLine;
    if (focusSection === "connections") followLine("connections", connectionLines[cursor.connections] ?? 0);
    const link = (index: number, arrow: string, tone: string, node: string, label: string | null | undefined) => {
      const here = focusSection === "connections" && cursor.connections === index;
      const lines = [fg(palette.accent)(here ? "› " : "  "), fg(tone)(`${arrow} `), fg(here ? palette.text : palette.body)(`${name(node)}\n`),
        fg(palette.muted)(`    ${label?.replace(/\s+/g, " ").trim() || "Unlabeled relationship"}\n`)];
      return here ? lines.map(chunk => ({ ...chunk, bg: rowBackground })) : lines;
    };
    relations.content = new StyledText([
      fg(palette.border)(`out ${outgoing.length} · in ${incoming.length}\n`),
      ...outgoing.flatMap((edge, index) => link(index, "→", palette.accent, edge.target, edge.label)),
      ...incoming.flatMap((edge, index) => link(outgoing.length + index, "←", palette.incoming, edge.source, edge.label)),
      ...(outgoing.length + incoming.length ? [] : [fg(palette.border)("No relationships")]),
    ]);

    // Mapped files as a nested tree: directories dim with a trailing slash (single-child chains joined), files normal, files touched this
    // session bright with an accent dot at the right edge. Every row sits on one column grid: a two-column cursor slot, then the tree.
    const fileFocus = fileMode || focusSection === "files";
    const fileChunks: TextChunk[] = fileMode ? [fg(palette.accent)(`Files ${paths.length ? fileCursor + 1 : 0}/${paths.length}`), nl] : [];
    const firstFileLine = fileChunks.length ? 1 : 0;
    fileLines = [];
    type Folder = { dirs: Map<string, Folder>; files: { name: string; index: number }[] };
    const root: Folder = { dirs: new Map(), files: [] };
    paths.slice(0, 500).forEach((path, index) => {
      const parts = path.split("/"), file = parts.pop() ?? path;
      let folder = root;
      for (const part of parts) { let next = folder.dirs.get(part); if (!next) { next = { dirs: new Map(), files: [] }; folder.dirs.set(part, next); } folder = next; }
      folder.files.push({ name: file, index });
    });
    let touchedAny = false;
    const treeRow = (prefix: string, connector: string, label: string, index: number | undefined) => {
      const recent = index === undefined ? undefined : byPath.get(paths[index] ?? ""), here = index !== undefined && fileFocus && fileCursor === index;
      const used = 2 + prefix.length + connector.length + label.length;
      const cells: TextChunk[] = [fg(palette.accent)(here ? "› " : "  "), fg(palette.border)(`${prefix}${connector}`), fg(index === undefined ? palette.muted : recent ? palette.text : palette.body)(label),
        fg(palette.muted)(" ".repeat(Math.max(1, bodyWidth() - used - 1))), fg(recent ? palette.accent : palette.panel)(recent ? "●" : " "), nl];
      if (recent) touchedAny = true;
      fileChunks.push(...(here ? cells.map(chunk => ({ ...chunk, bg: rowBackground })) : cells));
      fileLines.push(index ?? -1);
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
        if ("dir" in item) { treeRow(prefix, connector, `${item.dir}/`, undefined); walk(item.child, top ? "" : prefix + (last ? "   " : "│  "), false); }
        else treeRow(prefix, connector, item.file, item.index);
      });
    };
    walk(root, "", true);
    if (!paths.length) fileChunks.push(fg(palette.border)(fileError || (config ? "No files mapped" : "Map files in pathlight.activity.json")));
    else if (touchedAny) fileChunks.push(fg(palette.border)("● touched this session"));
    contentRows.files = fileChunks.filter(chunk => chunk.text.includes("\n")).length + (paths.length && touchedAny ? 1 : 0) + (paths.length ? 0 : 1);
    filesText.content = new StyledText(fileChunks);
    // First click highlights a row; clicking the highlighted row again opens it.
    filesText.onMouseDown = event => {
      event.preventDefault(); event.stopPropagation();
      const index = fileLines[event.y - filesText.y - firstFileLine] ?? -1, path = paths[index];
      if (index < 0 || !path || help.visible || summary.visible || search) return;
      if (fileMode && clickedFile === index) { openFile(path); return; }
      if (!fileMode) beginFiles();
      fileCursor = clickedFile = index; message = "Click again or Enter to open"; searchInput.focus(); update();
    };
    if (fileFocus) followLine("files", firstFileLine + Math.max(0, fileLines.indexOf(fileCursor)));
    activityText.content = activityContent();
    if (focusSection === "activity") followLine("activity", cursor.activity);

    const counts: Record<SectionKey, string> = { overview: "", connections: String(incoming.length + outgoing.length),
      files: fileMode ? `${paths.length ? fileCursor + 1 : 0}/${paths.length}` : String(paths.length), activity: events.length ? String(events.length) : "" };
    layoutSections();
    for (const key of sectionOrder) {
      const entry = sections[key], focused = focusSection === key;
      const label = `${isOpen(key) ? "▾" : "▸"} ${entry.number} ${entry.name}`;
      const rule = "─".repeat(Math.max(2, inspector.width - 2 - label.length - counts[key].length - 3));
      entry.header.content = new StyledText([fg(focused ? palette.accent : palette.border)(`${isOpen(key) ? "▾" : "▸"} `), fg(palette.border)(`${entry.number} `),
        fg(focused ? palette.accent : palette.body)(entry.name), fg(palette.rule)(` ${rule} `), fg(palette.muted)(counts[key])]);
      // Only the focused section shows a scrollbar, and only when it has more than fits.
      entry.content.verticalScrollBar.visible = focused && entry.content.scrollHeight > entry.content.viewport.height;
    }
    if (summary.visible) summary.content.content = summaryContent();
    body.gutterOptions = { color: fileMode ? palette.outgoing : palette.border };
    const mode = fileMode ? "files" : focusSection ? sections[focusSection].name.toLowerCase() : search ? "search" : "diagram";
    // A notice has the room: the hidden-label count waits until it goes.
    const labelNote = message ? 0 : hidden;
    const rightWidth = 17 + pkg.version.length + (labelNote ? `${labelNote} labels hidden  ·  `.length : 0);
    const rightContent = new StyledText([...(labelNote ? [fg(palette.border)(`${labelNote} labels hidden  ·  `)] : []), fg(palette.muted)(`zoom ${Math.round(16 / scale * 100)}%`), fg(palette.border)(" │ "), fg(palette.muted)(`pathlight ${pkg.version}`)]);
    const navigation: Hint[] = listMode ? [["↑↓", "select"], ["enter", "into / open"], ["backspace", "up"], ["i", "panel"], ["/", "search"], ["t", "ask"], ["?", "help"]] : [[selectKeys(), "select"], [vimTraverses ? "←↑↓→" : "h j k l", "pan"], ["+ -", "zoom"], ["/", "search"], ["f", "fit"], ["e", "files"], ["i", "panel"], ["t", "ask"], ["c", "session"], ["?", "help"]];
    const sectionHints: Record<SectionKey, Hint[]> = {
      overview: [["↑↓", "scroll"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      connections: [["↑↓", "move"], ["enter", "show in diagram"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      files: [["↑↓", "move"], ["enter", "open"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      activity: [["↑↓", "move"], ["enter", "show component"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
    };
    const room = Math.max(10, renderer.width - rightWidth - 16 - mode.length - String(selected?.id ?? "").length - 4);
    const ticker = tickerContent();
    const recentCall = ticker && events.length && Date.now() - (events[0]?.time ?? 0) < 8000;
    const hints = focusSection && !fileMode && !search ? hintChunks(sectionHints[focusSection], room)
      : search ? [fg(palette.muted)("type a name or id  "), ...hintChunks([["↑↓", "matches"], ["enter", "keep"], ["esc", "restore"]], room - 20)]
      : fileMode ? [fg(palette.accent)(`Files ${paths.length ? fileCursor + 1 : 0}/${paths.length}`), fg(palette.muted)("  type to filter  "), ...hintChunks([["enter", "open"], ["ctrl+r", "refresh"], ["esc", "back"]], room - 30)]
      : recentCall && room < 70 ? ticker : hintChunks(navigation, room);
    if (message !== lastToast) {
      lastToast = message;
      if (message) { const shown = message; setTimeout(() => { if (message === shown && !closing) { message = ""; update(); } }, /^Asked /.test(shown) ? 3500 : 2000); }
    }
    const style = message ? noticeStyle(message) : undefined;
    statusLeft.content = new StyledText([pill(mode, palette.accent), fg(palette.muted)("  Selected: "), fg(palette.body)(String(selected?.id ?? "")), fg(palette.muted)("  "),
      ...(style ? [fg(style.color)(`${style.glyph} `), fg(palette.body)(message)] : hints)]);
    const leftWidth = statusLeft.content instanceof StyledText ? statusLeft.content.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) : 0;
    const zoomWidth = 17 + pkg.version.length;
    statusRight.content = leftWidth + rightWidth + 2 <= renderer.width ? rightContent
      : leftWidth + zoomWidth + 2 <= renderer.width ? new StyledText([fg(palette.muted)(`zoom ${Math.round(16 / scale * 100)}%`), fg(palette.border)(" │ "), fg(palette.muted)(`pathlight ${pkg.version}`)])
      : new StyledText([]);
    crumbHint.content = new StyledText(ticker && !(recentCall && room < 70) ? ticker : []);
    dirty = true; renderer.requestRender();
  };
  const fit = () => {
    centerX = diagram.bounds.x + diagram.bounds.width / 2; centerY = diagram.bounds.y + diagram.bounds.height / 2;
    scale = Math.max(diagram.bounds.width / Math.max(1, viewport.width - 4), diagram.bounds.height * cellAspect() / Math.max(1, viewport.height - 2));
  };
  const animateTo = () => {
    targetX = centerX; targetY = centerY; targetScale = scale;
    animating = true;
  };
  const visit = (): Visit => ({ view: String(diagram.id), selected: selected ? String(selected.id) : undefined, x: centerX, y: centerY, scale });
  const restore = (saved: Visit) => {
    autoFit = false;
    selected = diagram.nodes.find(node => node.id === saved.selected) ?? diagram.nodes[0];
    centerX = targetX = saved.x; centerY = targetY = saved.y; scale = targetScale = saved.scale;
    animating = false;
  };
  const reveal = (target = selected) => {
    if (!target) return;
    if (!animating) targetScale = scale;
    targetX = target.children.length ? target.x + viewport.width * targetScale / 2 - targetScale * 2 : target.x + target.width / 2;
    targetY = target.children.length ? target.y + viewport.height * targetScale / cellAspect() / 2 - targetScale / cellAspect() : target.y + target.height / 2;
    animating = true;
  };
  // Opt-in only (key `a`): select the node of the newest call, running or finished (reads end in milliseconds), and glide to it.
  // Only calls after follow was turned on (or resumed) count, so it shows work as it happens and never replays history. A component that is not in this view
  // falls back to the nearest ancestor that is. The user's own selection or camera movement pauses it.
  const followActivity = () => {
    const latest = events[0];
    if (!followCamera || followPaused || !latest || latest.call === focusedCall || latest.time < followSince) return;
    const elements = new Set(rules.filter(rule => latest.paths.some(path => rule.match.match(path))).map(rule => rule.element));
    const inView = (element: string): typeof selected => {
      for (let id = element; id; id = id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "") {
        const node = nodeForElement(id);
        if (node) return node;
      }
      return undefined;
    };
    const target = [...elements].map(inView).filter((node): node is NonNullable<typeof selected> => Boolean(node)).sort((a, b) => a.children.length - b.children.length)[0];
    focusedCall = latest.call;
    if (!target) return;
    followSelecting = true;
    try { message = ""; selectNode(target, true); } finally { followSelecting = false; }
  };
  type Direction = "left" | "right" | "up" | "down";
  const ensureVisible = (node: NonNullable<typeof selected>) => {
    if (!animating) { targetX = centerX; targetY = centerY; targetScale = scale; }
    const halfWidth = viewport.width * targetScale / 2 * 0.9, halfHeight = viewport.height * targetScale / cellAspect() / 2 * 0.9;
    const inside = node.x >= targetX - halfWidth && node.x + node.width <= targetX + halfWidth
      && node.y >= targetY - halfHeight && node.y + node.height <= targetY + halfHeight;
    if (!inside) reveal(node);
  };
  // Nearest node in a direction, by the centres of their boxes; siblings win ties. Ancestors and descendants are
  // reached with Backspace/Enter, so they are not neighbours.
  const traverse = (direction: Direction) => {
    if (!selected) return;
    const current = selected;
    const lineage = new Set<string>([String(current.id)]);
    for (let parent = diagram.nodes.find(node => node.id === current.parent); parent; parent = diagram.nodes.find(node => node.id === parent?.parent)) lineage.add(String(parent.id));
    const descend = (id: string) => { for (const child of diagram.nodes.find(node => String(node.id) === id)?.children ?? []) { lineage.add(String(child)); descend(String(child)); } };
    descend(String(current.id));
    const cx = current.x + current.width / 2, cy = current.y + current.height / 2;
    const scored = diagram.nodes.filter(node => !lineage.has(String(node.id))).flatMap(node => {
      const dx = node.x + node.width / 2 - cx, dy = node.y + node.height / 2 - cy;
      const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
      const across = Math.abs(direction === "left" || direction === "right" ? dy : dx);
      if (along <= 1) return [];
      return [{ node, cone: across <= along * 1.5, score: (along + across * 2) * (node.parent === current.parent ? 0.6 : 1) }];
    });
    const pool = scored.some(entry => entry.cone) ? scored.filter(entry => entry.cone) : scored;
    const best = pool.sort((a, b) => a.score - b.score)[0]?.node;
    if (!best) { message = `Nothing ${direction === "up" ? "above" : direction === "down" ? "below" : `to the ${direction} of`} ${current.title}`; update(); return; }
    message = "";
    selectNode(best, false);
    ensureVisible(best);
  };
  const selectNode = (node: typeof selected, show: boolean) => {
    if (!node) return;
    pauseFollow();
    selected = node; fileCursor = 0; cursor.connections = 0; resetInspectorScroll();
    if (show) reveal();
    update();
  };
  // The node for the newest observed call that maps to something in this view.
  const nodeForElement = (element: string) => diagram.nodes.filter(node => String(node.modelRef) === element).sort((a, b) => a.children.length - b.children.length)[0];
  const newestWorkNode = () => {
    for (const event of events) {
      for (const rule of rules) {
        if (!event.paths.some(path => rule.match.match(path))) continue;
        const node = nodeForElement(rule.element);
        if (node) return node;
      }
    }
    return undefined;
  };
  activityText.onMouseDown = event => {
    event.preventDefault(); event.stopPropagation();
    if (fileMode || help.visible || summary.visible || search || pendingVisit) return;
    const element = activityTargets[event.y - activityText.y];
    if (!element) return;
    const node = nodeForElement(element);
    if (node) { message = ""; selectNode(node, true); } else { message = `${elementTitle(element)} is not in this view`; update(); }
  };
  const openLink = () => {
    if (!selected?.navigateTo) { message = "No linked view"; update(); return; }
    if (selected.navigateTo === diagram.id) return;
    try {
      const next = getDiagram(String(selected.navigateTo));
      history.push(visit()); if (history.length > 32) history.shift();
      animating = false; pendingVisit = { diagram: next };
    } catch (error) { message = error instanceof Error ? error.message : String(error); update(); }
  };
  // Go to view: every view in this project, picked by the user. It does not infer links between views.
  let gotoIndex = 0;
  const viewEntries = () => [...diagrams].filter(([, entry]) => entry.nodes.length);
  const renderGoto = () => {
    const entries = viewEntries();
    const chunks: TextChunk[] = [];
    entries.forEach(([id, entry], index) => {
      const current = id === String(diagram.id), cursor = index === gotoIndex;
      chunks.push(bg(cursor ? palette.pick : palette.panel)(fg(palette.muted)(` ${index < 9 ? index + 1 : "·"} `)),
        bg(cursor ? palette.pick : palette.panel)(fg(palette.text)(` ${String(entry.title ?? id).padEnd(30).slice(0, 30)}`)),
        bg(cursor ? palette.pick : palette.panel)(fg(palette.muted)(` ${id.padEnd(16).slice(0, 16)} ${entry.nodes.length} nodes `)),
        fg(current ? palette.incoming : palette.panel)(current ? "  ● here" : ""), nl);
    });
    goto.content.content = new StyledText(chunks);
    goto.foot.content = new StyledText(borderHints([["1-9", "jump"], ["↑↓", "choose"], ["enter", "go"], ["esc", "close"]]));
    goto.place(Math.min(80, renderer.width - 4), entries.length + 4);
  };
  const beginGoto = () => {
    const entries = viewEntries();
    gotoIndex = Math.max(0, entries.findIndex(([id]) => id === String(diagram.id)));
    goto.open(Math.min(80, renderer.width - 4), entries.length + 4); renderGoto(); update();
  };
  const goToView = (id: string) => {
    goto.close();
    if (id === String(diagram.id)) { update(); return; }
    try {
      const next = getDiagram(id);
      history.push(visit()); if (history.length > 32) history.shift();
      animating = false; pendingVisit = { diagram: next };
    } catch (error) { message = error instanceof Error ? error.message : String(error); update(); }
  };
  const finishSearch = (cancel: boolean) => {
    if (!search) return;
    if (cancel) restore(search.before);
    search = undefined; searchInput.blur(); searchRow.visible = false; heading.visible = true;
    message = ""; update();
  };
  // Ask about a node: type a question, with the component's context, into the agent's own tmux pane.
  let asking: typeof selected;
  const askContext = (target: NonNullable<typeof selected>) => {
    const title = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const links = [...diagram.edges.filter(edge => edge.source === target.id).map(edge => `→ ${title(edge.target)}`),
      ...diagram.edges.filter(edge => edge.target === target.id).map(edge => `← ${title(edge.source)}`)];
    const activity = [...new Set((byElement.get(String(target.modelRef ?? "")) ?? []).flatMap(event => event.paths.map(path => `${event.operation} ${path}`)))];
    return { files: files.get(String(target.modelRef ?? "")) ?? [], links, activity };
  };
  // What to send with the question: files, connections, activity. Tab moves between the question and these toggles.
  const askInclude = [true, true, false];
  let askFocus = -1, askSpans: { from: number; to: number }[] = [];
  const renderAsk = () => {
    if (!asking) return;
    const context = askContext(asking), counts = [context.files.length, context.links.length, context.activity.length], names = ["files", "connections", "activity"];
    const chunks: TextChunk[] = [fg(palette.muted)("about".padEnd(8)), fg(palette.text)(asking.title), fg(palette.purple)(`  ${asking.id}`), nl, fg(palette.muted)("include".padEnd(8))];
    let column = 8;
    askSpans = [];
    names.forEach((name, index) => {
      const on = askInclude[index], focused = askFocus === index;
      const paint = (chunk: TextChunk) => focused ? { ...chunk, bg: hot } : chunk;
      const text = `${on ? "●" : "○"} ${name} ${counts[index]}`;
      if (index) { chunks.push(fg(palette.muted)("   ")); column += 3; }
      chunks.push(paint(fg(on ? palette.accent : palette.border)(on ? "● " : "○ ")), paint(fg(on ? palette.body : palette.border)(`${name} `)), paint(fg(palette.border)(String(counts[index]))));
      askSpans.push({ from: column, to: column + text.length });
      column += text.length;
    });
    ask.content.content = new StyledText(chunks);
    askPrompt.fg = askFocus < 0 ? palette.accent : palette.border;
    ask.foot.content = new StyledText(borderHints(askFocus < 0 ? [["enter", "send"], ["alt+enter", "new line"], ["tab", "context"], ["esc", "cancel"]]
      : [["← →", "choose"], ["space", "toggle"], ["tab", "back to question"], ["esc", "cancel"]]));
    ask.meta.content = new StyledText([fg(binding ? palette.incoming : palette.muted)(" ● "), fg(palette.border)(`${liveLabel()} `)]);
    renderer.requestRender();
  };
  const focusAsk = (index: number) => { askFocus = index; if (index < 0) askInput.focus(); else askInput.blur(); renderAsk(); };
  ask.content.onMouseDown = event => {
    const column = event.x - ask.content.x;
    if (event.y - ask.content.y !== 1) return;
    const index = askSpans.findIndex(span => column >= span.from && column < span.to);
    if (index >= 0) { askInclude[index] = !askInclude[index]; focusAsk(index); }
  };
  const beginAsk = () => {
    if (!options.parent) { message = "Ask needs the viewer opened with pathlight show, which knows your agent's pane"; update(); return; }
    if (!selected) return;
    asking = selected; animating = false;
    askInput.setText(""); askInput.height = 1; askRow.height = 3;
    ask.open(Math.min(76, renderer.width - 4), 10);
    focusAsk(-1); message = ""; update();
  };
  ask.dismiss = () => finishAsk();
  help.dismiss = () => help.close();
  summary.dismiss = () => { summary.close(); update(); };
  goto.dismiss = () => { goto.close(); update(); };
  function finishAsk() { asking = undefined; askInput.blur(); ask.close(); update(); }
  // The question and the chosen context go to the agent's pane and are submitted there; an empty question sends nothing.
  const sendAsk = () => {
    const target = asking, parent = options.parent, question = askInput.plainText.trim();
    if (!target || !parent || !question) return;
    const context = askContext(target);
    const text = askMessage({ title: target.title, id: String(target.id), files: askInclude[0] ? context.files : [], links: askInclude[1] ? context.links : [], activity: askInclude[2] ? context.activity : [] }, question);
    const about = target.title, session = binding ? liveLabel() : "the agent";
    finishAsk();
    runTask(sendToPane(parent, text, true).pipe(
      Effect.tap(() => Effect.sync(() => { message = `Asked ${session} about ${about} · reply lands in the agent pane`; update(); })),
      Effect.catch(error => Effect.sync(() => { message = error.message; update(); }))));
  };
  let scrollToSection: SectionKey | undefined;
  const touched = new Set<SectionKey>();
  // A number focuses a section (and opens it); pressing it again hands the keys back to the diagram.
  const focusOn = (key: SectionKey) => {
    const entry = sections[key];
    if (focusSection === key) { focusSection = undefined; update(); return; }
    if (!inspector.visible) inspectorPreference = "open";
    entry.open = true; touched.add(key); focusSection = key; scrollToSection = key; update();
  };
  const foldSection = (key: SectionKey) => { sections[key].open = !sections[key].open; touched.add(key); update(); };
  for (const key of sectionOrder) sections[key].header.onMouseDown = event => {
    event.preventDefault(); event.stopPropagation();
    if (fileMode || search || asking) return;
    // The first click focuses the section; clicking the focused one folds it.
    if (focusSection === key) foldSection(key); else { focusSection = key; touched.add(key); scrollToSection = key; }
    update();
  };
  let clickedFile = -1;
  const endFiles = () => { clickedFile = -1; fileMode = false; focusSection = undefined; searchInput.blur(); searchRow.visible = false; heading.visible = true; };
  const openFile = (path: string) => {
    editorActive = true;
    searchInput.blur();
    runTask(Effect.gen(function* () {
      yield* io("Native.finishDrawing", async () => { await drawing; });
      yield* Effect.acquireRelease(io("Native.suspend", () => renderer.suspend()),
        () => io("Native.resume", async () => { await renderer.resume(); editorActive = false; searchInput.focus(); update(); }).pipe(Effect.orDie));
      yield* openEditor({ workspace: view.workspace, path }).pipe(
        Effect.tap(() => Effect.sync(() => { message = `Returned from editor: ${path}`; })),
        Effect.catch(error => Effect.sync(() => { message = error.message; })));
    }).pipe(Effect.scoped, Effect.catch(error => Effect.sync(() => { editorActive = false; message = error.message; searchInput.focus(); update(); }))));
  };
  const beginFiles = () => {
    fileMode = true; fileCursor = 0; fileQuery = ""; sections.files.open = true; touched.add("files"); focusSection = "files"; scrollToSection = "files"; inspectorPreference = "open"; message = fileError;
    searchInput.placeholder = "Filter mapped files"; searchInput.value = ""; searchPrompt.content = " files › "; searchPrompt.fg = palette.outgoing;
    searchRow.visible = true; heading.visible = false; searchInput.focus();
  };
  searchInput.on("input", (value: string) => {
    if (fileMode) { fileQuery = value; fileCursor = 0; message = ""; update(); return; }
    if (!search) return;
    const query = value.trim().toLowerCase();
    search.matches = query ? diagram.nodes.filter(node => node.title.toLowerCase().includes(query) || String(node.id).toLowerCase().includes(query)) : [];
    search.index = 0;
    message = query && !search.matches.length ? "No matches in this view" : "";
    const match = search.matches[0];
    if (match) selectNode(match, true);
    else { restore(search.before); update(); }
  });
  nodeListText.onMouseDown = event => {
    if (help.visible || summary.visible || goto.visible || search || asking || pendingVisit) return;
    const node = diagram.nodes[event.y - nodeListText.y];
    if (node) selectNode(node, false);
  };
  viewport.onMouseDown = event => {
    if (editorActive || help.visible || summary.visible || goto.visible || search || asking || pendingVisit) return;
    focusSection = undefined;
    if (fileMode) { endFiles(); message = ""; }
    // Hit the displayed cell bounds, not the fractional world-space plane:
    // rounding can put a group's visible title just outside that plane.
    const entry = nodeObjects.filter(({ box }) => box.visible && event.x >= box.x && event.x < box.x + box.width
      && event.y >= box.y && event.y < box.y + box.height).sort((a, b) => b.node.level - a.node.level)[0];
    if (entry) selectNode(entry.node, false);
  };
  renderer.keyInput.on("keypress", key => {
    if (editorActive) return;
    if (key.ctrl && key.name === "c") { key.preventDefault(); stop(); return; }
    if (pendingVisit) { key.preventDefault(); return; }
    if (search) {
      if (key.name === "escape") { key.preventDefault(); finishSearch(true); }
      else if (key.name === "return") { key.preventDefault(); if (search.matches.length) finishSearch(false); }
      else if (["up", "down", "tab"].includes(key.name)) {
        key.preventDefault();
        if (search.matches.length) {
          const step = key.name === "up" || key.name === "tab" && key.shift ? -1 : 1;
          search.index = (search.index + step + search.matches.length) % search.matches.length;
          selectNode(search.matches[search.index], true);
        }
      }
      return;
    }
    if (asking) {
      if (key.name === "escape") { key.preventDefault(); finishAsk(); }
      else if (key.name === "tab") { key.preventDefault(); focusAsk(askFocus < 0 ? 0 : -1); }
      else if (askFocus >= 0) {
        key.preventDefault();
        if (key.name === "left" || key.name === "h") focusAsk((askFocus + 2) % 3);
        else if (key.name === "right" || key.name === "l") focusAsk((askFocus + 1) % 3);
        else if (key.name === "space" || key.sequence === " ") { askInclude[askFocus] = !askInclude[askFocus]; renderAsk(); }
      }
      else if (key.name === "return" && !key.meta && !key.option && !key.shift) { key.preventDefault(); sendAsk(); }
      return;
    }
    if (goto.visible) {
      key.preventDefault();
      const entries = viewEntries();
      if (key.name === "escape" || key.name === "g") { goto.close(); update(); }
      else if (key.name === "return") { const entry = entries[gotoIndex]; if (entry) goToView(entry[0]); }
      else if (key.name === "up" || key.name === "k") { gotoIndex = (gotoIndex - 1 + entries.length) % entries.length; renderGoto(); }
      else if (key.name === "down" || key.name === "j") { gotoIndex = (gotoIndex + 1) % entries.length; renderGoto(); }
      else if (/^[1-9]$/.test(key.sequence)) { const entry = entries[Number(key.sequence) - 1]; if (entry) goToView(entry[0]); }
      return;
    }
    if (summary.visible) {
      key.preventDefault();
      if (key.name === "escape" || key.name === "c" || key.sequence === "?") { summary.close(); update(); }
      return;
    }
    if (help.visible) { key.preventDefault(); if (key.name === "escape" || key.sequence === "?") help.close();
      else if (key.name === "v" && !key.ctrl) { vimTraverses = !vimTraverses; showHelp(); }
      else if (key.ctrl && key.name === "c") stop(); return; }
    if (!fileMode && !key.ctrl && !key.meta && /^[1-4]$/.test(key.sequence)) { key.preventDefault(); focusOn(sectionOrder[Number(key.sequence) - 1] ?? "overview"); return; }
    if (focusSection && !fileMode) {
      const entry = sections[focusSection], key_ = focusSection;
      const items = key_ === "connections" ? connectionItems.length : key_ === "files" ? selectedPaths().length : key_ === "activity" ? activityItems.length : 0;
      const move = (step: number) => {
        if (key_ === "overview") { sections.overview.content.scrollBy(step * 2); return; }
        if (!items) return;
        if (key_ === "files") fileCursor = (fileCursor + step + items) % items; else cursor[key_] = (cursor[key_] + step + items) % items;
        scrollToSection = undefined; update();
      };
      if (key.name === "escape") { key.preventDefault(); focusSection = undefined; update(); return; }
      if (key.name === "tab") {
        key.preventDefault();
        focusSection = sectionOrder[(sectionOrder.indexOf(key_) + (key.shift ? -1 : 1) + sectionOrder.length) % sectionOrder.length];
        if (focusSection) { sections[focusSection].open = true; scrollToSection = focusSection; }
        update(); return;
      }
      if (key.name === "space" || key.sequence === " ") { key.preventDefault(); entry.open = !entry.open; touched.add(key_); update(); return; }
      if (key.name === "up" || key.name === "k") { key.preventDefault(); move(-1); return; }
      if (key.name === "down" || key.name === "j") { key.preventDefault(); move(1); return; }
      if (["left", "right", "h", "l"].includes(key.name) && !key.shift) { key.preventDefault(); return; }
      if (key.name === "return") {
        key.preventDefault();
        if (key_ === "connections") {
          const target = diagram.nodes.find(node => String(node.id) === connectionItems[cursor.connections]);
          if (target) { message = ""; selectNode(target, true); }
        } else if (key_ === "files") {
          const path = selectedPaths()[fileCursor];
          if (path) openFile(path);
        } else if (key_ === "activity") {
          const element = activityItems[cursor.activity]?.element;
          const node = element ? nodeForElement(element) : undefined;
          if (node) { message = ""; selectNode(node, true); } else if (element) { message = `${elementTitle(element)} is not in this view`; update(); }
        }
        return;
      }
    }
    if (!fileMode && key.sequence === "/") {
      key.preventDefault(); animating = false;
      search = { before: visit(), matches: [], index: 0 };
      searchInput.placeholder = "Search nodes in this view"; searchPrompt.content = " / "; searchPrompt.fg = palette.incoming;
      heading.visible = false; searchRow.visible = true; searchInput.value = ""; searchInput.focus(); update(); return;
    }
    if (!fileMode && key.name === "b") {
      key.preventDefault();
      const saved = history.at(-1);
      if (saved) { const next = getDiagram(saved.view); history.pop(); pendingVisit = { diagram: next, restore: saved }; animating = false; }
      else { message = "No previous view"; update(); }
      return;
    }
    if (!fileMode && (key.name === "o" || key.name === "return")) {
      key.preventDefault();
      if (key.name === "return" && selected?.children.length) selectNode(diagram.nodes.find(node => node.id === selected?.children[0]), true);
      else openLink();
      return;
    }
    if (!fileMode && key.name === "backspace") { key.preventDefault(); selectNode(diagram.nodes.find(node => node.id === selected?.parent), true); return; }
    const direction = ({ h: "left", j: "down", k: "up", l: "right", left: "left", down: "down", up: "up", right: "right" } as const)[key.name as "h"];
    const vimKey = key.name.length === 1;
    if (!fileMode && key.name === "g" && !key.ctrl && !key.shift) { key.preventDefault(); beginGoto(); return; }
    if (!fileMode && key.name === "t" && !key.ctrl) { key.preventDefault(); beginAsk(); return; }
    if (!fileMode && key.name === "c" && !key.ctrl) {
      key.preventDefault(); summary.foot.content = new StyledText(borderHints([["esc", "close"]])); summary.open(60, 12); summary.content.content = summaryContent(); update(); return;
    }
    if (!fileMode && key.name === "w" && !key.ctrl) {
      key.preventDefault();
      const target = newestWorkNode();
      if (target) { message = ""; followSelecting = true; try { selectNode(target, true); } finally { followSelecting = false; } } else { message = binding || following ? "No recent activity maps to a node in this view" : "Camera jump needs a bound session"; update(); }
      return;
    }
    if (!fileMode && key.name === "v" && !key.ctrl) {
      key.preventDefault(); vimTraverses = !vimTraverses;
      message = vimTraverses ? "hjkl select nodes, arrows pan" : "Arrows select nodes, hjkl pan"; update(); return;
    }
    if (!fileMode && listMode && ["up", "down", "j", "k"].includes(key.name)) {
      key.preventDefault();
      const index = diagram.nodes.findIndex(node => node.id === selected?.id), count = diagram.nodes.length;
      selectNode(diagram.nodes[(index + (key.name === "up" || key.name === "k" ? -1 : 1) + count) % count], false);
      return;
    }
    if (!fileMode && direction && vimKey === vimTraverses && !key.shift) { key.preventDefault(); traverse(direction); return; }
    const before = { x: centerX, y: centerY, scale };
    if (animating) { centerX = targetX; centerY = targetY; scale = targetScale; }
    if (!fileMode) key.preventDefault();
    if (key.ctrl && key.name === "c" || !fileMode && key.name === "q") { stop(); return; }
    if (fileMode) {
      const paths = selectedPaths();
      if (key.name === "escape") { key.preventDefault(); endFiles(); }
      else if (["up", "down", "tab", "pageup", "pagedown"].includes(key.name)) {
        key.preventDefault();
        const direction = key.name === "up" || key.name === "pageup" || key.name === "tab" && key.shift ? -1 : 1;
        const step = key.name === "pageup" || key.name === "pagedown" ? Math.max(1, sections.files.content.viewport.height - 1) : 1;
        if (paths.length) fileCursor = (fileCursor + direction * step % paths.length + paths.length) % paths.length;
        clickedFile = -1;
      } else if (key.ctrl && key.name === "r") {
        key.preventDefault();
        if (!refreshing) {
          refreshing = true; message = "Refreshing files...";
          runTask(nodeFiles(view.workspace, config).pipe(Effect.tap(next => Effect.sync(() => {
            files = next; fileError = ""; fileCursor = 0; message = "Files refreshed"; update();
          })), Effect.catch(error => Effect.sync(() => { message = error.message; update(); })),
          Effect.ensuring(Effect.sync(() => { refreshing = false; }))));
        }
      }
      else if (key.name === "return") {
        key.preventDefault();
        const path = paths[fileCursor];
        if (path) openFile(path);
      }
    } else if (key.sequence === "?") showHelp();
    else if (key.name === "i") { inspectorPreference = inspector.visible ? "closed" : "open"; }
    else if (key.name === "pageup" || key.name === "pagedown") {
      // The focused card scrolls; with none focused, the first open card that overflows does.
      const card = focusSection ? sections[focusSection].content : sectionOrder.map(name => sections[name].content).find(box => box.visible && box.scrollHeight > box.viewport.height);
      (card ?? inspectorScroll).scrollBy(key.name === "pageup" ? -5 : 5);
    }
    else if (key.name === "a") {
      if (followCamera && followPaused) { followPaused = false; message = "Following the work (a to stop)"; }
      else { followCamera = !followCamera; followPaused = false; message = followCamera ? (binding || following ? "Following the work (a to stop)" : "Follow needs a bound session") : "Follow off"; }
      focusedCall = ""; followSince = Date.now();
      if (followCamera) followActivity();
    }
    else if (key.name === "e") beginFiles();
    else if (key.name === "tab") {
      const index = diagram.nodes.findIndex(node => node.id === selected?.id);
      pauseFollow();
      selected = diagram.nodes[(index + (key.shift ? -1 : 1) + diagram.nodes.length) % diagram.nodes.length];
      fileCursor = 0; resetInspectorScroll();
    } else if (key.name === "+" || key.name === "=" || key.sequence === "+") { autoFit = false; pauseFollow(); scale = Math.max(2, scale / 1.25); }
    else if (key.name === "-" || key.sequence === "-") { autoFit = false; pauseFollow(); scale = Math.min(128, scale * 1.25); }
    else if (direction === "left") { autoFit = false; pauseFollow(); centerX -= scale * 6; }
    else if (direction === "right") { autoFit = false; pauseFollow(); centerX += scale * 6; }
    else if (direction === "down") { autoFit = false; pauseFollow(); centerY += scale * 3 / cellAspect(); }
    else if (direction === "up") { autoFit = false; pauseFollow(); centerY -= scale * 3 / cellAspect(); }
    else if (key.name === "f") { autoFit = true; fit(); }
    else if (key.name === "0") { autoFit = false; pauseFollow(); scale = 16; }
    else if (key.name === "r" && selected) { autoFit = false; centerX = selected.x + selected.width / 2; centerY = selected.y + selected.height / 2; }
    if (centerX !== before.x || centerY !== before.y || scale !== before.scale) {
      animateTo(); centerX = before.x; centerY = before.y; scale = before.scale;
    }
    update();
  });
  let lastInspectorKey = "";
  renderer.on("frame", () => {
    if (!initialFit && painted && revealProgress() >= 1) displayed.resolve();
    if (scrollToSection) { const target = scrollToSection; scrollToSection = undefined; inspectorScroll.scrollChildIntoView(`section-${target}`); }
    const inspectorKey = `${inspectorScroll.viewport.height}/${inspector.width}`;
    if (inspectorKey !== lastInspectorKey) { lastInspectorKey = inspectorKey; update(); }
  });
  renderer.setFrameCallback(async deltaMs => {
    if (editorActive || closing) return;
    try {
    if (pendingReload) {
      const next = pendingReload; pendingReload = undefined;
      const target = next.diagrams.get(String(diagram.id));
      if (!target?.nodes.length) { message = `View '${diagram.id}' is gone or empty in the new model; showing the previous version`; }
      else {
        const before = new Set(diagram.nodes.map(node => String(node.id)));
        const keep = selected ? String(selected.id) : undefined;
        for (const entry of nodeObjects) { viewport.remove(entry.box); entry.box.destroyRecursively(); }
        diagrams = next.diagrams; config = next.config; files = next.files; fileError = next.fileError;
        rules = config?.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) })) ?? [];
        diagram = target;
        nodeObjects = mountNodes(); routes = computeRoutes();
        selected = diagram.nodes.find(node => String(node.id) === keep) ?? diagram.nodes[0];
        fileCursor = Math.min(fileCursor, Math.max(0, selectedPaths().length - 1));
        indexEvents();
        const added = diagram.nodes.filter(node => !before.has(String(node.id))).map(node => node.title);
        const removed = [...before].filter(id => !diagram.nodes.some(node => String(node.id) === id));
        message = next.notice || (added.length || removed.length ? `Model reloaded: ${[...added.map(title => `+ ${title}`), ...removed.map(id => `− ${id.split(".").at(-1)}`)].slice(0, 4).join("  ")}` : "Model reloaded");
        const shown = message;
        setTimeout(() => { if (message === shown && !closing) { message = ""; update(); } }, 6000);
      }
      update();
    }
    if (pendingVisit) {
      const next = pendingVisit; pendingVisit = undefined;
      for (const entry of nodeObjects) { viewport.remove(entry.box); entry.box.destroyRecursively(); }
      diagram = next.diagram;
      nodeObjects = mountNodes(); routes = computeRoutes();
      selected = diagram.nodes[0]; fileCursor = 0; resetInspectorScroll(); message = "";
      initialFit = false; animating = false;
      if (next.restore) restore(next.restore);
      else { autoFit = true; fit(); targetX = centerX; targetY = centerY; targetScale = scale; }
      update();
    }
    layout();
    if (redrawAfterResize) { dirty = true; redrawAfterResize = false; }
    if (previousWidth !== viewport.width || previousHeight !== viewport.height) {
      stableLayoutFrames = 0;
      previousWidth = viewport.width; previousHeight = viewport.height;
      canvas.width = Math.max(1, viewport.width); canvas.height = Math.max(1, viewport.height);
      redrawAfterResize = true;
      if (autoFit && !initialFit) { const before = { x: centerX, y: centerY, scale }; fit(); animateTo(); centerX = before.x; centerY = before.y; scale = before.scale; }
      update();
    } else if (initialFit && viewport.width > 1 && viewport.height > 1 && ++stableLayoutFrames >= 2) {
      initialFit = false; revealStart = Date.now();
      fit(); targetX = centerX; targetY = centerY; targetScale = scale;
      update();
    }
    if (animating) {
      const fraction = 1 - Math.exp(-Math.min(deltaMs, 100) / 65);
      centerX += (targetX - centerX) * fraction; centerY += (targetY - centerY) * fraction; scale += (targetScale - scale) * fraction;
      if (Math.abs(targetX - centerX) + Math.abs(targetY - centerY) + Math.abs(targetScale - scale) < 0.02) {
        centerX = targetX; centerY = targetY; scale = targetScale; animating = false;
      }
      update();
    }
    if (revealProgress() < 1 || revealStart !== undefined) { update(); if (revealProgress() >= 1) revealStart = undefined; }
    if (!dirty) return;
    dirty = false;
    canvas.frameBuffer.clear(RGBA.fromHex(palette.background));
    paintGrid();
    drawing = (async () => {
      const bg = RGBA.fromHex(palette.background);
      const drawn = easeOut(revealProgress()) * 1.05;
      const isCovered = (x: number, y: number) => nodeObjects.some(({ node, rect }) => {
        const left = rect.x, top = rect.y, right = rect.x + rect.width - 1, bottom = rect.y + rect.height - 1;
        return x >= left && x <= right && y >= top && y <= bottom && (!node.children.length || x === left || x === right || y === top || y === bottom);
      });
      for (const cell of rasterize(routes, point => projected(point.x, point.y), isCovered, selected ? String(selected.id) : undefined)) {
        if (cell.t > drawn || cell.x < 0 || cell.y < 0 || cell.x >= viewport.width || cell.y >= viewport.height) continue;
        const fg = cell.tone === "out" ? palette.outgoing : cell.tone === "in" ? palette.incoming : palette.edgeDim;
        canvas.frameBuffer.setCell(cell.x, cell.y, cell.glyph, RGBA.fromHex(fg), bg);
      }
    })();
    await drawing;
    painted = true;
    canvas.requestRender();
    } catch (error) { renderError = error; stop(); }
  });
  // Live reload: the model, its layout and the activity mapping are re-read when their files change, keeping camera and selection.
  const reloadWorld = Effect.gen(function* () {
    const raw = yield* readActivityConfig(view.workspace).pipe(
      Effect.catchIf(error => !binding && !following && hasCode(error, "ENOENT"), () => Effect.succeed(undefined)));
    const nextConfig = binding || following || raw?.project === view.project ? raw : undefined;
    let nextError = "";
    const nextFiles = yield* nodeFiles(view.workspace, nextConfig).pipe(Effect.catch(error => Effect.sync(() => { nextError = error.message; return new Map<string, string[]>(); })));
    const nextDiagrams = yield* Effect.gen(function* () {
      const source = yield* acquireModel(view.workspace);
      if (source.hasErrors()) return yield* Effect.fail(failure("Reload.model", "The model has errors; showing the last good version"));
      const model = yield* io("LikeC4.layout", () => source.layoutedModel(view.project));
      return new Map([...model.views()].map(entry => [String(entry.id), entry.$view]));
    }).pipe(Effect.scoped);
    if (nextConfig) yield* validateActivityMapping(view, nextConfig);
    pendingReload = { diagrams: nextDiagrams, config: nextConfig, files: nextFiles, fileError: nextError, notice: "" };
    renderer.requestRender();
  });
  let reloading = false, again = false, reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const triggerReload = () => {
    if (closing) return;
    if (reloading) { again = true; return; }
    reloading = true;
    runTask(reloadWorld.pipe(
      Effect.catch(error => Effect.sync(() => { message = error.message; if (!editorActive) update(); })),
      Effect.ensuring(Effect.sync(() => { reloading = false; if (again) { again = false; scheduleReload(); } }))));
  };
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(triggerReload, 500); };
  const relevant = (name: string) => !/(^|\/)(node_modules|\.git|\.cache)(\/|$)/.test(name)
    && /\.(c4|likec4)$|(^|\/)(likec4\.config\.(json|js|ts)|\.likec4rc|pathlight\.activity\.json)$/.test(name);
  yield* Effect.acquireRelease(Effect.try({ try: () => watch(view.workspace, { recursive: true }, (_event, name) => { if (name && relevant(String(name))) scheduleReload(); }), catch: cause => failure("Native.watch", cause) }).pipe(
    Effect.catch(() => Effect.sync(() => { message = "Live reload unavailable: the model will not update until the viewer is reopened"; return undefined; }))),
    watcher => Effect.sync(() => { clearTimeout(reloadTimer); watcher?.close(); }));
  if (binding || following) yield* Effect.gen(function* () {
    if (following) binding = (yield* latestBinding(view.workspace)) ?? binding;
    events = binding ? yield* readActivity(view.workspace, binding) : [];
    const signature = `${binding?.session}/${events.map(event => `${event.call}${event.phase}`).join()}`;
    const changed = signature !== lastSignature;
    lastSignature = signature;
    indexEvents(); noteCalls(); followActivity();
    // Idle polls only refresh ages and tints every couple of seconds; a running call keeps the spinner moving.
    const flashing = anyFlash();
    if (changed || events.some(isActive) || flashing || wasFlashing || Date.now() - lastPaint > 2000) { wasFlashing = flashing; activityError = ""; lastPaint = Date.now(); if (!editorActive) update(); }
  }).pipe(Effect.catch(() => Effect.sync(() => { if (!activityError) message = "Activity unavailable: the journal could not be read"; activityError = "Activity unavailable"; if (!editorActive) update(); })),
    Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped);
  renderer.start(); update();
  const ready = yield* io("Native.firstFrame", () => Promise.race([displayed.promise.then(() => true), stopped.promise.then(() => false), renderer.closed.then(() => false)]));
  if (ready && options.ready) yield* writeReady(options.ready, { ready: true });
  if (ready) yield* io("Native.wait", () => Promise.race([stopped.promise, renderer.closed]));
  if (renderError !== undefined) return yield* Effect.fail(failure("Native.render", renderError));
}, Effect.scoped);
