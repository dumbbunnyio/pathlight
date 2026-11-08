import { createSignal } from "solid-js";
import type { Camera } from "../web/wire";
import { type Cell, world } from "./cell";

/**
 * The page's camera, the terminal's in pixels (src/viewer/camera.ts): the world point at the middle of the diagram and a zoom, where 100% puts a
 * cell of 16 by 32 world units on one measured character cell. It eases to where it is heading in about 120 ms; the browser composites one
 * transform. `moved` is false while it fits the view, so a resize refits until the person pans or zooms, as the terminal's `autoFit`.
 */
export interface Viewport { width: number; height: number }
type Bounds = readonly [number, number, number, number];

/** How long a glide takes, and its easing. */
const glideMs = 120;
const ease = (t: number) => 1 - (1 - t) ** 3;

export const createCamera = (cell: () => Cell) => {
  const [now, setNow] = createSignal<Camera>({ x: 0, y: 0, zoom: 1, moved: false });
  let target: Camera = now();
  let from: Camera = now(), start = 0, frame = 0;
  let viewport: Viewport = { width: 1, height: 1 };
  const listeners: ((camera: Camera) => void)[] = [];

  /** Pixels per world unit, across and down (the cell's aspect makes them equal). */
  const scale = (zoom: number) => cell().w / world.x * zoom;
  const step = (time: number) => {
    const t = Math.min(1, (time - start) / glideMs), k = ease(t);
    setNow({ x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, zoom: from.zoom * (target.zoom / from.zoom) ** k, moved: target.moved });
    frame = t < 1 ? requestAnimationFrame(step) : 0;
  };
  const go = (next: Camera, glide = true) => {
    target = next;
    cancelAnimationFrame(frame);
    if (!glide) { frame = 0; setNow(next); }
    else { from = now(); start = performance.now(); frame = requestAnimationFrame(step); }
    for (const listener of listeners) listener(next);
  };
  /** The terminal's fit: the view's middle, as large as fits with two columns and a row to spare, never above 150%. */
  const fitted = (bounds: Bounds): Camera => {
    const [x, y, width, height] = bounds, c = cell();
    const cols = viewport.width / c.w, rows = viewport.height / c.h;
    const per = Math.max(world.x / 1.5, width / Math.max(1, cols - 4), height * (world.x / world.y) / Math.max(1, rows - 2));
    return { x: x + width / 2, y: y + height / 2, zoom: world.x / per, moved: false };
  };
  const clampZoom = (zoom: number) => Math.min(8, Math.max(1 / 8, zoom));

  return {
    now, target: () => target,
    onMove: (listener: (camera: Camera) => void) => { listeners.push(listener); },
    /** The SVG transform that puts the camera's middle at the diagram's middle. */
    transform: () => {
      const camera = now(), k = scale(camera.zoom);
      return `matrix(${k} 0 0 ${k} ${viewport.width / 2 - camera.x * k} ${viewport.height / 2 - camera.y * k})`;
    },
    resize: (next: Viewport, bounds: Bounds | undefined) => {
      viewport = next;
      if (bounds && !target.moved) go(fitted(bounds), false);
    },
    fit: (bounds: Bounds, glide = true) => go(fitted(bounds), glide),
    /** Put back a camera a visit kept (Back), at once. */
    restore: (camera: Camera) => go(camera, false),
    /** Pan by pixels. */
    pan: (dx: number, dy: number, glide = false) => { const k = scale(target.zoom); go({ ...target, x: target.x - dx / k, y: target.y - dy / k, moved: true }, glide); },
    /** Pan by cells, as the arrow keys' pan does: six columns or three rows. */
    panCells: (columns: number, rows: number) => go({ ...target, x: target.x + columns * world.x / target.zoom, y: target.y + rows * world.y / target.zoom, moved: true }),
    /** Zoom by a factor about a point in the diagram's pixels (its middle when none). */
    zoomBy: (factor: number, at?: { x: number; y: number }, glide = true) => {
      const zoom = clampZoom(target.zoom * factor), k0 = scale(target.zoom), k1 = scale(zoom);
      const px = at ? at.x - viewport.width / 2 : 0, py = at ? at.y - viewport.height / 2 : 0;
      // The world point under the pointer stays under it.
      go({ x: target.x + px / k0 - px / k1, y: target.y + py / k0 - py / k1, zoom, moved: true }, glide);
    },
    actualSize: () => go({ ...target, zoom: 1, moved: true }),
    /** Glide so a rectangle is on screen, when any of it is off. */
    ensureVisible: (rect: Bounds) => {
      const k = scale(target.zoom), [x, y, width, height] = rect;
      const left = viewport.width / 2 + (x - target.x) * k, top = viewport.height / 2 + (y - target.y) * k;
      if (left >= 0 && top >= 0 && left + width * k <= viewport.width && top + height * k <= viewport.height) return;
      go({ ...target, x: x + width / 2, y: y + height / 2, moved: true });
    },
    /** A world point under a pixel of the diagram. */
    toWorld: (px: number, py: number) => { const camera = now(), k = scale(camera.zoom); return { x: camera.x + (px - viewport.width / 2) / k, y: camera.y + (py - viewport.height / 2) / k }; },
  };
};

export type PageCamera = ReturnType<typeof createCamera>;
