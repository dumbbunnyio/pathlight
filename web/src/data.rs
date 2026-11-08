//! What the server sends (`src/web/scene.ts` and `src/web/session.ts`), and the page's one change to it: the compact fit, which tightens the
//! empty space between cards and keeps everything else LikeC4 laid out. Only structure and words arrive; how it looks is the page's.

use rune::Color;
use serde::Deserialize;
use std::collections::HashMap;

fn color(s: &str) -> Color {
    rune::color::hex(s).unwrap_or(Color::WHITE)
}

#[derive(Deserialize, Clone, Debug)]
pub struct RawNode {
    pub id: String,
    pub title: String,
    pub technology: String,
    pub role: String,
    pub group: bool,
    pub opens: Option<String>,
    pub rect: [f32; 4],
    pub depth: f32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub label: String,
    pub technology: String,
    pub points: Vec<[f32; 2]>,
    pub label_at: Option<[f32; 2]>,
    pub opens: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RawView {
    pub id: String,
    pub title: String,
    pub nodes: Vec<RawNode>,
    pub edges: Vec<RawEdge>,
}

/// `GET /api/scene`: every view of the project, in the rail's order, with the palette they were colored for.
#[derive(Deserialize, Clone, Debug)]
pub struct RawModel {
    pub project: String,
    pub palette: HashMap<String, String>,
    pub views: Vec<RawView>,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub id: String,
    pub title: String,
    pub technology: String,
    /// What the model says the box is (person, store, queue, app, document, agent), or nothing.
    pub role: String,
    pub group: bool,
    pub opens: Option<String>,
    pub rect: [f32; 4],
    pub depth: f32,
}

#[derive(Clone, Debug)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub label: String,
    pub technology: String,
    pub points: Vec<[f32; 2]>,
    pub label_at: Option<[f32; 2]>,
}

#[derive(Clone, Debug)]
pub struct View {
    pub id: String,
    pub title: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub size: [f32; 2],
}

/// The page's colors: Pathlight's palette as the server derived it from the chosen theme.
#[derive(Clone, Debug)]
pub struct Ink {
    pub background: Color,
    pub panel: Color,
    pub text: Color,
    pub body: Color,
    pub muted: Color,
    pub border: Color,
    pub rule: Color,
    pub accent: Color,
    pub incoming: Color,
    pub edge: Color,
    pub hover: Color,
}

impl Ink {
    /// A dark room: the table is dark and light stands out white on it. In a light room the slabs rise toward white instead.
    pub fn dark(&self) -> bool {
        self.background.luminance() < 0.3
    }

    fn of(p: &HashMap<String, String>) -> Ink {
        let get = |k: &str, fallback: &str| color(p.get(k).map_or(fallback, String::as_str));
        let text = get("text", "#eef1f5");
        Ink {
            background: get("background", "#0e1116"),
            panel: get("panel", "#11151b"),
            text,
            body: get("body", "#c9d0da"),
            muted: get("muted", "#7d8796"),
            border: get("border", "#4f5866"),
            rule: get("rule", "#2b3441"),
            accent: get("accent", "#e8b45a"),
            incoming: get("incoming", "#6fcad6"),
            edge: get("edgeDim", "#3a4352"),
            hover: text.alpha(0.05),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Model {
    pub project: String,
    pub ink: Ink,
    pub views: Vec<View>,
}

impl Model {
    pub fn parse(json: &str) -> Result<Model, String> {
        let raw: RawModel = serde_json::from_str(json).map_err(|e| e.to_string())?;
        Ok(Model { project: raw.project, ink: Ink::of(&raw.palette), views: raw.views.into_iter().map(compact).collect() })
    }

    pub fn view(&self, id: &str) -> Option<&View> {
        self.views.iter().find(|v| v.id == id)
    }
}

/// One axis of the compact fit: inside a card the scale is `card`, between cards it is `gap`. Monotonic, so order, ranks, nesting and which side
/// an edge leaves all survive.
struct Axis(Vec<(f32, f32)>);

impl Axis {
    fn new(mut spans: Vec<(f32, f32)>, card: f32, gap: f32) -> Axis {
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut merged: Vec<(f32, f32)> = Vec::new();
        for (a, b) in spans {
            match merged.last_mut() {
                Some(last) if a <= last.1 => last.1 = last.1.max(b),
                _ => merged.push((a, b)),
            }
        }
        let mut stops = vec![(0.0, 0.0)];
        let mut at = (0.0, 0.0);
        for (a, b) in merged {
            at = (a, at.1 + (a - at.0).max(0.0) * gap);
            stops.push(at);
            at = (b, at.1 + (b - a) * card);
            stops.push(at);
        }
        stops.push((at.0 + 10_000.0, at.1 + 10_000.0 * gap));
        Axis(stops)
    }

    fn at(&self, v: f32) -> f32 {
        for pair in self.0.windows(2) {
            let ((a, fa), (b, fb)) = (pair[0], pair[1]);
            if v <= b {
                return if b > a { fa + (v - a) / (b - a) * (fb - fa) } else { fa };
            }
        }
        self.0.last().map_or(v, |p| p.1)
    }
}

pub fn compact(raw: RawView) -> View {
    let leaves = || raw.nodes.iter().filter(|n| !n.group);
    let left = raw.nodes.iter().map(|n| n.rect[0]).fold(f32::INFINITY, f32::min).min(0.0);
    let top = raw.nodes.iter().map(|n| n.rect[1]).fold(f32::INFINITY, f32::min).min(0.0);
    let xs = Axis::new(leaves().map(|n| (n.rect[0] - left, n.rect[0] - left + n.rect[2])).collect(), 0.5, 0.14);
    let ys = Axis::new(leaves().map(|n| (n.rect[1] - top, n.rect[1] - top + n.rect[3])).collect(), 0.36, 0.8);
    let map = |p: [f32; 2]| [xs.at(p[0] - left), ys.at(p[1] - top)];
    let mut far = [0.0_f32, 0.0_f32];
    let nodes: Vec<Node> = raw
        .nodes
        .iter()
        .map(|n| {
            let [x, y, w, h] = n.rect;
            let (a, b) = (map([x, y]), map([x + w, y + h]));
            far = [far[0].max(b[0]), far[1].max(b[1])];
            Node {
                id: n.id.clone(),
                title: n.title.clone(),
                technology: n.technology.clone(),
                role: n.role.clone(),
                group: n.group,
                opens: n.opens.clone(),
                rect: [a[0], a[1], b[0] - a[0], b[1] - a[1]],
                depth: n.depth,
            }
        })
        .collect();
    let edges = raw
        .edges
        .iter()
        .map(|e| {
            let points: Vec<[f32; 2]> = e.points.iter().map(|p| map(*p)).collect();
            for p in &points {
                far = [far[0].max(p[0]), far[1].max(p[1])];
            }
            Edge {
                id: e.id.clone(),
                source: e.source.clone(),
                target: e.target.clone(),
                label: e.label.clone(),
                technology: e.technology.clone(),
                points,
                label_at: e.label_at.map(map),
            }
        })
        .collect();
    View { id: raw.id, title: raw.title, nodes, edges, size: far }
}

/// A run of words in one color, from the terminal's own functions; `\n` ends a line.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Span {
    pub text: String,
    pub fg: Option<String>,
    #[serde(default)]
    pub bold: bool,
}

impl Span {
    pub fn color(&self) -> Option<Color> {
        self.fg.as_deref().and_then(rune::color::hex)
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Link {
    pub node: String,
    pub title: String,
    pub arrow: String,
    pub tone: String,
    pub label: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Opens {
    pub view: String,
    pub title: String,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Camera {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
    pub moved: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Header {
    pub project: String,
    pub view: String,
    pub boxes: usize,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Inspector {
    pub title: String,
    pub agent: bool,
    pub what: Vec<Span>,
    pub about: Vec<Span>,
    pub links: Vec<Link>,
    pub opens: Option<Opens>,
}

/// `frame` events on `/api/events`: what the server decided for this window.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub view: String,
    pub selected: Option<String>,
    pub can_back: bool,
    pub restore: Option<Camera>,
    pub header: Header,
    pub inspector: Inspector,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Message {
    pub window: String,
    pub frame: Frame,
}
