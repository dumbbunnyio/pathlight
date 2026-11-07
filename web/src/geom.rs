//! Shapes, arrowheads and dashes. The geometry of LikeC4's eleven element shapes and its arrowheads is LikeC4's own
//! (`packages/diagram/src/base-primitives/element/ElementShape.tsx` and `edge/EdgeMarkers.tsx` at v1.60.0, MIT, see NOTICE.md), ported to
//! polylines for Rune's `Shape`. Their constants are for LikeC4's card sizes; `k` scales them to the page's tighter cards.

use rune::{Color, LineCap, Shape};
use std::f32::consts::{FRAC_PI_2, PI};

pub type Pt = [f32; 2];

/// A figure as closed or open polylines, with curves flattened, so it can be filled, stroked or dashed.
#[derive(Default, Clone)]
pub struct Pen {
    pub subs: Vec<(Vec<Pt>, bool)>,
}

impl Pen {
    pub fn new() -> Pen {
        Pen::default()
    }

    fn cur(&mut self) -> &mut Vec<Pt> {
        if self.subs.last().is_none_or(|s| s.1) {
            let at = self.at();
            self.subs.push((vec![at], false));
        }
        &mut self.subs.last_mut().expect("pushed").0
    }

    fn at(&self) -> Pt {
        self.subs.last().and_then(|s| s.0.last().copied()).unwrap_or([0.0, 0.0])
    }

    pub fn move_to(mut self, p: Pt) -> Pen {
        self.subs.push((vec![p], false));
        self
    }

    pub fn line_to(mut self, p: Pt) -> Pen {
        self.cur().push(p);
        self
    }

    pub fn cubic_to(mut self, c1: Pt, c2: Pt, p: Pt) -> Pen {
        let a = self.at();
        let n = ((dist(a, c1) + dist(c1, c2) + dist(c2, p)) / 3.0).clamp(4.0, 48.0) as usize;
        let pts = self.cur();
        for i in 1..=n {
            let t = i as f32 / n as f32;
            let u = 1.0 - t;
            let (b0, b1, b2, b3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            pts.push([b0 * a[0] + b1 * c1[0] + b2 * c2[0] + b3 * p[0], b0 * a[1] + b1 * c1[1] + b2 * c2[1] + b3 * p[1]]);
        }
        self
    }

    pub fn quad_to(self, c: Pt, p: Pt) -> Pen {
        let a = self.at();
        let c1 = [a[0] + 2.0 / 3.0 * (c[0] - a[0]), a[1] + 2.0 / 3.0 * (c[1] - a[1])];
        let c2 = [p[0] + 2.0 / 3.0 * (c[0] - p[0]), p[1] + 2.0 / 3.0 * (c[1] - p[1])];
        self.cubic_to(c1, c2, p)
    }

    /// An elliptical arc around `c` from angle `a0` to `a1` (radians, y down), continuing the current polyline.
    pub fn arc(mut self, c: Pt, rx: f32, ry: f32, a0: f32, a1: f32) -> Pen {
        let n = (((a1 - a0).abs() / (PI / 24.0)).ceil() as usize).max(2);
        let pts = self.cur();
        for i in 0..=n {
            let t = a0 + (a1 - a0) * i as f32 / n as f32;
            pts.push([c[0] + rx * t.cos(), c[1] + ry * t.sin()]);
        }
        self
    }

    pub fn close(mut self) -> Pen {
        if let Some(last) = self.subs.last_mut() {
            last.1 = true;
        }
        self
    }

    pub fn rect(self, x: f32, y: f32, w: f32, h: f32, r: f32) -> Pen {
        let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
        self.move_to([x + r, y])
            .line_to([x + w - r, y])
            .arc([x + w - r, y + r], r, r, -FRAC_PI_2, 0.0)
            .line_to([x + w, y + h - r])
            .arc([x + w - r, y + h - r], r, r, 0.0, FRAC_PI_2)
            .line_to([x + r, y + h])
            .arc([x + r, y + h - r], r, r, FRAC_PI_2, PI)
            .line_to([x, y + r])
            .arc([x + r, y + r], r, r, PI, PI + FRAC_PI_2)
            .close()
    }

    pub fn ellipse(self, c: Pt, rx: f32, ry: f32) -> Pen {
        self.move_to([c[0] + rx, c[1]]).arc(c, rx, ry, 0.0, 2.0 * PI).close()
    }

    pub fn offset(mut self, dx: f32, dy: f32) -> Pen {
        for (pts, _) in &mut self.subs {
            for p in pts.iter_mut() {
                *p = [p[0] + dx, p[1] + dy];
            }
        }
        self
    }

    pub fn fill(&self, into: Shape, color: Color) -> Shape {
        self.subs.iter().filter(|s| s.1).fold(into, |s, (pts, _)| s.fill(pts.clone(), color))
    }

    pub fn stroke(&self, into: Shape, width: f32, color: Color, line: Option<crate::data::Line>) -> Shape {
        use crate::data::Line;
        let mut s = into;
        for (pts, closed) in &self.subs {
            let mut pts = pts.clone();
            if *closed && pts.first() != pts.last() {
                pts.push(pts[0]);
            }
            match line {
                None => {}
                Some(Line::Solid) => s = s.stroke_with(pts, false, width, LineCap::Round, color),
                Some(Line::Dashed) => s = dash(&pts, 5.0, 4.5).into_iter().fold(s, |s, d| s.stroke_with(d, false, width, LineCap::Butt, color)),
                Some(Line::Dotted) => s = dash(&pts, 0.01, 4.0).into_iter().fold(s, |s, d| s.stroke_with(d, false, width * 1.3, LineCap::Round, color)),
            }
        }
        s
    }
}

pub fn dist(a: Pt, b: Pt) -> f32 {
    (b[0] - a[0]).hypot(b[1] - a[1])
}

/// Splits a polyline into dashes `on` long with `off` between them.
pub fn dash(points: &[Pt], on: f32, off: f32) -> Vec<Vec<Pt>> {
    let mut out = Vec::new();
    let mut cur: Vec<Pt> = Vec::new();
    let mut drawing = true;
    let mut left = on;
    for w in points.windows(2) {
        let (mut a, b) = (w[0], w[1]);
        let mut seg = dist(a, b);
        while seg > 0.0 {
            let step = left.min(seg);
            let t = step / seg;
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            if drawing {
                if cur.is_empty() {
                    cur.push(a);
                }
                cur.push(p);
            }
            seg -= step;
            left -= step;
            a = p;
            if left <= 1e-4 {
                if drawing {
                    if cur.len() == 1 {
                        cur.push([cur[0][0] + 0.01, cur[0][1]]);
                    }
                    out.push(std::mem::take(&mut cur));
                }
                drawing = !drawing;
                left = if drawing { on } else { off };
            }
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

/// LikeC4's person silhouette, in a 115 × 120 box (`PersonIcon`).
const PERSON: &str = "M57.9197 0C10.9124 0 33.5766 54.75 33.5766 54.75C38.6131 62.25 45.3285 60.75 45.3285 66C45.3285 70.5 39.4526 72 33.5766 72.75C24.3431 72.75 15.9489 71.25 7.55474 84.75C2.51825 93 0 120 0 120H115C115 120 112.482 93 108.285 84.75C99.8905 70.5 91.4963 72.75 82.2628 72C76.3869 71.25 70.5109 69.75 70.5109 65.25C70.5109 60.75 77.2263 62.25 82.2628 54C82.2628 54.75 104.927 0 57.9197 0V0Z";

/// Reads an SVG path of absolute `M`, `C`, `H`, `V` and `Z` commands, scaled by `k` and moved by `at`.
fn svg_path(d: &str, k: f32, at: Pt) -> Pen {
    let mut nums: Vec<f32> = Vec::new();
    let mut pen = Pen::new();
    let mut cmd = ' ';
    let mut cur = [0.0_f32, 0.0_f32];
    let p = |x: f32, y: f32| [at[0] + x * k, at[1] + y * k];
    let flush = |cmd: char, nums: &mut Vec<f32>, pen: Pen, cur: &mut Pt| -> Pen {
        let mut pen = pen;
        match cmd {
            'M' if nums.len() >= 2 => {
                *cur = [nums[0], nums[1]];
                pen = pen.move_to(p(cur[0], cur[1]));
            }
            'C' => {
                for c in nums.chunks(6).filter(|c| c.len() == 6) {
                    pen = pen.cubic_to(p(c[0], c[1]), p(c[2], c[3]), p(c[4], c[5]));
                    *cur = [c[4], c[5]];
                }
            }
            'H' => {
                for x in nums.iter() {
                    cur[0] = *x;
                    pen = pen.line_to(p(cur[0], cur[1]));
                }
            }
            'V' => {
                for y in nums.iter() {
                    cur[1] = *y;
                    pen = pen.line_to(p(cur[0], cur[1]));
                }
            }
            'Z' => pen = pen.close(),
            _ => {}
        }
        nums.clear();
        pen
    };
    let mut token = String::new();
    for ch in d.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphabetic() || ch == ' ' || ch == ',' || (ch == '-' && !token.is_empty()) {
            if let Ok(v) = token.parse::<f32>() {
                nums.push(v);
            }
            token.clear();
            if ch == '-' {
                token.push(ch);
            }
            if ch.is_ascii_alphabetic() {
                pen = flush(cmd, &mut nums, pen, &mut cur);
                cmd = ch;
            }
        } else {
            token.push(ch);
        }
    }
    flush(cmd, &mut nums, pen, &mut cur)
}

/// The parts of one shape: `body` takes the card's fill and outline, `detail` the mix of fill and outline LikeC4 calls `mix-stroke` (drawn
/// under the body), `inset` the plain fill drawn over the detail, `lid` an outlined top (a cylinder's, a queue's, a bucket's), and `over` a
/// `mix-stroke` figure drawn last, on the body (the person's silhouette).
#[derive(Default)]
pub struct Figure {
    pub body: Pen,
    pub detail: Pen,
    pub inset: Pen,
    pub lid: Pen,
    pub over: Pen,
}

/// The figure for LikeC4's `shape` in a `w` × `h` box at the origin; `k` scales LikeC4's fixed sizes.
pub fn figure(shape: &str, w: f32, h: f32, k: f32) -> Figure {
    let r = 6.0 * k.max(0.6);
    let mut f = Figure::default();
    match shape {
        "component" => {
            f.body = Pen::new().rect(0.0, 0.0, w, h, r);
            let (rw, rh, ox, oy, between) = (60.0 * k, 26.0 * k, -20.0 * k, 22.0 * k, 14.0 * k);
            f.lid = Pen::new().rect(ox, oy, rw, rh, 3.0 * k).rect(ox, oy + rh + between, rw, rh, 3.0 * k);
        }
        "mobile" => {
            f.detail = Pen::new().rect(0.0, 0.0, w, h, r);
            f.inset = Pen::new().ellipse([17.0 * k, h / 2.0], 12.0 * k, 12.0 * k).rect(33.0 * k, 12.0 * k, w - 44.0 * k, h - 24.0 * k, 5.0 * k);
        }
        "browser" => {
            f.detail = Pen::new().rect(0.0, 0.0, w, h, r);
            f.inset = Pen::new()
                .ellipse([16.0 * k, 17.0 * k], 7.0 * k, 7.0 * k)
                .ellipse([36.0 * k, 17.0 * k], 7.0 * k, 7.0 * k)
                .ellipse([56.0 * k, 17.0 * k], 7.0 * k, 7.0 * k)
                .rect(70.0 * k, 8.0 * k, w - 80.0 * k, 17.0 * k, 4.0 * k)
                .rect(10.0 * k, 32.0 * k, w - 20.0 * k, h - 42.0 * k, 4.0 * k);
        }
        "person" => {
            f.body = Pen::new().rect(0.0, 0.0, w, h, r);
            let s = (h / 120.0).min(k * 0.9);
            f.over = svg_path(PERSON, s, [w - 115.0 * s - 6.0 * k, h - 120.0 * s]);
        }
        "queue" => {
            let ry = h / 2.0;
            let rx = ry * 0.185;
            f.body = Pen::new()
                .move_to([rx, 0.0])
                .arc([rx, ry], rx, ry, -FRAC_PI_2, -FRAC_PI_2 - PI)
                .line_to([w - rx, h])
                .arc([w - rx, ry], rx, ry, FRAC_PI_2, -FRAC_PI_2)
                .close();
            f.lid = Pen::new().ellipse([rx, ry], rx, ry - 0.75);
        }
        "bucket" => {
            let cx = w / 2.0;
            let (trx, try_) = (cx, (h / 8.0).min(cx * 0.08));
            let (brx, bry) = (trx * 0.8, try_ * 1.05);
            f.body = Pen::new()
                .move_to([w, try_])
                .arc([cx, try_], trx, try_, 0.0, -PI)
                .line_to([cx - brx, h - bry])
                .arc([cx, h - bry], brx, bry, PI, 0.0)
                .close();
            f.lid = Pen::new().ellipse([cx, try_], trx, try_);
        }
        "storage" | "cylinder" => {
            let rx = w / 2.0;
            let ry = 0.07 * rx;
            f.body = Pen::new()
                .move_to([w, ry])
                .arc([rx, ry], rx, ry, 0.0, -PI)
                .line_to([0.0, h - ry])
                .arc([rx, h - ry], rx, ry, PI, 0.0)
                .close();
            f.lid = Pen::new().ellipse([rx, ry], rx - 0.75, ry);
        }
        "document" => {
            let base = h - h / 16.0;
            let amp = h / 6.0;
            let r = 6.0 * k.max(0.6);
            f.body = Pen::new()
                .move_to([0.0, base])
                .line_to([0.0, r])
                .quad_to([0.0, 0.0], [r, 0.0])
                .line_to([w - r, 0.0])
                .quad_to([w, 0.0], [w, r])
                .line_to([w, base])
                .cubic_to([w * 0.75, base + amp], [w * 0.5, base - amp], [0.0, base])
                .close();
        }
        "agent" => {
            let (ear_w, ear_h, stem_w, stem_h, ball) = (14.0 * k, (h * 0.38).min(150.0 * k), 6.0 * k, 22.0 * k, 9.0 * k);
            let ear_y = (h - ear_h) / 2.0;
            f.detail = Pen::new()
                .rect(-ear_w + 2.0 * k, ear_y, ear_w, ear_h, 3.0 * k)
                .rect(w - 2.0 * k, ear_y, ear_w, ear_h, 3.0 * k)
                .rect((w - stem_w) / 2.0, -stem_h, stem_w, stem_h + 2.0 * k, 0.0)
                .ellipse([w / 2.0, -stem_h], ball, ball);
            f.body = Pen::new().rect(0.0, 0.0, w, h, r);
        }
        _ => f.body = Pen::new().rect(0.0, 0.0, w, h, r),
    }
    f
}

/// An arrowhead of LikeC4's kind with its tip at `tip`, pointing along `u` (a unit vector), drawn into `into`.
pub fn marker(into: Shape, kind: &str, tip: Pt, u: Pt, color: Color, hollow: Color) -> Shape {
    let (l, hw) = (7.5, 3.6);
    let n = [-u[1], u[0]];
    let at = |back: f32, side: f32| [tip[0] - u[0] * back + n[0] * side, tip[1] - u[1] * back + n[1] * side];
    match kind {
        "normal" | "onormal" => {
            let tri = vec![tip, at(l, hw), at(l, -hw)];
            if kind == "normal" {
                into.fill(tri, color)
            } else {
                into.fill(tri.clone(), hollow).stroke_with(tri, true, 1.1, LineCap::Round, color)
            }
        }
        "open" | "vee" => into.stroke_with(vec![at(l, hw), tip, at(l, -hw)], false, 1.3, LineCap::Round, color),
        "diamond" | "odiamond" => {
            let dia = vec![tip, at(l * 0.6, hw), at(l * 1.2, 0.0), at(l * 0.6, -hw)];
            if kind == "diamond" {
                into.fill(dia, color)
            } else {
                into.fill(dia.clone(), hollow).stroke_with(dia, true, 1.1, LineCap::Round, color)
            }
        }
        "dot" | "odot" => {
            let c = at(3.0, 0.0);
            let ring = Pen::new().ellipse(c, 3.0, 3.0);
            let pts = ring.subs[0].0.clone();
            if kind == "dot" {
                into.fill(pts, color)
            } else {
                into.fill(pts.clone(), hollow).stroke_with(pts, true, 1.1, LineCap::Round, color)
            }
        }
        "crow" => {
            let back = at(l, 0.0);
            into.line(back, at(0.0, hw), 1.2, LineCap::Round, color)
                .line(back, tip, 1.2, LineCap::Round, color)
                .line(back, at(0.0, -hw), 1.2, LineCap::Round, color)
        }
        _ => into,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shape_gives_a_closed_body_or_a_detail_inside_its_box() {
        for shape in ["rectangle", "person", "browser", "mobile", "cylinder", "storage", "queue", "bucket", "document", "component", "agent"] {
            let f = figure(shape, 160.0, 65.0, 0.36);
            let all: Vec<&Pt> = f.body.subs.iter().chain(&f.detail.subs).chain(&f.over.subs).flat_map(|s| &s.0).collect();
            assert!(!all.is_empty(), "{shape} draws nothing");
            // Agent's ears and antenna, and the component's two tabs, stand out of the box as LikeC4 draws them.
            let (lo, hi) = if shape == "agent" { (-12.0, 175.0) } else { (-1.0, 166.0) };
            for p in all {
                assert!(p[0] >= lo && p[0] <= hi && p[1] >= -12.0 && p[1] <= 66.0, "{shape} has {p:?} outside its box");
            }
            assert!(f.body.subs.iter().chain(&f.detail.subs).any(|s| s.1), "{shape} has nothing closed to fill");
        }
    }

    #[test]
    fn the_person_silhouette_is_read_whole() {
        let pen = svg_path(PERSON, 1.0, [0.0, 0.0]);
        assert_eq!(pen.subs.len(), 1);
        assert!(pen.subs[0].1, "it closes");
        let xs: Vec<f32> = pen.subs[0].0.iter().map(|p| p[0]).collect();
        assert!(xs.iter().cloned().fold(f32::MIN, f32::max) >= 114.0 && xs.iter().cloned().fold(f32::MAX, f32::min) <= 0.5);
    }

    #[test]
    fn dashes_cover_the_line_in_steps() {
        let d = dash(&[[0.0, 0.0], [100.0, 0.0]], 5.0, 5.0);
        assert_eq!(d.len(), 10);
        assert!((d[1][0][0] - 10.0).abs() < 1e-3);
    }
}
