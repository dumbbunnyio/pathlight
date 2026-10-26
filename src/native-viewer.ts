import { type Renderable, BoxRenderable, FrameBufferRenderable, InputRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable, StyledText, type TextChunk, fg, bg, RGBA, createCliRenderer } from "@opentui/core";
import { THREE } from "@opentui/three";
import { SplitPaneRenderable } from "opentui-split";
import { Effect, FiberSet, Schedule } from "effect";
import { watch } from "node:fs";
import { type View, acquireModel, validateActivityMapping } from "./catalog";
import { type ActivityBinding, type ActivityEvent, activityRows, formatAge, latestBinding, readActivity, readActivityConfig, readReplay, type Replay } from "./activity";
import { type Diff, readDiff } from "./diff";
import { type Plan, readPlan } from "./plan";
import { readStale, type Stale, staleText } from "./stale";
import { nodeFiles } from "./node-files";
import { openEditor } from "./editor";
import { askMessage, flowMessage, mapMessage, sendToPane } from "./ask";
import { readEntry, readKeys, saveElement } from "./edit";
import pkg from "../package.json" with { type: "json" };
import { type Hint, borderHints, hintChunks, noticeStyle, palette, pill, setPalette } from "./ui";
import { type Mode, loadThemes, modeOf, paletteOf, saveTheme, savedTheme, systemTheme, themeFromEnvironment } from "./theme";
import { retheme } from "./retheme";
import { type Candidate, search as rankSearch } from "./search";
import { rasterize, routeEdges, type Route } from "./routes";
import { checkFlows } from "./flows";
import { badgeText as stepBadge, badgesOf, flowMaps, flowsInView, flowsThrough, pathEdges, type FlowMap } from "./flow-view";
import { attempt, failure, hasCode, io } from "./effects";
import { writeReady } from "./ready";

export const viewNative = Effect.fn("Native.view")(function* (options: { view: View; activity?: ActivityBinding; follow?: boolean; parent?: string; ready?: string; select?: string }) {
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
// The theme is chosen before anything is drawn: PATHLIGHT_THEME, then the saved choice, then the built-in look. A theme that does not resolve falls back to it.
const themes = yield* loadThemes(view.workspace);
const environment = yield* themeFromEnvironment();
const themeOrder = (a: string, b: string) => a === "pathlight" ? -1 : b === "pathlight" ? 1 : a === "system" ? -1 : b === "system" ? 1 : a.localeCompare(b);
const themeNames = [...themes.keys()].sort(themeOrder);
const wantedTheme = environment.name || (yield* savedTheme().pipe(Effect.catch(() => Effect.succeed(undefined)))) || "pathlight";
let themeName = [wantedTheme, "pathlight"].find(name => themes.has(name))!;
let themeMode: Mode = environment.mode ?? "dark";
try { setPalette(paletteOf(themes.get(themeName)!, themeMode)); } catch { themeName = "pathlight"; setPalette(paletteOf(themes.get("pathlight")!, themeMode)); }
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
  const inspectorId = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  const relations = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "word" });
  const filesText = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "none" });
  const activityText = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  const stepsText = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "none" });
  const flowsText = new TextRenderable(renderer, { selectable: false, bg: palette.panel, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "none" });
  // Numbered, collapsible sections: each is a lighter block on the panel, with a bar on its left edge when focused.
  type SectionKey = "activity" | "steps" | "connections" | "flows" | "files";
  const thin = { showArrows: false, trackOptions: { foregroundColor: palette.edgeDim, backgroundColor: palette.panel } };
  const makeSection = (number: number, name: string, children: Renderable[]) => {
    const box = new BoxRenderable(renderer, { id: `section-${name.toLowerCase()}`, backgroundColor: palette.panel, width: "100%", height: 8, flexShrink: 0, flexDirection: "column", marginTop: 1 });
    const header = new TextRenderable(renderer, { selectable: false, bg: palette.panel, height: 1, flexShrink: 0, fg: palette.text, wrapMode: "none" });
    // Every card is the same height; whatever does not fit scrolls inside it, behind a hairline scrollbar.
    const content = new ScrollBoxRenderable(renderer, { ...surface, flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true, verticalScrollbarOptions: thin });
    for (const child of children) content.add(child);
    box.add(header); box.add(content);
    return { number, name, box, header, content, open: true };
  };
  const sections = {
    activity: makeSection(1, "Now", [activityText]),
    steps: makeSection(2, "Steps", [stepsText]),
    connections: makeSection(2, "Connects", [relations]),
    flows: makeSection(4, "In flows", [flowsText]),
    files: makeSection(3, "Files", [filesText]),
  };
  const sectionOrder: SectionKey[] = ["activity", "steps", "connections", "flows", "files"];
  // Before the first layout nothing is measured; start with what is hidden by default already hidden, so no frame shows Files or an empty Now.
  for (const key of ["files", "steps", "flows"] as const) { sections[key].box.visible = false; sections[key].box.height = 0; }
  if (!binding && !following) { sections.activity.box.visible = false; sections.activity.box.height = 0; }
  // Which section (if any) owns the movement keys. Undefined means the diagram does.
  let focusSection: SectionKey | undefined;
  const cursor: Record<SectionKey, number> = { connections: 0, files: 0, activity: 0, steps: 0, flows: 0 };
  let connectionItems: string[] = [];
  let fileLines: number[] = [];
  const hot = RGBA.fromHex(palette.hot), rowBackground = hot;
  const contentRows: Record<SectionKey, number> = { connections: 4, files: 4, activity: 4, steps: 4, flows: 2 };
  const highlight = (chunks: TextChunk[], from: number, to: number) => chunks.map((chunk, index) => index >= from && index < to ? { ...chunk, bg: hot } : chunk);
  for (const child of [inspectorTitle, inspectorHead, inspectorId, ...sectionOrder.map(key => sections[key].box)]) inspectorScroll.add(child);
  inspector.add(inspectorScroll);
  // Pinned under the scrolling cards: what is one key away, and the question field. Neither scrolls away.
  const inspectorActions = new TextRenderable(renderer, { selectable: false, bg: palette.panel, height: 2, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  const inspectorAsk = new TextRenderable(renderer, { selectable: false, bg: palette.panel, height: 1, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  inspector.add(inspectorActions); inspector.add(inspectorAsk);
  // One bottom row: the mode badge (the only filled block on screen), then key hints or a short-lived notice; zoom and version on the right.
  const statusLeft = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 1, flexGrow: 1, fg: palette.muted, wrapMode: "none" });
  const statusRight = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  const footer = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", paddingRight: 1 });
  footer.add(statusLeft); footer.add(statusRight);
  // A modal is one 1-column rounded frame over a dimmed backdrop. Its title, metadata and key hints are set into the border rows
  // (small panel-coloured texts laid over the border), so there is no separate header or footer.
  const makeModal = (color: string, titleChunks: TextChunk[], dim = 0.8) => {
    const modal = { dismiss: () => {}, get visible() { return panel.visible; } };
    const scrim = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 19000, visible: false,
      backgroundColor: RGBA.fromValues(0.02, 0.03, 0.04, dim), onMouse(event) { event.preventDefault(); event.stopPropagation(); if (event.type === "down") modal.dismiss(); } });
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
    return Object.assign(modal, { scrim, panel, content, title, meta, foot, place,
      open(width: number, height: number) { place(width, height); scrim.visible = panel.visible = true; },
      close() { scrim.visible = panel.visible = false; } });
  };
  const help = makeModal(palette.edgeDim, [fg(palette.accent)("◆ "), fg(palette.text)("Keyboard shortcuts")]);
  const summary = makeModal(palette.edgeDim, [fg(palette.text)("This session")]);
  const ask = makeModal(palette.accent, [fg(palette.text)("Ask the agent")]);
  const goto = makeModal(palette.edgeDim, [fg(palette.text)("Go to view")]);
  // No backdrop dimming: the diagram behind is the preview.
  const picker = makeModal(palette.edgeDim, [fg(palette.accent)("◆ "), fg(palette.text)("Theme")], 0);
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
  // The narrow-terminal view: every node as a row (indented by depth), the selection marked; it replaces the diagram.
  const listSurface = { backgroundColor: palette.background, rootOptions: { backgroundColor: palette.background }, wrapperOptions: { backgroundColor: palette.background },
    viewportOptions: { backgroundColor: palette.background }, contentOptions: { backgroundColor: palette.background } };
  const nodeList = new ScrollBoxRenderable(renderer, { ...listSurface, position: "absolute", left: 0, top: 0, width: "100%", height: "100%", visible: false, scrollX: false, scrollY: true,
    verticalScrollbarOptions: { showArrows: false, trackOptions: { foregroundColor: palette.edgeDim, backgroundColor: palette.background } } });
  const nodeListText = new TextRenderable(renderer, { selectable: false, bg: palette.background, width: "100%", flexShrink: 0, fg: palette.body, wrapMode: "none" });
  nodeList.add(nodeListText);
  viewport.add(canvas); viewport.add(nodeList); body.addPane(viewport, Math.max(1, renderer.width - 39), 36); body.addPane(inspector, 38, 28);
  resources.push({ dispose() { if (!inspector.parent) inspector.destroyRecursively(); } });
  for (const child of [topBar, body, footer, help.scrim, help.panel, summary.scrim, summary.panel, ask.scrim, ask.panel, goto.scrim, goto.panel, picker.scrim, picker.panel]) renderer.root.add(child);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  let centerX = diagram.bounds.x + diagram.bounds.width / 2;
  let centerY = diagram.bounds.y + diagram.bounds.height / 2;
  let scale = 16;
  // A view about one element (a neighbourhood) opens with that element selected; any other opens on its first node.
  // `pathlight draft` names a component's neighbourhood `<component>_near`, scoped to it when it can be, which is how the subject is found when it cannot.
  const firstNode = (scene: typeof diagram) => {
    const subject = "viewOf" in scene ? scene.viewOf : undefined;
    return scene.nodes.find(node => subject !== undefined && String(node.modelRef) === String(subject))
      ?? scene.nodes.find(node => `${String(node.modelRef).replace(/\./g, "_")}_near` === String(scene.id)) ?? scene.nodes[0];
  };
  // `--select ELEMENT` opens with that element selected, so a screen (or a bug report) can name exactly what it shows.
  const asked = options.select === undefined ? undefined : diagram.nodes.find(node => String(node.modelRef) === options.select);
  if (options.select !== undefined && !asked) return yield* Effect.fail(failure("Native.select", `The view '${view.id}' has no element '${options.select}'. Pathlight list names the views; the element ids are in the model.`));
  let selected = asked ?? firstNode(diagram);
  type Visit = { view: string; selected: string | undefined; x: number; y: number; scale: number };
  const history: Visit[] = [];
  let pendingReload: { diagrams: typeof diagrams; config: typeof config; files: typeof files; fileError: string; notice: string } | undefined;
  let pendingVisit: { diagram: ReturnType<typeof getDiagram>; restore?: Visit; select?: string; file?: string; notice?: string } | undefined;
  let dirty = true;
  let redrawAfterResize = false;
  let targetX = centerX, targetY = centerY, targetScale = scale;
  let animating = false;
  let fileMode = false, fileCursor = 0, editorActive = false;
  let fileQuery = "";
  // An element the mapping names as planned and that has no files yet (nor does anything inside it): designed, not built.
  const waiting = (ref: string) => (config?.planned ?? []).some(id => ref === id || ref.startsWith(`${id}.`))
    && !(files.get(ref)?.length) && ![...files].some(([element, paths]) => element.startsWith(`${ref}.`) && paths.length);
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
  // Calls made by subagents carry a label and are shown with it; `s` hides them to leave only the conversation's own calls.
  let showSubagents = true, allEvents: ActivityEvent[] = [];
  const visibleEvents = (list: ActivityEvent[]) => showSubagents ? list : list.filter(event => !event.agent);
  // Replay: the retained calls of the bound session, walked one step at a time. While it is on, `events` is the calls up to the current step and the live poll stands aside.
  let replay: { data: Replay; index: number; playing: boolean; speed: number; next: number } | undefined;
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
        ["o", "open the linked view"], ["g", "go to any view"], ["b", "back"], ["F", "trace a flow (F again: next, last one leaves)"], ["[ ]", "step through the flow"]] },
      { name: "Inspector", active: !!focusSection, rows: [["i", "toggle the inspector"], ["1-4", "focus a card"], ["j k", "move / scroll"], ["space", "fold card"],
        ["PgUp PgDn", "scroll the inspector"], ["e", "browse mapped files"], ["esc", "back to diagram"]] },
      { name: "Agent", active: false, rows: [["t", "ask the agent about it"], ["m", "ask it to improve the map"], ["d", "ask it to trace a flow"], ["n", "name and note it yourself"], ["w", "jump to the agent's work, and follow it"], ["c", "what this session touched"], ["a", "follow the work"], ["s", "show or hide subagent calls"], ["p", "replay the session"]] },
      { name: "Global", active: false, rows: [["/", "search views, boxes, files"], ["T", "choose a theme"], ["?", "this help"], ["q", "quit"]] },
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
      meta: new StyledText([fg(palette.muted)(" in "), fg(palette.accent)(focusSection ? "inspector" : "diagram"), fg(palette.muted)(` · pathlight ${pkg.version} `)]) };
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
  // The last `pathlight check` (the Stop hook runs one at the end of each turn): shown only when the model and the code disagree, with how old that check is.
  let stale: Stale | undefined;
  // What the last `pathlight diff` found against a git commit: connectors whose imports were added or lost are marked, and pairs that import each other with no relationship are counted.
  let diff: Diff | undefined;
  // The elements the agent said it is about to work on (`pathlight plan`): outlined, and activity on anything else is marked off-plan.
  let plan: Plan | undefined;
  // Flows: readings of the code (a journey is a LikeC4 dynamic view, a state diagram is what an agent wrote). They are loaded in the background after the first frame
  // and again when the model or a check changes, so a view never waits for them. In flow mode one is drawn on the diagram and read step by step in the inspector.
  let flows: FlowMap[] = [];
  let activeFlow: FlowMap | undefined, flowStep = 0;
  let flowPath = new Set<string>();
  let flowItems: ReturnType<typeof flowsThrough> = [];
  const inPlan = (ref: string) => (plan?.elements ?? []).some(id => ref === id || ref.startsWith(`${id}.`) || id.startsWith(`${ref}.`));
  const within = (id: string, ancestor: string) => id === ancestor || id.startsWith(`${ancestor}.`);
  const edgeMarks = () => {
    const marks = new Map<string, "added" | "lost" | "path">();
    if (!diff) { for (const key of flowPath) marks.set(key, "path"); return marks; }
    const ref = new Map(diagram.nodes.map(node => [String(node.id), String(node.modelRef)] as const));
    for (const edge of diagram.edges) {
      const from = ref.get(String(edge.source)), to = ref.get(String(edge.target));
      if (!from || !to) continue;
      const hits = diff.relationships.filter(item => within(item.source, from) && within(item.target, to));
      if (hits.some(item => item.change === "added")) marks.set(`${edge.source}\0${edge.target}`, "added");
      else if (hits.length) marks.set(`${edge.source}\0${edge.target}`, "lost");
    }
    // The flow being read wins over what changed: it is what the person asked to see.
    for (const key of flowPath) marks.set(key, "path");
    return marks;
  };
  const diffText = () => {
    if (!diff) return "";
    const added = diff.relationships.filter(item => item.change === "added").length, lost = diff.relationships.length - added;
    // Nothing changed, nothing said: the check badge on the right already shows the hooks are running.
    const parts = [added ? `+${added}` : "", lost ? `−${lost}` : "", diff.undeclared.length ? `${diff.undeclared.length} undeclared` : ""].filter(Boolean);
    return parts.length ? ` · vs ${diff.base} (static) ${parts.join(" ")}` : "";
  };
  const ago = (time: number) => { const age = formatAge(Date.now() - time); return age === "now" ? "just now" : `${age} ago`; };
  const staleBadge = (room: number) => {
    const detail = staleText(stale);
    if (!stale) return [];
    // A clean check says so, quietly: silence would look the same as a hook that never ran.
    if (!detail) { const text = `✓ in sync · checked ${ago(stale.time)} `; return text.length <= room ? [fg(palette.muted)(text)] : []; }
    const full = `▲ out of date: ${detail} · checked ${ago(stale.time)} `;
    const text = full.length <= room ? full : room >= 16 ? "▲ out of date " : "";
    return text ? [fg(palette.accent)(text)] : [];
  };
  const badgeContent = () => {
    const room = Math.max(0, renderer.width - 40);
    if (replay) return new StyledText([fg(palette.accent)("◀ replay"), fg(palette.border)(` ${liveLabel()} `)]);
    if (!binding && !following) { const only = staleBadge(room); return only.length ? new StyledText(only) : ""; }
    const busy = events.some(isActive);
    const live = [fg(binding ? palette.incoming : palette.muted)(`${busy ? spinner[Math.floor(Date.now() / 100) % spinner.length] : "●"} live`), fg(palette.border)(` ${liveLabel()} `)];
    return new StyledText([...staleBadge(room - 8 - liveLabel().length), ...live]);
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
    for (const key of sectionOrder) if (!touched.has(key) && key !== "files") sections[key].open = true;
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
      justifyContent: "center", title: group ? node.title : undefined, titleColor: palette.muted, titleAlignment: group ? "left" : "right" });
    const label = new TextRenderable(renderer, { selectable: false, fg: palette.body, wrapMode: "word", content: group ? "" : node.title, marginLeft: 1, marginRight: 1 });
    // The step number sits in the card's top border, on the left (the live tag is on the right); drawn only in flow mode.
    const badge = new TextRenderable(renderer, { position: "absolute", left: 1, top: -1, selectable: false, wrapMode: "none", bg: palette.background, fg: palette.purple, visible: false });
    box.add(label); box.add(badge); viewport.add(box);
    return { node, box, label, badge, rect: { x: 0, y: 0, width: 1, height: 1 } };
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
  // Section bodies start at the panel's edge; the panel has one column of padding each side and one for a scrollbar.
  const bodyWidth = () => Math.max(16, inspector.width - 2 - 1);
  const innerWidth = bodyWidth;
  const section = (title: string, tone: string, right = "") => [fg(tone)(title), fg(palette.border)(` ${"─".repeat(Math.max(2, innerWidth() - title.length - right.length - 2))} `), fg(palette.muted)(right)];
  const elementTitle = (id: string) => diagram.nodes.find(node => String(node.modelRef) === id)?.title ?? id.split(".").at(-1) ?? id;
  // Every open card gets an equal share of the inspector's height; a folded card is a padded header.
  let headRows = 2;
  const bodyRows: Record<SectionKey, number> = { connections: 4, files: 4, activity: 4, steps: 4, flows: 2 };
  const resetInspectorScroll = () => { inspectorScroll.scrollTo(0); for (const key of sectionOrder) sections[key].content.scrollTo(0); };
  // Sections folded automatically because the inspector is too short for every open card (never ones the user touched).
  const autoFolded = new Set<SectionKey>();
  const isOpen = (key: SectionKey) => sections[key].open && !autoFolded.has(key);
  // Files stay out of sight until asked for (`e`, or `3`): the actions line says how many there are.
  // "Now" says nothing when there is no session to watch.
  const shownSections = () => sectionOrder.filter(key => key === "files" ? fileMode || focusSection === "files" : key === "activity" ? Boolean(binding || following)
    : key === "steps" ? Boolean(activeFlow) : key === "connections" ? !activeFlow : !activeFlow && flowsThrough(flows, String(selected?.modelRef ?? "")).length > 0);
  const layoutSections = () => {
    const total = inspectorScroll.viewport.height;
    if (total <= 0) return;
    autoFolded.clear();
    const order = shownSections();
    let active = order.filter(key => sections[key].open);
    const wants = (key: SectionKey) => 1 + Math.max(1, contentRows[key]);
    // Each open section gets what its content needs, capped at a fair share; whatever a short section leaves over goes to the long ones.
    const allot = (keys: SectionKey[], compact: boolean) => {
      const closed = order.length - keys.length;
      let remaining = total - headRows - (compact ? 0 : order.length) - closed;
      const result = new Map<SectionKey, number>();
      const ordered = [...keys].sort((a, b) => wants(a) - wants(b));
      ordered.forEach((key, index) => {
        const give = Math.max(2, Math.min(wants(key), Math.floor(remaining / (ordered.length - index))));
        result.set(key, give); remaining -= give;
      });
      return { result, remaining };
    };
    // With a session attached the work is what is being watched, so activity is the last card to fold.
    for (const drop of (binding || following ? ["files", "flows", "connections", "activity"] : ["activity", "files", "flows", "connections"]) as SectionKey[]) {
      if (active.length <= 1 || [...allot(active, false).result].every(([key, rows]) => rows >= Math.min(4, wants(key)))) break;
      if (active.includes(drop) && !touched.has(drop)) { active = active.filter(key => key !== drop); autoFolded.add(drop); }
    }
    const roomy = allot(active, false);
    const compact = active.length > 0 && [...roomy.result].some(([key, rows]) => rows < Math.min(3, wants(key)));
    const plan = compact ? allot(active, true) : roomy;
    const ultra = compact && total - headRows - (order.length - active.length) < 3;
    for (const key of sectionOrder) {
      const entry = sections[key], isActive = active.includes(key), shown = order.includes(key);
      const rows = ultra ? Math.max(3, total - headRows) : plan.result.get(key) ?? 1;
      entry.box.visible = shown && (isActive || !ultra);
      entry.box.height = !shown ? 0 : isActive ? rows : 1;
      entry.box.marginTop = !shown || compact ? 0 : 1;
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
  // "Now": what the selected component's own mapped files saw, newest first. The work elsewhere is the header's line, `w`, `a` and `c`.
  const activityContent = () => {
    const note = (text: string, tone: string = palette.border) => { contentRows.activity = 1; return new StyledText([fg(tone)(text)]); };
    if (activityError) return note(activityError, palette.failure);
    if (!binding && !following) return note("○ no live session · model only");
    if (!config) return note("no file mapping · run pathlight init");
    if (!binding) return note("waiting for a session");
    const now = Date.now();
    const own = String(selected?.modelRef ?? "");
    const mine = activityRows(events, config, now, 64).filter(row => row.elements.includes(own));
    if (!mine.length) return note("nothing observed here yet");
    const width = bodyWidth();
    const spin = spinner[Math.floor(now / 100) % spinner.length] ?? "●";
    const collapsed: { row: (typeof mine)[number]; count: number; calls: string[] }[] = [];
    for (const row of mine) {
      const same = collapsed.find(entry => entry.row.operation === row.operation && entry.row.target === row.target && entry.row.agent === row.agent);
      if (same) { same.count++; same.calls.push(row.call); } else collapsed.push({ row, count: 1, calls: [row.call] });
    }
    const chunks: TextChunk[] = [];
    const shown = collapsed.slice(0, 3);
    for (const { row, count, calls } of shown) {
      const glyph = row.state === "started" ? spin : row.state === "completed" ? "✓" : row.state === "failed" ? "✗" : "~";
      const glyphTone = row.state === "failed" ? palette.failure : row.state === "started" ? palette.accent : row.state === "completed" ? palette.green : palette.muted;
      const op = (row.operation === "command" ? "run" : row.operation).padEnd(5);
      const first = row.paths[0]?.split("/").at(-1) ?? row.target;
      const extra = `${row.paths.length > 1 ? ` +${row.paths.length - 1}` : ""}${count > 1 ? ` ×${count}` : ""}${row.agent ? ` ·${row.agent.slice(0, 12)}` : ""}`;
      const age = formatAge(row.age);
      // Fixed grid: glyph (2) · op (5) · file + count · time, right aligned.
      const room = Math.max(4, width - 2 - 5 - age.length - 1);
      const shownFile = first.length + extra.length > room ? `${first.slice(0, Math.max(1, room - extra.length - 1))}…` : first;
      const gap = Math.max(1, width - 2 - 5 - shownFile.length - extra.length - age.length);
      const line: TextChunk[] = [fg(glyphTone)(`${glyph} `), fg(row.state === "started" ? palette.accent : palette.muted)(op), fg(palette.body)(shownFile), fg(palette.border)(extra), fg(palette.border)(`${" ".repeat(gap)}${age}`), nl];
      const flashing = calls.some(call => (rowFlashes.get(call) ?? 0) > now);
      chunks.push(...(flashing ? line.map(chunk => ({ ...chunk, bg: rowBackground })) : line));
    }
    const earlier = collapsed.length - shown.length;
    if (earlier > 0) chunks.push(fg(palette.border)(`${earlier} earlier · `), fg(palette.muted)("c"), fg(palette.border)(" session\n"));
    contentRows.activity = shown.length + (earlier > 0 ? 1 : 0);
    return new StyledText(chunks);
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
      chunks.push(fg(palette.outgoing)("  ■ "), fg(info.element ? palette.text : palette.failure)((path.length > room ? `…${path.slice(-(room - 1))}` : path).padEnd(Math.min(room, 40))),
        fg(palette.muted)(`×${info.count}  ${info.element ? elementTitle(info.element) : "not in the model"}`), nl);
    }
    if (!files.length) chunks.push(fg(palette.muted)("  no edits observed"), nl);
    chunks.push(nl, fg(palette.border)("Counts come from the retained calls, not totals. Commands show files they name."));
    summary.place(Math.min(100, renderer.width - 6), chunks.filter(chunk => chunk.text.includes("\n")).length + 4);
    return new StyledText(chunks);
  };
  // The header's one activity line: "now" while a tool runs, "last" once it has an outcome, then what it did, to which file, in which component.
  const tickerContent = () => {
    if (!binding || !config) return undefined;
    const [row] = activityRows(events, config, Date.now(), 1);
    if (!row || row.age > 120_000) return undefined;
    const running = row.state === "started";
    const verb = row.operation === "command" ? "run" : row.operation;
    const glyph = running ? (row.operation === "edit" ? "■" : row.operation === "read" ? "◦" : spinner[Math.floor(Date.now() / 100) % spinner.length]!)
      : row.state === "completed" ? "✓" : row.state === "failed" ? "✗" : "~";
    const tone = row.state === "failed" ? palette.failure : running ? (row.operation === "edit" ? palette.accent : row.operation === "read" ? palette.incoming : palette.command) : row.state === "completed" ? palette.green : palette.muted;
    const outcome = row.state === "failed" ? " failed" : row.state === "unconfirmed" ? ", no result" : "";
    return [fg(palette.border)(running ? "now  " : "last "), fg(tone)(`${glyph} `), fg(running ? tone : palette.body)(verb), fg(palette.body)(` ${row.target}`), fg(row.state === "failed" ? palette.failure : palette.muted)(outcome), fg(palette.muted)(" "),
      ...(row.agent ? [fg(palette.muted)(`[${row.agent.slice(0, 16)}] `)] : []),
      ...(row.elements.length ? [fg(palette.border)("in "), fg(palette.body)(row.elements.map(elementTitle).join(", ")), fg(palette.muted)(" ")] : []), fg(palette.border)(running && row.age < 1000 ? "" : formatAge(row.age))];
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
  // How long a finished call stays on its card: long enough to notice a failure after looking away.
  const outcomeMs = 30_000;
  // The tag in a card's top border: what a tool is doing to it now, or how the last call ended. Journal facts only: `done` is not `passing`.
  const cardTag = (related: ActivityEvent[], now: number): { text: string; color: string } | undefined => {
    const running = related.filter(isActive);
    if (running.length) {
      if (running.some(event => event.operation === "edit")) return { text: "■ edit", color: palette.accent };
      if (running.some(event => event.operation === "read")) return { text: "◦ read", color: palette.incoming };
      return { text: `▸ ${spinner[Math.floor(now / 100) % spinner.length]}`, color: palette.command };
    }
    const newest = related[0];
    if (newest && now - newest.time <= outcomeMs) {
      if (newest.phase === "failed") return { text: "✗ failed", color: palette.failure };
      if (newest.phase === "completed") return { text: "✓ done", color: palette.green };
    }
    // A call that started and never reported: not running as far as anyone knows, and not known to have finished.
    return related.some(event => event.phase === "started" && now - event.time > 30_000 && now - event.time <= 300_000) ? { text: "~ no result", color: palette.muted } : undefined;
  };
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
  // The breadcrumb as plain text: the room the activity ticker has beside it depends on its real width.
  let crumbPlain = "";
  const update = () => {
    layout();
    syncFlowStep();
    canvas.visible = !listMode; nodeList.visible = listMode;
    if (listMode) renderNodeList();
    headingText.content = headingContent(); badgeText.content = badgeContent();
    crumbPlain = `${view.project}/${diagram.id} · ${diagram.nodes.length} nodes${diagram.nodes.filter(node => waiting(String(node.modelRef))).length ? ` · ${diagram.nodes.filter(node => waiting(String(node.modelRef))).length} planned` : ""}${history.length ? ` · back ${history.length}` : ""}${diffText()}${plan ? ` · plan ${plan.elements.length}` : ""}`;
    breadcrumb.content = crumbPlain;
    crumbHint.visible = true;
    const worldWidth = Math.max(1, viewport.width) * scale;
    const worldHeight = Math.max(1, viewport.height) * scale / cellAspect();
    camera.left = -worldWidth / 2; camera.right = worldWidth / 2;
    camera.top = worldHeight / 2; camera.bottom = -worldHeight / 2;
    camera.position.set(centerX, -centerY, 1000); camera.lookAt(centerX, -centerY, 0);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    let hidden = 0;
    const now = Date.now();
    const previewed = focusSection === "connections" ? connectionItems[cursor.connections] : undefined;
    // Flow mode: which cards carry a step number, and which connectors are the path. A card that is not on the path steps back.
    const flowNodes = diagram.nodes.map(node => ({ id: String(node.id), modelRef: String(node.modelRef) }));
    const badges = activeFlow ? badgesOf(activeFlow, flowNodes) : new Map<string, number[]>();
    flowPath = activeFlow ? pathEdges(activeFlow, flowNodes, diagram.edges.map(edge => ({ source: String(edge.source), target: String(edge.target) }))) : new Set<string>();
    const stepNodeId = activeFlow ? (() => { const step = activeFlow.steps[flowStep]; const element = activeFlow.type === "journey" ? step?.to : step?.elements[0]; return flowNodes.find(node => node.modelRef === element)?.id; })() : undefined;
    const dashed = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "┄", vertical: "┆", topT: "┬", bottomT: "┴", leftT: "├", rightT: "┤", cross: "┼" };
    for (const entry of nodeObjects) {
      const group = entry.node.children.length > 0, id = String(entry.node.id);
      const related = byElement.get(String(entry.node.modelRef)) ?? [];
      const reads = related.filter(event => event.operation === "read").length, edits = related.filter(event => event.operation === "edit").length;
      const runs = related.filter(event => event.operation === "command").length;
      const offPlan = !!plan && related.length > 0 && !inPlan(String(entry.node.modelRef));
      const counts = [reads && `r${reads}`, edits && `e${edits}`, runs && `c${runs}`, offPlan && "off plan"].filter(Boolean).join(" ");
      const active = related.filter(isActive);
      const recent = related.find(event => now - event.time <= outcomeMs);
      const state = operationState(active, recent);
      const isSelected = id === String(selected?.id);
      const unbuilt = waiting(String(entry.node.modelRef));
      const neighbour = diagram.edges.some(edge => (edge.target === selected?.id && edge.source === entry.node.id) || (edge.source === selected?.id && edge.target === entry.node.id));
      const flashing = (flashes.get(String(entry.node.modelRef)) ?? 0) > now;
      // Selection and the panel cursor's target take the accent; neighbours are a step brighter; a running call or a fresh update pulses the accent.
      let border: string | RGBA = group ? palette.rule : palette.cardEdge;
      if (neighbour) border = group ? palette.border : palette.edgeDim;
      if (plan && inPlan(String(entry.node.modelRef))) border = palette.purple;
      // A behaviour view marks a state the agent found broken (#bug) or since repaired (#fixed).
      const marks = (entry.node as { tags?: readonly string[] }).tags ?? [];
      if (marks.includes("bug")) border = palette.failure; else if (marks.includes("fixed")) border = palette.green;
      if (state === "failed") border = palette.failure;
      if (previewed === id || isSelected || flashing) border = palette.accent;
      const numbers = badges.get(id), offPath = Boolean(activeFlow) && !group && !numbers;
      if (numbers && !isSelected && !flashing && state !== "failed") border = palette.purple;
      if (offPath && !isSelected) border = fade(border, 0.5);
      if (active.length && !isSelected) {
        const pulse = RGBA.fromHex(palette.accent), brightness = 0.55 + 0.45 * (1 + Math.sin(now / 220)) / 2;
        pulse.r *= brightness; pulse.g *= brightness; pulse.b *= brightness;
        border = pulse;
      }
      entry.box.borderColor = border;
      entry.box.customBorderChars = (previewed === id && !isSelected) || unbuilt ? dashed : undefined;
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
      if (group) entry.box.title = `${entry.node.title}${state ? ` [${state}]` : unbuilt ? " [planned]" : ""}${counts ? ` ·${counts}` : ""}`;
      else {
        // First line: the kind (dim) on the left and observed activity (dim) on the right; then the title.
        const rows = height - 2, textWidth = Math.max(4, width - 4);
        const stateText = unbuilt ? "[planned]" : "";
        const tag = cardTag(related, now);
        // A narrow card keeps just the glyph, so the state is still there when the words do not fit.
        entry.box.title = !tag ? undefined : width >= tag.text.length + 6 ? ` ${tag.text} ` : width >= 7 ? ` ${tag.text.slice(0, tag.text.indexOf(" ") > 0 ? tag.text.indexOf(" ") : 1)} ` : undefined;
        entry.box.titleColor = tag?.color;
        const statusText = [stateText, counts].filter(Boolean).join(" ");
        const kindFull = entry.node.kind ? String(entry.node.kind) : "";
        const kindText = kindFull.length + (statusText ? statusText.length + 1 : 0) < textWidth ? kindFull : "";
        const header = rows >= 2 && (statusText || (kindText && kindText.length < textWidth));
        const gap = Math.max(1, textWidth - kindText.length - statusText.length);
        const first: TextChunk[] = header ? [fg(palette.muted)(kindText.slice(0, Math.max(0, textWidth - statusText.length - 1))),
          fg(palette.muted)(statusText ? " ".repeat(gap) : ""), ...(stateText ? [fg(palette.muted)(stateText), fg(palette.muted)(counts ? ` ${counts}` : "")] : [fg(palette.muted)(counts)]), nl] : [];
        entry.label.content = new StyledText([...first, fg(offPath ? palette.border : bright ? palette.text : palette.body)(labelTitle(entry.node.title, textWidth, Math.max(1, rows - (header ? 1 : 0)), false))]);
      }
      entry.box.visible = !listMode && end.x > 0 && end.y > 0 && origin.x < viewport.width && origin.y < viewport.height;
      const badge = numbers && !group ? stepBadge(numbers) : "";
      entry.badge.visible = badge !== "" && width >= badge.length + 4;
      if (badge) { entry.badge.content = new StyledText([fg(id === stepNodeId ? palette.accent : palette.purple)(badge)]); }
      const bloom = Math.min(1, Math.max(0, (easeOut(revealProgress()) - (diagram.bounds.width ? (entry.node.x - diagram.bounds.x) / diagram.bounds.width * 0.45 : 0)) / 0.55));
      if (bloom < 1) { entry.box.borderColor = fade(entry.box.borderColor, bloom); }
      entry.label.visible = !group && width >= 8 && height >= 3 && bloom >= 0.7;
      if (!group && !entry.label.visible && bloom >= 0.7) hidden++;
    }
    const paths = selectedPaths();
    // The head says what the component is: its name and kind on one row, then what the model says it is for. Nothing else repeats the header or the cards.
    const headWidth = Math.max(10, inspector.width - 3);
    const kindText = selected?.kind ? String(selected.kind) : "";
    const titleText = (selected?.title ?? "No selection");
    const titleShown = titleText.length + kindText.length + 2 > headWidth ? `${titleText.slice(0, Math.max(1, headWidth - kindText.length - 3))}…` : titleText;
    inspectorTitle.content = new StyledText([fg(palette.text)(titleShown), fg(palette.muted)(`${" ".repeat(Math.max(1, headWidth - titleShown.length - kindText.length))}${kindText}`)]);
    const what = [selected?.technology, selected && waiting(String(selected.modelRef)) ? "planned: no files yet" : "", ...((selected as { tags?: readonly string[] } | undefined)?.tags ?? []).filter(tag => tag === "bug" || tag === "fixed")].filter(Boolean).join(" · ");
    inspectorHead.content = new StyledText([fg(palette.muted)(what || " ")]);
    inspectorHead.visible = what !== "";
    const description = describe(selected);
    const opens = selected?.navigateTo ? `o opens ${selected.navigateTo}` : "";
    inspectorId.content = new StyledText([...(description ? [fg(palette.body)(description)] : []), ...(description && opens ? [nl] : []), ...(opens ? [fg(palette.muted)(opens)] : [])]);
    inspectorId.visible = Boolean(description || opens);
    headRows = 1 + (what ? 1 : 0) + (description ? Math.ceil(description.length / headWidth) : 0) + (opens ? 1 : 0);

    const name = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const incoming = diagram.edges.filter(edge => edge.target === selected?.id);
    const outgoing = diagram.edges.filter(edge => edge.source === selected?.id);
    // Who calls it first, then what it calls: one row each, the relationship's own words beside the name. Enter walks the graph.
    const links = [...incoming.map(edge => ({ node: String(edge.source), arrow: "←", tone: palette.incoming, label: edge.label })),
      ...outgoing.map(edge => ({ node: String(edge.target), arrow: "→", tone: palette.accent, label: edge.label }))];
    connectionItems = links.map(item => item.node);
    cursor.connections = Math.min(cursor.connections, Math.max(0, connectionItems.length - 1));
    const nameColumn = Math.min(20, Math.max(8, ...links.map(item => name(item.node).length + 2)));
    const clip = (text: string, room: number) => room <= 0 ? "" : text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;
    const wrapWords = (text: string, room: number) => {
      const lines: string[] = [];
      for (const word of text.split(" ")) {
        const last = lines.at(-1);
        if (last !== undefined && last.length + 1 + word.length <= room) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word);
      }
      return lines;
    };
    // One row each. The row under the cursor shows its relationship in full, wrapped, so nothing a long description says is out of reach.
    const connectChunks: TextChunk[] = [], starts: number[] = [];
    let connectLine = 0;
    links.forEach((item, index) => {
      starts.push(connectLine);
      const here = focusSection === "connections" && cursor.connections === index;
      const full = item.label?.replace(/\s+/g, " ").trim() ?? "", room = bodyWidth() - 2 - 2 - nameColumn;
      const expand = here && full.length > room;
      const lines = [fg(palette.accent)(here ? "› " : "  "), fg(item.tone)(`${item.arrow} `), fg(here ? palette.text : palette.body)(clip(name(item.node), nameColumn - 1).padEnd(nameColumn)), fg(palette.muted)(`${expand ? "" : clip(full, room)}\n`)];
      connectChunks.push(...(here ? lines.map(chunk => ({ ...chunk, bg: rowBackground })) : lines)); connectLine++;
      if (expand) for (const part of wrapWords(full, bodyWidth() - 4).slice(0, 6)) { connectChunks.push({ ...fg(palette.muted)(`    ${part}\n`), bg: rowBackground }); connectLine++; }
    });
    contentRows.connections = Math.max(1, connectLine);
    if (focusSection === "connections") followLine("connections", starts[cursor.connections] ?? 0);
    relations.content = new StyledText(links.length ? connectChunks : [fg(palette.border)("none")]);

    // In flows: the flows this component is in, and which steps it plays. Nothing is shown for a component no flow touches.
    const ownElement = String(selected?.modelRef ?? "");
    flowItems = flowsThrough(flows, ownElement);
    cursor.flows = Math.min(cursor.flows, Math.max(0, flowItems.length - 1));
    contentRows.flows = Math.max(1, flowItems.length);
    flowsText.content = new StyledText(flowItems.flatMap(({ flow, steps }, index) => {
      const here = focusSection === "flows" && cursor.flows === index;
      const room = bodyWidth(), at = `${steps.length > 1 ? "steps" : "step"} ${steps.join("·")}`;
      const lines = [fg(palette.accent)(here ? "› " : "  "), fg(palette.purple)("◇ "), fg(here ? palette.text : palette.body)(clip(flow.title, Math.max(4, room - 4 - at.length - 1)).padEnd(Math.max(4, room - 4 - at.length))), fg(palette.muted)(`${at}\n`)];
      return here ? lines.map(chunk => ({ ...chunk, bg: rowBackground })) : lines;
    }));
    if (focusSection === "flows") followLine("flows", cursor.flows);

    // Steps: the flow being read, one row per step in the order it is told, with the component each lands on. `●` says the agent touched that component's
    // files (a fact from the journal, not that the step happened); the current step shows its latest call and whether the model backs it.
    const stepChunks: TextChunk[] = [], stepStarts: number[] = [];
    let stepLine = 0;
    if (activeFlow) {
      const flow = activeFlow, room = bodyWidth(), journey = flow.type === "journey";
      const syncLine = flow.sync.status === "none" ? "never synced" : flow.sync.status === "unknown" ? `synced at ${flow.sync.sha}, not a commit here`
        : flow.sync.status === "behind" ? `synced at ${flow.sync.sha} · files changed since` : `synced at ${flow.sync.sha} · files unchanged since`;
      stepChunks.push(fg(palette.purple)("◇ a reading of the code, not observed\n"), fg(flow.sync.status === "behind" || flow.sync.status === "unknown" ? palette.accent : palette.muted)(`${clip(syncLine, room)}\n`));
      stepLine += 2;
      let anyTouched = false;
      flow.steps.forEach((step, index) => {
        stepStarts.push(stepLine);
        const here = index === flowStep;
        const at = journey ? (step.to ? [step.to] : []) : step.elements;
        const comp = at.length ? clip(`${elementTitle(at[0]!)}${at.length > 1 ? ` +${at.length - 1}` : ""}`, 16) : "";
        const touched = at.some(element => (byElement.get(element)?.length ?? 0) > 0);
        anyTouched ||= touched;
        const titleRoom = Math.max(6, room - 2 - 3 - 1 - comp.length - 2);
        const row = [fg(palette.accent)(here ? "› " : "  "), fg(here ? palette.accent : palette.purple)(`${step.n}`.padStart(2) + " "), fg(step.mark === "bug" ? palette.failure : step.mark === "fixed" ? palette.green : here ? palette.text : palette.body)(clip(step.title, titleRoom).padEnd(titleRoom)),
          fg(palette.muted)(` ${comp}`), fg(palette.accent)(touched ? " ●" : "  "), nl];
        stepChunks.push(...(here ? row.map(chunk => ({ ...chunk, bg: rowBackground })) : row)); stepLine++;
        if (here) {
          const latest = at.flatMap(element => byElement.get(element) ?? []).sort((a, b) => b.time - a.time)[0];
          if (latest) {
            const glyph = latest.phase === "started" ? (spinner[Math.floor(Date.now() / 100) % spinner.length] ?? "●") : latest.phase === "completed" ? "✓" : "✗";
            const tone = latest.phase === "failed" ? palette.failure : latest.phase === "started" ? palette.accent : palette.green;
            const file = latest.paths[0]?.split("/").at(-1) ?? latest.tool;
            stepChunks.push(fg(palette.border)("     "), fg(tone)(`${glyph} `), fg(palette.muted)(`${latest.operation === "command" ? "run" : latest.operation} `), fg(palette.body)(clip(file, Math.max(4, room - 12))), fg(palette.border)(` ${formatAge(Date.now() - latest.time)}`), nl); stepLine++;
          }
          if (step.mark) { stepChunks.push(fg(palette.border)("     "), fg(step.mark === "bug" ? palette.failure : palette.green)(step.mark === "bug" ? "✗ marked as broken in the diagram\n" : "✓ marked as fixed in the diagram\n")); stepLine++; }
          if (step.backed === false) { stepChunks.push(fg(palette.border)("     "), fg(palette.accent)("≠ "), fg(palette.muted)("no relationship in the model\n")); stepLine++; }
          if (!step.elements.length) { stepChunks.push(fg(palette.border)("     "), fg(palette.muted)("no component for this step\n")); stepLine++; }
          if (step.call) {
            // The function this hop calls, as the file declares it (copied when the flow was written, checked by pathlight flows): a name, where, and the signature wrapped to the panel.
            stepChunks.push(fg(palette.border)("     "), fg(palette.purple)("ƒ "), fg(palette.text)(clip(step.call.name, Math.max(4, room - 8))), nl); stepLine++;
            const where = `declared in ${step.call.file}`;
            stepChunks.push(fg(palette.border)("       "), fg(palette.muted)(`${clip(where, Math.max(4, room - 7))}\n`)); stepLine++;
            const signature = step.call.declaration.replace(/^export\s+(default\s+)?/, ""), width = Math.max(12, room - 7);
            const lines: string[] = [];
            for (const word of signature.split(" ")) {
              const current = lines.at(-1);
              if (current !== undefined && current.length + 1 + word.length <= width) lines[lines.length - 1] = `${current} ${word}`;
              else lines.push(word.length > width ? `${word.slice(0, width - 1)}…` : word);
            }
            lines.slice(0, 3).forEach((line, index) => {
              stepChunks.push(fg(palette.border)("       "), fg(palette.body)(`${index === 2 && lines.length > 3 ? `${line.slice(0, Math.max(0, width - 1))}…` : line}\n`)); stepLine++;
            });
          }
        }
      });
      if (anyTouched) { stepChunks.push(fg(palette.accent)("●"), fg(palette.border)(" the agent touched its files\n")); stepLine++; }
      if (flow.findings.length) { stepChunks.push(fg(palette.border)(`${flow.findings.length} to check · pathlight flows\n`)); stepLine++; }
      followLine("steps", stepStarts[flowStep] ?? 0);
    }
    contentRows.steps = Math.max(1, stepLine);
    stepsText.content = new StyledText(stepChunks);

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
    if (!paths.length) fileChunks.push(fg(palette.border)(fileError || (config ? "No files mapped" : "Map files in .pathlight/pathlight.activity.json")));
    else if (touchedAny) fileChunks.push(fg(palette.border)("● touched this session"));
    contentRows.files = fileChunks.filter(chunk => chunk.text.includes("\n")).length + (paths.length && touchedAny ? 1 : 0) + (paths.length ? 0 : 1);
    filesText.content = new StyledText(fileChunks);
    // First click highlights a row; clicking the highlighted row again opens it.
    filesText.onMouseDown = event => {
      event.preventDefault(); event.stopPropagation();
      const index = fileLines[event.y - filesText.y - firstFileLine] ?? -1, path = paths[index];
      if (index < 0 || !path || help.visible || summary.visible) return;
      if (fileMode && clickedFile === index) { openFile(path); return; }
      if (!fileMode) beginFiles();
      fileCursor = clickedFile = index; message = "Click again or Enter to open"; searchInput.focus(); update();
    };
    if (fileFocus) followLine("files", firstFileLine + Math.max(0, fileLines.indexOf(fileCursor)));
    activityText.content = activityContent();
    if (focusSection === "activity") followLine("activity", cursor.activity);

    const observedHere = byElement.get(String(selected?.modelRef ?? ""))?.length ?? 0;
    const counts: Record<SectionKey, string> = { steps: activeFlow ? `${flowStep + 1}/${activeFlow.steps.length}` : "", flows: flowItems.length ? "◇ reading" : "", connections: links.length ? String(links.length) : "",
      files: fileMode ? `${paths.length ? fileCursor + 1 : 0}/${paths.length}` : String(paths.length), activity: observedHere ? String(observedHere) : "" };
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
    // Under the cards, always the same two lines: what is one key away, then the question field.
    const panelWidth = Math.max(10, inspector.width - (mounted === "overlay" ? 3 : 2));
    const action = (key: string, text: string) => [fg(palette.body)(key), fg(palette.muted)(` ${text}   `)];
    inspectorActions.content = new StyledText([fg(palette.rule)("─".repeat(panelWidth)), nl,
      ...(paths.length ? action("e", `files ${paths.length}`) : []), ...(binding ? action("c", "session") : []), ...(binding && events.length ? action("p", "replay") : [])]);
    const askLabel = clip(selected ? `ask about ${selected.title}…` : "ask…", panelWidth - 6);
    inspectorAsk.content = new StyledText([fg(palette.accent)("› "), fg(options.parent ? palette.muted : palette.border)(askLabel.padEnd(panelWidth - 3)), fg(palette.body)("t")].map(chunk => ({ ...chunk, bg: hot })));
    if (summary.visible) summary.content.content = summaryContent();
    if (goto.visible) renderGoto();
    body.gutterOptions = { color: fileMode ? palette.outgoing : palette.border };
    const mode = replay ? "replay" : fileMode ? "files" : focusSection ? sections[focusSection].name.toLowerCase() : activeFlow ? "flow" : "diagram";
    // A notice has the room: the hidden-label count waits until it goes.
    const labelNote = message ? 0 : hidden;
    const work = binding || following ? newestWork() : undefined;
    const sectionHints: Record<SectionKey, Hint[]> = {
      steps: [["↑↓", "step"], ["enter", "show"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      flows: [["↑↓", "move"], ["enter", "trace on the diagram"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      connections: [["↑↓", "move"], ["enter", "show in diagram"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      files: [["↑↓", "move"], ["enter", "open"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
      activity: [["↑↓", "scroll"], ["tab", "next"], ["space", "fold"], ["esc", "diagram"]],
    };
    // The footer says where you are and how to ask for help; keys are named only inside a mode that needs them.
    const rightText = `${labelNote ? `${labelNote} labels hidden  ·  ` : ""}zoom ${Math.round(16 / scale * 100)}%  │  ? help`;
    const room = Math.max(10, renderer.width - rightText.length - 16 - mode.length - String(selected?.id ?? "").length - 4);
    const hints = replay ? [fg(palette.accent)(`${replay.playing ? "▶" : "⏸"} ${replay.index + 1}/${replay.data.steps.length}`), fg(palette.muted)(`  turn ${replayTurn() + 1}/${replay.data.turns.length}  `),
        ...hintChunks([["space", replay.playing ? "pause" : "play"], ["←→", "step"], ["[ ]", "turn"], ["s", `${replay.speed}x`], ["esc", "exit"]], room - 24)]
      : focusSection && !fileMode ? hintChunks(sectionHints[focusSection], room)
      : activeFlow && !fileMode ? [fg(palette.purple)(`◇ ${clip(activeFlow.title, 24)} · ${flowStep + 1}/${activeFlow.steps.length}  `), ...hintChunks([["[ ]", "step"], ["F", "next flow"], ["esc", "exit"]], room - 40)]
      : fileMode ? [fg(palette.accent)(`Files ${paths.length ? fileCursor + 1 : 0}/${paths.length}`), fg(palette.muted)("  type to filter  "), ...hintChunks([["enter", "open"], ["ctrl+r", "refresh"], ["esc", "back"]], room - 30)]
      : [];
    if (message !== lastToast) {
      lastToast = message;
      if (message) { const shown = message; setTimeout(() => { if (message === shown && !closing) { message = ""; update(); } }, /^Asked /.test(shown) ? 3500 : 2000); }
    }
    const style = message ? noticeStyle(message) : undefined;
    statusLeft.content = new StyledText([pill(mode, palette.accent), fg(palette.muted)("  Selected: "), fg(palette.body)(String(selected?.id ?? "")), fg(palette.muted)("  "),
      ...(style ? [fg(style.color)(`${style.glyph} `), fg(palette.body)(message)] : hints)]);
    const leftWidth = statusLeft.content instanceof StyledText ? statusLeft.content.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) : 0;
    statusRight.content = leftWidth + rightText.length + 2 <= renderer.width
      ? new StyledText([...(labelNote ? [fg(palette.border)(`${labelNote} labels hidden  ·  `)] : []), fg(palette.muted)(`zoom ${Math.round(16 / scale * 100)}%`), fg(palette.border)("  │  "), fg(palette.muted)("? help")])
      : new StyledText([]);
    // One activity line, top right: an offer when the work is in another view, else the latest call. It is dropped when it would not fit.
    const ticker = tickerContent();
    const activity: TextChunk[] | undefined = work && "view" in work ? [fg(palette.accent)("● "), fg(palette.text)(`working in ${work.title}`), fg(palette.muted)("  "), pill("w", palette.accent), fg(palette.muted)(" go and follow")] : ticker;
    const crumbWidth = crumbPlain.length;
    const activityWidth = activity?.reduce((sum, chunk) => sum + chunk.text.length, 0) ?? 0;
    const available = renderer.width - 2 - crumbWidth - 3;
    const fitted: TextChunk[] = [];
    if (activity && available >= 24) {
      let left = activityWidth > available ? available - 1 : available;
      for (const chunk of activity) { if (left <= 0) break; fitted.push(chunk.text.length <= left ? chunk : { ...chunk, text: chunk.text.slice(0, left) }); left -= chunk.text.length; }
      if (activityWidth > available) fitted.push(fg(palette.muted)("…"));
    }
    crumbHint.content = new StyledText(fitted);
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
    // Past the last node on the right, the inspector is the next thing: `h` (or left) comes back.
    if (!best && direction === "right") { message = ""; focusOn("activity"); return; }
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
  // Flow mode. A step lands on one component (a journey's target, a state's first); stepping selects it and brings it into view like any other selection, and says
  // so when it is in another view. `F` enters the flows this view shows (the ones through the selection first) and cycles them; Esc leaves.
  const stepElement = (flow: FlowMap, index: number) => { const step = flow.steps[index]; return flow.type === "journey" ? step?.to : step?.elements[0]; };
  const goToStep = (index: number) => {
    const flow = activeFlow;
    if (!flow?.steps.length) return;
    flowStep = (index + flow.steps.length) % flow.steps.length;
    const element = stepElement(flow, flowStep), node = element ? nodeForElement(element) : undefined;
    if (node) { message = ""; selectNode(node, true); }
    else { message = element ? `${elementTitle(element)} is not in this view` : "No component for this step"; update(); }
  };
  const enterFlow = (flow: FlowMap, step = 1) => {
    activeFlow = flow; flowStep = Math.max(0, Math.min(flow.steps.length - 1, step - 1));
    if (focusSection === "connections") focusSection = undefined;
    goToStep(flowStep);
  };
  const exitFlow = () => { activeFlow = undefined; if (focusSection === "steps") focusSection = undefined; message = ""; update(); };
  const flowsHere = () => {
    const present = new Set(diagram.nodes.map(node => String(node.modelRef)));
    const through = new Set(flowsThrough(flows, String(selected?.modelRef ?? "")).map(entry => `${entry.flow.type}/${entry.flow.id}`));
    // The flow this very view draws comes first (its hops are the diagram), then the flows through the selection, then the rest.
    const rank = (flow: FlowMap) => (flow.view === String(diagram.id) ? 2 : 0) + (through.has(`${flow.type}/${flow.id}`) ? 1 : 0);
    return flowsInView(flows, present).sort((a, b) => rank(b) - rank(a));
  };
  const cycleFlow = () => {
    const here = flowsHere();
    if (!here.length) { message = flows.length ? "No flow touches this view" : "No flows yet · select a box and press d to ask the agent to trace one"; update(); return; }
    const at = activeFlow ? here.findIndex(flow => flow.type === activeFlow!.type && flow.id === activeFlow!.id) : -1;
    if (at === here.length - 1) { exitFlow(); return; }
    const next = here[at + 1]!, mine = flowsThrough([next], String(selected?.modelRef ?? ""))[0]?.steps[0];
    enterFlow(next, mine ?? 1);
  };
  // Stay on the step that matches the selection: choosing a component yourself moves the reader to its next step in the flow.
  const syncFlowStep = () => {
    const flow = activeFlow, ref = String(selected?.modelRef ?? "");
    if (!flow || !ref || stepElement(flow, flowStep) === ref) return;
    for (let offset = 1; offset <= flow.steps.length; offset++) {
      const index = (flowStep + offset) % flow.steps.length;
      if (stepElement(flow, index) === ref) { flowStep = index; return; }
    }
  };
  const loadFlows = () => {
    if (closing) return;
    runTask(checkFlows(view.workspace).pipe(Effect.map(flowMaps), Effect.tap(list => Effect.sync(() => {
      flows = list;
      if (activeFlow) { activeFlow = list.find(flow => flow.type === activeFlow!.type && flow.id === activeFlow!.id); if (!activeFlow) message = "That flow is gone"; }
      if (!editorActive && !closing) update();
    })), Effect.catch(() => Effect.void)));
  };
  // The newest call that maps to any element. In this view (or via an ancestor that is) it is a node; otherwise it names the view to go to:
  // one this view links to with navigateTo first, else the smallest view that contains the element. Never switches by itself.
  const newestWork = (): { node: NonNullable<typeof selected> } | { view: string; element: string; title: string } | undefined => {
    for (const event of events) {
      const elements = [...new Set(rules.filter(rule => event.paths.some(path => rule.match.match(path))).map(rule => rule.element))];
      if (!elements.length) continue;
      const exact = elements.map(nodeForElement).filter((node): node is NonNullable<typeof selected> => Boolean(node)).sort((a, b) => a.children.length - b.children.length)[0];
      if (exact) return { node: exact };
      // Another view that shows the exact component beats an enclosing group here (a group is not where the work happened).
      const linked = new Set(diagram.nodes.map(node => node.navigateTo && String(node.navigateTo)).filter(Boolean));
      const candidates = [...diagrams].flatMap(([id, entry]) => entry.nodes.some(node => elements.includes(String(node.modelRef))) ? [{ id, entry, element: elements.find(element => entry.nodes.some(node => String(node.modelRef) === element)) ?? elements[0]! }] : [])
        .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || a.entry.nodes.length - b.entry.nodes.length || Number(a.id === "index") - Number(b.id === "index"));
      const best = candidates[0];
      const enclosing = elements.map(element => {
        for (let id = element; id.includes("."); ) { id = id.slice(0, id.lastIndexOf(".")); const node = nodeForElement(id); if (node) return node; }
        return undefined;
      }).filter((node): node is NonNullable<typeof selected> => Boolean(node)).sort((a, b) => a.children.length - b.children.length)[0];
      if (!best && enclosing) return { node: enclosing };
      return best ? { view: best.id, element: best.element, title: String(best.entry.title ?? best.id) } : undefined;
    }
    return undefined;
  };
  const replayTurn = () => { let turn = 0; replay?.data.turns.forEach((start, index) => { if (start <= replay!.index) turn = index; }); return turn; };
  // Show the session as it stood after step `index`: the calls so far, the newest one flashing, and the camera on its component (switching view when it lives elsewhere).
  const showStep = (index: number) => {
    if (!replay) return;
    replay.index = Math.max(0, Math.min(replay.data.steps.length - 1, index));
    events = visibleEvents(replay.data.steps.slice(0, replay.index + 1).reverse());
    seenCalls.clear(); nodeFlashes.clear(); rowFlashes.clear();
    for (const event of events.slice(1)) seenCalls.add(event.call);
    indexEvents(); noteCalls();
    const work = newestWork();
    if (work && "node" in work) { message = ""; followSelecting = true; try { selectNode(work.node, true); } finally { followSelecting = false; } }
    else if (work) { animating = false; pendingVisit = { diagram: getDiagram(work.view), select: work.element }; message = `Went to ${work.title}`; }
    update();
  };
  const beginReplay = () => {
    const target = binding;
    if (!target) { message = "Replay needs a bound session"; update(); return; }
    message = "Loading the session…"; update();
    runTask(readReplay(view.workspace, target).pipe(
      Effect.tap(data => Effect.sync(() => {
        message = "";
        if (!data.steps.length) { message = "Nothing recorded to replay"; update(); return; }
        replay = { data, index: 0, playing: false, speed: 1, next: 0 };
        showStep(data.turns.at(-1) ?? 0);
      })),
      Effect.catch(() => Effect.sync(() => { message = "Replay unavailable: the journal could not be read"; update(); }))));
  };
  const endReplay = () => {
    replay = undefined;
    // The next poll puts the live calls back; they are not news, so nothing flashes.
    calmLoaded = false; seenCalls.clear(); nodeFlashes.clear(); rowFlashes.clear(); lastSignature = ""; message = "";
    update();
  };
  const replayKey = (key: { name: string; sequence: string; preventDefault(): void }) => {
    const play = replay;
    if (!play) return false;
    const last = play.data.steps.length - 1, turns = play.data.turns, turn = replayTurn();
    const go = (index: number) => { key.preventDefault(); play.playing = false; showStep(index); return true; };
    if (key.name === "escape" || key.name === "p") { key.preventDefault(); endReplay(); return true; }
    if (key.name === "right") return go(play.index + 1);
    if (key.name === "left") return go(play.index - 1);
    if (key.name === "home") return go(0);
    if (key.name === "end") return go(last);
    if (key.sequence === "]") return go(turns[turn + 1] ?? last);
    if (key.sequence === "[") return go(play.index > (turns[turn] ?? 0) ? turns[turn] ?? 0 : turns[turn - 1] ?? 0);
    if (key.name === "space" || key.sequence === " ") {
      key.preventDefault();
      if (!play.playing && play.index >= last) showStep(turns.at(-1) ?? 0);
      play.playing = !play.playing; play.next = Date.now() + 1000 / play.speed; update();
      return true;
    }
    if (key.name === "s") { key.preventDefault(); play.speed = play.speed === 1 ? 2 : play.speed === 2 ? 4 : 1; update(); return true; }
    return false;
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
  // The picker: `/` searches every view, box and mapped file in the project, `g` only the views. It does not infer links between views.
  // Typing narrows the list (see search.ts for the ranking) and the list scrolls inside its frame.
  type Pick = Candidate & { view?: string; element?: string; path?: string; detail: string };
  let gotoIndex = 0, gotoTop = 0, gotoQuery = "", gotoMode: "all" | "views" = "all", gotoItems: Pick[] = [];
  // Where a box that is not in this view opens: the view of its parent (the box among its siblings), else the view of the box itself, else a
  // view this one links to, else the smallest view that has it (the same last rule `w` uses).
  const viewHaving = (element: string) => {
    const linked = new Set(diagram.nodes.map(node => node.navigateTo && String(node.navigateTo)).filter(Boolean));
    const parent = element.includes(".") ? element.slice(0, element.lastIndexOf(".")) : undefined;
    const rank = ([id, entry]: [string, typeof diagram]) => {
      const subject = "viewOf" in entry ? String(entry.viewOf ?? "") : "";
      return subject && subject === parent ? 0 : subject === element ? 1 : linked.has(id) ? 2 : 3;
    };
    return [...diagrams].filter(([, entry]) => entry.nodes.some(node => String(node.modelRef) === element))
      .sort((a, b) => rank(a) - rank(b) || a[1].nodes.length - b[1].nodes.length || Number(a[0] === "index") - Number(b[0] === "index"))[0];
  };
  const pickCandidates = (): Pick[] => {
    const current = String(diagram.id);
    const views: Pick[] = [...diagrams].filter(([, entry]) => entry.nodes.length).map(([id, entry]) =>
      ({ kind: "view", name: String(entry.title ?? id), aliases: [id], here: id === current, view: id, detail: `${entry.nodes.length} nodes` }));
    if (gotoMode === "views") return views;
    const present = new Set(diagram.nodes.map(node => String(node.modelRef)));
    const titles = new Map<string, string>();
    for (const entry of diagrams.values()) for (const node of entry.nodes) if (node.modelRef && !titles.has(String(node.modelRef))) titles.set(String(node.modelRef), node.title);
    const boxes: Pick[] = [...titles].map(([element, title]) =>
      ({ kind: "box", name: title, aliases: [element, element.split(".").at(-1)!], here: present.has(element), element, detail: "" }));
    // Files the mapping puts outside the picture (tests, generated code) are not offered, and neither is a file that is a box of its own.
    const outside = (config?.ignore ?? []).map(glob => new Bun.Glob(glob));
    const mapped: Pick[] = [...files].filter(([element]) => titles.has(element)).flatMap(([element, paths]) => paths
      .filter(path => path.slice(path.lastIndexOf("/") + 1) !== titles.get(element) && !outside.some(glob => glob.match(path)))
      .map(path => ({ kind: "file" as const, name: path.slice(path.lastIndexOf("/") + 1), aliases: [path], here: present.has(element), element, path, detail: titles.get(element)! })));
    return [...views.filter(item => !item.here), ...boxes, ...mapped];
  };
  const gotoEntries = () => rankSearch(gotoQuery, gotoItems);
  // The frame is the list plus the query line, the border and a blank row above and below; keep it inside the terminal and fairly compact.
  const gotoRows = (count: number) => Math.max(1, Math.min(count, 18, renderer.height - 2 - 5));
  const renderGoto = () => {
    const entries = gotoEntries();
    const rows = gotoRows(Math.max(1, entries.length));
    gotoIndex = Math.min(gotoIndex, Math.max(0, entries.length - 1));
    if (gotoIndex < gotoTop) gotoTop = gotoIndex;
    if (gotoIndex >= gotoTop + rows) gotoTop = gotoIndex - rows + 1;
    gotoTop = Math.max(0, Math.min(gotoTop, Math.max(0, entries.length - rows)));
    const inner = Math.min(80, renderer.width - 4) - 6, contextWidth = Math.min(26, Math.floor(inner / 3)), nameWidth = Math.max(10, inner - 1 - 5 - 1 - contextWidth - 1);
    const fit = (text: string, width: number) => text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text.padEnd(width);
    const chunks: TextChunk[] = [fg(palette.incoming)(" › "), fg(palette.text)(gotoQuery), fg(palette.incoming)("▏"), nl];
    if (!entries.length) chunks.push(fg(palette.muted)(" Nothing matches"), nl);
    entries.slice(gotoTop, gotoTop + rows).forEach((entry, offset) => {
      const cursor = gotoTop + offset === gotoIndex, shade = bg(cursor ? palette.pick : palette.panel);
      // What the row says on the right: where it is. A row in the view you are in carries a dot; one elsewhere says which view it opens.
      const where = entry.kind === "view" ? (entry.here ? "● here" : entry.detail)
        : entry.here ? `● ${entry.kind === "file" ? entry.detail : "here"}` : entry.kind === "file" ? entry.detail : `in ${String(viewHaving(entry.element!)?.[1].title ?? "")}`;
      const dir = entry.kind === "file" ? ` ${entry.path!.slice(0, entry.path!.lastIndexOf("/") + 1)}` : "";
      const name = fit(entry.name + (dir.trim() ? dir : ""), nameWidth);
      chunks.push(shade(fg(palette.muted)(` ${entry.kind.padEnd(5)}`)), shade(fg(palette.text)(name.slice(0, Math.min(entry.name.length, nameWidth)))),
        shade(fg(palette.muted)(name.slice(Math.min(entry.name.length, nameWidth)))), shade(fg(entry.here ? palette.incoming : palette.muted)(` ${fit(where, contextWidth)} `)), nl);
    });
    goto.content.content = new StyledText(chunks);
    goto.meta.content = new StyledText([fg(palette.muted)(` ${entries.length ? `${gotoTop + 1}–${Math.min(entries.length, gotoTop + rows)} of ${entries.length}` : "0"} `)]);
    goto.foot.content = new StyledText(borderHints([["type", "search"], ["↑↓", "choose"], ["enter", "go"], ["esc", "close"]]));
    goto.place(Math.min(80, renderer.width - 4), rows + 1 + (entries.length ? 0 : 1) + 4);
  };
  // Themes: the palette is swapped in place and every widget recoloured, so moving through the picker previews each one live.
  const applyTheme = (name: string) => {
    const entry = themes.get(name);
    if (!entry) return false;
    let next: ReturnType<typeof paletteOf>;
    try { next = paletteOf(entry, themeMode); } catch (error) { message = `Theme ${name} cannot be used: ${error instanceof Error ? error.message : String(error)}`; update(); return false; }
    const before = { ...palette };
    setPalette(next);
    retheme([renderer.root, inspector], before, palette);
    renderer.setBackgroundColor(palette.background);
    themeName = name; dirty = true; update();
    return true;
  };
  let themeIndex = 0, themeBase = themeName, themeTop = 0;
  const themeRows = () => Math.max(3, Math.min(themeNames.length, renderer.height - 8));
  const renderThemes = () => {
    const rows = themeRows();
    if (themeIndex < themeTop) themeTop = themeIndex;
    if (themeIndex >= themeTop + rows) themeTop = themeIndex - rows + 1;
    const chunks: TextChunk[] = [];
    themeNames.slice(themeTop, themeTop + rows).forEach((name, offset) => {
      const index = themeTop + offset, cursor = index === themeIndex, current = name === themeBase, base = cursor ? palette.pick : palette.panel;
      const preview = themes.get(name) && (() => { try { return paletteOf(themes.get(name)!, themeMode); } catch { return undefined; } })();
      chunks.push(bg(base)(fg(current ? palette.accent : palette.muted)(current ? " ● " : "   ")), bg(base)(fg(palette.text)(` ${name.padEnd(24).slice(0, 24)}`)),
        bg(base)(fg(palette.muted)(` ${{ user: "yours   ", terminal: "terminal", bundled: "        " }[themes.get(name)?.source ?? "bundled"]} `)),
        ...(preview ? [preview.accent, preview.incoming, preview.green, preview.failure, preview.purple].map(color => bg(base)(fg(color)("██"))) : []), bg(base)(fg(palette.muted)(" ")), nl);
    });
    chunks.pop();
    picker.content.content = new StyledText(chunks);
    picker.meta.content = new StyledText([fg(palette.muted)(` ${themeIndex + 1}/${themeNames.length} · ${themeMode} `)]);
    picker.foot.content = new StyledText(borderHints([["↑↓", "preview"], ["enter", "keep"], ["esc", "cancel"]]));
    picker.place(Math.min(64, renderer.width - 4), rows + 4);
  };
  const beginThemes = () => {
    themeBase = themeName; themeIndex = Math.max(0, themeNames.indexOf(themeName)); themeTop = 0;
    picker.open(Math.min(64, renderer.width - 4), themeRows() + 4); renderThemes(); update();
  };
  const moveTheme = (to: number) => {
    themeIndex = (to + themeNames.length) % themeNames.length;
    applyTheme(themeNames[themeIndex]!); renderThemes();
  };
  const cancelThemes = () => { picker.close(); if (themeName !== themeBase) applyTheme(themeBase); update(); };
  const keepTheme = () => {
    picker.close(); themeBase = themeName; message = `Theme: ${themeName}`;
    runTask(saveTheme(themeName).pipe(Effect.catch(error => Effect.sync(() => { message = `Theme ${themeName} is in use but was not saved: ${error.message}`; update(); }))));
    update();
  };
  // The terminal's own colours are asked for once, in the background (OSC queries; tmux must pass them through). Until they arrive, or if they never
  // do, `system` is simply absent from the picker. They also decide light or dark for themes with both, unless PATHLIGHT_MODE says otherwise.
  runTask(io("Native.terminalColors", () => renderer.getPalette({ timeout: 1000 })).pipe(
    Effect.flatMap(colors => Effect.sync(() => {
      if (closing || !colors.defaultBackground) return;
      themes.set("system", systemTheme(colors));
      themeNames.splice(0, themeNames.length, ...[...themes.keys()].sort(themeOrder));
      const detected = environment.mode ? undefined : modeOf(colors.defaultBackground);
      if (detected && detected !== themeMode) themeMode = detected;
      if (picker.visible) { renderThemes(); return; }
      if (wantedTheme === "system" || detected) applyTheme(wantedTheme === "system" ? "system" : themeName);
    })),
    Effect.catch(() => Effect.void)));
  const beginGoto = (mode: "all" | "views") => {
    gotoMode = mode; gotoQuery = ""; gotoTop = 0; gotoItems = pickCandidates();
    goto.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)(mode === "views" ? "Go to view" : "Search"), fg(palette.muted)(" ")]);
    gotoIndex = mode === "views" ? Math.max(0, gotoEntries().findIndex(item => item.here)) : 0;
    goto.open(Math.min(80, renderer.width - 4), 8); renderGoto(); update();
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
  // Go to a box (and, for a file, show it in the Files section): in place when this view has it, else in the view that fits it best. Back returns.
  const showFile = (path: string) => {
    const index = selectedPaths().indexOf(path);
    if (index < 0) return;
    fileCursor = index; sections.files.open = true; touched.add("files"); focusSection = "files"; scrollToSection = "files"; inspectorPreference = "open";
  };
  const landOn = (element: string, path?: string) => {
    goto.close();
    const here = nodeForElement(element);
    if (here) { selectNode(here, true); if (path) showFile(path); update(); return; }
    const best = viewHaving(element);
    if (!best) { message = "That is not in any view"; update(); return; }
    history.push(visit()); if (history.length > 32) history.shift();
    animating = false; pendingVisit = { diagram: getDiagram(best[0]), select: element, file: path };
    message = `Went to ${String(best[1].title ?? best[0])}`;
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
  // `t` asks a question; `m` asks the agent to improve the map; `n` is the person's own name and note (two steps, no agent).
  let askMode: "ask" | "map" | "flow" | "name" | "note" = "ask", editKey = "", editTitle = "";
  let askFocus = -1, askSpans: { from: number; to: number }[] = [];
  const renderAsk = () => {
    if (!asking) return;
    if (askMode !== "ask") {
      const names = { map: "Ask the agent to improve the map", flow: "Ask the agent to trace a flow", name: "Name", note: "Note" } as const;
      ask.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)(names[askMode]), fg(palette.muted)(" ")]);
      ask.content.content = new StyledText([fg(palette.muted)("about".padEnd(8)), fg(palette.text)(asking.title), fg(palette.purple)(`  ${asking.id}`), nl, fg(palette.muted)(askMode === "map" ? "it reads the files, then edits the overlay" : askMode === "flow" ? "it reads the code, then records a journey you can trace with F" : askMode === "name" ? "step 1 of 2" : "step 2 of 2 · empty clears it")]);
      askPrompt.fg = palette.accent;
      ask.foot.content = new StyledText(borderHints(askMode === "map" || askMode === "flow" ? [["enter", "send"], ["alt+enter", "new line"], ["esc", "cancel"]] : [["enter", askMode === "name" ? "next" : "save"], ["esc", "cancel"]]));
      ask.meta.content = new StyledText([fg(palette.muted)(" ")]);
      renderer.requestRender();
      return;
    }
    ask.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)("Ask the agent"), fg(palette.muted)(" ")]);
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
  const openAsk = (target: NonNullable<typeof selected>, mode: typeof askMode, text: string, placeholder: string) => {
    asking = target; askMode = mode; animating = false;
    askInput.placeholder = placeholder;
    askInput.setText(text); askInput.gotoBufferEnd(); askInput.height = 1; askRow.height = 3;
    ask.open(Math.min(76, renderer.width - 4), 10);
    focusAsk(-1); message = ""; update();
  };
  const beginAsk = () => {
    if (!options.parent) { message = "Ask needs the viewer opened with pathlight show, which knows your agent's pane"; update(); return; }
    if (!selected) return;
    openAsk(selected, "ask", "", "What do you want to know about it?");
  };
  // Map editing needs the element's overlay key, which `pathlight draft` records; a hand-written model has none.
  const withKey = (target: NonNullable<typeof selected>, then: (key: string) => Effect.Effect<void>) =>
    runTask(readKeys(view.workspace).pipe(
      Effect.flatMap(keys => {
        const key = keys.get(String(target.modelRef ?? "")) ?? keys.get(String(target.id));
        return key ? then(key) : Effect.sync(() => { message = "Only a model made by pathlight draft can be edited here; edit your model file instead"; update(); });
      }),
      Effect.catch(() => Effect.void)));
  const beginMap = () => {
    if (!options.parent) { message = "Changing the map needs the viewer opened with pathlight show, which knows your agent's pane"; update(); return; }
    const target = selected;
    if (target) withKey(target, key => Effect.sync(() => { editKey = key; openAsk(target, "map", "", "What should it work out, or what should it be called?"); }));
  };
  const beginFlow = () => {
    if (!options.parent) { message = "Tracing a flow needs the viewer opened with pathlight show, which knows your agent's pane"; update(); return; }
    if (selected) openAsk(selected, "flow", "", "What should it trace? (for example: what happens when someone places an order)");
  };
  const beginName = () => {
    const target = selected;
    if (target) withKey(target, key => readEntry(view.workspace, key).pipe(Effect.flatMap(entry => Effect.sync(() => {
      editKey = key; editTitle = target.title; noteDraft = entry?.note ?? "";
      openAsk(target, "name", entry?.title ?? target.title, "Name");
    })), Effect.catch(error => Effect.sync(() => { message = error.message; update(); }))));
  };
  let noteDraft = "";
  ask.dismiss = () => finishAsk();
  help.dismiss = () => help.close();
  summary.dismiss = () => { summary.close(); update(); };
  goto.dismiss = () => { goto.close(); update(); };
  picker.dismiss = () => cancelThemes();
  function finishAsk() { asking = undefined; askMode = "ask"; askInput.blur(); ask.close(); update(); }
  // The question and the chosen context go to the agent's pane and are submitted there; an empty question sends nothing.
  const sendAsk = () => {
    const target = asking, parent = options.parent, question = askInput.plainText.trim();
    if (target && askMode === "name") { editTitle = question; askMode = "note"; askInput.setText(noteDraft); askInput.gotoBufferEnd(); askInput.placeholder = "A line about what it is for"; renderAsk(); return; }
    if (target && askMode === "note") {
      const key = editKey, entry = { title: editTitle, note: question }, generated = target.title;
      finishAsk(); message = "Saving the name and rebuilding the map…"; update();
      runTask(saveElement(view.workspace, key, entry, generated).pipe(
        Effect.tap(() => Effect.sync(() => { message = "Saved as yours · the map is rebuilding"; update(); })),
        Effect.catch(error => Effect.sync(() => { message = error.message; update(); }))));
      return;
    }
    if (!target || !parent || !question) return;
    const context = askContext(target);
    if (askMode === "flow") {
      const text = flowMessage({ title: target.title, id: String(target.id), files: context.files, links: context.links }, question);
      finishAsk();
      runTask(sendToPane(parent, text, true).pipe(
        Effect.tap(() => Effect.sync(() => { message = `Asked the agent to trace a flow from ${target.title} · F shows it once it is written`; update(); })),
        Effect.catch(error => Effect.sync(() => { message = error.message; update(); }))));
      return;
    }
    if (askMode === "map") {
      const text = mapMessage({ title: target.title, id: String(target.id), key: editKey, files: context.files, links: context.links }, question);
      finishAsk();
      runTask(sendToPane(parent, text, true).pipe(
        Effect.tap(() => Effect.sync(() => { message = `Asked the agent to improve ${target.title} · it replies in the agent pane`; update(); })),
        Effect.catch(error => Effect.sync(() => { message = error.message; update(); }))));
      return;
    }
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
    if (fileMode || asking) return;
    // The first click focuses the section; clicking the focused one folds it.
    if (focusSection === key) foldSection(key); else { focusSection = key; touched.add(key); scrollToSection = key; }
    update();
  };
  inspectorAsk.onMouseDown = event => {
    event.preventDefault(); event.stopPropagation();
    if (fileMode || help.visible || summary.visible || goto.visible || picker.visible || asking || pendingVisit) return;
    beginAsk();
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
    if (fileMode) { fileQuery = value; fileCursor = 0; message = ""; update(); }
  });
  nodeListText.onMouseDown = event => {
    if (help.visible || summary.visible || goto.visible || picker.visible || asking || pendingVisit) return;
    const node = diagram.nodes[event.y - nodeListText.y];
    if (node) selectNode(node, false);
  };
  viewport.onMouseDown = event => {
    if (editorActive || help.visible || summary.visible || goto.visible || picker.visible || asking || pendingVisit) return;
    focusSection = undefined;
    if (fileMode) { endFiles(); message = ""; }
    // Hit the displayed cell bounds, not the fractional world-space plane:
    // rounding can put a group's visible title just outside that plane.
    const entry = nodeObjects.filter(({ box }) => box.visible && event.x >= box.x && event.x < box.x + box.width
      && event.y >= box.y && event.y < box.y + box.height).sort((a, b) => b.node.level - a.node.level)[0];
    if (entry) selectNode(entry.node, false);
  };
  // A paste into the picker is text for the query, not keys.
  renderer.keyInput.on("paste", event => {
    if (!goto.visible) return;
    event.preventDefault();
    gotoQuery = (gotoQuery + new TextDecoder().decode(event.bytes).replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, 256); gotoIndex = 0; renderGoto();
  });
  renderer.keyInput.on("keypress", key => {
    if (editorActive) return;
    if (key.ctrl && key.name === "c") { key.preventDefault(); stop(); return; }
    if (pendingVisit) { key.preventDefault(); return; }
    if (asking) {
      if (key.name === "escape") { key.preventDefault(); finishAsk(); }
      else if (key.name === "tab") { key.preventDefault(); if (askMode === "ask") focusAsk(askFocus < 0 ? 0 : -1); }
      else if (askFocus >= 0) {
        key.preventDefault();
        if (key.name === "left" || key.name === "h") focusAsk((askFocus + 2) % 3);
        else if (key.name === "right" || key.name === "l") focusAsk((askFocus + 1) % 3);
        else if (key.name === "space" || key.sequence === " ") { askInclude[askFocus] = !askInclude[askFocus]; renderAsk(); }
      }
      else if (key.name === "return" && !key.meta && !key.option && !key.shift) { key.preventDefault(); sendAsk(); }
      return;
    }
    if (picker.visible) {
      key.preventDefault();
      if (key.name === "escape" || key.sequence === "T") cancelThemes();
      else if (key.name === "return") keepTheme();
      else if (key.name === "up" || key.name === "k") moveTheme(themeIndex - 1);
      else if (key.name === "down" || key.name === "j") moveTheme(themeIndex + 1);
      else if (key.name === "pageup") moveTheme(Math.max(0, themeIndex - themeRows()));
      else if (key.name === "pagedown") moveTheme(Math.min(themeNames.length - 1, themeIndex + themeRows()));
      else if (key.name === "home") moveTheme(0);
      else if (key.name === "end") moveTheme(themeNames.length - 1);
      else if (key.ctrl && key.name === "c") stop();
      return;
    }
    if (goto.visible) {
      key.preventDefault();
      const entries = gotoEntries(), page = gotoRows(entries.length);
      const move = (to: number) => { gotoIndex = entries.length ? (to + entries.length) % entries.length : 0; renderGoto(); };
      if (key.name === "escape") { goto.close(); update(); }
      else if (key.name === "return") {
        const entry = entries[gotoIndex];
        if (entry?.kind === "view") goToView(entry.view!);
        else if (entry) landOn(entry.element!, entry.path);
      }
      else if (key.name === "up" || (key.ctrl && key.name === "p")) move(gotoIndex - 1);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) move(gotoIndex + 1);
      else if (key.name === "pageup") { gotoIndex = Math.max(0, gotoIndex - page); renderGoto(); }
      else if (key.name === "pagedown") { gotoIndex = Math.min(Math.max(0, entries.length - 1), gotoIndex + page); renderGoto(); }
      else if (key.name === "home") { gotoIndex = 0; renderGoto(); }
      else if (key.name === "end") { gotoIndex = Math.max(0, entries.length - 1); renderGoto(); }
      else if (key.ctrl && key.name === "u") { gotoQuery = ""; gotoIndex = 0; renderGoto(); }
      else if (key.name === "backspace") { gotoQuery = gotoQuery.slice(0, -1); gotoIndex = 0; renderGoto(); }
      else if (key.ctrl && key.name === "c") stop();
      else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") { gotoQuery += key.sequence; gotoIndex = 0; renderGoto(); }
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
    if (!key.ctrl && !key.meta && replayKey(key)) return;
    if (!fileMode && !key.ctrl && !key.meta && /^[1-4]$/.test(key.sequence)) { key.preventDefault(); focusOn((["activity", activeFlow ? "steps" : "connections", "files", "flows"] as const)[Number(key.sequence) - 1] ?? "activity"); return; }
    if (focusSection && !fileMode) {
      const entry = sections[focusSection], key_ = focusSection;
      const items = key_ === "connections" ? connectionItems.length : key_ === "files" ? selectedPaths().length : key_ === "flows" ? flowItems.length : 0;
      const move = (step: number) => {
        if (key_ === "activity") { sections.activity.content.scrollBy(step * 2); return; }
        if (key_ === "steps") { goToStep(flowStep + step); return; }
        if (!items) return;
        if (key_ === "files") fileCursor = (fileCursor + step + items) % items; else cursor[key_] = (cursor[key_] + step + items) % items;
        scrollToSection = undefined; update();
      };
      if (key.name === "escape") { key.preventDefault(); focusSection = undefined; update(); return; }
      if (key.name === "tab") {
        key.preventDefault();
        const shown = shownSections();
        focusSection = shown[(Math.max(0, shown.indexOf(key_)) + (key.shift ? -1 : 1) + shown.length) % shown.length];
        if (focusSection) { sections[focusSection].open = true; scrollToSection = focusSection; }
        update(); return;
      }
      if (key.name === "space" || key.sequence === " ") { key.preventDefault(); entry.open = !entry.open; touched.add(key_); update(); return; }
      if (key.name === "up" || key.name === "k") { key.preventDefault(); move(-1); return; }
      if (key.name === "down" || key.name === "j") { key.preventDefault(); move(1); return; }
      if ((key.name === "left" || key.name === "h") && !key.shift) { key.preventDefault(); focusSection = undefined; update(); return; }
      if ((key.name === "right" || key.name === "l") && !key.shift) { key.preventDefault(); return; }
      if (key.name === "return") {
        key.preventDefault();
        if (key_ === "connections") {
          const target = diagram.nodes.find(node => String(node.id) === connectionItems[cursor.connections]);
          if (target) { message = ""; selectNode(target, true); }
        } else if (key_ === "files") {
          const path = selectedPaths()[fileCursor];
          if (path) openFile(path);
        } else if (key_ === "steps") goToStep(flowStep);
        else if (key_ === "flows") {
          const entry = flowItems[cursor.flows];
          if (entry) { focusSection = undefined; enterFlow(entry.flow, entry.steps[0]); }
        }
        return;
      }
    }
    if (!fileMode && key.sequence === "F") { key.preventDefault(); cycleFlow(); return; }
    if (!fileMode && activeFlow && !key.ctrl && !key.meta) {
      if (key.sequence === "]") { key.preventDefault(); goToStep(flowStep + 1); return; }
      if (key.sequence === "[") { key.preventDefault(); goToStep(flowStep - 1); return; }
      if (key.name === "escape") { key.preventDefault(); exitFlow(); return; }
    }
    if (!fileMode && key.sequence === "/") { key.preventDefault(); animating = false; beginGoto("all"); return; }
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
    if (!fileMode && key.name === "g" && !key.ctrl && !key.shift) { key.preventDefault(); beginGoto("views"); return; }
    if (!fileMode && key.name === "t" && !key.ctrl && key.sequence === "T") { key.preventDefault(); beginThemes(); return; }
    if (!fileMode && key.name === "t" && !key.ctrl) { key.preventDefault(); beginAsk(); return; }
    if (!fileMode && key.name === "m" && !key.ctrl) { key.preventDefault(); beginMap(); return; }
    if (!fileMode && key.name === "d" && !key.ctrl) { key.preventDefault(); beginFlow(); return; }
    if (!fileMode && key.name === "n" && !key.ctrl) { key.preventDefault(); beginName(); return; }
    if (!fileMode && key.name === "c" && !key.ctrl) {
      key.preventDefault(); summary.foot.content = new StyledText(borderHints([["esc", "close"]])); summary.open(60, 12); summary.content.content = summaryContent(); update(); return;
    }
    if (!fileMode && key.name === "p" && !key.ctrl) { key.preventDefault(); beginReplay(); return; }
    if (!fileMode && key.name === "w" && !key.ctrl) {
      key.preventDefault();
      const work = newestWork();
      // Going to the work is asking to watch it, so follow turns on with the jump (`a` stops it); a viewer with no session has nothing to follow.
      const startFollow = () => { if (binding || following) { followCamera = true; followPaused = false; focusedCall = ""; followSince = Date.now(); } };
      if (work && "node" in work) { message = ""; followSelecting = true; try { selectNode(work.node, true); } finally { followSelecting = false; } startFollow(); if (followCamera) message = "Following the work (a to stop)"; update(); }
      else if (work) {
        history.push(visit()); if (history.length > 32) history.shift();
        animating = false; startFollow(); pendingVisit = { diagram: getDiagram(work.view), select: work.element, notice: `Went to ${work.title}${followCamera ? " · following (a to stop)" : ""}` }; update();
      } else { message = binding || following ? "No recent activity maps to a node" : "Camera jump needs a bound session"; update(); }
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
    else if (key.name === "s") {
      showSubagents = !showSubagents;
      message = showSubagents ? "Subagent calls shown" : "Subagent calls hidden";
      if (replay) showStep(replay.index); else { events = visibleEvents(allEvents); indexEvents(); }
      update();
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
      selected = firstNode(diagram); fileCursor = 0; resetInspectorScroll(); message = next.notice ?? "";
      initialFit = false; animating = false;
      if (next.restore) restore(next.restore);
      else { autoFit = true; fit(); targetX = centerX; targetY = centerY; targetScale = scale; }
      if (next.select) selected = nodeForElement(next.select) ?? selected;
      if (next.file) showFile(next.file);
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
      for (const cell of rasterize(routes, point => projected(point.x, point.y), isCovered, selected ? String(selected.id) : undefined, edgeMarks())) {
        if (cell.t > drawn || cell.x < 0 || cell.y < 0 || cell.x >= viewport.width || cell.y >= viewport.height) continue;
        const fg = cell.tone === "out" ? palette.outgoing : cell.tone === "in" ? palette.incoming : cell.tone === "added" ? palette.green : cell.tone === "lost" ? palette.failure : cell.tone === "path" ? palette.purple : palette.edgeDim;
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
    yield* Effect.sync(loadFlows);
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
  yield* Effect.gen(function* () {
    const next = yield* readStale(view.workspace), nextDiff = yield* readDiff(view.workspace), nextPlan = yield* readPlan(view.workspace);
    if (next?.time !== stale?.time && stale !== undefined) loadFlows();
    if (JSON.stringify(next) !== JSON.stringify(stale) || JSON.stringify(nextDiff) !== JSON.stringify(diff) || JSON.stringify(nextPlan) !== JSON.stringify(plan)) { stale = next; diff = nextDiff; plan = nextPlan; dirty = true; if (!editorActive) update(); }
  }).pipe(Effect.repeat(Schedule.spaced("3 seconds")), Effect.forkScoped);
  if (binding || following) yield* Effect.gen(function* () {
    if (replay) {
      if (replay.playing && Date.now() >= replay.next) {
        replay.next = Date.now() + 1000 / replay.speed;
        if (replay.index >= replay.data.steps.length - 1) { replay.playing = false; update(); } else showStep(replay.index + 1);
      }
      return;
    }
    if (following) binding = (yield* latestBinding(view.workspace)) ?? binding;
    allEvents = binding ? yield* readActivity(view.workspace, binding) : [];
    events = visibleEvents(allEvents);
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
  // Flows are read after the first frame, so opening a view never waits for them.
  if (ready) loadFlows();
  if (ready) yield* io("Native.wait", () => Promise.race([stopped.promise, renderer.closed]));
  if (renderError !== undefined) return yield* Effect.fail(failure("Native.render", renderError));
}, Effect.scoped);
