import { BoxRenderable, TextRenderable, StyledText, fg, RGBA, createCliRenderer } from "@opentui/core";
import { Effect, FiberSet, Schedule } from "effect";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { View } from "./catalog";
import { type ActivityBinding, type ActivityEvent, latestBinding, readActivity, readReplay, type Replay } from "./activity";
import { type Diff, diffWorkspace, recordDiff } from "./diff";
import { draftWorkspace } from "./draft";
import { type Decisions, decide, pending, reviewItems, reviewMessage, type Verdict } from "./review";
import type { Plan } from "./plan";
import type { Stale } from "./stale";
import { nodeFiles } from "./node-files";
import { firstChange, openEditor } from "./editor";
import { sendToPane } from "./ask";
import pkg from "../package.json" with { type: "json" };
import { borderHints, palette, setPalette } from "./ui";
import { type Mode, loadThemes, paletteOf, savedTheme, themeFromEnvironment } from "./theme";
import { rasterize, routeEdges, type Route } from "./routes";
import { checkFlows } from "./flows";
import { badgeText as stepBadge, badgesOf, flowMaps, flowsThrough, pathEdges } from "./flow-view";
import { attempt, failure, io } from "./effects";
import { writeReady } from "./ready";
import { declarationLine } from "./scan-imports";
import { isActive, nowCard, operationState, sessionSummary, ticker } from "./viewer/activity-view";
import { createCamera } from "./viewer/camera";
import { boundsOf, compact } from "./viewer/compact";
import { cardLook } from "./viewer/card-view";
import { connectsCard, filesCard, flowsCard, stepsCard } from "./viewer/cards";
import { crumbActivity, footerContent, modeHints, workOffer } from "./viewer/footer";
import { badgeContent as headerBadge, diffText, edgeMarks } from "./viewer/header";
import { helpContent } from "./viewer/help";
import { allotSections, headContent, nodeListContent, pinnedLines, sectionHeader } from "./viewer/inspector-view";
import { type Action, hints, keyAction } from "./viewer/keys";
import { createGotoPicker, pickCandidates } from "./viewer/pickers";
import { createThemePicker } from "./viewer/theme-picker";
import { createAskDialog } from "./viewer/ask-dialog";
import { reviewSection } from "./viewer/review-view";
import { choose, createState, firstNode, remember, type Visit } from "./viewer/state";
import { createFlowMode } from "./viewer/flow-mode";
import { createWidgets, type SectionKey, sectionOrder } from "./viewer/widgets";
import { loadWorld, readChecks } from "./viewer/world";
import { easeOut, fade } from "./viewer/text";
import { elementsOf, newestWork as newestIn, nodeForElement as nodeIn, nodeOrAncestor, viewHaving as viewIn } from "./viewer/where";

export const viewNative = Effect.fn("Native.view")(function* (options: { view: View; activity?: ActivityBinding; follow?: boolean; parent?: string; ready?: string; select?: string }) {
const view = options.view;
let binding = options.activity;
const following = options.follow === true;
const world = yield* loadWorld(view, { watching: Boolean(binding || following), reload: false });
let { config, files, fileError, diagrams } = world;
// Compact fit: each view is drawn from a copy with Pathlight's spacing and card sizes and LikeC4's arrangement (viewer/compact.ts), made once per view.
// A cell is taken to be half as wide as it is tall, as the camera does when the terminal does not say.
type Layout = NonNullable<ReturnType<typeof diagrams.get>>;
const shaped = new WeakMap<Layout, Layout>();
const shape = (raw: Layout): Layout => {
  const known = shaped.get(raw);
  if (known) return known;
  const rects = compact(raw.nodes.map(node => ({ id: String(node.id), parent: node.parent ? String(node.parent) : null, children: node.children.map(String),
    x: node.x, y: node.y, width: node.width, height: node.height, title: node.title, kind: node.kind ? String(node.kind) : undefined })), { aspect: 0.5, kindRow: true });
  const nodes = raw.nodes.map((node, index) => ({ ...node, x: rects[index]!.x, y: rects[index]!.y, width: rects[index]!.width, height: rects[index]!.height }));
  const next = { ...raw, nodes, bounds: boundsOf(nodes) } as Layout;
  shaped.set(raw, next);
  return next;
};
const getDiagram = (id: string) => {
  const next = diagrams.get(id);
  if (!next) throw new Error(`Unknown linked view '${id}'.`);
  if (!next.nodes.length) throw new Error(`View '${id}' has no nodes.`);
  return shape(next);
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
  const { headingText, badgeText, heading, breadcrumb, crumbHint, searchInput, searchPrompt, searchRow, body, viewport, canvas, inspector, inspectorScroll, inspectorTitle, inspectorHead, inspectorId, relations, filesText, activityText, stepsText, flowsText, sections, inspectorActions, inspectorAsk, statusLeft, statusRight, footer, help, summary, ask, goto, picker, askInput, askPrompt, askRow, nodeList, nodeListText } = createWidgets(renderer);
  if (!binding && !following) { sections.activity.box.visible = false; sections.activity.box.height = 0; }
  let connectionItems: string[] = [];
  let fileLines: number[] = [];
  const hot = RGBA.fromHex(palette.hot), rowBackground = hot;
  const contentRows: Record<SectionKey, number> = { connections: 4, files: 4, activity: 4, steps: 4, flows: 2 };
  resources.push({ dispose() { if (!inspector.parent) inspector.destroyRecursively(); } });
  const camera = createCamera(renderer, viewport, diagram.bounds);
  // `--select ELEMENT` opens with that element selected, so a screen (or a bug report) can name exactly what it shows.
  const asked = options.select === undefined ? undefined : diagram.nodes.find(node => String(node.modelRef) === options.select);
  if (options.select !== undefined && !asked) return yield* Effect.fail(failure("Native.select", `The view '${view.id}' has no element '${options.select}'. Pathlight list names the views; the element ids are in the model.`));
  type Scene = ReturnType<typeof getDiagram>;
  type Node = Scene["nodes"][number];
  const state = createState<Node, Scene, { diagrams: typeof diagrams; config: typeof config; files: typeof files; fileError: string; notice: string }>(asked ?? firstNode(diagram));
  let dirty = true;
  let redrawAfterResize = false;
  let fileMode = false, editorActive = false;
  let fileQuery = "";
  // An element the mapping names as planned and that has no files yet (nor does anything inside it): designed, not built.
  const waiting = (ref: string) => (config?.planned ?? []).some(id => ref === id || ref.startsWith(`${id}.`))
    && !(files.get(ref)?.length) && ![...files].some(([element, paths]) => element.startsWith(`${ref}.`) && paths.length);
  const selectedPaths = () => {
    const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
    const paths = [...files.get(String(state.selected?.modelRef ?? "")) ?? []].sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.localeCompare(b));
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
  const showHelp = () => {
    const guide = helpContent({ inspector: !!state.focusSection, vim: vimTraverses, screenWidth: renderer.width, version: pkg.version });
    help.content.content = guide.content; help.meta.content = guide.meta;
    help.foot.content = new StyledText(borderHints(hints.help));
    if (help.visible) help.place(guide.width, guide.height + 4); else help.open(guide.width, guide.height + 4);
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
  // The review (`c`): the person's verdicts on the new dependencies `diff` lists. `drafted` is whether the map is a draft (its arrows are the imports,
  // so it is redrawn rather than edited), and `redrawnFor` the diff it was last redrawn for, so a redraw that changes nothing is not repeated.
  let decisions: Decisions = { version: 1, decisions: [] }, reviewCursor = 0, drafted = false, redrawnFor = -1;
  // The elements the agent said it is about to work on (`pathlight plan`): outlined, and activity on anything else is marked off-plan.
  let plan: Plan | undefined;
  // Flows: readings of the code (a journey is a LikeC4 dynamic view, a state diagram is what an agent wrote). They are loaded in the background after the first frame
  // and again when the model or a check changes, so a view never waits for them. In flow mode one is drawn on the diagram and read step by step in the inspector.
  const flowMode = createFlowMode<Node>({ view: () => diagram, selected: () => String(state.selected?.modelRef ?? ""), nodeFor: element => nodeForElement(element), select: node => selectNode(node, true),
    title: id => elementTitle(id), say: text => { message = text; }, update: () => update(),
    entering: () => { if (state.focusSection === "connections") state.focusSection = undefined; }, leaving: () => { if (state.focusSection === "steps") state.focusSection = undefined; } });
  let flowPath = new Set<string>();
  let flowItems: ReturnType<typeof flowsThrough> = [];
  const inPlan = (ref: string) => (plan?.elements ?? []).some(id => ref === id || ref.startsWith(`${id}.`) || id.startsWith(`${ref}.`));
  const badgeContent = () => headerBadge({ width: renderer.width, replay: Boolean(replay), live: liveLabel(), bound: Boolean(binding), watching: Boolean(binding || following),
    busy: events.some(isActive), open: pending(reviewItems(diff, decisions)).length, stale, now: Date.now() });
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
    diagram.edges.map(edge => ({ source: String(edge.source), target: String(edge.target), points: [] })));
  let nodeObjects = mountNodes();
  let routes = computeRoutes();
  let previousWidth = 0, previousHeight = 0;
  let initialFit = true, stableLayoutFrames = 0;
  // One-time "draw-on" when the first view opens: nodes bloom left to right, connectors extend source to target.
  const revealMs = 600;
  let revealStart: number | undefined;
  const revealProgress = () => initialFit ? 0 : revealStart === undefined ? 1 : Math.min(1, (Date.now() - revealStart) / revealMs);
  // Section bodies start at the panel's edge; the panel has one column of padding each side and one for a scrollbar.
  const bodyWidth = () => Math.max(16, inspector.width - 2 - 1);
  // A component's title from this view, else from any view that draws it (the review and the header name components this view may not show), else its id.
  let titles: { of: typeof diagrams; byRef: Map<string, string> } | undefined;
  const elementTitle = (id: string) => {
    const here = diagram.nodes.find(node => String(node.modelRef) === id)?.title;
    if (here) return here;
    if (titles?.of !== diagrams) titles = { of: diagrams, byRef: new Map([...diagrams.values()].flatMap(scene => scene.nodes.map(node => [String(node.modelRef), node.title] as const)).reverse()) };
    return titles.byRef.get(id) ?? id.split(".").at(-1) ?? id;
  };
  // Every open card gets an equal share of the inspector's height; a folded card is a padded header.
  let headRows = 2;
  const bodyRows: Record<SectionKey, number> = { connections: 4, files: 4, activity: 4, steps: 4, flows: 2 };
  const resetInspectorScroll = () => { inspectorScroll.scrollTo(0); for (const key of sectionOrder) sections[key].content.scrollTo(0); };
  // Sections folded automatically because the inspector is too short for every open card (never ones the user touched).
  const autoFolded = new Set<SectionKey>();
  const isOpen = (key: SectionKey) => sections[key].open && !autoFolded.has(key);
  // Files stay out of sight until asked for (`e`, or `3`): the actions line says how many there are.
  // "Now" says nothing when there is no session to watch.
  const shownSections = () => sectionOrder.filter(key => key === "files" ? fileMode || state.focusSection === "files" : key === "activity" ? Boolean(binding || following)
    : key === "steps" ? Boolean(flowMode.active) : key === "connections" ? !flowMode.active : !flowMode.active && flowsThrough(flowMode.flows, String(state.selected?.modelRef ?? "")).length > 0);
  const layoutSections = () => {
    const total = inspectorScroll.viewport.height;
    if (total <= 0) return;
    const { cards, autoFolded: folded } = allotSections({ total, headRows, shown: shownSections(), open: key => sections[key].open, contentRows, touched, watching: Boolean(binding || following) });
    autoFolded.clear();
    for (const key of folded) autoFolded.add(key);
    for (const key of sectionOrder) {
      const entry = sections[key], card = cards[key];
      entry.box.visible = card.visible; entry.box.height = card.height; entry.box.marginTop = card.marginTop; entry.content.visible = card.contentVisible;
      bodyRows[key] = card.bodyRows;
    }
  };
  // Keep a line of a card's scrolling body in view.
  const followLine = (key: SectionKey, line: number) => {
    const box = sections[key].content, rows = Math.min(bodyRows[key], box.viewport.height > 0 ? box.viewport.height : bodyRows[key]);
    if (rows <= 0) return;
    if (line < box.scrollTop) box.scrollTo(line); else if (line >= box.scrollTop + rows) box.scrollTo(line - rows + 1);
  };
  // "Now", the session summary and the header's activity line are written in viewer/activity-view.ts from what the journal retained.
  const activityContent = () => {
    const card = nowCard({ error: activityError, bound: Boolean(binding), following, config, events, element: String(state.selected?.modelRef ?? ""), width: bodyWidth(), now: Date.now(), flashes: rowFlashes, background: rowBackground });
    contentRows.activity = card.lines;
    return new StyledText(card.chunks);
  };
  // `c`: the review of new dependencies on top (when there are any), then what the session touched.
  const summaryContent = () => {
    const items = reviewItems(diff, decisions), frame = Math.min(100, renderer.width - 6);
    reviewCursor = Math.min(reviewCursor, Math.max(0, items.length - 1));
    const head = reviewSection(items, { base: diff?.base ?? "HEAD", cursor: reviewCursor, width: frame - 6, title: elementTitle, drawnLater: drafted, background: rowBackground });
    const made = sessionSummary({ session: binding ? `${binding.source}:${binding.session.slice(0, 8)}` : undefined, config, events, elementTitle, screenWidth: renderer.width, ruleWidth: bodyWidth(), now: Date.now() });
    summary.place(items.length ? frame : made.size[0], made.size[1] + head.lines);
    summary.title.content = new StyledText([fg(palette.muted)(" "), fg(palette.text)(items.length ? "Review" : "This session"), fg(palette.muted)(" ")]);
    summary.foot.content = new StyledText(borderHints(items.length ? hints.review : hints.close));
    return new StyledText([...head.chunks, ...made.chunks]);
  };
  // A drafted map draws every import, so redrawing it for one accepted dependency would also draw the ones not yet decided. It is redrawn once every
  // new dependency is accepted (none undecided, none rejected and still in the code), and once per diff.
  const settleReview = Effect.gen(function* () {
    const items = reviewItems(diff, decisions);
    if (!drafted || !diff || !items.length || !items.every(item => item.verdict === "accepted") || redrawnFor === diff.time) return;
    redrawnFor = diff.time;
    yield* draftWorkspace(view.workspace);
    const fresh = yield* diffWorkspace(view.workspace);
    yield* recordDiff(view.workspace, fresh);
    diff = fresh;
    message = `The map now draws the ${items.length === 1 ? "dependency" : `${items.length} dependencies`} you accepted`;
  });
  // A verdict on the dependency under the cursor. Rejecting one asks the agent to take it out; accepting one on a model a person wrote asks it to add the
  // relationship. Both are typed into the agent's pane and submitted, as `t` does.
  const decideOn = (verdict: Verdict) => {
    const item = reviewItems(diff, decisions)[reviewCursor];
    if (!item) return;
    const pair = `${elementTitle(item.source)} → ${elementTitle(item.target)}`;
    runTask(Effect.gen(function* () {
      decisions = yield* decide(view.workspace, item, verdict);
      if (verdict === "accepted" && drafted) message = `Accepted ${pair}`;
      else if (options.parent) {
        yield* sendToPane(options.parent, reviewMessage(item, verdict, elementTitle), true);
        message = verdict === "accepted" ? `Accepted ${pair}: asked the agent to add it to the model` : `Rejected ${pair}: asked the agent to take it out`;
      } else message = `${verdict === "accepted" ? "Accepted" : "Rejected"} ${pair}; there is no agent pane to tell (open the viewer with pathlight show)`;
      yield* settleReview;
    }).pipe(Effect.catch(error => Effect.sync(() => { message = error.message; })),
      Effect.ensuring(Effect.sync(() => { if (summary.visible) summary.content.content = summaryContent(); if (!editorActive) update(); }))));
  };
  const tickerContent = () => ticker(binding ? config : undefined, events, elementTitle, Date.now());
  // A faint grid fixed to the diagram's coordinates: panning and zooming read as camera motion.
  const paintGrid = () => {
    let step = 32;
    while (step / camera.scale < 7) step *= 2;
    const halfWidth = viewport.width * camera.scale / 2, halfHeight = viewport.height * camera.scale / camera.cellAspect() / 2;
    const dot = RGBA.fromHex(palette.grid), bg = RGBA.fromHex(palette.background);
    for (let wx = Math.floor((camera.centerX - halfWidth) / step) * step; wx <= camera.centerX + halfWidth; wx += step) {
      for (let wy = Math.floor((camera.centerY - halfHeight) / step) * step; wy <= camera.centerY + halfHeight; wy += step) {
        const p = camera.projected(wx, wy), x = Math.floor(p.x), y = Math.floor(p.y);
        if (x >= 0 && y >= 0 && x < viewport.width && y < viewport.height) canvas.frameBuffer.setCell(x, y, "·", dot, bg);
      }
    }
  };
  let listSelected = "";
  const renderNodeList = () => {
    const now = Date.now();
    nodeListText.content = nodeListContent(diagram.nodes, { selected: state.selected?.id, width: Math.max(10, viewport.width - 2), background: hot, state: index => {
      const related = byElement.get(String(diagram.nodes[index]!.modelRef)) ?? [];
      return operationState(related.filter(isActive), related.find(event => now - event.time <= 5000));
    } });
    const index = diagram.nodes.findIndex(node => node.id === state.selected?.id), signature = `${diagram.id}/${state.selected?.id}`;
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
    flowMode.sync();
    canvas.visible = !listMode; nodeList.visible = listMode;
    if (listMode) renderNodeList();
    headingText.content = headingContent(); badgeText.content = badgeContent();
    crumbPlain = `${view.project}/${diagram.id} · ${diagram.nodes.length} nodes${diagram.nodes.filter(node => waiting(String(node.modelRef))).length ? ` · ${diagram.nodes.filter(node => waiting(String(node.modelRef))).length} planned` : ""}${state.history.length ? ` · back ${state.history.length}` : ""}${diffText(diff)}${plan ? ` · plan ${plan.elements.length}` : ""}`;
    breadcrumb.content = crumbPlain;
    crumbHint.visible = true;
    camera.sync();
    let hidden = 0;
    const now = Date.now();
    const previewed = state.focusSection === "connections" ? connectionItems[state.cursor.connections] : undefined;
    // Flow mode: which cards carry a step number, and which connectors are the path. A card that is not on the path steps back.
    const flowNodes = diagram.nodes.map(node => ({ id: String(node.id), modelRef: String(node.modelRef) }));
    const badges = flowMode.active ? badgesOf(flowMode.active, flowNodes) : new Map<string, number[]>();
    flowPath = flowMode.active ? pathEdges(flowMode.active, flowNodes, diagram.edges.map(edge => ({ source: String(edge.source), target: String(edge.target) }))) : new Set<string>();
    const stepNodeId = flowMode.active ? (() => { const step = flowMode.active.steps[flowMode.step]; const element = flowMode.active.type === "journey" ? step?.to : step?.elements[0]; return flowNodes.find(node => node.modelRef === element)?.id; })() : undefined;
    for (const entry of nodeObjects) {
      const group = entry.node.children.length > 0, id = String(entry.node.id), ref = String(entry.node.modelRef);
      const related = byElement.get(ref) ?? [];
      const isSelected = id === String(state.selected?.id);
      const numbers = badges.get(id);
      const origin = camera.projected(entry.node.x, entry.node.y);
      const end = camera.projected(entry.node.x + entry.node.width, entry.node.y + entry.node.height);
      let left = Math.round(origin.x), top = Math.round(origin.y), right = Math.max(left + 3, Math.round(end.x)), bottom = Math.max(top + 3, Math.round(end.y));
      // At low zoom a card can land on its group's border row and hide the title: keep it inside the group's frame.
      const container = diagram.nodes.find(node => node.id === entry.node.parent);
      if (container) {
        const a = camera.projected(container.x, container.y), b = camera.projected(container.x + container.width, container.y + container.height);
        left = Math.max(left, Math.round(a.x) + 1); top = Math.max(top, Math.round(a.y) + 1);
        right = Math.max(left + 3, Math.min(right, Math.round(b.x) - 1)); bottom = Math.max(top + 3, Math.min(bottom, Math.round(b.y) - 1));
      }
      const width = right - left, height = bottom - top;
      const look = cardLook({ title: entry.node.title, kind: entry.node.kind ? String(entry.node.kind) : "", group, tags: (entry.node as { tags?: readonly string[] }).tags ?? [], related, now,
        selected: isSelected, previewed: previewed === id, flashing: (flashes.get(ref) ?? 0) > now,
        neighbour: diagram.edges.some(edge => (edge.target === state.selected?.id && edge.source === entry.node.id) || (edge.source === state.selected?.id && edge.target === entry.node.id)),
        unbuilt: waiting(ref), planned: Boolean(plan) && inPlan(ref), offPlan: !!plan && related.length > 0 && !inPlan(ref), numbers, flow: Boolean(flowMode.active), width, height });
      entry.box.borderColor = look.border;
      entry.box.customBorderChars = look.dashes;
      entry.box.backgroundColor = palette.background;
      entry.box.left = left; entry.box.top = top;
      entry.box.width = width; entry.box.height = height;
      entry.rect = { x: left, y: top, width, height };
      entry.box.title = look.title;
      if (look.label) { entry.box.titleColor = look.titleColor; entry.label.content = look.label; }
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
    const selected = state.selected;
    const opens = selected?.navigateTo ? `o opens ${diagrams.get(String(selected.navigateTo))?.title ?? selected.navigateTo}` : "";
    const head = headContent({ title: selected?.title, kind: selected?.kind ? String(selected.kind) : "", technology: selected?.technology, planned: Boolean(selected && waiting(String(selected.modelRef))),
      tags: (selected as { tags?: readonly string[] } | undefined)?.tags ?? [], description: selected?.description, opens, width: Math.max(10, inspector.width - 3) });
    inspectorTitle.content = head.title;
    inspectorHead.content = head.what; inspectorHead.visible = head.hasWhat;
    inspectorId.content = head.about; inspectorId.visible = head.hasAbout;
    headRows = head.rows;

    const name = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const incoming = diagram.edges.filter(edge => edge.target === state.selected?.id);
    const outgoing = diagram.edges.filter(edge => edge.source === state.selected?.id);
    // Who calls it first, then what it calls: one row each, the relationship's own words beside the name. Enter walks the graph.
    const links = [...incoming.map(edge => ({ node: String(edge.source), arrow: "←", tone: palette.incoming, label: edge.label })),
      ...outgoing.map(edge => ({ node: String(edge.target), arrow: "→", tone: palette.accent, label: edge.label }))];
    connectionItems = links.map(item => item.node);
    state.cursor.connections = Math.min(state.cursor.connections, Math.max(0, connectionItems.length - 1));
    const connects = connectsCard(links, name, state.focusSection === "connections" ? state.cursor.connections : undefined, bodyWidth(), rowBackground);
    contentRows.connections = connects.lines;
    if (state.focusSection === "connections") followLine("connections", connects.starts[state.cursor.connections] ?? 0);
    relations.content = new StyledText(connects.chunks);

    // In flows: the flows this component is in, and which steps it plays. Nothing is shown for a component no flow touches.
    flowItems = flowsThrough(flowMode.flows, String(state.selected?.modelRef ?? ""));
    state.cursor.flows = Math.min(state.cursor.flows, Math.max(0, flowItems.length - 1));
    const flowCard = flowsCard(flowItems, state.focusSection === "flows" ? state.cursor.flows : undefined, bodyWidth(), rowBackground);
    contentRows.flows = flowCard.lines;
    flowsText.content = new StyledText(flowCard.chunks);
    if (state.focusSection === "flows") followLine("flows", state.cursor.flows);

    // Steps: the flow being read, with the current step opened up.
    const steps = flowMode.active ? stepsCard(flowMode.active, flowMode.step, byElement, elementTitle, bodyWidth(), Date.now(), rowBackground) : undefined;
    if (steps) followLine("steps", steps.starts[flowMode.step] ?? 0);
    contentRows.steps = steps?.lines ?? 1;
    stepsText.content = new StyledText(steps?.chunks ?? []);

    // Mapped files as a tree; the files the session touched are marked.
    const fileFocus = fileMode || state.focusSection === "files";
    const fileCard = filesCard({ paths, byPath, cursor: fileFocus ? state.fileCursor : undefined, counter: fileMode, width: bodyWidth(), background: rowBackground,
      empty: fileError || (config ? "No files mapped" : "Map files in .pathlight/pathlight.activity.json") });
    fileLines = fileCard.rows;
    contentRows.files = fileCard.lines;
    filesText.content = new StyledText(fileCard.chunks);
    // First click highlights a row; clicking the highlighted row again opens it.
    filesText.onMouseDown = event => {
      event.preventDefault(); event.stopPropagation();
      const index = fileLines[event.y - filesText.y - fileCard.first] ?? -1, path = paths[index];
      if (index < 0 || !path || help.visible || summary.visible) return;
      if (fileMode && clickedFile === index) { openAtChange(path); return; }
      if (!fileMode) beginFiles();
      state.fileCursor = clickedFile = index; message = "Click again or Enter to open"; searchInput.focus(); update();
    };
    if (fileFocus) followLine("files", fileCard.first + Math.max(0, fileLines.indexOf(state.fileCursor)));
    activityText.content = activityContent();
    if (state.focusSection === "activity") followLine("activity", state.cursor.activity);

    const observedHere = byElement.get(String(state.selected?.modelRef ?? ""))?.length ?? 0;
    const counts: Record<SectionKey, string> = { steps: flowMode.active ? `${flowMode.step + 1}/${flowMode.active.steps.length}` : "", flows: flowItems.length ? "◇ reading" : "", connections: links.length ? String(links.length) : "",
      files: fileMode ? `${paths.length ? state.fileCursor + 1 : 0}/${paths.length}` : String(paths.length), activity: observedHere ? String(observedHere) : "" };
    layoutSections();
    for (const key of sectionOrder) {
      const entry = sections[key], focused = state.focusSection === key;
      entry.header.content = sectionHeader({ open: isOpen(key), focused, number: entry.number, name: entry.name, count: counts[key], width: inspector.width });
      // Only the focused section shows a scrollbar, and only when it has more than fits.
      entry.content.verticalScrollBar.visible = focused && entry.content.scrollHeight > entry.content.viewport.height;
    }
    const pinned = pinnedLines({ width: Math.max(10, inspector.width - (mounted === "overlay" ? 3 : 2)), files: paths.length, session: Boolean(binding), replay: Boolean(binding && events.length),
      title: selected?.title, canAsk: Boolean(options.parent), background: hot });
    inspectorActions.content = pinned.actions;
    inspectorAsk.content = pinned.ask;
    if (summary.visible) summary.content.content = summaryContent();
    if (goto.visible) gotoPicker.render();
    body.gutterOptions = { color: fileMode ? palette.outgoing : palette.border };
    const mode = replay ? "replay" : fileMode ? "files" : state.focusSection ? sections[state.focusSection].name.toLowerCase() : flowMode.active ? "flow" : "diagram";
    const work = binding || following ? newestWork() : undefined;
    if (message !== lastToast) {
      lastToast = message;
      if (message) { const shown = message; setTimeout(() => { if (message === shown && !closing) { message = ""; update(); } }, /^Asked /.test(shown) ? 3500 : 2000); }
    }
    const footing = footerContent({ mode, selected: String(state.selected?.id ?? ""), message, hidden, scale: camera.scale, width: renderer.width, hints: room => modeHints({ room,
      replay: replay && { playing: replay.playing, index: replay.index, steps: replay.data.steps.length, turn: replayTurn(), turns: replay.data.turns.length, speed: replay.speed },
      section: !fileMode ? state.focusSection : undefined, flow: flowMode.active && !fileMode ? { title: flowMode.active.title, step: flowMode.step, steps: flowMode.active.steps.length } : undefined,
      files: fileMode ? { cursor: state.fileCursor, count: paths.length } : undefined }) });
    statusLeft.content = footing.left; statusRight.content = footing.right;
    // One activity line, top right: an offer when the work is in another view, else the latest call. It is dropped when it would not fit.
    crumbHint.content = crumbActivity(work && "view" in work ? workOffer(work.title) : tickerContent(), renderer.width - 2 - crumbPlain.length - 3);
    dirty = true; renderer.requestRender();
  };
  const fit = () => camera.fit(diagram.bounds);
  const visit = (): Visit => ({ view: String(diagram.id), selected: state.selected ? String(state.selected.id) : undefined, ...camera.placement() });
  const restore = (saved: Visit) => {
    state.selected = diagram.nodes.find(node => node.id === saved.selected) ?? diagram.nodes[0];
    camera.restore(saved);
  };
  const reveal = (target = state.selected) => { if (target) camera.reveal(target); };
  // Opt-in only (key `a`): select the node of the newest call, running or finished (reads end in milliseconds), and glide to it.
  // Only calls after follow was turned on (or resumed) count, so it shows work as it happens and never replays history. A component that is not in this view
  // falls back to the nearest ancestor that is. The user's own selection or camera movement pauses it.
  const followActivity = () => {
    const latest = events[0];
    if (!followCamera || followPaused || !latest || latest.call === focusedCall || latest.time < followSince) return;
    const target = [...elementsOf(rules, latest)].map(element => nodeOrAncestor(diagram, element)).filter((node): node is Node => Boolean(node)).sort((a, b) => a.children.length - b.children.length)[0];
    focusedCall = latest.call;
    if (!target) return;
    followSelecting = true;
    try { message = ""; selectNode(target, true); } finally { followSelecting = false; }
  };
  type Direction = "left" | "right" | "up" | "down";
  // Nearest node in a direction, by the centres of their boxes; siblings win ties. Ancestors and descendants are
  // reached with Backspace/Enter, so they are not neighbours.
  const traverse = (direction: Direction) => {
    if (!state.selected) return;
    const current = state.selected;
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
    camera.ensureVisible(best);
  };
  const selectNode = (node: typeof state.selected, show: boolean) => {
    if (!node) return;
    pauseFollow();
    choose(state, node); resetInspectorScroll();
    if (show) reveal();
    update();
  };
  // The node for the newest observed call that maps to something in this view.
  const nodeForElement = (element: string) => nodeIn(diagram, element);
  const loadFlows = () => {
    if (closing) return;
    runTask(checkFlows(view.workspace).pipe(Effect.map(flowMaps), Effect.tap(list => Effect.sync(() => {
      flowMode.load(list);
      if (!editorActive && !closing) update();
    })), Effect.catch(() => Effect.void)));
  };
  const newestWork = () => newestIn(events, rules, diagram, diagrams);
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
    else if (work) { camera.animating = false; state.pendingVisit = { diagram: getDiagram(work.view), select: work.element }; message = `Went to ${work.title}`; }
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
  const openLink = () => {
    if (!state.selected?.navigateTo) { message = "No linked view"; update(); return; }
    if (state.selected.navigateTo === diagram.id) return;
    try {
      const next = getDiagram(String(state.selected.navigateTo));
      remember(state, visit());
      camera.animating = false; state.pendingVisit = { diagram: next };
    } catch (error) { message = error instanceof Error ? error.message : String(error); update(); }
  };
  // The picker: `/` searches every view, box and mapped file in the project, `g` only the views (see viewer/pickers.ts).
  const viewHaving = (element: string) => viewIn(diagrams, diagram, element);
  const gotoPicker = createGotoPicker({ screen: renderer, widget: goto, candidates: mode => pickCandidates({ views: diagrams, current: diagram, mode, files, ignore: config?.ignore ?? [] }),
    viewOf: element => String(viewHaving(element)?.[1].title ?? ""), go: pick => { if (pick.kind === "view") goToView(pick.view!); else landOn(pick.element!, pick.path); }, update: () => update() });
  const themePicker = createThemePicker({ renderer, picker, recolour: () => [renderer.root, inspector], themes, names: themeNames, order: themeOrder, name: themeName, mode: themeMode,
    wanted: wantedTheme, fixedMode: Boolean(environment.mode), say: text => { message = text; }, redraw: () => { dirty = true; update(); }, update: () => update(), run: effect => runTask(effect), closing: () => closing });
  const goToView = (id: string) => {
    goto.close();
    if (id === String(diagram.id)) { update(); return; }
    try {
      const next = getDiagram(id);
      remember(state, visit());
      camera.animating = false; state.pendingVisit = { diagram: next };
    } catch (error) { message = error instanceof Error ? error.message : String(error); update(); }
  };
  // Go to a box (and, for a file, show it in the Files section): in place when this view has it, else in the view that fits it best. Back returns.
  const showFile = (path: string) => {
    const index = selectedPaths().indexOf(path);
    if (index < 0) return;
    state.fileCursor = index; sections.files.open = true; touched.add("files"); state.focusSection = "files"; scrollToSection = "files"; inspectorPreference = "open";
  };
  const landOn = (element: string, path?: string) => {
    goto.close();
    const here = nodeForElement(element);
    if (here) { selectNode(here, true); if (path) showFile(path); update(); return; }
    const best = viewHaving(element);
    if (!best) { message = "That is not in any view"; update(); return; }
    remember(state, visit());
    camera.animating = false; state.pendingVisit = { diagram: getDiagram(best[0]), select: element, file: path };
    message = `Went to ${String(best[1].title ?? best[0])}`;
  };
  // Ask about a node (`t`), or ask the agent to improve the map (`m`) or trace a flow (`d`), or name it yourself (`n`): see viewer/ask-dialog.ts.
  const askContext = (target: Node) => {
    const title = (id: string) => diagram.nodes.find(node => node.id === id)?.title ?? id;
    const links = [...diagram.edges.filter(edge => edge.source === target.id).map(edge => `→ ${title(edge.target)}`),
      ...diagram.edges.filter(edge => edge.target === target.id).map(edge => `← ${title(edge.source)}`)];
    const activity = [...new Set((byElement.get(String(target.modelRef ?? "")) ?? []).flatMap(event => event.paths.map(path => `${event.operation} ${path}`)))];
    return { files: files.get(String(target.modelRef ?? "")) ?? [], links, activity };
  };
  const dialog = createAskDialog<Node>({ renderer, widgets: { ask, askInput, askPrompt, askRow }, workspace: view.workspace, parent: options.parent, selected: () => state.selected, context: askContext,
    live: () => ({ bound: Boolean(binding), label: liveLabel() }), say: text => { message = text; }, update: () => update(), run: effect => runTask(effect), opening: () => { camera.animating = false; }, background: hot });
  help.dismiss = () => help.close();
  summary.dismiss = () => { summary.close(); update(); };
  goto.dismiss = () => { goto.close(); update(); };
  picker.dismiss = () => themePicker.cancel();
  let scrollToSection: SectionKey | undefined;
  const touched = new Set<SectionKey>();
  // A number focuses a section (and opens it); pressing it again hands the keys back to the diagram.
  const focusOn = (key: SectionKey) => {
    const entry = sections[key];
    if (state.focusSection === key) { state.focusSection = undefined; update(); return; }
    if (!inspector.visible) inspectorPreference = "open";
    entry.open = true; touched.add(key); state.focusSection = key; scrollToSection = key; update();
  };
  const foldSection = (key: SectionKey) => { sections[key].open = !sections[key].open; touched.add(key); update(); };
  for (const key of sectionOrder) sections[key].header.onMouseDown = event => {
    event.preventDefault(); event.stopPropagation();
    if (fileMode || dialog.asking) return;
    // The first click focuses the section; clicking the focused one folds it.
    if (state.focusSection === key) foldSection(key); else { state.focusSection = key; touched.add(key); scrollToSection = key; }
    update();
  };
  inspectorAsk.onMouseDown = event => {
    event.preventDefault(); event.stopPropagation();
    if (fileMode || help.visible || summary.visible || goto.visible || picker.visible || dialog.asking || state.pendingVisit) return;
    dialog.beginAsk();
  };
  let clickedFile = -1;
  const endFiles = () => { clickedFile = -1; fileMode = false; state.focusSection = undefined; searchInput.blur(); searchRow.visible = false; heading.visible = true; };
  const openFile = (path: string, line?: number, returned = `Returned from editor: ${path}`) => {
    editorActive = true;
    searchInput.blur();
    runTask(Effect.gen(function* () {
      yield* io("Native.finishDrawing", async () => { await drawing; });
      yield* Effect.acquireRelease(io("Native.suspend", () => renderer.suspend()),
        () => io("Native.resume", async () => { await renderer.resume(); editorActive = false; searchInput.focus(); update(); }).pipe(Effect.orDie));
      yield* openEditor({ workspace: view.workspace, path, line }).pipe(
        Effect.tap(() => Effect.sync(() => { message = returned; })),
        Effect.catch(error => Effect.sync(() => { message = error.message; })));
    }).pipe(Effect.scoped, Effect.catch(error => Effect.sync(() => { editorActive = false; message = error.message; searchInput.focus(); update(); }))));
  };
  // A mapped file with uncommitted changes opens at its first change: what changed is what there is to read.
  const openAtChange = (path: string) => runTask(firstChange(view.workspace, path).pipe(
    Effect.tap(line => Effect.sync(() => openFile(path, line, line ? `Returned from ${path} (opened at its first change, line ${line})` : undefined)))));
  const beginFiles = () => {
    fileMode = true; state.fileCursor = 0; fileQuery = ""; sections.files.open = true; touched.add("files"); state.focusSection = "files"; scrollToSection = "files"; inspectorPreference = "open"; message = fileError;
    searchInput.placeholder = "Filter mapped files"; searchInput.value = ""; searchPrompt.content = " files › "; searchPrompt.fg = palette.outgoing;
    searchRow.visible = true; heading.visible = false; searchInput.focus();
  };
  searchInput.on("input", (value: string) => {
    if (fileMode) { fileQuery = value; state.fileCursor = 0; message = ""; update(); }
  });
  nodeListText.onMouseDown = event => {
    if (help.visible || summary.visible || goto.visible || picker.visible || dialog.asking || state.pendingVisit) return;
    const node = diagram.nodes[event.y - nodeListText.y];
    if (node) selectNode(node, false);
  };
  viewport.onMouseDown = event => {
    if (editorActive || help.visible || summary.visible || goto.visible || picker.visible || dialog.asking || state.pendingVisit) return;
    state.focusSection = undefined;
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
    gotoPicker.paste(new TextDecoder().decode(event.bytes));
  });
  // Which action a key means is decided in viewer/keys.ts; here it is done.
  const glide = (change: () => void) => camera.glide(change);
  const perform = (action: Action) => {
    const play = replay;
    const replayGo = (index: number) => { if (play) { play.playing = false; showStep(index); } };
    const key_ = state.focusSection;
    switch (action.type) {
      case "stop": stop(); return;
      case "swallow": return;
      case "askCancel": dialog.finish(); return;
      case "askTab": dialog.tab(); return;
      case "askChoose": dialog.choose(action.by); return;
      case "askToggle": dialog.toggle(); return;
      case "askSend": dialog.send(); return;
      case "themeCancel": themePicker.cancel(); return;
      case "themeKeep": themePicker.keep(); return;
      case "themeMove": themePicker.move(action.to); return;
      case "gotoClose": case "gotoGo": case "gotoMove": case "gotoPage": case "gotoHome": case "gotoEnd": case "gotoClear": case "gotoErase": case "gotoType": gotoPicker.key(action); return;
      case "summaryClose": summary.close(); update(); return;
      case "reviewMove": reviewCursor = Math.max(0, reviewCursor + action.by); summary.content.content = summaryContent(); update(); return;
      case "decide": decideOn(action.verdict); return;
      // Read before deciding: the import that makes the dependency, at its line.
      case "reviewRead": { const example = reviewItems(diff, decisions)[reviewCursor]?.example; if (example) openFile(example.from, example.line, `Returned from ${example.from}:${example.line}`); return; }
      case "helpClose": help.close(); return;
      case "helpSwap": vimTraverses = !vimTraverses; showHelp(); return;
      case "replayExit": endReplay(); return;
      case "replayStep": if (play) replayGo(play.index + action.by); return;
      case "replayHome": replayGo(0); return;
      case "replayEnd": if (play) replayGo(play.data.steps.length - 1); return;
      case "replayTurn": {
        if (!play) return;
        const turns = play.data.turns, turn = replayTurn(), last = play.data.steps.length - 1;
        replayGo(action.by > 0 ? turns[turn + 1] ?? last : play.index > (turns[turn] ?? 0) ? turns[turn] ?? 0 : turns[turn - 1] ?? 0); return;
      }
      case "replayToggle":
        if (!play) return;
        if (!play.playing && play.index >= play.data.steps.length - 1) showStep(play.data.turns.at(-1) ?? 0);
        play.playing = !play.playing; play.next = Date.now() + 1000 / play.speed; update(); return;
      case "replaySpeed": if (play) { play.speed = play.speed === 1 ? 2 : play.speed === 2 ? 4 : 1; update(); } return;
      case "focus": focusOn(action.section); return;
      case "sectionLeave": state.focusSection = undefined; update(); return;
      case "sectionTab": {
        const shown = shownSections();
        state.focusSection = shown[(Math.max(0, shown.indexOf(key_!)) + action.by + shown.length) % shown.length];
        if (state.focusSection) { sections[state.focusSection].open = true; scrollToSection = state.focusSection; }
        update(); return;
      }
      case "sectionFold": sections[key_!].open = !sections[key_!].open; touched.add(key_!); update(); return;
      case "sectionMove": {
        if (key_ === "activity") { sections.activity.content.scrollBy(action.by * 2); return; }
        if (key_ === "steps") { flowMode.goTo(flowMode.step + action.by); return; }
        const items = key_ === "connections" ? connectionItems.length : key_ === "files" ? selectedPaths().length : key_ === "flows" ? flowItems.length : 0;
        if (!items) return;
        if (key_ === "files") state.fileCursor = (state.fileCursor + action.by + items) % items; else state.cursor[key_!] = (state.cursor[key_!] + action.by + items) % items;
        scrollToSection = undefined; update(); return;
      }
      case "sectionEnter":
        if (key_ === "connections") {
          const target = diagram.nodes.find(node => String(node.id) === connectionItems[state.cursor.connections]);
          if (target) { message = ""; selectNode(target, true); }
        } else if (key_ === "files") {
          const path = selectedPaths()[state.fileCursor];
          if (path) openAtChange(path);
        } else if (key_ === "steps") flowMode.goTo(flowMode.step);
        else if (key_ === "flows") {
          const entry = flowItems[state.cursor.flows];
          if (entry) { state.focusSection = undefined; flowMode.enter(entry.flow, entry.steps[0]); }
        }
        return;
      case "cycleFlow": flowMode.cycle(); return;
      case "flowStep": flowMode.goTo(flowMode.step + action.by); return;
      case "exitFlow": flowMode.exit(); return;
      case "search": camera.animating = false; gotoPicker.begin("all"); return;
      case "back": {
        const saved = state.history.at(-1);
        if (saved) { const next = getDiagram(saved.view); state.history.pop(); state.pendingVisit = { diagram: next, restore: saved }; camera.animating = false; }
        else { message = "No previous view"; update(); }
        return;
      }
      case "open":
        if (action.enter && state.selected?.children.length) selectNode(diagram.nodes.find(node => node.id === state.selected?.children[0]), true);
        else openLink();
        return;
      case "parent": selectNode(diagram.nodes.find(node => node.id === state.selected?.parent), true); return;
      case "views": gotoPicker.begin("views"); return;
      case "themes": themePicker.begin(); return;
      case "ask": dialog.beginAsk(); return;
      case "map": dialog.beginMap(); return;
      case "trace": dialog.beginFlow(); return;
      case "name": dialog.beginName(); return;
      case "session": summary.foot.content = new StyledText(borderHints(hints.close)); summary.open(60, 12); summary.content.content = summaryContent(); update(); return;
      case "replay": beginReplay(); return;
      case "work": {
        const work = newestWork();
        // Going to the work is asking to watch it, so follow turns on with the jump (`a` stops it); a viewer with no session has nothing to follow.
        const startFollow = () => { if (binding || following) { followCamera = true; followPaused = false; focusedCall = ""; followSince = Date.now(); } };
        if (work && "node" in work) { message = ""; followSelecting = true; try { selectNode(work.node, true); } finally { followSelecting = false; } startFollow(); if (followCamera) message = "Following the work (a to stop)"; update(); }
        else if (work) {
          remember(state, visit());
          camera.animating = false; startFollow(); state.pendingVisit = { diagram: getDiagram(work.view), select: work.element, notice: `Went to ${work.title}${followCamera ? " · following (a to stop)" : ""}` }; update();
        } else { message = binding || following ? "No recent activity maps to a node" : "Camera jump needs a bound session"; update(); }
        return;
      }
      case "swap": vimTraverses = !vimTraverses; message = vimTraverses ? "hjkl select nodes, arrows pan" : "Arrows select nodes, hjkl pan"; update(); return;
      case "listMove": {
        const index = diagram.nodes.findIndex(node => node.id === state.selected?.id), count = diagram.nodes.length;
        selectNode(diagram.nodes[(index + action.by + count) % count], false); return;
      }
      case "traverse": traverse(action.direction); return;
      case "endFiles": endFiles(); break;
      case "fileMove": {
        const paths = selectedPaths(), step = action.page ? Math.max(1, sections.files.content.viewport.height - 1) : 1;
        if (paths.length) state.fileCursor = (state.fileCursor + action.by * step % paths.length + paths.length) % paths.length;
        clickedFile = -1; break;
      }
      case "refreshFiles":
        if (!refreshing) {
          refreshing = true; message = "Refreshing files...";
          runTask(nodeFiles(view.workspace, config).pipe(Effect.tap(next => Effect.sync(() => {
            files = next; fileError = ""; state.fileCursor = 0; message = "Files refreshed"; update();
          })), Effect.catch(error => Effect.sync(() => { message = error.message; update(); })),
          Effect.ensuring(Effect.sync(() => { refreshing = false; }))));
        }
        break;
      case "fileOpen": { const path = selectedPaths()[state.fileCursor]; if (path) openAtChange(path); break; }
      case "help": showHelp(); break;
      case "inspector": inspectorPreference = inspector.visible ? "closed" : "open"; break;
      case "scrollInspector": {
        // The focused card scrolls; with none focused, the first open card that overflows does.
        const card = key_ ? sections[key_].content : sectionOrder.map(name => sections[name].content).find(box => box.visible && box.scrollHeight > box.viewport.height);
        (card ?? inspectorScroll).scrollBy(action.by * 5); break;
      }
      case "subagents":
        showSubagents = !showSubagents;
        message = showSubagents ? "Subagent calls shown" : "Subagent calls hidden";
        if (replay) showStep(replay.index); else { events = visibleEvents(allEvents); indexEvents(); }
        break;
      case "follow":
        if (followCamera && followPaused) { followPaused = false; message = "Following the work (a to stop)"; }
        else { followCamera = !followCamera; followPaused = false; message = followCamera ? (binding || following ? "Following the work (a to stop)" : "Follow needs a bound session") : "Follow off"; }
        focusedCall = ""; followSince = Date.now();
        if (followCamera) followActivity();
        break;
      case "files": {
        const call = flowMode.active?.steps[flowMode.step]?.call;
        // In a flow, the step's function is what there is to read: open it where the file declares it now, not where it was when the flow was written.
        if (call) runTask(io("Native.readCall", () => readFile(join(view.workspace, call.file), "utf8")).pipe(
          Effect.map(source => declarationLine(source, call.name)),
          Effect.catch(() => Effect.succeed(undefined)),
          Effect.tap(line => Effect.sync(() => openFile(call.file, line, line ? `Returned from ${call.name}` : `${call.name} is no longer declared in ${call.file}; opened it at the top`)))));
        else beginFiles();
        break;
      }
      case "nextNode": {
        const index = diagram.nodes.findIndex(node => node.id === state.selected?.id);
        pauseFollow();
        state.selected = diagram.nodes[(index + action.by + diagram.nodes.length) % diagram.nodes.length];
        state.fileCursor = 0; resetInspectorScroll(); break;
      }
      case "zoom": camera.autoFit = false; pauseFollow(); glide(() => { camera.scale = action.by > 0 ? Math.max(2, camera.scale / 1.25) : Math.min(128, camera.scale * 1.25); }); break;
      case "pan": {
        camera.autoFit = false; pauseFollow();
        const direction = action.direction;
        glide(() => {
          if (direction === "left") camera.centerX -= camera.scale * 6; else if (direction === "right") camera.centerX += camera.scale * 6;
          else if (direction === "down") camera.centerY += camera.scale * 3 / camera.cellAspect(); else camera.centerY -= camera.scale * 3 / camera.cellAspect();
        });
        break;
      }
      case "fit": camera.autoFit = true; glide(fit); break;
      case "actualSize": camera.autoFit = false; pauseFollow(); glide(() => { camera.scale = 16; }); break;
      case "centre": { const selected = state.selected; if (selected) { camera.autoFit = false; glide(() => { camera.centerX = selected.x + selected.width / 2; camera.centerY = selected.y + selected.height / 2; }); } break; }
      case "idle": case "pass": break;
    }
    update();
  };
  renderer.keyInput.on("keypress", key => {
    if (editorActive) return;
    const layer = state.pendingVisit ? "visit" : dialog.asking ? "ask" : picker.visible ? "picker" : goto.visible ? "goto" : summary.visible ? "summary" : help.visible ? "help" : "main";
    const action = keyAction(key, { layer, askContext: dialog.focus >= 0, replay: Boolean(replay), fileMode, focusSection: state.focusSection, flow: Boolean(flowMode.active), listMode, vim: vimTraverses });
    if (!action) return;
    if (action.type !== "pass") key.preventDefault();
    perform(action);
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
    if (state.pendingReload) {
      const next = state.pendingReload; state.pendingReload = undefined;
      const raw = next.diagrams.get(String(diagram.id)), target = raw && shape(raw);
      if (!target?.nodes.length) { message = `View '${diagram.id}' is gone or empty in the new model; showing the previous version`; }
      else {
        const before = new Set(diagram.nodes.map(node => String(node.id)));
        const keep = state.selected ? String(state.selected.id) : undefined;
        for (const entry of nodeObjects) { viewport.remove(entry.box); entry.box.destroyRecursively(); }
        diagrams = next.diagrams; config = next.config; files = next.files; fileError = next.fileError;
        rules = config?.mappings.map(rule => ({ ...rule, match: new Bun.Glob(rule.glob) })) ?? [];
        diagram = target;
        nodeObjects = mountNodes(); routes = computeRoutes();
        state.selected = diagram.nodes.find(node => String(node.id) === keep) ?? diagram.nodes[0];
        state.fileCursor = Math.min(state.fileCursor, Math.max(0, selectedPaths().length - 1));
        indexEvents();
        const added = diagram.nodes.filter(node => !before.has(String(node.id))).map(node => node.title);
        const removed = [...before].filter(id => !diagram.nodes.some(node => String(node.id) === id));
        message = next.notice || (added.length || removed.length ? `Model reloaded: ${[...added.map(title => `+ ${title}`), ...removed.map(id => `− ${id.split(".").at(-1)}`)].slice(0, 4).join("  ")}` : "Model reloaded");
        const shown = message;
        setTimeout(() => { if (message === shown && !closing) { message = ""; update(); } }, 6000);
      }
      update();
    }
    if (state.pendingVisit) {
      const next = state.pendingVisit; state.pendingVisit = undefined;
      for (const entry of nodeObjects) { viewport.remove(entry.box); entry.box.destroyRecursively(); }
      diagram = next.diagram;
      nodeObjects = mountNodes(); routes = computeRoutes();
      state.selected = firstNode(diagram); state.fileCursor = 0; resetInspectorScroll(); message = next.notice ?? "";
      initialFit = false; camera.animating = false;
      if (next.restore) restore(next.restore);
      else { camera.autoFit = true; fit(); camera.settle(); }
      if (next.select) state.selected = nodeForElement(next.select) ?? state.selected;
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
      if (camera.autoFit && !initialFit) { const before = camera.placement(); fit(); camera.animateTo(); camera.centerX = before.x; camera.centerY = before.y; camera.scale = before.scale; }
      update();
    } else if (initialFit && viewport.width > 1 && viewport.height > 1 && ++stableLayoutFrames >= 2) {
      initialFit = false; revealStart = Date.now();
      fit(); camera.settle();
      update();
    }
    if (camera.step(deltaMs)) update();
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
      for (const cell of rasterize(routes, point => camera.projected(point.x, point.y), isCovered, state.selected ? String(state.selected.id) : undefined, edgeMarks(diff, diagram.nodes, diagram.edges, flowPath))) {
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
  const reloadWorld = Effect.suspend(() => loadWorld(view, { watching: Boolean(binding || following), reload: true })).pipe(Effect.flatMap(next => Effect.sync(() => {
    state.pendingReload = { ...next, notice: "" };
    renderer.requestRender();
    loadFlows();
  })));
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
    const { stale: next, diff: nextDiff, decisions: nextDecisions, plan: nextPlan, drafted: isDraft } = yield* readChecks(view.workspace, binding);
    drafted = isDraft;
    if (next?.time !== stale?.time && stale !== undefined) loadFlows();
    if (JSON.stringify(next) !== JSON.stringify(stale) || JSON.stringify(nextDiff) !== JSON.stringify(diff) || JSON.stringify(nextPlan) !== JSON.stringify(plan) || JSON.stringify(nextDecisions) !== JSON.stringify(decisions)) {
      stale = next; diff = nextDiff; plan = nextPlan; decisions = nextDecisions; dirty = true;
      yield* settleReview.pipe(Effect.catch(error => Effect.sync(() => { message = error.message; })));
      if (summary.visible) summary.content.content = summaryContent();
      if (!editorActive) update();
    }
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
