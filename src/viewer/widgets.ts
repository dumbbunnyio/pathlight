import { type Renderable, BoxRenderable, FrameBufferRenderable, InputRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable, StyledText, type TextChunk, fg, RGBA, type createCliRenderer } from "@opentui/core";
import { SplitPaneRenderable } from "opentui-split";
import { palette } from "../ui";

/** The inspector's cards, in the order they stack. */
export type SectionKey = "activity" | "steps" | "connections" | "flows" | "files";
export const sectionOrder: SectionKey[] = ["activity", "steps", "connections", "flows", "files"];

/**
 * Every widget of the viewer, built once and added to the screen: the header, the diagram's viewport and canvas, the inspector and its cards, the
 * footer, the modals (help, session, ask, go to, theme) and the narrow-terminal node list. What they show is set by the viewer on each update.
 */
export function createWidgets(renderer: Awaited<ReturnType<typeof createCliRenderer>>) {
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
  // Before the first layout nothing is measured; start with what is hidden by default already hidden, so no frame shows Files or an empty Now.
  for (const key of ["files", "steps", "flows"] as const) { sections[key].box.visible = false; sections[key].box.height = 0; }
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
  for (const child of [topBar, body, footer, help.scrim, help.panel, summary.scrim, summary.panel, ask.scrim, ask.panel, goto.scrim, goto.panel, picker.scrim, picker.panel]) renderer.root.add(child);
  return { topBar, headingText, badgeText, heading, breadcrumb, crumbHint, breadcrumbRow, searchInput, searchPrompt, searchRow, body, viewport, canvas, inspector, inspectorScroll, inspectorTitle, inspectorHead, inspectorId, relations, filesText, activityText, stepsText, flowsText, sections, inspectorActions, inspectorAsk, statusLeft, statusRight, footer, help, summary, ask, goto, picker, askInput, askPrompt, askRow, fitAsk, nodeList, nodeListText };
}
