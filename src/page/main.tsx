import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import type { Act, Frame, SceneData } from "../web/wire";
import { createCamera } from "./camera";
import { type Cell, fontFamily, fontSize, measureCell } from "./cell";
import { Footer, Header, Help, NodeList, Rail } from "./chrome";
import { Diagram } from "./diagram";
import { Inspector } from "./inspector";
import { type PageAction, pageKey } from "./keys";

/**
 * The browser page (plan 4d): the terminal viewer drawn by a browser. It draws what the server sends and reports what the person did; every
 * decision (the layout in cells, the words, the colors, what is selected, where Back goes, where the inspector sits) is the server's, made by
 * the terminal's own functions. The page owns the pixels: the measured cell, the camera, the pointer and the keys.
 */

const params = new URLSearchParams(location.search);
const token = params.get("t") ?? "";
const api = (path: string, extra = "") => `${path}?t=${encodeURIComponent(token)}${extra}`;

/** The window's size in cells, and the pixels it has. */
interface Size { cols: number; rows: number; width: number; height: number }
const sizeOf = (cell: Cell): Size => ({ cols: Math.max(20, Math.floor(innerWidth / cell.w)), rows: Math.max(8, Math.floor(innerHeight / cell.h)), width: innerWidth, height: innerHeight });

/** The rail's width in cells, beside a docked inspector only, so the terminal's breakpoints and the diagram's room stay the terminal's elsewhere. */
const railCols = 26;

const App = (props: { scene: SceneData; cell: Cell }) => {
  const cell = props.cell;
  const views = new Map(props.scene.views.map(view => [view.id, view]));
  const [frame, setFrame] = createSignal<Frame>();
  const [pending, setPending] = createSignal<string | null>(null);
  const [help, setHelp] = createSignal(false);
  const [size, setSize] = createSignal(sizeOf(cell));
  const camera = createCamera(() => cell);
  let windowId = "", shownView = "", reveal = false;

  const post = (act: Act) => {
    if (!windowId) return;
    void fetch(api("/api/act", `&w=${encodeURIComponent(windowId)}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(act) });
  };
  const scene = createMemo(() => views.get(frame()?.view ?? "") ?? props.scene.views[0]!);

  // Where everything sits, in pixels from the cells: the header's two lines and its rule, the body, the footer's line; in the body the diagram,
  // the inspector where the terminal puts it, and the rail beside a docked one.
  const layout = createMemo(() => {
    const { width, height } = size(), placement = frame()?.placement;
    const top = cell.h * 3, bottom = height - cell.h, body = Math.max(cell.h, bottom - top);
    const docked = placement?.mount === "docked", below = placement?.mount === "below", overlay = placement?.mount === "overlay";
    const panel = placement ? placement.width * cell.w : 0;
    const rail = docked && size().cols >= 120 + railCols / 2 ? railCols * cell.w : 0;
    const inspectorRows = below ? Math.min(body - cell.h * 2, placement!.height * cell.h) : body;
    const diagram = {
      left: rail ? rail + cell.w : 0, top,
      width: Math.max(cell.w, (docked ? width - panel - cell.w : width) - (rail ? rail + cell.w : 0)),
      height: below ? Math.max(cell.h, body - inspectorRows - cell.h) : body,
    };
    const inspector = docked ? { left: width - panel, top, width: panel, height: body }
      : below ? { left: 0, top: bottom - inspectorRows, width, height: inspectorRows }
      : overlay ? { left: width - panel, top, width: panel, height: body } : undefined;
    return { top, bottom, body, rail, diagram, inspector, docked, below, overlay, list: placement?.list ?? false };
  });

  const fitNow = (glide: boolean) => camera.fit(scene().bounds, glide);
  const apply = (next: Frame) => {
    const before = frame();
    const changedView = next.view !== shownView;
    shownView = next.view;
    setFrame(next);
    setPending(null);
    const view = views.get(next.view);
    if (next.restore) camera.restore(next.restore);
    else if (changedView && view) { camera.resize({ width: layout().diagram.width, height: layout().diagram.height }, undefined); fitNow(false); }
    if (reveal && next.selected && next.selected !== before?.selected) {
      const card = view?.cards.find(entry => entry.id === next.selected);
      if (card) camera.ensureVisible(card.rect);
    }
    reveal = false;
    // When the first frame is on screen, for the speed measured in tests/web-page.test.ts.
    if (!before) requestAnimationFrame(() => performance.mark("pathlight:drawn"));
    // The view and the selection go in the address, so a reload opens there.
    const address = new URLSearchParams({ t: token, view: next.view, ...(next.selected ? { select: next.selected } : {}) });
    history.replaceState(null, "", `?${address}`);
  };

  // The stream of frames: one window on the server, opened at the address's view and selection, at this window's size.
  const opened = size();
  const events = new EventSource(api("/api/events", `&cols=${opened.cols}&rows=${opened.rows}${params.get("view") ? `&view=${encodeURIComponent(params.get("view")!)}` : ""}${params.get("select") ? `&select=${encodeURIComponent(params.get("select")!)}` : ""}`));
  events.onmessage = event => {
    const data = JSON.parse(event.data) as { window: string; frame: Frame };
    windowId = data.window;
    apply(data.frame);
  };
  onCleanup(() => events.close());

  // A resize refits while the view is fitted, and tells the server the new size in cells: the inspector's place and its words follow it.
  let sizeTimer = 0;
  const resized = () => {
    const next = sizeOf(cell), before = size();
    setSize(next);
    if (next.cols !== before.cols || next.rows !== before.rows) { clearTimeout(sizeTimer); sizeTimer = window.setTimeout(() => post({ kind: "size", cols: next.cols, rows: next.rows }), 40); }
  };
  addEventListener("resize", resized);
  onCleanup(() => removeEventListener("resize", resized));
  // The diagram's room changes with the window and with the inspector's place: the camera keeps its middle, and refits while it fits.
  createEffect(on(() => [layout().diagram.width, layout().diagram.height] as const, ([width, height]) => {
    if (frame()) camera.resize({ width, height }, scene().bounds);
  }));
  // The footer says the zoom; the server hears it once the camera stops.
  let zoomTimer = 0;
  camera.onMove(target => { clearTimeout(zoomTimer); zoomTimer = window.setTimeout(() => post({ kind: "zoom", zoom: Math.round(target.zoom * 1000) / 1000 }), 150); });

  const select = (id: string) => { setPending(id); post({ kind: "select", id }); };
  const into = (id: string) => { if (frame()?.selected !== id) post({ kind: "select", id }); post({ kind: "into", camera: camera.target() }); };
  const openView = (view: string) => { if (view !== frame()?.view) post({ kind: "open", view, camera: camera.target() }); };

  const perform = (action: PageAction) => {
    const current = frame();
    switch (action.type) {
      case "traverse": reveal = true; post({ kind: "traverse", direction: action.direction }); return;
      case "listMove": {
        const ids = current?.list?.ids ?? [], at = ids.indexOf(current?.selected ?? "");
        const next = ids[Math.max(0, Math.min(ids.length - 1, at + action.by))];
        if (next) select(next);
        return;
      }
      case "open": post({ kind: "into", camera: camera.target() }); return;
      case "openView": post({ kind: "openView", camera: camera.target() }); return;
      case "back": post({ kind: "back", camera: camera.target() }); return;
      case "parent": post({ kind: "back", up: true, camera: camera.target() }); return;
      case "help": setHelp(true); return;
      case "helpClose": setHelp(false); return;
      case "inspector": post({ kind: "inspector" }); return;
      case "fit": fitNow(true); return;
      case "actualSize": camera.actualSize(); return;
      case "zoom": camera.zoomBy(action.by > 0 ? 1.25 : 1 / 1.25); return;
      case "pan": camera.panCells(action.direction === "left" ? -6 : action.direction === "right" ? 6 : 0, action.direction === "up" ? -3 : action.direction === "down" ? 3 : 0); return;
    }
  };
  const keydown = (event: KeyboardEvent) => {
    const action = pageKey(event, { help: help(), overlay: layout().overlay, list: layout().list });
    if (!action) return;
    event.preventDefault();
    perform(action);
  };
  addEventListener("keydown", keydown);
  onCleanup(() => removeEventListener("keydown", keydown));

  // Pointer: drag pans, the wheel pans, ctrl+wheel (a pinch on a touchpad) zooms about the pointer. A drag is not a click.
  let drag: { x: number; y: number; moved: boolean } | undefined, dragged = false;
  const svgPoint = (event: MouseEvent, svg: SVGSVGElement) => { const box = svg.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, moved: false }; dragged = false;
  };
  const move = (event: PointerEvent) => {
    if (!drag || !(event.buttons & 1)) { drag = undefined; return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    // Captured only once it is a drag: a capture from the press would make the click land on the diagram instead of the card under it.
    if (!drag.moved) (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.moved = true; dragged = true;
    camera.pan(dx, dy);
    drag.x = event.clientX; drag.y = event.clientY;
  };
  const up = () => { drag = undefined; };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const svg = event.currentTarget as SVGSVGElement;
    const scale = event.deltaMode === 1 ? cell.h : event.deltaMode === 2 ? layout().diagram.height : 1;
    if (event.ctrlKey || event.metaKey) camera.zoomBy(Math.exp(-event.deltaY * scale * 0.01), svgPoint(event, svg), false);
    else camera.pan(-event.deltaX * scale, -event.deltaY * scale);
  };
  // A click that ended a drag does not select.
  const swallow = (event: MouseEvent) => { if (dragged) { event.stopPropagation(); dragged = false; } };

  return (
    <Show when={frame()}>{current => (
      <>
        <Header frame={current()} />
        <div class="rule" style={{ top: `${cell.h * 2}px` }} />
        <Show when={layout().rail}>
          <div class="rail-box" style={{ top: `${layout().top}px`, width: `${layout().rail}px`, height: `${layout().body}px` }}>
            <Rail rows={props.scene.rail} current={current().view} open={openView} />
          </div>
          <div class="divider" style={{ left: `${layout().rail + cell.w / 2}px`, top: `${layout().top}px`, height: `${layout().body}px` }} />
        </Show>
        <Show when={!layout().list} fallback={
          <div class="list-box" style={{ top: `${layout().top}px`, height: `${layout().below ? layout().diagram.height : layout().body}px` }}><NodeList frame={current()} select={select} /></div>}>
          <svg class="diagram" style={{ left: `${layout().diagram.left}px`, top: `${layout().diagram.top}px` }} width={layout().diagram.width} height={layout().diagram.height}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}
            ref={svg => svg.addEventListener("click", swallow, { capture: true })}>
            <Diagram scene={scene()} frame={current()} cell={cell} camera={camera} pending={pending()} select={select} into={into} />
          </svg>
        </Show>
        <Show when={layout().inspector}>{box => (
          <>
            <Show when={layout().docked}><div class="divider" style={{ left: `${box().left - cell.w / 2}px`, top: `${box().top}px`, height: `${box().height}px` }} /></Show>
            <Show when={layout().below}><div class="rule" style={{ top: `${box().top - cell.h / 2}px` }} /></Show>
            <aside class="inspector" classList={{ overlay: layout().overlay }}
              style={{ left: `${box().left}px`, top: `${box().top}px`, width: `${box().width}px`, height: `${box().height}px` }}>
              <Inspector frame={current()} select={select} />
            </aside>
          </>
        )}</Show>
        <Footer frame={current()} />
        <Show when={help()}><Help frame={current()} close={() => setHelp(false)} /></Show>
      </>
    )}</Show>
  );
};

const boot = async () => {
  const cell = measureCell();
  const root = document.documentElement.style;
  root.setProperty("--cw", `${cell.w}px`); root.setProperty("--ch", `${cell.h}px`);
  root.setProperty("--font", fontFamily); root.setProperty("--font-size", `${fontSize}px`);
  const response = await fetch(api("/api/scene"));
  if (!response.ok) { document.body.textContent = `Pathlight: ${response.status} ${await response.text()}`; return; }
  const scene = await response.json() as SceneData;
  // The terminal's palette, in the theme and mode the terminal would use.
  for (const [name, value] of Object.entries(scene.palette)) root.setProperty(`--${name}`, value);
  document.documentElement.dataset.mode = scene.mode;
  render(() => <App scene={scene} cell={cell} />, document.getElementById("app")!);
};

void boot();
