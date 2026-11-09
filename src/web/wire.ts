/**
 * What travels between `pathlight web` and the browser page (`src/page/`): the scene of every view, laid out in the terminal's cells, and one
 * window's frames and acts. Types only, with no imports, so the page's own TypeScript configuration (DOM, no Bun) checks against the same shapes
 * the server sends.
 */

/** A run of text with one color (and a background, for a pill or a cursor row). */
export interface Span { text: string; fg?: string; bg?: string; bold?: boolean }

export type Side = "E" | "W" | "N" | "S";

export interface SceneCard {
  id: string; title: string; group: boolean; parent: string | null; opens: string | null;
  /** Its outer cells, in world units (a cell is 16 wide and 32 tall): `[x, y, width, height]`. */
  rect: [number, number, number, number];
  /** How deep it sits: a group is drawn under what it holds. */
  level: number;
}
export interface SceneRoute {
  /** The relationship's id, and the boxes it joins. */
  id: string; source: string; target: string;
  /** Cell middles, in world units, every run horizontal or vertical; the first touches the source's border, the last the target's. */
  points: [number, number][];
  /** The way the arrowhead points at the target (east for a run that arrives from the left), as the terminal's `▶ ◀ ▼ ▲`. */
  arrow: Side;
}
export interface Scene {
  id: string;
  /** The view's own name (the last part of `Holder / Name`), and its whole title as the header names it. */
  title: string; heading: string; kind: string;
  cards: SceneCard[]; routes: SceneRoute[];
  /** What the camera fits: the cards and the connectors' runs, as the terminal's `f` fits. */
  bounds: [number, number, number, number];
}

/** A row of the views rail, in the words of the terminal's view picker (`g`): the view's name, what holds it, how many boxes. */
export interface RailRow { view: string; name: string; holder: string; detail: string }

/**
 * `GET /api/scene`: every view, the overview first, the rail, and the palette of the theme and mode the terminal would use. `revision` counts the
 * model's reloads; every frame carries it, and a window whose scene is older fetches it again.
 */
export interface SceneData { project: string; mode: "dark" | "light"; palette: Record<string, string>; views: Scene[]; rail: RailRow[]; revision: number }

/** Where the page's camera stood: the world point at the middle of the diagram and the zoom (1 is 100%); `moved` is false while it fits. */
export interface Camera { x: number; y: number; zoom: number; moved: boolean }

/** Where the inspector goes, by the terminal's breakpoints, and how much room it has (columns beside or over the diagram, rows below it). */
export interface Placement { mount: "docked" | "below" | "overlay" | "none"; list: boolean; width: number; height: number }

/** A card as the terminal draws it at 100%: its border color and dashes, the text in its top border, and its label's lines. */
export interface CardLook { border: string; dashed: boolean; title: Span[]; label: Span[][]; pulse?: boolean }

/** Everything the page draws besides the diagram's geometry, for the window's view, selection and size. */
export interface Frame {
  view: string; selected: string | null; canBack: boolean;
  /** Set only on Back: the camera to put back. */
  restore: Camera | null;
  /** The selection moved without the person (follow, `w`): bring it into view. */
  reveal: boolean;
  size: { cols: number; rows: number };
  placement: Placement;
  /** Header line 1 (where you are), its right-hand side, line 2 (the box count) and line 2's right: the news line (the agent's work now). */
  header: { line1: Span[]; badge: Span[]; line2: Span[]; news: Span[] };
  footer: { left: Span[]; right: Span[] };
  /** Each card's look, by id. */
  cards: Record<string, CardLook>;
  /** Each connector's color, whether it is dotted, and whether it touches the selection, in the scene's order. */
  routes: { color: string; dotted: boolean; lit: boolean }[];
  inspector: {
    title: Span[]; what: Span[][]; about: Span[][];
    /** Work: the selected box's own recent edits and commands, while a session is watched. */
    work: { header: Span[]; lines: Span[][] } | null;
    /** Connects: its header, its lines, and the box each line names (a wrapped line names none). */
    connects: { header: Span[]; lines: Span[][]; rows: (string | null)[] };
    opens: { view: string; title: string } | null;
  };
  /** Under 80 columns the node list replaces the diagram: its lines, and the node on each. */
  list: { lines: Span[][]; ids: string[] } | null;
  /** `?`: the terminal's help for the keys the page has. */
  help: { lines: Span[][]; meta: Span[] };
}

export type Direction = "left" | "right" | "up" | "down";

/** What the person did, posted to `/api/act`. The camera travels with a move to another view, so Back can put it back. */
export type Act =
  | { kind: "select"; id: string | null }
  | { kind: "traverse"; direction: Direction }
  | { kind: "open"; view: string; select?: string | null; camera?: Camera }
  | { kind: "into"; camera?: Camera }
  | { kind: "openView"; camera?: Camera }
  /** `b`: the last visit. `up` (Backspace): the last visit, else the box that holds the selection, else the view whose box opens this one. */
  | { kind: "back"; up?: boolean; camera?: Camera }
  | { kind: "size"; cols: number; rows: number }
  | { kind: "zoom"; zoom: number }
  | { kind: "inspector" }
  /** `a`: follow the work, or stop; resumes a paused follow. */
  | { kind: "follow" }
  /** `w`: to the newest work, and follow it. */
  | { kind: "work"; camera?: Camera }
  /** The person moved the camera (drag, wheel, keys): pauses follow. */
  | { kind: "moved" };
