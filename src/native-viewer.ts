import { BoxRenderable, FrameBufferRenderable, InputRenderable, ScrollBoxRenderable, TextRenderable, StyledText, fg, RGBA, createCliRenderer } from "@opentui/core";
import { THREE, ThreeCliRenderer } from "@opentui/three";
import { SplitPaneRenderable } from "opentui-split";
import { Effect, FiberSet, Schedule } from "effect";
import { type View, acquireModel, validateActivityMapping } from "./catalog";
import { type ActivityBinding, type ActivityEvent, activityRows, formatAge, latestBinding, readActivity, readActivityConfig } from "./activity";
import { nodeFiles } from "./node-files";
import { openEditor } from "./editor";
import { composeConnectors, terminalConnectors } from "./connectors";
import { attempt, failure, hasCode, io } from "./effects";
import { writeReady } from "./ready";

export const viewNative = Effect.fn("Native.view")(function* (options: { view: View; activity?: ActivityBinding; follow?: boolean; ready?: string }) {
const view = options.view;
let binding = options.activity;
const following = options.follow === true;
const loadedConfig = yield* readActivityConfig(view.workspace).pipe(
  Effect.catchIf(error => !binding && !following && hasCode(error, "ENOENT"), () => Effect.succeed(undefined)));
const config = binding || following || loadedConfig?.project === view.project ? loadedConfig : undefined;
if (config) yield* validateActivityMapping(view, config);
let fileError = "";
let files = yield* nodeFiles(view.workspace, config).pipe(Effect.catch(error => Effect.sync(() => {
  fileError = error.message; return new Map<string, string[]>();
})));
const diagrams = yield* Effect.gen(function* () {
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
const rules = config?.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) })) ?? [];
const palette = { background: "#0f141b", panel: "#151d27", node: "#1b2532", border: "#526171", muted: "#93a4b5",
  text: "#e7eff7", incoming: "#68cfda", outgoing: "#e9bd70", command: "#b79cf2", failure: "#f08080" };
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
  const topBar = new BoxRenderable(renderer, { height: 3, flexShrink: 0, border: ["bottom"], borderColor: palette.border, paddingLeft: 1 });
  const heading = new TextRenderable(renderer, { height: 1, fg: palette.text, wrapMode: "none" });
  const breadcrumb = new TextRenderable(renderer, { height: 1, fg: palette.muted, wrapMode: "none",
    content: `${view.project} / ${diagram.id}  ·  ${diagram.nodes.length} nodes  ·  ${diagram.edges.length} relationships` });
  topBar.add(heading); topBar.add(breadcrumb);
  const searchInput = new InputRenderable(renderer, { width: "100%", visible: false, maxLength: 256,
    placeholder: "Search nodes in this view", backgroundColor: palette.panel, textColor: palette.text });
  topBar.insertBefore(searchInput, breadcrumb);
  const body = new SplitPaneRenderable(renderer, { flexGrow: 1, flexBasis: 0, minHeight: 1, direction: "horizontal",
    gutterOptions: { color: palette.border } });
  const viewport = new BoxRenderable(renderer, { minHeight: 1, overflow: "hidden" });
  const canvas = new FrameBufferRenderable(renderer, { position: "absolute", left: 0, top: 0, width: renderer.width, height: Math.max(1, renderer.height - 7) });
  const inspector = new BoxRenderable(renderer, { width: 38, flexShrink: 0, border: false,
    paddingLeft: 1, paddingRight: 1, backgroundColor: palette.panel });
  const inspectorScroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true });
  const inspectorTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, fg: palette.text, wrapMode: "none" });
  const inspectorId = new TextRenderable(renderer, { height: 2, flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  const relations = new TextRenderable(renderer, { width: "100%", flexShrink: 0, fg: palette.text, wrapMode: "word" });
  const fileHeading = new TextRenderable(renderer, { height: 2, flexShrink: 0, fg: palette.muted });
  const fileRows = Array.from({ length: 5 }, (_, index) => new TextRenderable(renderer, { id: `file-${index}`, height: 1,
    flexShrink: 0, fg: palette.text, wrapMode: "none" }));
  const activityText = new TextRenderable(renderer, { width: "100%", flexShrink: 0, fg: palette.muted, wrapMode: "word" });
  for (const child of [inspectorTitle, inspectorId, relations, fileHeading, ...fileRows, activityText]) inspectorScroll.add(child);
  inspector.add(inspectorScroll);
  const footer = new TextRenderable(renderer, { height: 1, flexShrink: 0, fg: palette.muted, bg: palette.panel, wrapMode: "none" });
  const shortcuts = new TextRenderable(renderer, { height: 1, flexShrink: 0, fg: palette.muted, wrapMode: "none" });
  const notice = new TextRenderable(renderer, { height: 1, flexShrink: 0, visible: false, fg: palette.outgoing, wrapMode: "none" });
  const help = new BoxRenderable(renderer, { position: "absolute", left: 2, top: 3, width: "90%", height: 21,
    border: true, borderStyle: "rounded", borderColor: palette.incoming, backgroundColor: palette.panel, paddingLeft: 2, paddingRight: 2,
    zIndex: 20000, visible: false, title: " Keyboard shortcuts " });
  const helpShield = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
    zIndex: 19000, visible: false, shouldFill: false, onMouse(event) { event.preventDefault(); event.stopPropagation(); } });
  const searchShield = new BoxRenderable(renderer, { position: "absolute", left: 0, top: 3, width: "100%", height: 1,
    zIndex: 10000, visible: false, shouldFill: false, onMouse(event) { event.preventDefault(); event.stopPropagation(); searchInput.focus(); } });
  const helpText = new TextRenderable(renderer, { fg: palette.text, wrapMode: "word" });
  help.add(helpText);
  viewport.add(canvas); body.addPane(viewport, Math.max(1, renderer.width - 39), 36); body.addPane(inspector, 38, 28);
  resources.push({ dispose() { if (!inspector.parent) inspector.destroyRecursively(); } });
  for (const child of [topBar, body, notice, footer, shortcuts, searchShield, helpShield, help]) renderer.root.add(child);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  let centerX = diagram.bounds.x + diagram.bounds.width / 2;
  let centerY = diagram.bounds.y + diagram.bounds.height / 2;
  let scale = 16;
  let selected = diagram.nodes[0];
  type Visit = { view: string; selected: string | undefined; x: number; y: number; scale: number };
  const history: Visit[] = [];
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
  let followCamera = false, focusedCall = "";
  // Which key family moves the selection; the other family pans. `v` swaps them.
  let vimTraverses = true;
  const selectKeys = () => vimTraverses ? "h j k l" : "Arrows";
  const panKeys = () => vimTraverses ? "Arrows" : "h j k l";
  const helpContent = () => `NAVIGATE
  ${selectKeys().padEnd(18)} Select the neighbor in that direction
  ${panKeys().padEnd(18)} Pan (Shift+${vimTraverses ? "hjkl" : "arrows"} also pans)
  v                  Swap: ${vimTraverses ? "arrows select, hjkl pan" : "hjkl select, arrows pan"}
  Tab / Shift+Tab    Next / previous node
  + / -              Zoom
  f / 0 / r          Fit / actual size / center selection
  Enter / Backspace  Child / parent
  o / b              Open linked view / back

INSPECT
  /                  Search this view
  i                  Toggle inspector
  a                  Camera follows running tools
  PageUp / PageDown  Scroll inspector
  e                  Browse mapped files
  ? / Escape         Close help
  q                  Quit`;
  const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const isActive = (event: ActivityEvent) => event.phase === "started" && Date.now() - event.time <= 30_000;
  const operationColor = (operation: ActivityEvent["operation"]) => operation === "edit" ? palette.outgoing : operation === "read" ? palette.incoming : operation === "command" ? palette.command : palette.muted;
  const mix = (from: string, to: string, amount: number) => {
    const a = RGBA.fromHex(from), b = RGBA.fromHex(to);
    return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount, 1);
  };
  const indexEvents = () => {
    byElement = new Map();
    for (const event of events) {
      for (const element of new Set(rules.filter(rule => event.paths.some(path => rule.match.match(path))).map(rule => rule.element))) {
        byElement.set(element, [...byElement.get(element) ?? [], event]);
      }
    }
  };
  const liveLabel = () => binding ? `${binding.source}:${binding.session.slice(0, 8)}` : "waiting for a session";
  const headingContent = () => {
    const title = `C4VIEW  /  ${diagram.title ?? diagram.id}`;
    if (!binding && !following) return title;
    const busy = events.some(isActive);
    return new StyledText([fg(palette.text)(title),
      fg(busy ? palette.outgoing : binding ? palette.incoming : palette.muted)(`   ${busy ? spinner[Math.floor(Date.now() / 100) % spinner.length] : "●"} LIVE ${liveLabel()}`)]);
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
      border: true, borderStyle: "rounded", borderColor: palette.border, shouldFill: !node.children.length, backgroundColor: palette.node, zIndex: z,
      justifyContent: "center",
      title: node.children.length ? node.title : undefined });
    const label = new TextRenderable(renderer, { fg: palette.text, wrapMode: "word", content: node.children.length ? "" : node.title, marginLeft: 1, marginRight: 1 });
    box.add(label); viewport.add(box);
    return { node, box, label };
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
      const label = new TextRenderable(renderer, { position: "absolute", width: 1, height: 1, content: "▶", fg: palette.border, bg: palette.background, zIndex: 1000 });
      viewport.add(label); markers.push({ end, direction, label, type });
    };
    marker(false); marker(true);
    return { edge, material, markers };
  });
  let nodeObjects = mountNodes();
  let edges = mountEdges();
  let previousWidth = 0, previousHeight = 0;
  let initialFit = true, stableLayoutFrames = 0;
  const cellAspect = () => {
    const resolution = renderer.resolution;
    return resolution && resolution.width > 0 && resolution.height > 0
      ? (resolution.width / renderer.width) / (resolution.height / renderer.height) : 0.5;
  };
  const projected = (x: number, y: number) => {
    const p = point(x, y, 10).project(camera);
    return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
  };
  const activityContent = () => {
    const header = fg(palette.muted)("\nACTIVITY\n");
    if (activityError) return new StyledText([header, fg(palette.failure)(activityError)]);
    if (!binding && !following) return new StyledText([header, fg(palette.muted)("Not bound to an agent session")]);
    if (!config) return new StyledText([header, fg(palette.muted)(`No activity mappings for ${view.project}`)]);
    if (!binding) return new StyledText([header, fg(palette.muted)("Waiting for an agent session to record activity")]);
    const rows = activityRows(events, config, Date.now(), 6);
    if (!rows.length) return new StyledText([header, fg(palette.muted)("Waiting for mapped activity")]);
    return new StyledText([header, ...rows.flatMap(row => {
      const badge = row.state === "failed" ? "FAIL" : row.state === "unconfirmed" ? "????" : row.state === "started" ? row.operation.toUpperCase().padEnd(4) : "done";
      const tone = row.state === "failed" ? palette.failure : row.state === "completed" || row.state === "unconfirmed" ? palette.muted : operationColor(row.operation);
      const mapped = row.elements.length > 0;
      return [fg(tone)(`${badge} ${formatAge(row.age).padStart(3)} `), fg(mapped ? palette.text : palette.muted)(`${row.target}\n`),
        fg(mapped ? palette.incoming : palette.muted)(`        ${row.elements.join(", ") || "unmapped"}\n`)];
    })]);
  };
  const tickerContent = () => {
    if (!binding || !config) return "";
    const [row] = activityRows(events, config, Date.now(), 1);
    if (!row || row.age > 120_000) return "";
    const label = row.state === "started" ? row.operation.toUpperCase() : row.state === "completed" ? "done" : row.state === "failed" ? "FAIL" : "????";
    return ` ● ${label} ${row.target} → ${row.elements.join(", ") || "unmapped"} · ${formatAge(row.age)}`;
  };
  const update = () => {
    layout();
    heading.content = headingContent();
    breadcrumb.content = search ? `Search ${search.matches.length ? search.index + 1 : 0}/${search.matches.length} · Enter keep · Esc cancel`
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
      const active = related.filter(isActive);
      const recent = related.find(event => Date.now() - event.time <= 5000);
      const state = active.length ? active.some(event => event.operation === "edit") ? "EDIT" : active.some(event => event.operation === "read") ? "READ" : "RUN"
        : recent?.phase === "failed" ? "FAILED" : recent?.phase === "completed" ? "DONE" : "";
      const incoming = diagram.edges.some(edge => edge.target === selected?.id && edge.source === entry.node.id);
      const outgoing = diagram.edges.some(edge => edge.source === selected?.id && edge.target === entry.node.id);
      entry.box.borderColor = entry.node.id === selected?.id ? palette.text : state === "FAILED" ? palette.failure
        : state === "EDIT" || outgoing ? palette.outgoing : state === "READ" || incoming ? palette.incoming : state === "RUN" ? palette.command : palette.border;
      if (active.length && entry.node.id !== selected?.id) {
        const pulse = RGBA.fromHex(state === "EDIT" ? palette.outgoing : state === "RUN" ? palette.command : palette.incoming);
        const brightness = 0.72 + 0.28 * (1 + Math.sin(Date.now() / 220)) / 2;
        pulse.r *= brightness; pulse.g *= brightness; pulse.b *= brightness;
        entry.box.borderColor = pulse;
      }
      // Where work has recently happened: a tint that cools in coarse steps (so a finished call stops changing the screen).
      const latest = related.reduce<ActivityEvent | undefined>((best, event) => !best || event.time > best.time ? event : best, undefined);
      const warmth = !latest ? 0 : Date.now() - latest.time < 10_000 ? 3 : Date.now() - latest.time < 30_000 ? 2 : Date.now() - latest.time < 90_000 ? 1 : 0;
      entry.box.backgroundColor = entry.node.id === selected?.id ? "#233343"
        : warmth && latest ? mix(palette.node, operationColor(latest.operation), warmth * 0.07) : palette.node;
      if (entry.node.children.length) entry.box.title = `${entry.node.title}${state ? ` [${state}]` : ""}${counts ? ` ·${counts}` : ""}`;
      else entry.label.content = `${entry.node.title}${state || counts ? `\n${state ? `[${state}]` : ""}${state && counts ? " " : ""}${counts}` : ""}`;
      const origin = projected(entry.node.x, entry.node.y);
      const end = projected(entry.node.x + entry.node.width, entry.node.y + entry.node.height);
      const width = Math.max(2, Math.round(end.x) - Math.round(origin.x));
      const height = Math.max(2, Math.round(end.y) - Math.round(origin.y));
      entry.box.left = Math.round(origin.x); entry.box.top = Math.round(origin.y);
      entry.box.width = width; entry.box.height = height;
      entry.box.visible = end.x > 0 && end.y > 0 && origin.x < viewport.width && origin.y < viewport.height;
      entry.label.visible = width >= 8 && height >= 3;
      if (!entry.label.visible) { hidden++; continue; }
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
          : Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? "▶" : "◀" : dy >= 0 ? "▼" : "▲";
      }
    }
    const paths = selectedPaths();
    inspectorTitle.content = selected?.title ?? "No selection";
    inspectorId.content = `${selected?.id ?? ""}\n${selected?.children.length ? "Group" : "Element"} · ${paths.length} mapped files${selected?.navigateTo ? ` · o opens ${selected.navigateTo}` : ""}`;
    const name = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const incoming = diagram.edges.filter(edge => edge.target === selected?.id);
    const outgoing = diagram.edges.filter(edge => edge.source === selected?.id);
    relations.content = new StyledText([
      fg(palette.incoming)(`\nINCOMING  ${incoming.length}\n`),
      fg(palette.text)(incoming.map(edge => `← ${name(edge.source)}\n  ${edge.label?.replace(/\s+/g, " ").trim() || "Unlabeled relationship"}`).join("\n") || "None"),
      fg(palette.outgoing)(`\n\nOUTGOING  ${outgoing.length}\n`),
      fg(palette.text)(outgoing.map(edge => `→ ${name(edge.target)}\n  ${edge.label?.replace(/\s+/g, " ").trim() || "Unlabeled relationship"}`).join("\n") || "None"),
    ]);
    fileHeading.content = `\n${fileMode ? `Files ${paths.length ? fileCursor + 1 : 0}/${paths.length}` : `FILES  ${paths.length}  ·  e to browse`}`;
    const start = Math.floor(fileCursor / fileRows.length) * fileRows.length;
    fileRows.forEach((row, index) => {
      const path = paths[start + index];
      row.visible = !!path || index === 0;
      row.content = path ? `${fileMode && fileCursor === start + index ? "›" : " "} ${path}` : fileError || "No direct file mappings";
      row.bg = fileMode && fileCursor === start + index ? "#294052" : palette.panel;
      row.onMouseDown = event => { event.preventDefault(); event.stopPropagation(); if (!path || help.visible || search) return;
        if (!fileMode) beginFiles(); fileCursor = start + index; message = "Enter opens the selected file"; searchInput.focus(); update(); };
    });
    activityText.content = activityContent();
    body.gutterOptions = { color: fileMode ? palette.outgoing : palette.border };
    footer.content = ` ${braille ? "BRAILLE + Three camera" : "GPU + Three camera"} | Zoom: ${Math.round(16 / scale * 100)}% | Selected: ${selected?.id}${hidden ? ` | ${hidden} labels hidden` : ""}`;
    shortcuts.content = search ? " Type a name or ID · ↑↓/Tab matches · Enter keep · Esc restore" : fileMode ? ` Files ${paths.length ? fileCursor + 1 : 0}/${paths.length} · Type to filter · Enter edit · Ctrl+R refresh · Esc diagram` : tickerContent() || ` ${selectKeys()} select · ${panKeys()} pan · +/- zoom · / search · f fit · e files · i inspect · ? help`;
    notice.visible = !!message; notice.content = ` ${message}`;
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
    search = undefined; searchInput.blur(); searchInput.visible = false; heading.visible = true;
    message = ""; update();
  };
  const beginFiles = () => {
    fileMode = true; fileCursor = 0; fileQuery = ""; inspectorPreference = "open"; message = fileError;
    searchInput.placeholder = "Filter mapped files"; searchInput.value = "";
    searchInput.visible = true; heading.visible = false; searchInput.focus();
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
    if (fileMode || editorActive || help.visible || search || pendingVisit) return;
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
    if (help.visible) { key.preventDefault(); if (key.name === "escape" || key.sequence === "?") { help.visible = false; helpShield.visible = false; }
      else if (key.ctrl && key.name === "c") stop(); return; }
    if (!fileMode && key.sequence === "/") {
      key.preventDefault(); animating = false;
      search = { before: visit(), matches: [], index: 0 };
      searchInput.placeholder = "Search nodes in this view";
      heading.visible = false; searchInput.visible = true; searchInput.value = ""; searchInput.focus(); update(); return;
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
      if (key.name === "escape") { key.preventDefault(); fileMode = false; searchInput.blur(); searchInput.visible = false; heading.visible = true; }
      else if (["up", "down", "tab", "pageup", "pagedown"].includes(key.name)) {
        key.preventDefault();
        const direction = key.name === "up" || key.name === "pageup" || key.name === "tab" && key.shift ? -1 : 1;
        const step = key.name === "pageup" || key.name === "pagedown" ? fileRows.length : 1;
        if (paths.length) fileCursor = (fileCursor + direction * step % paths.length + paths.length) % paths.length;
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
        if (path) {
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
        }
      }
    } else if (key.sequence === "?") { helpText.content = helpContent(); help.visible = true; helpShield.visible = true; }
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
    if (!initialFit && painted) displayed.resolve();
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
      initialFit = false;
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
    if (!dirty) return;
    dirty = false;
    canvas.frameBuffer.clear(RGBA.fromHex(palette.background));
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
        for (const cell of composeConnectors(routes, selected?.id)) {
          if (cell.x < 0 || cell.y < 0 || cell.x >= viewport.width || cell.y >= viewport.height) continue;
          const fg = RGBA.fromHex(cell.emphasis === "outgoing" ? palette.outgoing : cell.emphasis === "incoming" ? palette.incoming : palette.border);
          canvas.frameBuffer.setCell(cell.x, cell.y, cell.glyph, fg, bg);
        }
      } else await activeEngine.drawScene(scene, canvas.frameBuffer, 0);
    })();
    await drawing;
    painted = true;
    canvas.requestRender();
    } catch (error) { renderError = error; stop(); }
  });
  if (binding || following) yield* Effect.gen(function* () {
    if (following) binding = (yield* latestBinding(view.workspace)) ?? binding;
    events = binding ? yield* readActivity(view.workspace, binding) : [];
    indexEvents(); followActivity();
    activityError = ""; if (!editorActive) update();
  }).pipe(Effect.catch(() => Effect.sync(() => { activityError = "Activity unavailable"; if (!editorActive) update(); })),
    Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped);
  renderer.start(); update();
  const ready = yield* io("Native.firstFrame", () => Promise.race([displayed.promise.then(() => true), stopped.promise.then(() => false), renderer.closed.then(() => false)]));
  if (ready && options.ready) yield* writeReady(options.ready, { ready: true });
  if (ready) yield* io("Native.wait", () => Promise.race([stopped.promise, renderer.closed]));
  if (renderError !== undefined) return yield* Effect.fail(failure("Native.render", renderError));
}, Effect.scoped);
