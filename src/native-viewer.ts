import { BoxRenderable, FrameBufferRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, StyledText, type TextChunk, fg, bg, bold, dim, RGBA, createCliRenderer } from "@opentui/core";
import { THREE, ThreeCliRenderer } from "@opentui/three";
import { SplitPaneRenderable } from "opentui-split";
import { Effect, FiberSet, Schedule } from "effect";
import { watch } from "node:fs";
import { type View, acquireModel, validateActivityMapping } from "./catalog";
import { type ActivityBinding, type ActivityEvent, activityRows, formatAge, latestBinding, readActivity, readActivityConfig } from "./activity";
import { nodeFiles } from "./node-files";
import { openEditor } from "./editor";
import { askMessage, sendToPane } from "./ask";
import { type Hint, hintChunks, noticeStyle, palette, pill } from "./ui";
import { arrowGlyph, composeConnectors, terminalConnectors } from "./connectors";
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
if (!process.stdin.isTTY || !process.stdout.isTTY) return yield* Effect.fail(failure("Native.terminal", "The native viewer needs a terminal. Use c4view show to open a tmux pane."));
const renderer = yield* Effect.acquireRelease(io("Native.renderer", () => createCliRenderer({ exitOnCtrlC: false, exitSignals: [], consoleMode: "disabled", targetFps: 30, backgroundColor: palette.background })),
  renderer => io("Native.close", async () => { renderer.destroy(); await renderer.closed; }).pipe(Effect.orDie));
const stopped = Promise.withResolvers<void>();
const stop = () => stopped.resolve();
const displayed = Promise.withResolvers<void>();
let painted = false, closing = false;
let renderError: unknown;
let engine: ThreeCliRenderer | undefined;
let drawing: Promise<void> | undefined;
let refreshing = false;
const scene = new THREE.Scene();
const resources: { dispose(): void }[] = [];
const sceneResources: { dispose(): void }[] = [];
yield* Effect.addFinalizer(() => io("Native.graphics.close", async () => {
  closing = true; renderer.pause(); await drawing?.catch(() => {});
  engine?.destroy();
  for (const resource of sceneResources) resource.dispose();
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
  const inspectorScroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true });
  const inspectorTitle = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 0, fg: palette.text, wrapMode: "none" });
  const inspectorId = new TextRenderable(renderer, { selectable: false, flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  const relations = new TextRenderable(renderer, { selectable: false, width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "word" });
  const fileHeading = new TextRenderable(renderer, { selectable: false, height: 2, flexShrink: 0, fg: palette.muted });
  const fileRows = Array.from({ length: 5 }, (_, index) => new TextRenderable(renderer, { selectable: false, id: `file-${index}`, height: 1,
    flexShrink: 0, fg: palette.text, wrapMode: "none" }));
  const activityText = new TextRenderable(renderer, { selectable: false, width: "100%", flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  for (const child of [inspectorTitle, inspectorId, relations, fileHeading, ...fileRows, activityText]) inspectorScroll.add(child);
  inspector.add(inspectorScroll);
  const statusLeft = new TextRenderable(renderer, { selectable: false, height: 1, fg: palette.muted, wrapMode: "none" });
  const statusRight = new TextRenderable(renderer, { selectable: false, height: 1, fg: palette.muted, wrapMode: "none" });
  const footer = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", backgroundColor: palette.panel, paddingLeft: 1, paddingRight: 1 });
  footer.add(statusLeft); footer.add(statusRight);
  const shortcuts = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  const notice = new TextRenderable(renderer, { selectable: false, height: 1, flexShrink: 0, visible: false, fg: palette.text, wrapMode: "none" });
  // A floating dialog over a dimmed backdrop: rounded border, coloured title, body, and a row of key hints.
  const makeModal = (title: string, color: string) => {
    const scrim = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 19000, visible: false,
      backgroundColor: RGBA.fromValues(0.03, 0.04, 0.06, 0.7), onMouse(event) { event.preventDefault(); event.stopPropagation(); } });
    const panel = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 60, height: 10, border: true, borderStyle: "rounded", borderColor: color,
      backgroundColor: palette.panel, title: ` ${title} `, titleColor: color, titleAlignment: "left", paddingLeft: 2, paddingRight: 2, paddingTop: 1,
      zIndex: 20000, visible: false, flexDirection: "column" });
    const content = new TextRenderable(renderer, { selectable: false, fg: palette.text, wrapMode: "none", flexShrink: 0 });
    const foot = new TextRenderable(renderer, { selectable: false, fg: palette.muted, wrapMode: "none", flexShrink: 0, marginTop: 1 });
    panel.add(content); panel.add(foot);
    const place = (width: number, height: number) => {
      const w = Math.max(20, Math.min(width, renderer.width - 2)), h = Math.max(5, Math.min(height, renderer.height - 2));
      panel.width = w; panel.height = h;
      panel.left = Math.floor((renderer.width - w) / 2); panel.top = Math.max(1, Math.floor((renderer.height - h) / 3));
    };
    return { scrim, panel, content, foot, place,
      get visible() { return panel.visible; },
      open(width: number, height: number) { place(width, height); scrim.visible = panel.visible = true; },
      close() { scrim.visible = panel.visible = false; } };
  };
  const help = makeModal("Keyboard shortcuts", palette.incoming);
  const summary = makeModal("This session", palette.outgoing);
  const ask = makeModal("Ask the agent", palette.command);
  const askInput = new InputRenderable(renderer, { flexGrow: 1, maxLength: 400, placeholder: "What do you want to know about it?", backgroundColor: palette.background,
    textColor: palette.text, focusedBackgroundColor: palette.background });
  const askRow = new BoxRenderable(renderer, { height: 1, width: "100%", flexShrink: 0, flexDirection: "row", backgroundColor: palette.background, marginTop: 1 });
  askRow.add(new TextRenderable(renderer, { selectable: false, content: " › ", fg: palette.command, wrapMode: "none", flexShrink: 0 })); askRow.add(askInput);
  ask.panel.insertBefore(askRow, ask.foot);
  const searchShield = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 3, width: "100%", height: 1,
    zIndex: 10000, visible: false, shouldFill: false, onMouse(event) { event.preventDefault(); event.stopPropagation(); searchInput.focus(); } });
  viewport.add(canvas); body.addPane(viewport, Math.max(1, renderer.width - 39), 36); body.addPane(inspector, 38, 28);
  resources.push({ dispose() { if (!inspector.parent) inspector.destroyRecursively(); } });
  for (const child of [topBar, body, notice, footer, shortcuts, searchShield, help.scrim, help.panel, summary.scrim, summary.panel, ask.scrim, ask.panel]) renderer.root.add(child);
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
  let braille = true;
  let fileMode = false, fileCursor = 0, editorActive = false;
  let fileQuery = "";
  const selectedPaths = () => {
    const paths = files.get(String(selected?.modelRef ?? "")) ?? [];
    return fileMode ? paths.filter(path => path.toLowerCase().includes(fileQuery.trim().toLowerCase())) : paths;
  };
  let inspectorPreference: "auto" | "open" | "closed" = "auto";
  let layoutKey = "";
  let events: ActivityEvent[] = [];
  let byElement = new Map<string, ActivityEvent[]>();
  let byPath = new Map<string, ActivityEvent>();
  let followCamera = false, focusedCall = "", lastSignature = "", lastPaint = 0;
  // Which key family moves the selection; the other family pans. `v` swaps them.
  let vimTraverses = true;
  const selectKeys = () => vimTraverses ? "h j k l" : "Arrows";
  const panKeys = () => vimTraverses ? "Arrows" : "h j k l";
  // Two columns of keycaps and what they do; one column when the terminal is narrow.
  const helpContent = () => {
    const arrows = "← ↑ ↓ →";
    const navigate: Hint[] = [[vimTraverses ? "h j k l" : arrows, "select a neighbour"], [vimTraverses ? arrows : "h j k l", "pan"], ["+ -", "zoom"], ["f", "fit everything"],
      ["0", "actual size"], ["r", "centre the selection"], ["Tab", "next node"], ["Enter", "into a group / open a link"], ["Backspace", "up to the parent"],
      ["o", "open the linked view"], ["b", "back"]];
    const inspect: Hint[] = [["/", "search this view"], ["i", "toggle the inspector"], ["e", "browse mapped files"], ["t", "ask the agent about it"],
      ["w", "jump to the agent's work"], ["c", "what this session touched"], ["a", "camera follows the work"], ["v", "swap hjkl and arrows"],
      ["PgUp PgDn", "scroll the inspector"], ["?", "this help"], ["q", "quit"]];
    const keyWidth = 9;
    const cell = ([key, label]: Hint) => [bg(palette.keycap)(fg(palette.text)(` ${key.padEnd(keyWidth)} `)), fg(palette.muted)(` ${label}`)];
    const cellText = ([key, label]: Hint) => ` ${key.padEnd(keyWidth)}  ${label}`.length;
    const chunks: TextChunk[] = [];
    const wide = renderer.width >= 92;
    if (wide) {
      const column = 46;
      chunks.push(fg(palette.incoming)(bold("NAVIGATE".padEnd(column))), fg(palette.outgoing)(bold("INSPECT AND ACT")), nl, nl);
      for (let index = 0; index < Math.max(navigate.length, inspect.length); index++) {
        const left = navigate[index], right = inspect[index];
        if (left) chunks.push(...cell(left)); chunks.push(fg(palette.muted)(" ".repeat(Math.max(1, column - (left ? cellText(left) : 0)))));
        if (right) chunks.push(...cell(right));
        chunks.push(nl);
      }
    } else {
      chunks.push(fg(palette.incoming)(bold("NAVIGATE")), nl);
      for (const hint of navigate) chunks.push(...cell(hint), nl);
      chunks.push(nl, fg(palette.outgoing)(bold("INSPECT AND ACT")), nl);
      for (const hint of inspect) chunks.push(...cell(hint), nl);
    }
    return { content: new StyledText(chunks), lines: chunks.filter(chunk => chunk.text.includes("\n")).length };
  };
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const isActive = (event: ActivityEvent) => event.phase === "started" && Date.now() - event.time <= 30_000;
  const operationColor = (operation: ActivityEvent["operation"]) => operation === "edit" ? palette.outgoing : operation === "read" ? palette.incoming : operation === "command" ? palette.command : palette.muted;
  const mix = (from: string | RGBA, to: string | RGBA, amount: number) => {
    const a = typeof from === "string" ? RGBA.fromHex(from) : from, b = typeof to === "string" ? RGBA.fromHex(to) : to;
    return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount, 1);
  };
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
  const headingContent = () => new StyledText([fg(palette.incoming)("◆ "), fg(palette.muted)(bold("C4VIEW")), fg(palette.border)("  /  "),
    fg(palette.text)(bold(diagram.title ?? String(diagram.id)))]);
  // Right-hand badge: the live session when there is one, otherwise nothing at all.
  const badgeContent = () => {
    if (!binding && !following) return "";
    const busy = events.some(isActive);
    const label = `${busy ? spinner[Math.floor(Date.now() / 100) % spinner.length] : "●"} LIVE ${liveLabel()}`;
    // Filled only while the agent is actually working, so it draws the eye exactly when something is happening.
    return new StyledText([busy ? pill(label, palette.outgoing) : fg(binding ? palette.incoming : palette.muted)(` ${label} `)]);
  };
  let activityError = "";
  const layout = () => {
    const side = renderer.width >= 120;
    const visible = inspectorPreference === "open" || inspectorPreference === "auto" && (side || renderer.height >= 34);
    const key = `${side}/${visible}`;
    if (key === layoutKey) return;
    layoutKey = key;
    body.direction = side ? "horizontal" : "vertical";
    inspector.visible = visible;
    if (visible && !inspector.parent) body.addPane(inspector);
    else if (!visible && inspector.parent) body.remove(inspector);
    const total = side ? renderer.width : Math.max(1, renderer.height - 5 - (message ? 1 : 0));
    const panelSize = side ? Math.min(42, Math.max(32, Math.floor(renderer.width * 0.23))) : Math.min(10, Math.max(5, Math.floor(renderer.height / 3)));
    body.minSizes = visible ? [side ? 36 : 8, side ? 28 : 5] : [1];
    body.sizes = visible ? [Math.max(1, total - panelSize - 1), panelSize] : [total];
  };
  let message = "";
  const own = <T extends { dispose(): void }>(resource: T) => { sceneResources.push(resource); return resource; };
  const point = (x: number, y: number, z = 0) => new THREE.Vector3(x, -y, z);
  const color = (hex: string) => new THREE.Color(hex).convertLinearToSRGB();
  const mountNodes = () => diagram.nodes.map(node => {
    const z = node.level + 1;
    const box = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 1, height: 1,
      ...(node.children.length ? { border: true, borderStyle: "rounded" as const, borderColor: palette.border } : { border: false }), shouldFill: !node.children.length, backgroundColor: palette.node, zIndex: z,
      justifyContent: "center",
      title: node.children.length ? node.title : undefined });
    const label = new TextRenderable(renderer, { selectable: false, fg: palette.text, wrapMode: "word", content: node.children.length ? "" : node.title, marginLeft: 1, marginRight: 1 });
    box.add(label); viewport.add(box);
    return { node, box, label, ring: undefined as RGBA | undefined, rect: { x: 0, y: 0, width: 1, height: 1 } };
  });
  const mountEdges = () => diagram.edges.map(edge => {
    const points = edge.points.map(([x, y]) => point(x, y, 0));
    const path = new THREE.CurvePath<THREE.Vector3>();
    if (points.length >= 4 && (points.length - 1) % 3 === 0) {
      for (let i = 0; i + 3 < points.length; i += 3) {
        const a = points[i], b = points[i + 1], c = points[i + 2], d = points[i + 3];
        if (a && b && c && d) path.add(new THREE.CubicBezierCurve3(a, b, c, d));
      }
    } else for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a && b) path.add(new THREE.LineCurve3(a, b));
    }
    const material = own(new THREE.LineBasicMaterial({ color: color(palette.border) }));
    if (path.curves.length) scene.add(new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(path.getPoints(240))), material));
    const markers: { end: THREE.Vector3; direction: THREE.Vector3; label: TextRenderable; type: string | undefined }[] = [];
    const marker = (tail: boolean) => {
      const type = tail ? edge.tail : edge.head;
      if (type === "none" || tail && !type) return;
      const end = tail ? points[0] : points.at(-1);
      const neighbor = tail ? points.find(p => !p.equals(end ?? p)) : points.findLast(p => !p.equals(end ?? p));
      if (!end || !neighbor) return;
      const direction = end.clone().sub(neighbor).normalize();
      const label = new TextRenderable(renderer, { selectable: false, position: "absolute", width: 1, height: 1, content: "▶", fg: palette.border, bg: palette.background, zIndex: 1000 });
      viewport.add(label); markers.push({ end, direction, label, type });
    };
    marker(false); marker(true);
    return { edge, material, markers };
  });
  let nodeObjects = mountNodes();
  let edges = mountEdges();
  let previousWidth = 0, previousHeight = 0;
  let initialFit = true, stableLayoutFrames = 0;
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
    const p = point(x, y, 10).project(camera);
    return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
  };
  const nl = fg(palette.text)("\n");
  const innerWidth = () => Math.max(16, inspector.width - 3);
  const section = (title: string, tone: string, right = "") => [fg(tone)(bold(title)), fg(palette.border)(` ${"─".repeat(Math.max(2, innerWidth() - title.length - right.length - 2))} `), fg(palette.muted)(right)];
  const elementTitle = (id: string) => diagram.nodes.find(node => String(node.modelRef) === id)?.title ?? id.split(".").at(-1) ?? id;
  // Which element each rendered line of the activity list belongs to, so a click can select its node.
  let activityTargets: (string | undefined)[] = [];
  const activityContent = () => {
    activityTargets = [undefined, undefined];
    const activityTotal = events.length ? `${events.length} call${events.length > 1 ? "s" : ""}` : "";
    const header = [nl, ...section("ACTIVITY", palette.muted, activityTotal), nl];
    const note = (text: string, tone: string = palette.muted) => new StyledText([...header, fg(tone)(text)]);
    if (activityError) return note(activityError, palette.failure);
    const advice = (lines: string[]) => new StyledText([...header, ...lines.flatMap((line, index) => [fg(index === 0 ? palette.muted : palette.border)(line), ...(index < lines.length - 1 ? [nl] : [])])]);
    if (!binding && !following) return advice(["Not watching an agent session.", "Open this with /c4view in Claude Code,", "or: c4view show VIEW --follow"]);
    if (!config) return advice([`No activity mappings for ${view.project}.`, "Run c4view init to map files", "to the components in this model."]);
    if (!binding) return advice(["Waiting for an agent session", "to record its first tool call."]);
    const now = Date.now();
    const rows = activityRows(events, config, now, 64);
    const mapped = rows.filter(row => row.elements.length);
    if (!mapped.length) return note(rows.length ? `${rows.length} calls, none mapped to a component` : "Waiting for mapped activity");
    const groups = new Map<string, typeof mapped>();
    for (const row of mapped) groups.set(row.elements[0] ?? "", [...groups.get(row.elements[0] ?? "") ?? [], row]);
    const width = innerWidth();
    const spin = spinner[Math.floor(now / 100) % spinner.length] ?? "●";
    const chunks = [...header];
    for (const [element, group] of [...groups].slice(0, 4)) {
      const running = group.some(row => row.state === "started");
      const inView = diagram.nodes.some(node => String(node.modelRef) === element);
      chunks.push(fg(running ? operationColor(group.find(row => row.state === "started")?.operation ?? "other") : palette.muted)(running ? `${spin} ` : "● "),
        fg(palette.text)(bold(elementTitle(element))), ...(inView ? [] : [fg(palette.muted)("  other view")]), nl);
      activityTargets.push(element);
      const collapsed: { row: (typeof group)[number]; count: number }[] = [];
      for (const row of group) {
        const same = collapsed.find(entry => entry.row.operation === row.operation && entry.row.target === row.target);
        if (same) same.count++; else collapsed.push({ row, count: 1 });
      }
      for (const { row, count } of collapsed.slice(0, 3)) {
        const glyph = row.state === "started" ? spin : row.state === "completed" ? "✓" : row.state === "failed" ? "✗" : "?";
        const glyphTone = row.state === "failed" ? palette.failure : row.state === "started" ? operationColor(row.operation) : palette.muted;
        const badge = (row.operation === "command" ? "RUN" : row.operation.toUpperCase()).padEnd(4);
        const first = row.paths[0]?.split("/").at(-1) ?? row.target;
        const target = `${first}${row.paths.length > 1 ? ` +${row.paths.length - 1}` : ""}${count > 1 ? ` ×${count}` : ""}`;
        const age = formatAge(row.age);
        const room = Math.max(4, width - 2 - 2 - badge.length - 1 - age.length - 1);
        const shown = target.length > room ? `${target.slice(0, room - 1)}…` : target;
        chunks.push(fg(glyphTone)(`  ${glyph} `), fg(operationColor(row.operation))(`${badge} `), fg(palette.text)(shown),
          fg(palette.muted)(`${" ".repeat(Math.max(1, width - 2 - 2 - badge.length - 1 - shown.length - age.length))}${age}`), nl);
        activityTargets.push(element);
      }
    }
    const hidden = rows.length - mapped.length;
    // Edits to files no component claims are the useful kind of unmapped: they show where the mapping has a gap.
    const gaps = [...new Set(rows.filter(row => !row.elements.length && row.operation === "edit").flatMap(row => row.paths))];
    if (gaps.length) {
      chunks.push(nl, fg(palette.outgoing)(bold("NO COMPONENT")), fg(palette.muted)(`  ${gaps.length} edited file${gaps.length > 1 ? "s" : ""}\n`));
      for (const path of gaps.slice(0, 3)) chunks.push(fg(palette.muted)("  ✎ "), fg(palette.text)(`${path.length > width - 4 ? `…${path.slice(-(width - 5))}` : path}\n`));
    }
    if (hidden > 0) chunks.push(fg(palette.border)(`+${hidden} unmapped call${hidden > 1 ? "s" : ""}`));
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
      fg(palette.muted)(bold("COMPONENTS TOUCHED")), nl];
    for (const [element, entry] of [...byComponent].sort((a, b) => a[1].last - b[1].last).slice(0, 8)) {
      const name = elementTitle(element).padEnd(24).slice(0, 24);
      chunks.push(fg(palette.muted)("  ● "), fg(palette.text)(name), fg(palette.incoming)(`r${entry.reads}`.padEnd(5)), fg(palette.outgoing)(`e${entry.edits}`.padEnd(5)),
        fg(palette.command)(`c${entry.commands}`.padEnd(6)), fg(palette.muted)(formatAge(entry.last)), nl);
    }
    if (!byComponent.size) chunks.push(fg(palette.muted)("  none mapped"), nl);
    chunks.push(nl, fg(palette.muted)(bold("FILES EDITED")), nl);
    const files = [...edited].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    for (const [path, info] of files) {
      const room = width - 30;
      chunks.push(fg(palette.outgoing)("  ✎ "), fg(info.element ? palette.text : palette.failure)((path.length > room ? `…${path.slice(-(room - 1))}` : path).padEnd(Math.min(room, 40))),
        fg(palette.muted)(`×${info.count}  ${info.element ? elementTitle(info.element) : "no component"}`), nl);
    }
    if (!files.length) chunks.push(fg(palette.muted)("  no edits observed"), nl);
    chunks.push(nl, fg(palette.border)("Counts come from the retained calls, not totals. Commands show files they name."));
    summary.place(Math.min(100, renderer.width - 6), chunks.filter(chunk => chunk.text.includes("\n")).length + 7);
    return new StyledText(chunks);
  };
  const tickerContent = () => {
    if (!binding || !config) return undefined;
    const [row] = activityRows(events, config, Date.now(), 1);
    if (!row || row.age > 120_000) return undefined;
    const label = row.state === "started" ? row.operation.toUpperCase() : row.state === "completed" ? "done" : row.state === "failed" ? "FAIL" : "????";
    const tone = row.state === "failed" ? palette.failure : row.state === "started" ? operationColor(row.operation) : palette.muted;
    return [fg(tone)(" ● "), fg(tone)(bold(label)), fg(palette.text)(` ${row.target} `), fg(palette.muted)("→ "), fg(row.elements.length ? palette.incoming : palette.muted)(row.elements.join(", ") || "unmapped"),
      fg(palette.muted)(` · ${formatAge(row.age)}`)];
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
  const paintRings = () => {
    const bg = RGBA.fromHex(palette.background);
    for (const entry of nodeObjects) {
      if (!entry.ring || !entry.box.visible || entry.node.children.length) continue;
      const { x, y, width, height } = entry.rect, ring = entry.ring;
      const x0 = x - 1, y0 = y - 1, x1 = x + width, y1 = y + height;
      const put = (cx: number, cy: number, glyph: string) => { if (cx >= 0 && cy >= 0 && cx < viewport.width && cy < viewport.height) canvas.frameBuffer.setCell(cx, cy, glyph, ring, bg); };
      put(x0, y0, "╭"); put(x1, y0, "╮"); put(x0, y1, "╰"); put(x1, y1, "╯");
      for (let cx = x0 + 1; cx < x1; cx++) { put(cx, y0, "─"); put(cx, y1, "─"); }
      for (let cy = y0 + 1; cy < y1; cy++) { put(x0, cy, "│"); put(x1, cy, "│"); }
    }
  };
  // LikeC4's own description, flattened: the model is the single source of what a component is for.
  const describe = (node: typeof selected) => {
    const raw = node?.description as { txt?: string; md?: string } | null | undefined;
    const text = (raw?.txt ?? raw?.md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
    return text.length > 420 ? `${text.slice(0, 419)}…` : text;
  };
  // The element's LikeC4 colour as a faint tint on its card, so kinds (database, queue, external...) read at a glance.
  const hues: Record<string, string> = { primary: "#4f8bd8", blue: "#4f8bd8", secondary: "#7a7fe0", indigo: "#6d6fe0", sky: "#4db8e8",
    green: "#4fbf7f", amber: "#e0a63c", red: "#e0605f", gray: "#8a97a6", slate: "#7d8da0", muted: "#8a97a6" };
  const cardColor = (node: { color?: unknown }) => { const hue = hues[String(node.color ?? "")]; return hue ? mix(palette.node, hue, 0.1) : RGBA.fromHex(palette.node); };
  const update = () => {
    layout();
    headingText.content = headingContent(); badgeText.content = badgeContent();
    crumbHint.content = new StyledText(hintChunks([["t", "ask"], ["c", "session"], ["?", "help"]], 36));
    breadcrumb.content = search ? new StyledText([fg(palette.incoming)(bold(`Search ${search.matches.length ? search.index + 1 : 0}/${search.matches.length}`)), fg(palette.muted)(" · Enter keep · Esc cancel")])
      : `${view.project} / ${diagram.id}  ·  ${diagram.nodes.length} nodes  ·  ${diagram.edges.length} relationships  ·  Back: ${history.length}`;
    searchShield.visible = !!search;
    searchShield.height = Math.max(1, renderer.height - 5);
    const worldWidth = Math.max(1, viewport.width) * scale;
    const worldHeight = Math.max(1, viewport.height) * scale / cellAspect();
    camera.left = -worldWidth / 2; camera.right = worldWidth / 2;
    camera.top = worldHeight / 2; camera.bottom = -worldHeight / 2;
    camera.position.set(centerX, -centerY, 1000); camera.lookAt(centerX, -centerY, 0);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    let hidden = 0;
    for (const entry of nodeObjects) {
      const related = byElement.get(String(entry.node.modelRef)) ?? [];
      const reads = related.filter(event => event.operation === "read").length, edits = related.filter(event => event.operation === "edit").length;
      const runs = related.filter(event => event.operation === "command").length;
      const counts = [reads && `r${reads}`, edits && `e${edits}`, runs && `c${runs}`].filter(Boolean).join(" ");
      const countChunks = (r: number, e: number, c: number) => [...r ? [fg(palette.incoming)(`r${r} `)] : [], ...e ? [fg(palette.outgoing)(`e${e} `)] : [], ...c ? [fg(palette.command)(`c${c}`)] : []];
      const active = related.filter(isActive);
      const recent = related.find(event => Date.now() - event.time <= 5000);
      const state = active.length ? active.some(event => event.operation === "edit") ? "EDIT" : active.some(event => event.operation === "read") ? "READ" : "RUN"
        : recent?.phase === "failed" ? "FAILED" : recent?.phase === "completed" ? "DONE" : "";
      const incoming = diagram.edges.some(edge => edge.target === selected?.id && edge.source === entry.node.id);
      const outgoing = diagram.edges.some(edge => edge.source === selected?.id && edge.target === entry.node.id);
      // Leaves are borderless cards; their ring is painted on the canvas just outside them (see paintRings).
      const emphasis: string | RGBA | undefined = entry.node.id === selected?.id ? palette.text : state === "FAILED" ? palette.failure
        : state === "EDIT" || outgoing ? palette.outgoing : state === "READ" || incoming ? palette.incoming : state === "RUN" ? palette.command : undefined;
      const outline = (color: string | RGBA | undefined) => { if (entry.node.children.length) entry.box.borderColor = color ?? palette.border; else entry.ring = color === undefined ? undefined : typeof color === "string" ? RGBA.fromHex(color) : color; };
      outline(emphasis);
      if (active.length && entry.node.id !== selected?.id) {
        const pulse = RGBA.fromHex(state === "EDIT" ? palette.outgoing : state === "RUN" ? palette.command : palette.incoming);
        const brightness = 0.72 + 0.28 * (1 + Math.sin(Date.now() / 220)) / 2;
        pulse.r *= brightness; pulse.g *= brightness; pulse.b *= brightness;
        outline(pulse);
      }
      // Where work has recently happened: a tint that cools in coarse steps (so a finished call stops changing the screen).
      const latest = related.reduce<ActivityEvent | undefined>((best, event) => !best || event.time > best.time ? event : best, undefined);
      const warmth = !latest ? 0 : Date.now() - latest.time < 10_000 ? 3 : Date.now() - latest.time < 30_000 ? 2 : Date.now() - latest.time < 90_000 ? 1 : 0;
      entry.box.backgroundColor = entry.node.id === selected?.id ? "#233343"
        : entry.node.children.length ? palette.background : warmth && latest ? mix(cardColor(entry.node), operationColor(latest.operation), warmth * 0.07) : cardColor(entry.node);
      const origin = projected(entry.node.x, entry.node.y);
      const end = projected(entry.node.x + entry.node.width, entry.node.y + entry.node.height);
      const width = Math.max(2, Math.round(end.x) - Math.round(origin.x));
      const height = Math.max(2, Math.round(end.y) - Math.round(origin.y));
      entry.box.left = Math.round(origin.x); entry.box.top = Math.round(origin.y);
      entry.box.width = width; entry.box.height = height;
      entry.rect = { x: Math.round(origin.x), y: Math.round(origin.y), width, height };
      if (entry.node.children.length) entry.box.title = `${entry.node.title}${state ? ` [${state}]` : ""}${counts ? ` ·${counts}` : ""}`;
      else entry.label.content = new StyledText([fg(palette.text)(labelTitle(entry.node.title, width - 2, height, !!(state || counts))),
        ...(state || counts ? [nl, ...(state ? [fg(operationColor(state === "EDIT" ? "edit" : state === "READ" ? "read" : state === "RUN" ? "command" : "other"))(`[${state}]`)] : []),
          ...(counts ? [fg(palette.text)(state ? " " : ""), ...countChunks(reads, edits, runs)] : [])] : [])]);
      entry.box.visible = end.x > 0 && end.y > 0 && origin.x < viewport.width && origin.y < viewport.height;
      const bloom = Math.min(1, Math.max(0, (easeOut(revealProgress()) - (diagram.bounds.width ? (entry.node.x - diagram.bounds.x) / diagram.bounds.width * 0.45 : 0)) / 0.55));
      if (bloom < 1) { if (entry.ring) entry.ring = fade(entry.ring, bloom); if (entry.node.children.length) entry.box.borderColor = fade(entry.box.borderColor, bloom); entry.box.backgroundColor = fade(entry.box.backgroundColor, bloom); }
      entry.label.visible = width >= 6 && height >= 2 && bloom >= 0.7;
      if (!entry.label.visible) { if (bloom >= 0.7) hidden++; continue; }
    }
    for (const { edge, material, markers } of edges) {
      const hex = edge.source === selected?.id ? palette.outgoing : edge.target === selected?.id ? palette.incoming : palette.border;
      material.color.copy(color(hex));
      for (const { end, direction, label, type } of markers) {
        const tip = projected(end.x, -end.y);
        const dx = direction.x, dy = -direction.y * cellAspect();
        const length = Math.hypot(dx, dy);
        let x = Math.floor(tip.x), y = Math.floor(tip.y);
        const covered = () => nodeObjects.some(({ node }) => {
          const a = projected(node.x, node.y), b = projected(node.x + node.width, node.y + node.height);
          const left = Math.round(a.x), top = Math.round(a.y), right = Math.max(left + 2, Math.round(b.x)) - 1, bottom = Math.max(top + 2, Math.round(b.y)) - 1;
          return x >= left && x <= right && y >= top && y <= bottom
            && (!node.children.length || x === left || x === right || y === top || y === bottom);
        });
        for (let step = 1; step <= 32 && covered(); step++) { x = Math.floor(tip.x - dx / length * step); y = Math.floor(tip.y - dy / length * step); }
        label.left = x; label.top = y; label.fg = hex;
        label.visible = !braille && x >= 0 && y >= 0 && x < viewport.width && y < viewport.height && !covered();
        label.content = type === "diamond" ? "◆" : type === "odiamond" ? "◇" : type === "dot" ? "●" : type === "odot" ? "○"
          : arrowGlyph(dx, dy);
      }
    }
    const paths = selectedPaths();
    inspectorTitle.content = new StyledText([fg(palette.text)(bold(selected?.title ?? "No selection"))]);
    const facts = [selected?.technology, `${paths.length} file${paths.length === 1 ? "" : "s"}`, selected?.navigateTo ? `o opens ${selected.navigateTo}` : undefined].filter(Boolean).join(" · ");
    const hue = hues[String(selected?.color ?? "")] ?? palette.muted;
    const kindChip = selected?.kind ? [bg(mix(palette.panel, hue, 0.22))(fg(hue)(bold(` ${selected.kind} `))), fg(palette.muted)("  ")] : [];
    const description = describe(selected);
    inspectorId.content = new StyledText([...kindChip, fg(palette.muted)(`${selected?.id ?? ""}\n`), fg(palette.muted)(facts),
      ...(description ? [nl, nl, fg(palette.text)(description)] : [])]);
    const name = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const incoming = diagram.edges.filter(edge => edge.target === selected?.id);
    const outgoing = diagram.edges.filter(edge => edge.source === selected?.id);
    const link = (arrow: string, tone: string, node: string, label: string | null | undefined) =>
      [fg(tone)(`${arrow} `), fg(palette.text)(`${name(node)}\n`), fg(palette.muted)(`  ${label?.replace(/\s+/g, " ").trim() || "Unlabeled relationship"}\n`)];
    relations.content = new StyledText([
      nl, ...section("INCOMING", palette.incoming, String(incoming.length)), nl,
      ...(incoming.length ? incoming.flatMap(edge => link("←", palette.incoming, edge.source, edge.label)) : [fg(palette.muted)("None\n")]),
      nl, ...section("OUTGOING", palette.outgoing, String(outgoing.length)), nl,
      ...(outgoing.length ? outgoing.flatMap(edge => link("→", palette.outgoing, edge.target, edge.label)) : [fg(palette.muted)("None\n")]),
    ]);
    fileHeading.content = new StyledText([nl, ...(fileMode
      ? [fg(palette.outgoing)(bold(`Files ${paths.length ? fileCursor + 1 : 0}/${paths.length}`))]
      : section("FILES", palette.muted, `${paths.length}  e browse`))]);
    const start = Math.floor(fileCursor / fileRows.length) * fileRows.length;
    fileRows.forEach((row, index) => {
      const path = paths[start + index];
      row.visible = !!path || index === 0;
      if (path) {
        const slash = path.lastIndexOf("/") + 1;
        const touched = byPath.get(path);
        row.content = new StyledText([fg(palette.outgoing)(`${fileMode && fileCursor === start + index ? "›" : " "} `), fg(palette.muted)(path.slice(0, slash)),
          fg(touched ? operationColor(touched.operation) : palette.text)(touched ? bold(path.slice(slash)) : path.slice(slash))]);
      } else row.content = new StyledText([fg(palette.muted)(fileError || (config ? "No direct file mappings" : "Map files in c4view.activity.json"))]);
      row.bg = fileMode && fileCursor === start + index ? "#294052" : palette.panel;
      // First click highlights a row; clicking the highlighted row again opens it.
      row.onMouseDown = event => { event.preventDefault(); event.stopPropagation(); if (!path || help.visible || summary.visible || search) return;
        if (fileMode && clickedFile === start + index) { openFile(path); return; }
        if (!fileMode) beginFiles();
        fileCursor = clickedFile = start + index; message = "Click again or Enter to open · Esc or click the diagram to go back"; searchInput.focus(); update(); };
    });
    activityText.content = activityContent();
    if (summary.visible) summary.content.content = summaryContent();
    body.gutterOptions = { color: fileMode ? palette.outgoing : palette.border };
    const mode = fileMode ? { name: "FILES", color: palette.outgoing } : search ? { name: "SEARCH", color: palette.incoming } : { name: "VIEW", color: palette.incoming };
    statusLeft.content = new StyledText([pill(mode.name, mode.color), fg(palette.muted)("  Selected: "), fg(palette.text)(bold(String(selected?.id ?? "")))]);
    statusRight.content = new StyledText([...(braille ? [] : [fg(palette.outgoing)("GPU + Three camera  ·  ")]), ...(hidden ? [fg(palette.border)(`${hidden} labels hidden  ·  `)] : []), fg(palette.muted)(`Zoom: ${Math.round(16 / scale * 100)}%`)]);
    const ticker = tickerContent();
    const navigation: Hint[] = [[selectKeys(), "select"], [vimTraverses ? "←↑↓→" : "h j k l", "pan"], ["+ -", "zoom"], ["/", "search"], ["f", "fit"], ["e", "files"], ["i", "inspector"]];
    shortcuts.content = new StyledText(search ? [fg(palette.muted)(" Type a name or ID   "), ...hintChunks([["↑↓", "matches"], ["Enter", "keep"], ["Esc", "restore"]], renderer.width - 22)]
      : fileMode ? [fg(palette.outgoing)(bold(` Files ${paths.length ? fileCursor + 1 : 0}/${paths.length}`)), fg(palette.muted)("   Type to filter   "), ...hintChunks([["Enter", "open"], ["Ctrl+R", "refresh"], ["Esc", "back"]], renderer.width - 40)]
      : ticker ?? (!inspector.visible && selected && describe(selected)
        ? [fg(palette.text)(bold(` ${selected.title}`)), fg(palette.muted)(`  ${describe(selected)}`.slice(0, Math.max(0, renderer.width - selected.title.length - 4)))]
        : hintChunks(navigation, renderer.width)));
    notice.visible = !!message;
    if (message) { const style = noticeStyle(message); notice.content = new StyledText([fg(style.color)(` ${style.glyph} `), fg(palette.text)(message)]); }
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
  // Opt-in only (key `a`): glide to the node of the newest running call without changing the selection.
  const followActivity = () => {
    const latest = events.find(isActive);
    if (!followCamera || !latest || latest.call === focusedCall) return;
    const elements = new Set(rules.filter(rule => latest.paths.some(path => rule.match.match(path))).map(rule => rule.element));
    const target = diagram.nodes.filter(node => elements.has(String(node.modelRef))).sort((a, b) => a.children.length - b.children.length)[0];
    focusedCall = latest.call;
    if (target) reveal(target);
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
    selected = node; fileCursor = 0; inspectorScroll.scrollTo(0);
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
    return { files: files.get(String(target.modelRef ?? "")) ?? [], links };
  };
  const beginAsk = () => {
    if (!options.parent) { message = "Ask needs the viewer opened with c4view show, which knows your agent's pane"; update(); return; }
    if (!selected) return;
    asking = selected; animating = false;
    const context = askContext(selected);
    ask.content.content = new StyledText([fg(palette.muted)("About  "), fg(palette.text)(bold(selected.title)), fg(palette.muted)(`  ${selected.id}`), nl,
      fg(palette.muted)("Sends  "), fg(palette.text)(`${context.files.length} file${context.files.length === 1 ? "" : "s"} · ${context.links.length} connection${context.links.length === 1 ? "" : "s"}`),
      fg(palette.muted)("  with it")]);
    const inner = Math.min(76, renderer.width - 4) - 6;
    ask.foot.content = new StyledText(hintChunks([["Enter", "type it in"], ["Alt+Enter", "send"], ["Esc", "cancel"]], inner));
    askInput.value = "";
    ask.open(Math.min(76, renderer.width - 4), 10);
    askInput.focus(); message = ""; update();
  };
  const finishAsk = () => { asking = undefined; askInput.blur(); ask.close(); update(); };
  const sendAsk = (submit: boolean) => {
    const target = asking, parent = options.parent, question = askInput.value.trim();
    if (!target || !parent) return;
    if (!question) { message = "Type a question first"; update(); return; }
    const context = askContext(target);
    const text = askMessage({ title: target.title, id: String(target.id), files: context.files, links: context.links }, question);
    finishAsk(); message = "Sending…"; update();
    runTask(sendToPane(parent, text, submit).pipe(
      Effect.tap(command => Effect.sync(() => { message = submit ? `Sent to ${parent} (${command})` : `Typed into ${parent} (${command}) · press Enter there to send`; update(); })),
      Effect.catch(error => Effect.sync(() => { message = error.message; update(); }))));
  };
  let clickedFile = -1;
  const endFiles = () => { clickedFile = -1; fileMode = false; searchInput.blur(); searchRow.visible = false; heading.visible = true; };
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
    fileMode = true; fileCursor = 0; fileQuery = ""; inspectorPreference = "open"; message = fileError;
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
  viewport.onMouseDown = event => {
    if (editorActive || help.visible || summary.visible || search || asking || pendingVisit) return;
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
      else if (key.name === "return") { key.preventDefault(); sendAsk(key.meta || key.option); }
      return;
    }
    if (summary.visible) {
      key.preventDefault();
      if (key.name === "escape" || key.name === "c" || key.sequence === "?") { summary.close(); update(); }
      return;
    }
    if (help.visible) { key.preventDefault(); if (key.name === "escape" || key.sequence === "?") help.close();
      else if (key.ctrl && key.name === "c") stop(); return; }
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
    if (!fileMode && key.name === "t" && !key.ctrl) { key.preventDefault(); beginAsk(); return; }
    if (!fileMode && key.name === "c" && !key.ctrl) {
      key.preventDefault(); summary.foot.content = new StyledText(hintChunks([["Esc", "close"]], 40)); summary.open(60, 12); summary.content.content = summaryContent(); update(); return;
    }
    if (!fileMode && key.name === "w" && !key.ctrl) {
      key.preventDefault();
      const target = newestWorkNode();
      if (target) { message = ""; selectNode(target, true); } else { message = binding || following ? "No recent activity maps to a node in this view" : "Camera jump needs a bound session"; update(); }
      return;
    }
    if (!fileMode && key.name === "v" && !key.ctrl) {
      key.preventDefault(); vimTraverses = !vimTraverses;
      message = vimTraverses ? "hjkl select nodes, arrows pan" : "Arrows select nodes, hjkl pan"; update(); return;
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
        const step = key.name === "pageup" || key.name === "pagedown" ? fileRows.length : 1;
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
    } else if (key.sequence === "?") { const guide = helpContent(); help.content.content = guide.content; help.foot.content = new StyledText(hintChunks([["Esc", "close"]], 40)); help.open(Math.min(96, renderer.width - 4), guide.lines + 7); }
    else if (key.name === "i") { inspectorPreference = inspector.visible ? "closed" : "open"; }
    else if (key.name === "pageup" || key.name === "pagedown") { inspectorScroll.scrollBy(key.name === "pageup" ? -5 : 5); }
    else if (key.name === "a") {
      followCamera = !followCamera; focusedCall = "";
      message = followCamera ? (binding || following ? "Camera follows running tools (a to stop)" : "Camera follow needs a bound session") : "Camera follow off";
      if (followCamera) followActivity();
    }
    else if (key.name === "g") { braille = !braille; message = ""; }
    else if (key.name === "s") { engine?.toggleSuperSampling(); message = "Sampling changed: compare line continuity"; }
    else if (key.name === "e") beginFiles();
    else if (key.name === "tab") {
      const index = diagram.nodes.findIndex(node => node.id === selected?.id);
      selected = diagram.nodes[(index + (key.shift ? -1 : 1) + diagram.nodes.length) % diagram.nodes.length];
      fileCursor = 0; inspectorScroll.scrollTo(0);
    } else if (key.name === "+" || key.name === "=" || key.sequence === "+") scale = Math.max(2, scale / 1.25);
    else if (key.name === "-" || key.sequence === "-") scale = Math.min(128, scale * 1.25);
    else if (direction === "left") centerX -= scale * 6;
    else if (direction === "right") centerX += scale * 6;
    else if (direction === "down") centerY += scale * 3 / cellAspect();
    else if (direction === "up") centerY -= scale * 3 / cellAspect();
    else if (key.name === "f") fit();
    else if (key.name === "0") scale = 16;
    else if (key.name === "r" && selected) { centerX = selected.x + selected.width / 2; centerY = selected.y + selected.height / 2; }
    if (centerX !== before.x || centerY !== before.y || scale !== before.scale) {
      animateTo(); centerX = before.x; centerY = before.y; scale = before.scale;
    }
    update();
  });
  let fileRevealKey = "";
  renderer.on("frame", () => {
    if (!initialFit && painted && revealProgress() >= 1) displayed.resolve();
    const key = fileMode ? `${fileQuery}/${fileCursor}/${inspectorScroll.viewport.width}/${inspectorScroll.viewport.height}` : "";
    if (key === fileRevealKey) return;
    fileRevealKey = key;
    if (fileMode) inspectorScroll.scrollChildIntoView(`file-${fileCursor % fileRows.length}`);
  });
  engine = new ThreeCliRenderer(renderer, { width: Math.max(1, renderer.width), height: Math.max(1, renderer.height - 7), autoResize: false, backgroundColor: RGBA.fromHex(palette.background) });
  yield* io("Native.graphics.init", () => engine.init()).pipe(Effect.uninterruptible);
  engine.setActiveCamera(camera);
  const activeEngine = engine;
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
        for (const entry of edges) for (const marker of entry.markers) { viewport.remove(marker.label); marker.label.destroyRecursively(); }
        scene.clear();
        for (const resource of sceneResources.splice(0)) resource.dispose();
        diagrams = next.diagrams; config = next.config; files = next.files; fileError = next.fileError;
        rules = config?.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) })) ?? [];
        diagram = target;
        nodeObjects = mountNodes(); edges = mountEdges();
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
      for (const entry of edges) for (const marker of entry.markers) { viewport.remove(marker.label); marker.label.destroyRecursively(); }
      scene.clear();
      for (const resource of sceneResources.splice(0)) resource.dispose();
      diagram = next.diagram;
      nodeObjects = mountNodes(); edges = mountEdges();
      selected = diagram.nodes[0]; fileCursor = 0; inspectorScroll.scrollTo(0); message = "";
      initialFit = false; animating = false;
      if (next.restore) restore(next.restore);
      else { fit(); targetX = centerX; targetY = centerY; targetScale = scale; }
      update();
    }
    layout();
    if (redrawAfterResize) { dirty = true; redrawAfterResize = false; }
    if (previousWidth !== viewport.width || previousHeight !== viewport.height) {
      stableLayoutFrames = 0;
      previousWidth = viewport.width; previousHeight = viewport.height;
      canvas.width = Math.max(1, viewport.width); canvas.height = Math.max(1, viewport.height);
      redrawAfterResize = true;
      activeEngine.setSize(Math.max(1, viewport.width), Math.max(1, viewport.height), true);
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
    paintGrid(); paintRings();
    drawing = (async () => {
      if (braille) {
        const nodes = diagram.nodes.map(node => {
          const a = projected(node.x, node.y), b = projected(node.x + node.width, node.y + node.height);
          return { x: Math.round(a.x), y: Math.round(a.y), width: Math.max(2, Math.round(b.x) - Math.round(a.x)), height: Math.max(2, Math.round(b.y) - Math.round(a.y)), children: node.children };
        });
        const projectedEdges = diagram.edges.map(edge => {
          const coordinates = edge.points.map(([x, y]): [number, number] => { const p = projected(x, y); return [p.x * 16, p.y * 32]; });
          const first = coordinates[0];
          if (!first) throw new Error("Empty edge geometry");
          const points: [[number, number], ...[number, number][]] = [first, ...coordinates.slice(1)];
          return { ...edge, points };
        });
        const routes = terminalConnectors({ bounds: { x: 32, y: 32 }, edges: projectedEdges }, nodes);
        const bg = RGBA.fromHex(palette.background);
        const drawn = easeOut(revealProgress()) * 1.05;
        for (const cell of composeConnectors(routes, selected?.id)) {
          if (cell.t > drawn || cell.glyph === "\u2800") continue;
          if (cell.x < 0 || cell.y < 0 || cell.x >= viewport.width || cell.y >= viewport.height) continue;
          // Quiet connections brighten toward their arrowhead: a static cue for direction, not an animation of traffic.
          const fg = cell.emphasis === "outgoing" ? RGBA.fromHex(palette.outgoing) : cell.emphasis === "incoming" ? RGBA.fromHex(palette.incoming)
            : mix(palette.edgeLow, palette.edgeHigh, Math.min(1, Math.max(0, cell.t)));
          canvas.frameBuffer.setCell(cell.x, cell.y, cell.glyph, fg, bg);
        }
      } else await activeEngine.drawScene(scene, canvas.frameBuffer, 0);
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
    && /\.(c4|likec4)$|(^|\/)(likec4\.config\.(json|js|ts)|\.likec4rc|c4view\.activity\.json)$/.test(name);
  yield* Effect.acquireRelease(Effect.try({ try: () => watch(view.workspace, { recursive: true }, (_event, name) => { if (name && relevant(String(name))) scheduleReload(); }), catch: cause => failure("Native.watch", cause) }).pipe(
    Effect.catch(() => Effect.sync(() => { message = "Live reload unavailable: the model will not update until the viewer is reopened"; return undefined; }))),
    watcher => Effect.sync(() => { clearTimeout(reloadTimer); watcher?.close(); }));
  if (binding || following) yield* Effect.gen(function* () {
    if (following) binding = (yield* latestBinding(view.workspace)) ?? binding;
    events = binding ? yield* readActivity(view.workspace, binding) : [];
    const signature = `${binding?.session}/${events.map(event => `${event.call}${event.phase}`).join()}`;
    const changed = signature !== lastSignature;
    lastSignature = signature;
    indexEvents(); followActivity();
    // Idle polls only refresh ages and tints every couple of seconds; a running call keeps the spinner moving.
    if (changed || events.some(isActive) || Date.now() - lastPaint > 2000) { activityError = ""; lastPaint = Date.now(); if (!editorActive) update(); }
  }).pipe(Effect.catch(() => Effect.sync(() => { activityError = "Activity unavailable"; if (!editorActive) update(); })),
    Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped);
  renderer.start(); update();
  const ready = yield* io("Native.firstFrame", () => Promise.race([displayed.promise.then(() => true), stopped.promise.then(() => false), renderer.closed.then(() => false)]));
  if (ready && options.ready) yield* writeReady(options.ready, { ready: true });
  if (ready) yield* io("Native.wait", () => Promise.race([stopped.promise, renderer.closed]));
  if (renderError !== undefined) return yield* Effect.fail(failure("Native.render", renderError));
}, Effect.scoped);
