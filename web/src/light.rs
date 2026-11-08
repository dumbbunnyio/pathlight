//! The page's light (plan 4d, "The look"). Rune lays out and draws the page as usual; this compositor then lights it with `rune-light`: every
//! element marked as a card becomes a raised slab with a bevelled edge, a soft key light and a cool fill give the table its depth, and when
//! the selection moves along a line, a tight point of light runs along it. The selected box's glow is not light here: the page draws it under
//! the solid box (`lib.rs`), so it can only show around the edges; this tells the page when the light has arrived, and where the pin prick
//! travelling the line is (`App::pin`), which the page draws at an exact size. The recipe is Rune's own
//! (`examples/cursed-settings/src/gfx.rs`): the frame without text is the albedo, the glyphs are lit on their own, and `rune-light` writes the
//! lit frame to the window, encoding it for an 8-bit target itself.

use crate::App;
use rune::compose::{Compositor, Frame, is_glyph};
use rune::render::{Instance, KIND_GRADIENT, KIND_LAYER, KIND_LAYER_END, KIND_RECT};
use rune_light::{Light, LightRenderer, Prim, Scene, Settings};

const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// How an element stands on the table when it is lit. Bit 31 makes every explicit mark non-zero (a zero mark inherits the parent's).
pub mod mat {
    /// Flat on the table: no slab, no shadow.
    pub const FLAT: u8 = 0;
    /// A box: a slab that casts a shadow and catches the light on its bevel.
    pub const CARD: u8 = 1;
    /// The selected box: the same slab, lifted a little higher.
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

/// The selection's light. When the selection moves to a box joined to the last one by a line, a tight point of light runs quickly along
/// that line; the new box's glow (drawn by the page under the box) comes up when it arrives.
#[derive(Default)]
pub struct Lighting {
    res: Option<Res>,
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
        // Rune's desktop and headless platforms record each instance's mark when a compositor is attached; its web platform does not (at
        // the pin), so the browser would see no slabs at all. Ask for them, and draw the frame again with them.
        if !rt.track_marks {
            rt.track_marks = true;
            rt.invalidate();
            self.animating = true;
        }
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
            let m = material(rt.marks.get(i).copied().unwrap_or(0));
            // A box with a sheen is drawn as a gradient, not a plain rect; both are its slab.
            if (kind == KIND_RECT || kind == KIND_GRADIENT)
                && let Some(p) = prim(ins, m, s)
            {
                prims.push(p);
            }
        }

        let zoom = rt.state.zoom;

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
                self.travel = Some(Travel { path, along, start: rt.t, seconds: (length as f64 / 1100.0).clamp(0.18, 0.42) });
            } else {
                self.travel = None;
            }
            self.last = selected.clone();
        }
        let travelling = self.travel.as_ref().map(|t| ((rt.t - t.start) / t.seconds) as f32).filter(|u| *u < 1.0);
        if travelling.is_none() {
            self.travel = None;
        }

        // The selected box's glow is the page's own (a glow under the solid box, so it shows only around the edges): the light tells the page
        // when to show it, which is once the light has arrived along the line, or at once when there was no line to travel.
        let glow = if travelling.is_some() { None } else { selected.clone() };
        if rt.state.glow != glow {
            rt.state.glow = glow;
            rt.invalidate();
        }
        // The pin prick on its way along the line, in the view's own points, eased so it leaves and arrives gently. The page draws it, so
        // its size is exact: a pixel wider than the line.
        let pin = match (travelling, self.travel.as_ref()) {
            (Some(u), Some(travel)) => Some(travel.at(u * u * (3.0 - 2.0 * u))),
            _ => None,
        };
        if rt.state.pin != pin {
            rt.state.pin = pin;
            rt.invalidate();
        }
        self.animating = travelling.is_some();

        // Calibrated on Rune's own lit demos (rune-light's `raised` scene): a dim room, one key light, a faint cool fill.
        let lights = vec![
            // The key light: above the top left of the window, so every slab has a lit edge toward it and a soft shadow away from it.
            Light::point(w * 0.22, h * 0.12, 520.0 * s).color([1.0, 0.94, 0.86]).intensity(if dark { 2.6 } else { 2.2 }).radius(90.0 * s).range(6000.0 * s).specular(1.4),
            // The fill: low and far at the bottom right, cool, so the shadow side is never black.
            Light::point(w * 1.05, h * 1.1, 900.0 * s).color([0.55, 0.65, 1.0]).intensity(0.35).radius(240.0 * s).range(9000.0 * s).specular(0.4),
        ];
        let settings = Settings {
            ambient: if dark { [0.3, 0.31, 0.34] } else { [0.62, 0.62, 0.64] },
            rim: 1.0,
            contact_ao: 0.5,
            albedo_floor: if dark { 0.04 } else { 0.0 },
            // A matte table: the key light should not paint a sheen across the floor and the panels.
            background_gloss: 0.08,
            background_roughness: 0.85,
            // No light across a box's face, ever: the boxes stay solid.
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
