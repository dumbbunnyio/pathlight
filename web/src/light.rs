//! The page's light (plan 4d, "The look"). Rune lays out and draws the page as usual; this compositor then lights it with `rune-light`: every
//! element marked as a card becomes a raised slab with a bevelled edge, a soft key light from above gives the table its depth, and the
//! selection is a lamp in the theme's accent that hangs over the selected box and glides to the next one. The recipe is Rune's own
//! (`examples/cursed-settings/src/gfx.rs`): the frame without text is the albedo, the glyphs are lit on their own, and `rune-light` writes the
//! lit frame to the window, encoding it for an 8-bit target itself.

use crate::App;
use rune::compose::{Compositor, Frame, is_glyph};
use rune::render::{Instance, KIND_LAYER, KIND_LAYER_END, KIND_RECT};
use rune_light::{Light, LightRenderer, Prim, Scene, Settings};

const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// How an element stands on the table when it is lit. Bit 31 makes every explicit mark non-zero (a zero mark inherits the parent's).
pub mod mat {
    /// Flat on the table: no slab, no shadow.
    pub const FLAT: u8 = 0;
    /// A box: a slab that casts a shadow and catches the light on its bevel.
    pub const CARD: u8 = 1;
    /// The selected box: the same slab, lifted toward the lamp.
    pub const LIFTED: u8 = 2;
}

pub fn mark(material: u8) -> u32 {
    (1 << 31) | ((material as u32) << 16)
}

fn material(mark: u32) -> u8 {
    ((mark >> 16) & 0xFF) as u8
}

fn prim(ins: &Instance, material: u8, s: f32) -> Option<Prim> {
    if ins.fill[3] < 0.02 {
        return None;
    }
    let a = ins.fill[3].max(1e-4);
    let p = Prim::from_rune(ins.rect, ins.radii).albedo([ins.fill[0] / a, ins.fill[1] / a, ins.fill[2] / a]);
    match material {
        mat::CARD => Some(p.raised(6.0 * s).bevel(5.0 * s, 1.6 * s).gloss(0.42, 0.5)),
        // Lifted high enough to stand between the table and the lamp behind it.
        mat::LIFTED => Some(p.raised(16.0 * s).bevel(5.0 * s, 1.8 * s).gloss(0.5, 0.42)),
        _ => None,
    }
}

struct Tex {
    view: wgpu::TextureView,
}

fn tex(device: &wgpu::Device, label: &str, size: (u32, u32)) -> Tex {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: HDR,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    Tex { view: tex.create_view(&Default::default()) }
}

fn pass<'e>(enc: &'e mut wgpu::CommandEncoder, view: &'e wgpu::TextureView, clear: [f32; 4]) -> wgpu::RenderPass<'e> {
    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("pathlight"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color { r: clear[0] as f64, g: clear[1] as f64, b: clear[2] as f64, a: clear[3] as f64 }),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

struct Res {
    size: (u32, u32),
    format: wgpu::TextureFormat,
    base: Tex,
    text: Tex,
    light: LightRenderer,
}

/// The light's trip from one box to the next along the line that joins them, in the view's own (world) points.
struct Travel {
    path: Vec<[f32; 2]>,
    /// Arc length at each point of `path`.
    along: Vec<f32>,
    start: f64,
    seconds: f64,
}

impl Travel {
    fn at(&self, u: f32) -> [f32; 2] {
        let total = *self.along.last().unwrap_or(&0.0);
        let want = total * u;
        let i = self.along.partition_point(|&d| d < want).clamp(1, self.path.len().max(2) - 1);
        let (a, b) = (self.path[i - 1], self.path[i]);
        let span = (self.along[i] - self.along[i - 1]).max(1e-4);
        let t = ((want - self.along[i - 1]) / span).clamp(0.0, 1.0);
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
}

/// The selection's light. Behind the selected box it is a backlight; when the selection moves to a box joined to the last one, it leaves
/// the old box as a tight point of light running along that line and slips behind the new box, becoming its backlight. Between boxes no
/// line joins, it glides. It fades in and out rather than cutting.
#[derive(Default)]
pub struct Lighting {
    res: Option<Res>,
    lamp: Option<[f32; 2]>,
    on: f32,
    animating: bool,
    last: Option<String>,
    travel: Option<Travel>,
}

impl Compositor<App> for Lighting {
    fn animating(&self) -> bool {
        self.animating
    }

    fn render(&mut self, f: &mut Frame<'_, App>) {
        if self.res.as_ref().is_none_or(|r| r.size != f.size || r.format != f.format) {
            f.ui.add_format(f.device, HDR);
            self.res = Some(Res {
                size: f.size,
                format: f.format,
                base: tex(f.device, "pathlight base", f.size),
                text: tex(f.device, "pathlight text", f.size),
                light: LightRenderer::new(f.device, f.queue, f.size.0, f.size.1, f.format),
            });
        }
        let res = self.res.as_mut().expect("made above");
        let rt = &mut *f.rt;
        let s = rt.env.scale;
        let dark = rt.env.system_dark;
        let (w, h) = (f.size.0 as f32, f.size.1 as f32);

        // Glyphs are lit on their own, so they leave the frame for their own layer, but only those outside an isolated layer: a layer (an
        // element fading in when a view opens, say) must keep its begin, its contents and its end together, or its shapes are lost while its
        // words still draw. Glyphs inside one stay with it and are lit as part of the surface for the moment it lasts.
        let (mut base, mut text, mut prims) = (Vec::new(), Vec::new(), Vec::new());
        let mut depth = 0_i32;
        for (i, ins) in rt.instances.iter().enumerate() {
            let kind = ins.params[1];
            if kind == KIND_LAYER {
                depth += 1;
            } else if kind == KIND_LAYER_END {
                depth -= 1;
            } else if is_glyph(ins) && depth == 0 {
                text.push(*ins);
                continue;
            }
            base.push(*ins);
            if kind == KIND_RECT
                && let Some(p) = prim(ins, material(rt.marks.get(i).copied().unwrap_or(0)), s)
            {
                prims.push(p);
            }
        }

        // Where a point of the view lands on the window, in device pixels: the stage's place, then the camera.
        let stage = rt.presented("stage").map_or([0.0, 0.0], |(r, _)| [r[0], r[1]]);
        let (pan, zoom) = (rt.state.pan, rt.state.zoom);
        let screen = |p: [f32; 2]| [(stage[0] + pan[0] + p[0] * zoom) * s, (stage[1] + pan[1] + p[1] * zoom) * s];

        // A new selection joined to the last by a line: the light travels that line, from the old box to the new one.
        let selected = rt.state.selected.clone();
        if selected != self.last {
            if let (Some(from), Some(to), Some(view)) = (self.last.as_deref(), selected.as_deref(), rt.state.current())
                && let Some(edge) = view.edges.iter().find(|e| (e.source == from && e.target == to) || (e.source == to && e.target == from))
                && edge.points.len() > 1
            {
                let mut pen = crate::geom::Pen::new().move_to(edge.points[0]);
                if edge.points.len() % 3 == 1 {
                    for c in edge.points[1..].chunks(3) {
                        pen = pen.cubic_to(c[0], c[1], c[2]);
                    }
                } else {
                    for q in &edge.points[1..] {
                        pen = pen.line_to(*q);
                    }
                }
                let mut path = pen.subs.swap_remove(0).0;
                if edge.source == to {
                    path.reverse();
                }
                let mut along = vec![0.0];
                for w in path.windows(2) {
                    along.push(along.last().unwrap() + crate::geom::dist(w[0], w[1]));
                }
                let length = *along.last().unwrap() * zoom;
                self.travel = Some(Travel { path, along, start: rt.t, seconds: (length as f64 / 480.0).clamp(0.45, 1.1) });
                // The old box's backlight goes out as the light leaves it; the new one's is lit when it arrives.
                self.lamp = None;
            } else {
                self.travel = None;
            }
            self.last = selected.clone();
        }
        let travelling = self.travel.as_ref().map(|t| ((rt.t - t.start) / t.seconds) as f32).filter(|u| *u < 1.0);
        if travelling.is_none() {
            self.travel = None;
        }

        // The backlight: behind the selected box's centre, gliding there when no line was travelled.
        let target = selected.as_ref().and_then(|id| rt.presented(&format!("node/{id}"))).filter(|(r, a)| r[2] > 0.0 && *a > 0.05).map(|(r, _)| [(r[0] + r[2] / 2.0) * s, (r[1] + r[3] / 2.0) * s]);
        let k = 1.0 - (-(f.dt as f32).min(0.1) * 9.0).exp();
        let wanted = if target.is_some() && travelling.is_none() { 1.0 } else { 0.0 };
        // Out fast as the light leaves on a line, in at the normal pace when it arrives.
        self.on += (wanted - self.on) * if travelling.is_some() { (k * 2.5).min(1.0) } else { k };
        if let Some(t) = target
            && travelling.is_none()
        {
            let at = self.lamp.get_or_insert(t);
            at[0] += (t[0] - at[0]) * k;
            at[1] += (t[1] - at[1]) * k;
        }
        let gliding = match (target, self.lamp) {
            (Some(t), Some(at)) => (t[0] - at[0]).hypot(t[1] - at[1]) > 0.5,
            _ => false,
        };
        self.animating = travelling.is_some() || gliding || (self.on > 0.01 && self.on < 0.99);

        // Rune's colors are sRGB; light is linear.
        let lin = |c: rune::Color| [c.r, c.g, c.b].map(|v| v.max(0.0).powf(2.2));
        let accent = lin(rt.state.model.ink.accent);
        // Calibrated on Rune's own lit demos (rune-light's `raised` scene): a dim room, one key light, a faint cool fill.
        let mut lights = vec![
            // The key light: above the top left of the window, so every slab has a lit edge toward it and a soft shadow away from it.
            Light::point(w * 0.22, h * 0.12, 520.0 * s).color([1.0, 0.94, 0.86]).intensity(if dark { 2.6 } else { 2.2 }).radius(90.0 * s).range(6000.0 * s).specular(1.4),
            // The fill: low and far at the bottom right, cool, so the shadow side is never black.
            Light::point(w * 1.05, h * 1.1, 900.0 * s).color([0.55, 0.65, 1.0]).intensity(0.35).radius(240.0 * s).range(9000.0 * s).specular(0.4),
        ];
        if let Some(at) = self.lamp
            && self.on > 0.01
        {
            // The lamp is behind the selected box: just above the table, under the slab's top, so the slab hides it and its light bleeds out
            // around the edges as a halo with soft rays, while the box's face stays as it is (rune-light's backlight, `examples/live.rs`).
            // A small source low under the slab: a larger one would reach above the slab's top and light its face.
            lights.push(
                Light::point(at[0], at[1], 3.0 * s)
                    .color(accent)
                    .intensity(if dark { 3.6 } else { 1.2 })
                    .radius(3.0 * s)
                    // A tight reach: the halo hugs the box instead of tinting the room.
                    .range(if dark { 380.0 } else { 260.0 } * s)
                    // With shafts on, rune-light treats the light as standing behind the UI: it lights no face from the front, only the
                    // rims facing it and the air in the gaps (composite.wgsl). That is the backlight.
                    .shafts(1.0)
                    .softness(2.2)
                    .scaled(self.on),
            );
        }
        // The light on its way: a tight, bright point riding the line, eased so it leaves and arrives gently.
        if let (Some(u), Some(travel)) = (travelling, self.travel.as_ref()) {
            let e = u * u * (3.0 - 2.0 * u);
            let p = screen(travel.at(e));
            lights.push(Light::point(p[0], p[1], 3.0 * s).color(accent).intensity(if dark { 5.0 } else { 2.0 }).radius(2.0 * s).range(90.0 * s).bulb(1.6));
        }
        let settings = Settings {
            ambient: if dark { [0.3, 0.31, 0.34] } else { [0.62, 0.62, 0.64] },
            rim: 1.0,
            contact_ao: 0.5,
            albedo_floor: if dark { 0.04 } else { 0.0 },
            // A matte table: the key light should not paint a sheen across the floor and the panels.
            background_gloss: 0.08,
            background_roughness: 0.85,
            // Rays only in the gaps around a box, never across a box's face: the selected box stays dark against its halo.
            shafts_over: 0.0,
            time: rt.t as f32,
            ..Settings::default()
        };

        let clear = rt.clear_color();
        let ranges = f.ui.prepare_lists(f.device, f.queue, &mut rt.text.atlas, &[&base, &text], f.size);
        // Isolated layers (opacity, fades) are drawn into their own targets before any pass that composites them.
        f.ui.encode_layers(f.encoder);
        let a = clear[3].max(1e-4);
        {
            let mut p = pass(f.encoder, &res.base.view, [clear[0] / a, clear[1] / a, clear[2] / a, 1.0]);
            f.ui.draw_range(&mut p, HDR, ranges[0].clone());
        }
        {
            let mut p = pass(f.encoder, &res.text.view, [0.0; 4]);
            f.ui.draw_range(&mut p, HDR, ranges[1].clone());
        }
        let lit = res.light.render(f.device, f.queue, f.encoder, &Scene { prims: &prims, lights: &lights, settings, emission: None }, &res.base.view, &res.text.view, f.target);
        if !lit {
            // No light drew (none can be on at once, but never leave the window empty): the page as Rune draws it.
            let mut p = pass(f.encoder, f.target, clear);
            f.ui.draw_range(&mut p, f.format, ranges[0].clone());
            f.ui.draw_range(&mut p, f.format, ranges[1].clone());
        }
    }
}
