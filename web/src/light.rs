//! The page's light (plan 4d, "The look"). Rune lays out and draws the page as usual; this compositor then lights it with `rune-light`: every
//! element marked as a card becomes a raised slab with a bevelled edge, a soft key light from above gives the table its depth, and the
//! selection is a lamp in the theme's accent that hangs over the selected box and glides to the next one. The recipe is Rune's own
//! (`examples/cursed-settings/src/gfx.rs`): the frame without text is the albedo, the glyphs are lit on their own, and `rune-light` writes the
//! lit frame to the window, encoding it for an 8-bit target itself.

use crate::App;
use rune::compose::{Compositor, Frame, is_glyph};
use rune::render::{Instance, KIND_RECT};
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
        mat::LIFTED => Some(p.raised(12.0 * s).bevel(5.0 * s, 1.8 * s).gloss(0.5, 0.42)),
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

/// The lamp follows the selection on a critically damped approach, and fades in and out rather than cutting.
#[derive(Default)]
pub struct Lighting {
    res: Option<Res>,
    lamp: Option<[f32; 2]>,
    on: f32,
    animating: bool,
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

        let (mut base, mut text, mut prims) = (Vec::new(), Vec::new(), Vec::new());
        for (i, ins) in rt.instances.iter().enumerate() {
            if is_glyph(ins) {
                text.push(*ins);
            } else {
                base.push(*ins);
                if ins.params[1] == KIND_RECT
                    && let Some(p) = prim(ins, material(rt.marks.get(i).copied().unwrap_or(0)), s)
                {
                    prims.push(p);
                }
            }
        }

        // The lamp: over the selected box's centre, in device pixels, gliding there.
        let target = rt.state.selected.as_ref().and_then(|id| rt.presented(&format!("node/{id}"))).filter(|(r, a)| r[2] > 0.0 && *a > 0.05).map(|(r, _)| [(r[0] + r[2] / 2.0) * s, (r[1] + r[3] / 2.0) * s]);
        let k = 1.0 - (-(f.dt as f32).min(0.1) * 9.0).exp();
        self.on += ((if target.is_some() { 1.0 } else { 0.0 }) - self.on) * k;
        if let Some(t) = target {
            let at = self.lamp.get_or_insert(t);
            at[0] += (t[0] - at[0]) * k;
            at[1] += (t[1] - at[1]) * k;
        }
        let gliding = match (target, self.lamp) {
            (Some(t), Some(at)) => (t[0] - at[0]).hypot(t[1] - at[1]) > 0.5,
            _ => false,
        };
        self.animating = gliding || (self.on > 0.01 && self.on < 0.99);

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
            lights.push(
                // High enough that the selected box is lit evenly and its words stay readable; the pool falls on its neighbours.
                Light::point(at[0], at[1], 170.0 * s)
                    .color(accent)
                    // On a light table the same lamp floods; it is a tint there, not a pool.
                    .intensity(if dark { 1.5 } else { 0.35 })
                    .radius(26.0 * s)
                    .range(if dark { 520.0 } else { 340.0 } * s)
                    .specular(1.6)
                    .scaled(self.on),
            );
        }
        let settings = Settings {
            ambient: if dark { [0.3, 0.31, 0.34] } else { [0.62, 0.62, 0.64] },
            rim: 1.0,
            contact_ao: 0.5,
            albedo_floor: if dark { 0.04 } else { 0.0 },
            // A matte table: the key light should not paint a sheen across the floor and the panels.
            background_gloss: 0.08,
            background_roughness: 0.85,
            time: rt.t as f32,
            ..Settings::default()
        };

        let clear = rt.clear_color();
        let all = rt.instances.clone();
        let ranges = f.ui.prepare_lists(f.device, f.queue, &mut rt.text.atlas, &[&base, &text, &all], f.size);
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
            f.ui.draw_range(&mut p, f.format, ranges[2].clone());
        }
    }
}
