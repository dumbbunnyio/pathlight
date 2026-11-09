//! Paths for the page's own drawing: curves flattened to polylines for Rune's `Shape`, and dashes.

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

    /// Strokes every polyline, solid or in dashes `(on, off)` long.
    pub fn stroke(&self, into: Shape, width: f32, color: Color, dashes: Option<(f32, f32)>) -> Shape {
        let mut s = into;
        for (pts, closed) in &self.subs {
            let mut pts = pts.clone();
            if *closed && pts.first() != pts.last() {
                pts.push(pts[0]);
            }
            s = match dashes {
                None => s.stroke_with(pts, false, width, LineCap::Round, color),
                Some((on, off)) => dash(&pts, on, off).into_iter().fold(s, |s, d| s.stroke_with(d, false, width, LineCap::Round, color)),
            };
        }
        s
    }
}

pub fn dist(a: Pt, b: Pt) -> f32 {
    (b[0] - a[0]).hypot(b[1] - a[1])
}

/// The first `u` (0 to 1) of a polyline's length; a negative `u` takes the same share from its end instead.
pub fn cut(points: &[Pt], u: f32) -> Vec<Pt> {
    if u < 0.0 {
        let mut rev: Vec<Pt> = points.iter().rev().copied().collect();
        rev = cut(&rev, -u);
        rev.reverse();
        return rev;
    }
    let total: f32 = points.windows(2).map(|w| dist(w[0], w[1])).sum();
    let mut left = total * u.min(1.0);
    let mut out = Vec::with_capacity(points.len());
    if let Some(first) = points.first() {
        out.push(*first);
    }
    for w in points.windows(2) {
        let seg = dist(w[0], w[1]);
        if seg >= left {
            let t = if seg > 0.0 { left / seg } else { 0.0 };
            out.push([w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t]);
            return out;
        }
        left -= seg;
        out.push(w[1]);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashes_cover_the_line_in_steps() {
        let d = dash(&[[0.0, 0.0], [100.0, 0.0]], 5.0, 5.0);
        assert_eq!(d.len(), 10);
        assert!((d[1][0][0] - 10.0).abs() < 1e-3);
    }
}
