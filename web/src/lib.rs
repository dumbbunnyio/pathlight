//! Pathlight's browser page, drawn with Rune. It draws; the server decides (plan 4d, decision 9). The model and its layout come from
//! `GET /api/scene`, what is selected and the inspector's words from `frame` events, and every choice the person makes goes back to the server as
//! an act (`POST /api/act`). The camera, the compact fit and the drawing are the page's.
//!
//! The look (plan 4d, "The look"): one room, one lamp, a map cut into stone. The whole window is one dark table (`light.rs` paints it);
//! the rail, the title and the inspector stand on it as slabs rather than panels beside it. Boxes are slabs whose height is attention: the
//! selection stands tallest, its neighbors stand, the rest settle nearly flush into the stone. Lines are grooves cut into the table; the
//! ones touching the selection are quietly lit. What the model says a box is (a person, a store, a queue) is a word on it in the mono
//! face, never a shape. The rule for all of it (David, 2026-11-07): elegant, simple, subdued, and instant.

pub mod data;
pub mod geom;
pub mod light;
#[cfg(target_arch = "wasm32")]
mod net;

use data::{Camera, Edge, Frame, Ink, Model, Node, Span, View};
use geom::Pen;
use light::{mark, mat};
use rune::tok::motion;
use rune::{
    AppSpec, Color, Cursor, Cx, Drag, El, Key, KeyEvent, Live, MagnifyEvent, Phase, ScrollSpec, Shadow, Shape, TextStyle, Tx, WheelEvent, canvas, col, el, rich,
    row, text,
};
use std::sync::{Arc, OnceLock};

const NAME: TextStyle = TextStyle::new(14.0, 600.0);
/// The mono face for what the model says: roles, technologies, counts.
const SMALL: TextStyle = TextStyle::new(10.5, 450.0).mono().tracking(0.3);
const BODY: TextStyle = TextStyle::new(13.0, 400.0).lh(19.0);
const NAV: TextStyle = TextStyle::new(13.0, 450.0);
const SECTION: TextStyle = TextStyle::new(10.5, 600.0).mono().tracking(1.4);
const HEAD: TextStyle = TextStyle::new(18.0, 600.0);
const TITLE: TextStyle = TextStyle::new(22.0, 650.0).tracking(-0.2);
const EDGE_LABEL: TextStyle = TextStyle::new(10.0, 450.0).mono();
const MIN_ZOOM: f32 = 0.05;

/// How high a box stands on the table, in points: the selection, its neighbors, the rest, and the lift under the pointer.
const HEIGHT_SELECTED: f32 = 16.0;
const HEIGHT_NEAR: f32 = 9.0;
const HEIGHT_FAR: f32 = 3.0;
const HEIGHT_HOVER: f32 = 2.0;

/// What the page asks of the server. The page never decides these itself.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    Select(Option<String>),
    Open { view: String, select: Option<String>, camera: Camera },
    Back,
}

impl Act {
    pub fn json(&self) -> String {
        let quote = |s: &str| serde_json::to_string(s).unwrap_or_default();
        match self {
            Act::Select(None) => r#"{"kind":"select","id":null}"#.into(),
            Act::Select(Some(id)) => format!(r#"{{"kind":"select","id":{}}}"#, quote(id)),
            Act::Open { view, select, camera } => format!(
                r#"{{"kind":"open","view":{},"select":{},"camera":{{"x":{},"y":{},"zoom":{},"moved":{}}}}}"#,
                quote(view),
                select.as_deref().map_or("null".into(), quote),
                camera.x,
                camera.y,
                camera.zoom,
                camera.moved
            ),
            Act::Back => r#"{"kind":"back"}"#.into(),
        }
    }
}

pub struct App {
    pub model: Arc<Model>,
    pub frame: Frame,
    pub window: String,
    /// The selection as drawn: the person's click shows at once, and the server's frame confirms it.
    pub selected: Option<String>,
    /// The box under the pointer.
    pub hover: Option<String>,
    /// The box whose glow shows: the selection, once the light travelling to it has arrived (`light.rs` sets it).
    pub glow: Option<String>,
    /// Where the ball of light travelling a line to the new selection is, in the view's points (`light.rs` sets it).
    pub pin: Option<[f32; 2]>,
    /// The line the ball travels and how far along it is charged: a share of its length from its source, or from its target when negative
    /// (`light.rs` sets it).
    pub trail: Option<(String, f32)>,
    /// Acts waiting to be sent; the wasm side sends them, the tests read them.
    pub outbox: Vec<Act>,
    pub problem: Option<String>,
    pub size: [f32; 2],
    pub stage: [f32; 2],
    pub moved: bool,
    pub pan: [f32; 2],
    pub zoom: f32,
    pub live_pan: Live<[f32; 2]>,
    pub live_zoom: Live<f32>,
    pub pan_at_press: [f32; 2],
    /// Set when a new view arrives, so the next layout fits it (or puts back the camera Back carried).
    pub refit: bool,
}

/// The model the page starts with, set before the app is made (the wasm side fetches it; the tests load a fixture).
pub static START: OnceLock<(Arc<Model>, Frame)> = OnceLock::new();

impl Default for App {
    fn default() -> App {
        let (model, frame) = START.get().cloned().unwrap_or_else(|| (Arc::new(Model { project: String::new(), ink: empty_ink(), views: Vec::new() }), Frame::default()));
        App::new(model, frame)
    }
}

fn empty_ink() -> Ink {
    Model::parse(r#"{"project":"","palette":{},"views":[]}"#).expect("an empty model parses").ink
}

impl App {
    pub fn new(model: Arc<Model>, frame: Frame) -> App {
        let selected = frame.selected.clone();
        App {
            model,
            frame,
            window: String::new(),
            glow: selected.clone(),
            hover: None,
            pin: None,
            trail: None,
            selected,
            outbox: Vec::new(),
            problem: None,
            size: [1440.0, 900.0],
            stage: [0.0, 0.0],
            moved: false,
            pan: [0.0, 0.0],
            zoom: 1.0,
            live_pan: Live::new([0.0, 0.0]),
            live_zoom: Live::new(1.0),
            pan_at_press: [0.0, 0.0],
            refit: true,
        }
    }

    pub fn current(&self) -> Option<&View> {
        self.model.view(&self.frame.view)
    }

    /// A frame from the server: its view and selection are the truth. A new view is fitted, unless Back carried the camera it left.
    pub fn take(&mut self, window: String, frame: Frame) {
        let new_view = frame.view != self.frame.view;
        self.window = window;
        self.selected = frame.selected.clone();
        if let Some(c) = frame.restore {
            self.moved = c.moved;
            if c.moved {
                self.camera([c.x, c.y], c.zoom);
            } else {
                self.refit = true;
            }
        } else if new_view {
            self.moved = false;
            self.refit = true;
        }
        self.frame = frame;
        if self.refit && self.stage[0] > 0.0 {
            self.fit();
        }
    }

    fn send(&mut self, act: Act) {
        self.outbox.push(act);
        #[cfg(target_arch = "wasm32")]
        net::flush(self);
    }

    pub fn select(&mut self, id: Option<String>) {
        if self.selected == id {
            return;
        }
        self.selected = id.clone();
        self.send(Act::Select(id));
    }

    pub fn open(&mut self, view: String, select: Option<String>) {
        let camera = Camera { x: self.pan[0], y: self.pan[1], zoom: self.zoom, moved: self.moved };
        self.send(Act::Open { view, select, camera });
    }

    pub fn back(&mut self) {
        if self.frame.can_back {
            self.send(Act::Back);
        }
    }

    fn camera(&mut self, pan: [f32; 2], zoom: f32) {
        (self.pan, self.zoom) = (pan, zoom.clamp(MIN_ZOOM, 4.0));
        self.live_pan.set(self.pan);
        self.live_zoom.set(self.zoom);
    }

    /// The whole view on the stage, however large: the zoom goes as low as it must, and up to 1.6 for a small one.
    pub fn fit(&mut self) {
        let [w, h] = self.stage;
        let Some(view) = self.current() else { return };
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let [vw, vh] = view.size;
        let margin = 48.0_f32.min(w / 8.0).min(h / 8.0);
        let zoom = ((w - 2.0 * margin) / vw.max(1.0)).min((h - 2.0 * margin) / vh.max(1.0)).min(1.6);
        self.refit = false;
        self.camera([(w - vw * zoom) / 2.0, (h - vh * zoom) / 2.0], zoom.max(MIN_ZOOM));
    }

    fn zoom_about(&mut self, q: [f32; 2], factor: f32) {
        let zoom = (self.zoom * factor).clamp(MIN_ZOOM, 4.0);
        let world = [(q[0] - self.pan[0]) / self.zoom, (q[1] - self.pan[1]) / self.zoom];
        self.moved = true;
        self.camera([q[0] - world[0] * zoom, q[1] - world[1] * zoom], zoom);
    }
}

// ---- The diagram ----------------------------------------------------------------------------

/// A group is a well sunk into the table: darker than the floor, its upper walls in shadow and its lower lip catching the lamp, its name
/// cut into the stone at the top left.
fn group_box(node: &Node, selected: bool, ink: &Ink) -> Vec<El> {
    let [x, y, w, h] = node.rect;
    let id = node.id.clone();
    let depth = node.depth.min(3.0);
    let dark = ink.dark();
    let well = el()
        .key(format!("well/{id}"))
        .pin(Some(x), Some(y), None, None)
        .size(w, h)
        .radius(18.0)
        // Each nested well is a step lighter than the one it sits in, so a well inside a well still reads.
        .fill(ink.background.mix(Color::BLACK, if dark { 0.35 } else { 0.05 }).mix(ink.text, 0.02 * depth.min(2.0).max(0.0) + 0.012))
        .border(1.0, Color::BLACK.alpha(if dark { 0.35 } else { 0.08 }))
        .box_shadow(Shadow { x: 2.0, y: 5.0, blur: 18.0, spread: 0.0, color: Color::BLACK.alpha(if dark { 0.55 } else { 0.16 }), inset: true })
        .box_shadow(Shadow { x: -1.0, y: -1.0, blur: 1.0, spread: 0.0, color: ink.text.alpha(0.07), inset: true })
        .mark(mark(mat::FLAT, 0.0))
        .inert();
    let title = row()
        .key(format!("group/{id}"))
        .role("button")
        .label(node.title.clone())
        .pin(Some(x + 16.0), Some(y + 12.0), None, None)
        .cursor(Cursor::Pointer)
        .child(text(node.title.to_uppercase()).font(SECTION).color(if selected { ink.accent } else { ink.muted.alpha(0.8) }))
        .on_press(move |s: &mut App| s.select(Some(id.clone())));
    vec![well, title]
}

/// A box is a slab standing on the table, lit by the room; how high it stands is how near it is to the selection. Under the pointer its edge
/// catches the lamp: a warm glow along the border, no light shone on it. When selected it glows around its edges. What the model says it is
/// (a person, a store, a queue) is a word on it, never a shape.
fn card(node: &Node, s: &App, near: bool, ink: &Ink) -> El {
    let [x, y, w, h] = node.rect;
    let id = node.id.clone();
    let selected = s.selected.as_deref() == Some(id.as_str());
    let hovered = s.hover.as_deref() == Some(id.as_str());
    let height = if selected { HEIGHT_SELECTED } else if near { HEIGHT_NEAR } else { HEIGHT_FAR } + if hovered { HEIGHT_HOVER } else { 0.0 };
    // Boxes away from the selection recede by color and by height, never by opacity: an opacity layer would not survive the light's split
    // of shapes and text. A slab rises toward the light: toward the text's white in a dark room, toward white in a light one.
    let lift = if ink.dark() { ink.text } else { Color::WHITE };
    let slab = ink.background.mix(lift, if selected { 0.16 } else if near { 0.105 } else { 0.045 }).mix(ink.text, if ink.dark() || near { 0.0 } else { 0.03 });
    let (title, quiet) = if near { (ink.text, ink.body) } else { (ink.text.mix(ink.background, 0.5), ink.body.mix(ink.background, 0.55)) };
    let mut words = col().w_full().h_full().px(13.0).justify_center().gap(4.0).min_w(0.0).inert();
    words = words.child(text(node.title.clone()).font(NAME).color(title).truncate());
    let about: Vec<String> = [node.role.to_uppercase(), node.technology.clone()].into_iter().filter(|w| !w.is_empty()).collect();
    if !about.is_empty() && h >= 40.0 {
        words = words.child(text(about.join("  ·  ")).font(SMALL).color(quiet).truncate());
    }
    let card = el()
        .key(format!("node/{id}"))
        .role("button")
        .label(node.title.clone())
        .focusable(true)
        .pin(Some(x), Some(y), None, None)
        .size(w, h)
        .radius(12.0)
        .fill(slab)
        .gradient(ink.text.alpha(if near { 0.04 } else { 0.015 }), Color::TRANSPARENT);
    // The lamp's warmth, for the edge under the pointer.
    let warm = Color { r: 1.0, g: 0.93, b: 0.82, a: 1.0 };
    let border = if selected {
        Color::WHITE.alpha(0.4)
    } else if hovered {
        warm.alpha(0.3)
    } else {
        ink.text.alpha(if near { 0.08 } else { 0.035 })
    };
    let card = card.border(1.0, border);
    // The selected box is backlit: a white glow lies under the solid box, the same on every side, so the light shows only around its
    // edges and never through it. A tight rim and a soft spill, both faint: the directional backlight is the light's (light.rs); this only
    // keeps the whole rim from going dark on the far side. Under the pointer the rim is the lamp's warmth. The colors spring, so the glow
    // comes up and goes out.
    let glowing = s.glow.as_deref() == Some(id.as_str());
    let (rim, spill) = if glowing {
        (Color::WHITE.alpha(0.22), Color::WHITE.alpha(0.06))
    } else if hovered {
        (warm.alpha(0.14), warm.alpha(0.0))
    } else {
        (Color::WHITE.alpha(0.0), Color::WHITE.alpha(0.0))
    };
    let watch = id.clone();
    let mut card = card
        .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 32.0, spread: 4.0, color: spill, inset: false })
        .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 6.0, spread: 0.5, color: rim, inset: false })
        .shadow(3.0, 8.0, Color::BLACK.alpha(if glowing { 0.0 } else if ink.dark() { 0.4 } else { 0.2 }))
        .mark(mark(mat::CARD, height))
        .cursor(Cursor::Pointer)
        .motion(motion::SNAPPY)
        .on_hover_change(move |s: &mut App, on: bool, _tx: &mut Tx| {
            if on {
                s.hover = Some(watch.clone());
            } else if s.hover.as_deref() == Some(watch.as_str()) {
                s.hover = None;
            }
        })
        .child(words);
    let pick = id.clone();
    card = card.on_press(move |s: &mut App| s.select(Some(pick.clone())));
    if let Some(opens) = node.opens.clone() {
        card = card.on_double_press(move |s: &mut App| s.open(opens.clone(), None));
    }
    card
}

/// A relationship's route as LikeC4 laid it, flattened: cubic Béziers when the points come in threes, straight runs otherwise.
pub fn edge_pen(edge: &Edge) -> Pen {
    let p = &edge.points;
    let Some(first) = p.first() else { return Pen::new() };
    let mut pen = Pen::new().move_to(*first);
    if p.len() % 3 == 1 && p.len() > 1 {
        for t in p[1..].chunks(3) {
            pen = pen.cubic_to(t[0], t[1], t[2]);
        }
    } else {
        for q in &p[1..] {
            pen = pen.line_to(*q);
        }
    }
    pen
}

/// A relationship nobody is looking at: a groove cut into the table, its far wall catching the lamp as a hairline, ending in a small bead
/// on its target so the direction reads without an arrowhead.
fn groove(into: Shape, edge: &Edge, dim: bool, ink: &Ink) -> Shape {
    let pen = edge_pen(edge);
    let Some(tip) = pen.subs.first().and_then(|s| s.0.last().copied()) else { return into };
    let cut = ink.background.mix(Color::BLACK, if ink.dark() { 0.5 } else { 0.12 });
    let lit = ink.text.alpha(if dim { 0.09 } else { 0.15 });
    let s = pen.stroke(into, 1.7, cut, None);
    let s = pen.clone().offset(0.5, 0.9).stroke(s, 0.8, lit, None);
    let s = Pen::new().ellipse(tip, 2.4, 2.4).fill(s, cut);
    Pen::new().ellipse([tip[0] + 0.4, tip[1] + 0.7], 1.6, 1.6).fill(s, lit)
}

/// A relationship carrying the selection's light: a fine, quietly lit line along the route with the faintest halo, and a small bead on its
/// target. In a light room white would vanish, so it takes the theme's accent there.
fn filament(into: Shape, points: Vec<[f32; 2]>, bead: bool, ink: &Ink) -> Shape {
    if points.len() < 2 {
        return into;
    }
    let light = if ink.dark() { Color::WHITE } else { ink.accent };
    let pen = Pen { subs: vec![(points, false)] };
    let s = pen.stroke(into, 3.0, light.alpha(0.05), None);
    let s = pen.stroke(s, 1.2, light.alpha(0.5), None);
    match (bead, pen.subs[0].0.last()) {
        (true, Some(tip)) => Pen::new().ellipse(*tip, 2.1, 2.1).fill(s, light.alpha(0.6)),
        _ => s,
    }
}

/// A label goes on the diagram only where its edge has the room; Connects always has it.
fn label_fits(e: &Edge) -> bool {
    let (Some(a), Some(b)) = (e.points.first(), e.points.last()) else { return false };
    if e.label.is_empty() {
        return false;
    }
    let wide = e.label.chars().count() as f32 * 6.2 + 14.0;
    let (dx, dy) = ((b[0] - a[0]).abs(), (b[1] - a[1]).abs());
    if dx >= dy { dx >= wide + 12.0 } else { dx < 12.0 && dy >= 42.0 }
}

fn diagram(s: &App, view: &View, ink: &Ink) -> El {
    let sel = s.selected.as_deref();
    let touching = |e: &Edge| sel.is_some_and(|id| e.source == id || e.target == id);
    let near = |id: &str| {
        sel.is_none_or(|sel| {
            sel == id
                || view.nodes.iter().any(|n| n.id == sel && n.group && id.starts_with(&format!("{sel}.")))
                || view.edges.iter().any(|e| (e.source == sel && e.target == id) || (e.target == sel && e.source == id))
        })
    };
    let [vw, vh] = [view.size[0].max(1.0), view.size[1].max(1.0)];
    let mut world = el().key(format!("world/{}", view.id)).size(vw, vh).origin(0.0, 0.0).live_offset(&s.live_pan).live_scale(&s.live_zoom);

    let mut groups: Vec<&Node> = view.nodes.iter().filter(|n| n.group).collect();
    groups.sort_by(|a, b| a.depth.total_cmp(&b.depth).reverse());
    for node in groups {
        for part in group_box(node, sel == Some(node.id.as_str()), ink) {
            world = world.child(part);
        }
    }

    // Lines: grooves, and filaments of light where the selection is. While the ball travels, only the line behind it is charged; the rest
    // of the new box's lines light when it arrives.
    let dim = sel.is_some();
    let travelling = s.trail.as_ref().map(|t| t.0.as_str());
    let mut grooves = Shape::new();
    let mut lit = Shape::new();
    for e in &view.edges {
        if touching(e) && travelling.is_none() {
            lit = filament(lit, edge_pen(e).subs.first().map(|s| s.0.clone()).unwrap_or_default(), true, ink);
        } else if travelling == Some(e.id.as_str()) {
            let u = s.trail.as_ref().map_or(0.0, |t| t.1);
            let path = edge_pen(e).subs.first().map(|s| s.0.clone()).unwrap_or_default();
            lit = filament(lit, geom::cut(&path, u), false, ink);
            grooves = groove(grooves, e, dim, ink);
        } else {
            grooves = groove(grooves, e, dim, ink);
        }
    }
    world = world.child(canvas(grooves.view_box(vw, vh)).size(vw, vh).pin(Some(0.0), Some(0.0), None, None).inert());
    world = world.child(canvas(lit.view_box(vw, vh)).size(vw, vh).pin(Some(0.0), Some(0.0), None, None).inert());

    for node in view.nodes.iter().filter(|n| !n.group) {
        world = world.child(card(node, s, near(&node.id), ink));
    }

    // The ball of energy travelling the line: a white core a little wider than the line, with a soft halo, so the eye can follow it.
    if let Some([x, y]) = s.pin {
        let z = s.zoom.max(0.05);
        let d = 1.6 + 2.0 / z;
        world = world.child(
            el().key("pin")
                .pin(Some(x - d / 2.0), Some(y - d / 2.0), None, None)
                .size(d, d)
                .radius(d / 2.0)
                .fill(Color::WHITE.alpha(0.9))
                .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 10.0 / z, spread: 0.5 / z, color: Color::WHITE.alpha(0.35), inset: false })
                .mark(mark(mat::FLAT, 0.0))
                .inert(),
        );
    }

    // Words on a line only where they answer something: around the selected box, or everywhere when nothing is selected. Cut into the
    // table like the group names, on a small dark plate so the line does not run through them.
    for e in view.edges.iter().filter(|e| (!dim || touching(e)) && label_fits(e)) {
        if let Some([x, y]) = e.label_at {
            let plate = ink.background.mix(Color::BLACK, 0.3);
            let mut words = col().px(7.0).py(3.0).items_center().radius(5.0).fill(plate).border(1.0, ink.text.alpha(0.07)).child(text(e.label.clone()).font(EDGE_LABEL).color(if dim { ink.text } else { ink.body }));
            if !e.technology.is_empty() {
                words = words.child(text(e.technology.clone()).font(TextStyle::new(9.5, 400.0).mono()).color(ink.muted));
            }
            world = world.child(row().key(format!("label/{}", e.id)).pin(Some(x - 100.0), Some(y - 10.0), None, None).w(200.0).center().inert().child(words));
        }
    }

    // Where you are, cut into the table at the top left of the stage: the project, the view, the count.
    let h = &s.frame.header;
    let title = col()
        .key("header")
        .pin(Some(24.0), Some(20.0), None, None)
        .gap(3.0)
        .inert()
        .child(text(h.project.to_uppercase()).font(SECTION).color(ink.muted))
        .child(text(h.view.clone()).font(TITLE).color(ink.text))
        .child(text(format!("{} boxes", h.boxes)).font(SMALL).color(ink.muted));

    el().key("stage")
        .grow(1.0)
        .h_full()
        .min_w(0.0)
        .clip_soft(0.0)
        .cursor(Cursor::Grab)
        .child(world)
        .child(title)
        .on_layout(|s: &mut App, r| {
            s.stage = [r[2], r[3]];
            if !s.moved || s.refit {
                s.fit();
            }
        })
        .on_wheel(|s: &mut App, e: WheelEvent, tx: &mut Tx| {
            s.moved = true;
            s.camera([s.pan[0] + e.dx, s.pan[1] + e.dy], s.zoom);
            tx.live_only();
            true
        })
        .on_magnify(|s: &mut App, e: MagnifyEvent, tx: &mut Tx| {
            s.zoom_about([e.x, e.y], 1.0 + e.delta);
            tx.live_only();
            true
        })
        .on_drag(|s: &mut App, d: &mut Drag, _tx: &mut Tx| {
            match d.phase {
                Phase::Down => s.pan_at_press = s.pan,
                Phase::Up if d.dx.hypot(d.dy) < 3.0 => s.select(None),
                _ => {}
            }
            if d.dx.hypot(d.dy) >= 3.0 {
                s.moved = true;
                s.camera([s.pan_at_press[0] + d.dx, s.pan_at_press[1] + d.dy], s.zoom);
            }
        })
}

// ---- The inspector --------------------------------------------------------------------------

/// Lines of spans as the terminal's functions gave them, wrapped by the page.
fn spans(lines: &[Span], fallback: Color, style: TextStyle) -> El {
    let mut out = col().w_full().gap(4.0).min_w(0.0);
    let mut line = String::new();
    let mut marks: Vec<rune::Span> = Vec::new();
    let push = |line: &mut String, marks: &mut Vec<rune::Span>, out: El| -> El {
        let el = rich(std::mem::take(line), std::mem::take(marks)).font(style).color(fallback).w_full();
        out.child(el)
    };
    for span in lines {
        for (i, part) in span.text.split('\n').enumerate() {
            if i > 0 {
                out = push(&mut line, &mut marks, out);
            }
            if part.is_empty() {
                continue;
            }
            let start = line.len() as u32;
            line.push_str(part);
            marks.push(rune::Span { start, end: line.len() as u32, color: span.color(), weight: span.bold.then_some(650.0), ..Default::default() });
        }
    }
    if !line.is_empty() {
        out = push(&mut line, &mut marks, out);
    }
    out
}

fn section(title: &str, ink: &Ink) -> El {
    text(title.to_uppercase()).font(SECTION).color(ink.muted)
}

/// A slab standing on the table: the pane the inspector's words lie on, and the rail's current view.
fn slab(ink: &Ink, height: f32) -> El {
    el().fill(ink.background.mix(ink.text, 0.06))
        .border(1.0, ink.text.alpha(0.07))
        .gradient(ink.text.alpha(0.025), Color::TRANSPARENT)
        .box_shadow(Shadow { x: 0.0, y: 10.0, blur: 30.0, spread: 0.0, color: Color::BLACK.alpha(0.3), inset: false })
        .mark(mark(mat::CARD, height))
}

fn inspector(s: &App, ink: &Ink) -> El {
    let i = &s.frame.inspector;
    let mut head = col().w_full().gap(8.0);
    head = head.child(
        row()
            .w_full()
            .justify_between()
            .items_center()
            .gap(8.0)
            .child(text(i.title.clone()).font(HEAD).color(ink.text).truncate().min_w(0.0))
            .child(if i.agent { text("AGENT").font(SECTION).color(ink.muted) } else { el() }),
    );
    if !i.what.is_empty() {
        head = head.child(spans(&i.what, ink.muted, SMALL));
    }
    if !i.about.is_empty() {
        head = head.child(spans(&i.about, ink.body, BODY));
    }
    let mut body = col().key("inspector-body").w_full().gap(22.0).child(head);

    if !i.links.is_empty() {
        let mut links = col().w_full().gap(2.0);
        for link in &i.links {
            let node = link.node.clone();
            let tone = rune::color::hex(&link.tone).unwrap_or(ink.accent);
            let mut lines = col().min_w(0.0).grow(1.0).gap(1.0).child(text(link.title.clone()).font(TextStyle::new(13.0, 500.0)).color(ink.text).truncate());
            if !link.label.is_empty() {
                lines = lines.child(text(link.label.clone()).font(TextStyle::new(12.0, 400.0)).color(ink.muted).wrap());
            }
            links = links.child(
                row()
                    .key(format!("link/{}/{}", link.arrow, link.node))
                    .role("button")
                    .label(link.title.clone())
                    .w_full()
                    .gap(10.0)
                    .px(8.0)
                    .py(6.0)
                    .radius(7.0)
                    .hover(ink.hover)
                    .mark(mark(mat::FLAT, 0.0))
                    .cursor(Cursor::Pointer)
                    .on_press(move |s: &mut App| s.select(Some(node.clone())))
                    .child(text(link.arrow.clone()).font(TextStyle::new(13.0, 500.0)).color(tone))
                    .child(lines),
            );
        }
        body = body.child(col().w_full().gap(8.0).child(section("Connects", ink)).child(links));
    }

    if let Some(opens) = i.opens.clone() {
        let view = opens.view.clone();
        body = body.child(
            row()
                .key("open-view")
                .role("button")
                .label(format!("Open {}", opens.title))
                .h(34.0)
                .px(12.0)
                .items_center()
                .justify_between()
                .radius(9.0)
                .fill(ink.background.mix(ink.text, 0.1))
                .border(1.0, ink.text.alpha(0.08))
                .hover(ink.hover)
                // A key standing on the pane.
                .mark(mark(mat::CARD, 3.0))
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| s.open(view.clone(), None))
                .child(text(format!("Open {}", opens.title)).font(TextStyle::new(12.5, 500.0)).color(ink.text))
                .child(text("→").font(TextStyle::new(13.0, 400.0)).color(ink.muted)),
        );
    }

    col()
        .key("inspector")
        .w(356.0)
        .h_full()
        .min_h(0.0)
        .pt(16.0)
        .pb(16.0)
        .pr(16.0)
        .child(
            slab(ink, 6.0)
                .key("pane")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .radius(16.0)
                .child(col().key("inspector-scroll").w_full().h_full().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(el().w_full().px(18.0).pt(20.0).pb(20.0).child(body))),
        )
}

// ---- The window -----------------------------------------------------------------------------

fn rail(s: &App, ink: &Ink) -> El {
    let mut items = col().w_full().gap(3.0);
    for view in &s.model.views {
        let on = view.id == s.frame.view;
        let id = view.id.clone();
        let item = if on { slab(ink, 3.0).key(format!("view/{}", view.id)) } else { el().key(format!("view/{}", view.id)).hover(ink.hover).mark(mark(mat::FLAT, 0.0)) };
        items = items.child(
            item.role("tab")
                .label(view.title.clone())
                .w_full()
                .h(32.0)
                .px(12.0)
                .items_center()
                .radius(9.0)
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| s.open(id.clone(), None))
                .child(text(view.title.clone()).font(NAV).color(if on { ink.text } else { ink.muted }).truncate()),
        );
    }
    // The brand: a small lit stone in the theme's accent, and the project's name.
    let gem = el().size(9.0, 9.0).radius(2.5).fill(ink.accent).box_shadow(Shadow { x: 0.0, y: 0.0, blur: 12.0, spread: 1.0, color: ink.accent.alpha(0.55), inset: false }).mark(mark(mat::FLAT, 0.0));
    col()
        .key("rail")
        .w(236.0)
        .h_full()
        .min_h(0.0)
        .pt(22.0)
        .pl(14.0)
        .pr(8.0)
        .gap(18.0)
        .child(row().px(12.0).gap(10.0).items_center().child(gem).child(text(s.model.project.clone()).font(TextStyle::new(14.5, 600.0)).color(ink.text).truncate()))
        .child(row().px(12.0).child(section("Views", ink)))
        .child(col().key("rail-scroll").w_full().grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(el().w_full().pb(16.0).child(items)))
}

pub fn view(s: &App, _cx: &mut Cx<App>) -> El {
    let ink = &s.model.ink;
    // The window is the table; the room paints it (light.rs), so nothing here fills it.
    let root = row().key("root").w_full().h_full().on_layout(|s: &mut App, r| s.size = [r[2], r[3]]);
    if let Some(problem) = &s.problem {
        return root.center().child(text(problem.clone()).font(BODY).color(ink.text));
    }
    let Some(current) = s.current() else {
        return root.center().child(text("Loading…").font(BODY).color(ink.muted));
    };
    let wide = s.size[0] >= 1100.0;
    let mut root = root;
    if wide {
        root = root.child(rail(s, ink));
    }
    root.child(diagram(s, current, ink)).child(inspector(s, ink))
}

fn on_key(s: &mut App, e: &KeyEvent, _tx: &mut Tx) -> bool {
    match &e.key {
        Key::Escape => {
            s.select(None);
            true
        }
        Key::Enter => {
            if let Some(opens) = s.frame.inspector.opens.clone() {
                s.open(opens.view, None);
            }
            true
        }
        Key::Text(t) if t.as_str() == "f" => {
            s.moved = false;
            s.fit();
            true
        }
        Key::Text(t) if t.as_str() == "b" => {
            s.back();
            true
        }
        _ => false,
    }
}

pub fn spec() -> AppSpec<App> {
    AppSpec::<App> { on_key: Some(on_key), ..AppSpec::new("Pathlight", (1440.0, 900.0), App::default, view) }
}

#[cfg(test)]
mod tests;
