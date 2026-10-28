import { THREE } from "@opentui/three";

export interface Rect { x: number; y: number; width: number; height: number }
/** What the camera needs of the terminal: its size in cells and, when the terminal reports it, in pixels (for the cell's aspect). */
export interface Screen { readonly width: number; readonly height: number; readonly resolution?: { width: number; height: number } | null }
export interface Area { readonly width: number; readonly height: number }
/** Where the camera stood, as a visit records it for Back. */
export interface Placement { x: number; y: number; scale: number }

/**
 * The approved camera: an eased Three orthographic projection of LikeC4's world units onto the diagram's cells. `scale` is world units per cell
 * column (16 is 100%); a cell's height in world units is `scale / cellAspect()`. Moves set a target and `step` eases towards it each frame.
 * `autoFit` keeps the diagram fitted through load and resize until the user pans or zooms.
 */
export function createCamera(screen: Screen, viewport: Area, bounds: Rect) {
  const three = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  const camera = {
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2,
    scale: 16,
    targetX: 0, targetY: 0, targetScale: 16,
    animating: false,
    autoFit: true,
    cellAspect() {
      const resolution = screen.resolution;
      return resolution && resolution.width > 0 && resolution.height > 0
        ? (resolution.width / screen.width) / (resolution.height / screen.height) : 0.5;
    },
    /** The Three camera set to where this one is now; call before projecting. */
    sync() {
      const worldWidth = Math.max(1, viewport.width) * camera.scale;
      const worldHeight = Math.max(1, viewport.height) * camera.scale / camera.cellAspect();
      three.left = -worldWidth / 2; three.right = worldWidth / 2;
      three.top = worldHeight / 2; three.bottom = -worldHeight / 2;
      three.position.set(camera.centerX, -camera.centerY, 1000); three.lookAt(camera.centerX, -camera.centerY, 0);
      three.updateProjectionMatrix(); three.updateMatrixWorld();
    },
    projected(x: number, y: number) {
      const p = new THREE.Vector3(x, -y, 10).project(three);
      return { x: (p.x + 1) * viewport.width / 2, y: (1 - p.y) * viewport.height / 2 };
    },
    fit(area: Rect) {
      camera.centerX = area.x + area.width / 2; camera.centerY = area.y + area.height / 2;
      camera.scale = Math.max(area.width / Math.max(1, viewport.width - 4), area.height * camera.cellAspect() / Math.max(1, viewport.height - 2));
    },
    /** Stand still where the camera is: the target is the current position. */
    settle() { camera.targetX = camera.centerX; camera.targetY = camera.centerY; camera.targetScale = camera.scale; },
    animateTo() { camera.settle(); camera.animating = true; },
    placement(): Placement { return { x: camera.centerX, y: camera.centerY, scale: camera.scale }; },
    restore(saved: Placement) {
      camera.autoFit = false;
      camera.centerX = camera.targetX = saved.x; camera.centerY = camera.targetY = saved.y; camera.scale = camera.targetScale = saved.scale;
      camera.animating = false;
    },
    /** Glide to a node: a leaf is centred, a group is brought in from its top-left corner. */
    reveal(target: Rect & { children: readonly unknown[] }) {
      if (!camera.animating) camera.targetScale = camera.scale;
      camera.targetX = target.children.length ? target.x + viewport.width * camera.targetScale / 2 - camera.targetScale * 2 : target.x + target.width / 2;
      camera.targetY = target.children.length ? target.y + viewport.height * camera.targetScale / camera.cellAspect() / 2 - camera.targetScale / camera.cellAspect() : target.y + target.height / 2;
      camera.animating = true;
    },
    /** Reveal a node only when it is not already well inside the view (where the camera is heading). */
    ensureVisible(node: Rect & { children: readonly unknown[] }) {
      if (!camera.animating) camera.settle();
      const halfWidth = viewport.width * camera.targetScale / 2 * 0.9, halfHeight = viewport.height * camera.targetScale / camera.cellAspect() / 2 * 0.9;
      const inside = node.x >= camera.targetX - halfWidth && node.x + node.width <= camera.targetX + halfWidth
        && node.y >= camera.targetY - halfHeight && node.y + node.height <= camera.targetY + halfHeight;
      if (!inside) camera.reveal(node);
    },
    /**
     * A move made from where the camera is heading, then eased to: `change` edits the centre or scale directly (a key's pan or zoom, a fit) and the
     * camera glides from where it stood. Nothing moves when `change` leaves the camera where it was.
     */
    glide(change: () => void) {
      const before = camera.placement();
      if (camera.animating) { camera.centerX = camera.targetX; camera.centerY = camera.targetY; camera.scale = camera.targetScale; }
      change();
      if (camera.centerX !== before.x || camera.centerY !== before.y || camera.scale !== before.scale) {
        camera.animateTo(); camera.centerX = before.x; camera.centerY = before.y; camera.scale = before.scale;
      }
    },
    /** One frame of easing; true while it moved. */
    step(deltaMs: number) {
      if (!camera.animating) return false;
      const fraction = 1 - Math.exp(-Math.min(deltaMs, 100) / 65);
      camera.centerX += (camera.targetX - camera.centerX) * fraction; camera.centerY += (camera.targetY - camera.centerY) * fraction; camera.scale += (camera.targetScale - camera.scale) * fraction;
      if (Math.abs(camera.targetX - camera.centerX) + Math.abs(camera.targetY - camera.centerY) + Math.abs(camera.targetScale - camera.scale) < 0.02) {
        camera.centerX = camera.targetX; camera.centerY = camera.targetY; camera.scale = camera.targetScale; camera.animating = false;
      }
      return true;
    },
  };
  camera.settle();
  return camera;
}

export type Camera = ReturnType<typeof createCamera>;
