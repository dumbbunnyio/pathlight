//! The room the page is lit in (plan 4d, "The look"). Rune lays out and draws the page as usual; this compositor then builds the room around
//! it: a stone table painted under everything (`shaders/room.wgsl`, `table`), the page lit by `rune-light` as slabs standing on that table
//! under one warm lamp, and a film finish over the lit frame (vignette, grain, the sRGB encode: `film`).
//!
//! What stands how high is attention. Every element marked as a card carries the height it wants (`mark`); the compositor eases each slab
//! toward it, so the selection rises, its neighbors stand and the rest settle into the stone, and a view's boxes stand up as it opens. The
//! lamp drifts toward the selection, so the shadows swing with it. When the selection moves along a line, a ball of energy runs the line
//! (the page draws it, `App::pin`, and lights the line behind it, `App::trail`); where the line enters the new box it goes behind the solid
//! box and backlights it from that side. The recipe for lighting is Rune's own (`examples/cursed-settings/src/gfx.rs`): the frame without
//! text is the albedo, the glyphs are lit on their own.

use crate::App;
use rune::compose::{Compositor, Frame, is_glyph};
use rune::render::{Instance, KIND_GRADIENT, KIND_LAYER, KIND_LAYER_END, KIND_RECT};
use rune_light::{Light, LightRenderer, Prim, Scene, Settings};
use std::collections::HashMap;

const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// How an element stands on the table when it is lit. Bit 31 makes every explicit mark non-zero (a zero mark inherits the parent's).
pub mod mat {
    /// Flat on the table: no slab, no shadow.
    pub const FLAT: u8 = 0;
    /// A slab that casts a shadow and catches the light on its bevel, as high as its mark says.
    pub const CARD: u8 = 1;
}

/// A mark: the material, and for a card the height it wants in points (to a tenth).
pub fn mark(material: u8, height: f32) -> u32 {
    (1 << 31) | ((material as u32) << 16) | ((height.max(0.0) * 10.0).round() as u32).min(0xFFFF)
}

fn material(mark: u32) -> u8 {
    ((mark >> 16) & 0xFF) as u8
}

fn wanted(mark: u32) -> f32 {
    (mark & 0xFFFF) as f32 / 10.0
}

fn prim(ins: &Instance, height: f32, s: f32) -> Option<Prim> {
    if ins.fill[3] < 0.02 {
        return None;
    }
    let a = ins.fill[3].max(1e-4);
    let p = Prim::from_rune(ins.rect, ins.radii).albedo([ins.fill[0] / a, ins.fill[1] / a, ins.fill[2] / a]);
    // Machined slabs (rune-light's `machine` in examples/live.rs): a tight bevel with a thin bright edge. A slab settling into the table
    // keeps its bevel until it is nearly flush.
    let k = (height / 6.0).clamp(0.0, 1.0);
    Some(p.raised(height * s).bevel(2.2 * s * k, 1.6 * s * k).gloss(0.5 + 0.12 * k, 0.32 - 0.06 * k))
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

fn pass<'e>(enc: &'e mut wgpu::CommandEncoder, view: &'e wgpu::TextureView, clear: Option<[f32; 4]>) -> wgpu::RenderPass<'e> {
    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("pathlight"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: match clear {
                    Some(c) => wgpu::LoadOp::Clear(wgpu::Color { r: c[0] as f64, g: c[1] as f64, b: c[2] as f64, a: c[3] as f64 }),
                    None => wgpu::LoadOp::Load,
                },
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

/// The room's two passes (`shaders/room.wgsl`): the table under the page and the film over the lit frame.
struct Room {
    uniform: wgpu::Buffer,
    layout: wgpu::BindGroupLayout,
    table: wgpu::RenderPipeline,
    film: wgpu::RenderPipeline,
}

impl Room {
    fn new(device: &wgpu::Device, window: wgpu::TextureFormat) -> Room {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pathlight room"), source: wgpu::ShaderSource::Wgsl(include_str!("shaders/room.wgsl").into()) });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor { label: Some("pathlight room"), size: 80, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pathlight room"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipe = |entry: &str, format: wgpu::TextureFormat| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        Room { uniform, layout, table: pipe("table", HDR), film: pipe("film", window) }
    }

    fn bind(&self, device: &wgpu::Device, lit: &wgpu::TextureView) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pathlight room"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(lit) },
            ],
        })
    }
}

struct Res {
    size: (u32, u32),
    format: wgpu::TextureFormat,
    base: Tex,
    text: Tex,
    lit: Tex,
    light: LightRenderer,
    room: Room,
    bind: wgpu::BindGroup,
}

/// The light's trip from one box to the next along the line that joins them, in the view's own (world) points.
struct Travel {
    edge: String,
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

/// Where the energy sits behind the selected box once it has arrived: the point where its line entered the box (in the view's points), or
/// none when it came by no line and rises from the box's center.
struct Rest {
    id: String,
    entry: Option<[f32; 2]>,
    since: f64,
}

fn ease_to(cur: &mut f32, target: f32, dt: f32, rate: f32) {
    *cur += (target - *cur) * (1.0 - (-dt.min(0.1) * rate).exp());
}

/// The room, and the selection's light as energy. When the selection moves to a box joined to the last one by a line, a ball of energy
/// travels that line; where the line enters the new box it goes behind it and becomes a light under the solid box, so the whole box is
/// backlit, brightest on the side it came in from, with soft rays through the gaps. With no line it rises behind the box's center. It stays
/// while the box is selected and fades with the selection.
#[derive(Default)]
pub struct Lighting {
    res: Option<Res>,
    animating: bool,
    last: Option<String>,
    travel: Option<Travel>,
    /// For whom the travel is, so its arrival can hand over to the backlight.
    to: Option<String>,
    rest: Option<Rest>,
    on: f32,
    /// Each slab's height now, by where it stands in the view (so the camera can move without resetting it); new slabs rise from the table.
    heights: HashMap<(i32, i32), (f32, bool)>,
    /// The lamp's place on the window, as it drifts toward the selection.
    lamp: Option<[f32; 2]>,
    hover_on: f32,
    hover_at: [f32; 2],
}

impl Compositor<App> for Lighting {
    fn animating(&self) -> bool {
        self.animating
    }

    fn render(&mut self, f: &mut Frame<'_, App>) {
        if self.res.as_ref().is_none_or(|r| r.size != f.size || r.format != f.format) {
            f.ui.add_format(f.device, HDR);
            let lit = tex(f.device, "pathlight lit", f.size);
            let room = Room::new(f.device, f.format);
            let bind = room.bind(f.device, &lit.view);
            self.res = Some(Res {
                size: f.size,
                format: f.format,
                base: tex(f.device, "pathlight base", f.size),
                text: tex(f.device, "pathlight text", f.size),
                // rune-light writes linear light into the lit frame; the film pass encodes it for the window.
                light: LightRenderer::new(f.device, f.queue, f.size.0, f.size.1, HDR),
                lit,
                room,
                bind,
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
        let dt = f.dt as f32;
        let (w, h) = (f.size.0 as f32, f.size.1 as f32);

        // Where a point of the view lands on the window, in device pixels: the stage's place, then the camera; and back.
        let stage = rt.presented("stage").map_or([0.0, 0.0], |(r, _)| [r[0], r[1]]);
        let (pan, zoom) = (rt.state.pan, rt.state.zoom.max(1e-3));
        let screen = |p: [f32; 2]| [(stage[0] + pan[0] + p[0] * zoom) * s, (stage[1] + pan[1] + p[1] * zoom) * s];
        let world = |x: f32, y: f32| [(x / s - stage[0] - pan[0]) / zoom, (y / s - stage[1] - pan[1]) / zoom];

        // Glyphs are lit on their own, so they leave the frame for their own layer, but only those outside an isolated layer: a layer (an
        // element fading in when a view opens, say) must keep its begin, its contents and its end together, or its shapes are lost while its
        // words still draw. Glyphs inside one stay with it and are lit as part of the surface for the moment it lasts.
        let (mut base, mut text, mut prims) = (Vec::new(), Vec::new(), Vec::new());
        let mut depth = 0_i32;
        let mut settling = false;
        for v in self.heights.values_mut() {
            v.1 = false;
        }
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
            let m = rt.marks.get(i).copied().unwrap_or(0);
            // A box with a sheen is drawn as a gradient, not a plain rect; both are its slab.
            if (kind == KIND_RECT || kind == KIND_GRADIENT) && material(m) == mat::CARD {
                // The slab eases toward the height its mark wants; a slab new to the table rises from it.
                let at = world(ins.rect[0], ins.rect[1]);
                let key = ((at[0] * 2.0).round() as i32, (at[1] * 2.0).round() as i32);
                let want = wanted(m);
                let (height, seen) = self.heights.entry(key).or_insert((0.0, false));
                if !*seen {
                    ease_to(height, want, dt, 9.0);
                    if (want - *height).abs() > 0.05 {
                        settling = true;
                    } else {
                        *height = want;
                    }
                }
                *seen = true;
                if let Some(p) = prim(ins, *height, s) {
                    prims.push(p);
                }
            }
        }
        self.heights.retain(|_, v| v.1);

        // A new selection joined to the last by a line: the light travels that line, from the old box to the new one.
        let selected = rt.state.selected.clone();
        if selected != self.last {
            if let (Some(from), Some(to), Some(view)) = (self.last.as_deref(), selected.as_deref(), rt.state.current())
                && let Some(edge) = view.edges.iter().find(|e| (e.source == from && e.target == to) || (e.source == to && e.target == from))
                && edge.points.len() > 1
            {
                let mut path = crate::edge_pen(edge).subs.swap_remove(0).0;
                if edge.source == to {
                    path.reverse();
                }
                let mut along = vec![0.0];
                for w in path.windows(2) {
                    along.push(along.last().unwrap() + crate::geom::dist(w[0], w[1]));
                }
                let length = *along.last().unwrap() * zoom;
                // Quick, but slow enough to follow with the eye.
                self.travel = Some(Travel { edge: edge.id.clone(), path, along, start: rt.t, seconds: (length as f64 / 1000.0).clamp(0.2, 0.45) });
                self.to = selected.clone();
                self.rest = None;
            } else {
                self.travel = None;
                // No line: the energy rises behind the new box's center.
                self.rest = selected.clone().map(|id| Rest { id, entry: None, since: rt.t });
            }
            self.on = 0.0;
            self.last = selected.clone();
        }
        let travelling = self.travel.as_ref().map(|t| ((rt.t - t.start) / t.seconds) as f32).filter(|u| *u < 1.0);
        if travelling.is_none()
            && let Some(travel) = self.travel.take()
        {
            // Arrived: the energy goes behind the box where the line meets it.
            self.rest = self.to.take().map(|id| Rest { id, entry: travel.path.last().copied(), since: rt.t });
        }
        if self.rest.as_ref().is_some_and(|r| Some(&r.id) != selected.as_ref()) {
            self.rest = None;
        }

        // The selected box's glow is the page's own (a glow under the solid box, so it shows only around the edges): the light tells the page
        // when to show it, which is once the light has arrived along the line, or at once when there was no line to travel.
        let glow = if travelling.is_some() { None } else { selected.clone() };
        if rt.state.glow != glow {
            rt.state.glow = glow;
            rt.invalidate();
        }
        // The ball on its way along the line, in the view's own points, eased so it leaves and arrives gently; the line behind it is
        // charged. The page draws both.
        let eased = travelling.map(|u| u * u * (3.0 - 2.0 * u));
        let pin = match (eased, self.travel.as_ref()) {
            (Some(u), Some(travel)) => Some(travel.at(u)),
            _ => None,
        };
        let trail = match (eased, self.travel.as_ref()) {
            (Some(u), Some(travel)) => Some((travel.edge.clone(), if rt.state.current().is_some_and(|v| v.edges.iter().any(|e| e.id == travel.edge && e.source == self.last.as_deref().unwrap_or(""))) { u } else { -u })),
            _ => None,
        };
        if rt.state.pin != pin || rt.state.trail != trail {
            rt.state.pin = pin;
            rt.state.trail = trail;
            rt.invalidate();
        }
        // Behind the box: born at the entry point, it settles a little way in toward the center as it grows, so the whole box is backlit and
        // the entry side brightest.
        ease_to(&mut self.on, if self.rest.is_some() { 1.0 } else { 0.0 }, dt, 10.0);
        let behind = self.rest.as_ref().and_then(|r| {
            let (rect, _) = rt.presented(&format!("node/{}", r.id)).filter(|(b, a)| b[2] > 0.0 && *a > 0.05)?;
            let c = [(rect[0] + rect[2] / 2.0) * s, (rect[1] + rect[3] / 2.0) * s];
            let grow = (((rt.t - r.since) / 0.5) as f32).clamp(0.0, 1.0);
            let ease = 1.0 - (1.0 - grow).powi(3);
            let at = r.entry.map_or(c, |e| {
                let e = screen(e);
                let m = 0.38 * ease;
                [e[0] + (c[0] - e[0]) * m, e[1] + (c[1] - e[1]) * m]
            });
            Some((at, 0.35 + 0.65 * ease, grow < 1.0))
        });

        // The lamp hangs high over the top left of the table and leans toward what is selected, so the shadows swing with the choice.
        let rest_lamp = [w * 0.22, h * 0.1];
        let want_lamp = selected
            .as_deref()
            .and_then(|id| rt.presented(&format!("node/{id}")))
            .map_or(rest_lamp, |(r, _)| {
                let c = [(r[0] + r[2] / 2.0) * s, (r[1] + r[3] / 2.0) * s];
                [rest_lamp[0] + (c[0] - rest_lamp[0]) * 0.45, rest_lamp[1] + (c[1] - rest_lamp[1]) * 0.35]
            });
        let lamp = self.lamp.get_or_insert(want_lamp);
        let mut lamp_moving = false;
        for k in 0..2 {
            ease_to(&mut lamp[k], want_lamp[k], dt, 3.5);
            if (lamp[k] - want_lamp[k]).abs() > 0.5 {
                lamp_moving = true;
            }
        }
        let lamp = *lamp;

        // A small light rises over the box under the pointer.
        let hovered = rt.state.hover.as_deref().and_then(|id| rt.presented(&format!("node/{id}"))).filter(|(r, a)| r[2] > 0.0 && *a > 0.05).map(|(r, _)| [(r[0] + r[2] / 2.0) * s, (r[1] + r[3] / 2.0) * s]);
        if let Some(at) = hovered {
            self.hover_at = at;
        }
        ease_to(&mut self.hover_on, if hovered.is_some() { 1.0 } else { 0.0 }, dt, 8.0);
        let hover_moving = self.hover_on > 0.01 && self.hover_on < 0.99;

        self.animating = travelling.is_some() || behind.is_some_and(|b| b.2) || (self.on > 0.01 && self.on < 0.99) || settling || lamp_moving || hover_moving;

        // Calibrated on Rune's own lit demos (rune-light's `raised` scene): a dim room, one key light, a faint cool fill.
        let mut lights = vec![
            // The lamp: high over the table, so every slab has a lit edge toward it and a soft shadow away from it.
            Light::point(lamp[0], lamp[1], 520.0 * s).color([1.0, 0.94, 0.86]).intensity(if dark { 2.6 } else { 2.2 }).radius(40.0 * s).range(6000.0 * s).specular(1.4),
            // The fill: low and far at the bottom right, cool, so the shadow side is never black.
            Light::point(w * 1.05, h * 1.1, 900.0 * s).color([0.55, 0.65, 1.0]).intensity(0.35).radius(240.0 * s).range(9000.0 * s).specular(0.4),
        ];
        if self.hover_on > 0.01 {
            lights.push(Light::point(self.hover_at[0], self.hover_at[1] - 30.0 * s, 160.0 * s).color([1.0, 0.97, 0.9]).intensity(if dark { 0.55 } else { 0.3 }).radius(60.0 * s).range(700.0 * s).specular(0.8).scaled(self.hover_on));
        }
        // The energy behind the box: a small white source on the table under the slab. With `shafts` on, rune-light treats it as standing
        // behind the UI: it lights no face from the front, only the rims and the air in the gaps, as soft rays (composite.wgsl).
        if let Some((at, strength, _)) = behind {
            lights.push(
                Light::point(at[0], at[1], 3.0 * s)
                    .color([1.0, 0.98, 0.95])
                    .intensity(if dark { 4.5 } else { 1.6 })
                    .radius(4.0 * s)
                    .range(if dark { 340.0 } else { 240.0 } * s)
                    .shafts(if dark { 1.4 } else { 0.7 })
                    .softness(2.0)
                    .scaled(strength * self.on),
            );
        }
        let settings = Settings {
            ambient: if dark { [0.3, 0.31, 0.34] } else { [0.62, 0.62, 0.64] },
            rim: 1.8,
            contact_ao: 0.6,
            albedo_floor: if dark { 0.04 } else { 0.0 },
            // A matte table: the lamp should not paint a sheen across the floor and the panels.
            background_gloss: 0.08,
            background_roughness: 0.85,
            // No light across a box's face, ever: the boxes stay solid.
            shafts_over: 0.0,
            time: rt.t as f32,
            ..Settings::default()
        };

        // The room's own numbers: the table under the page, the lamp's pool on it, and the film over the lit frame.
        let ink = &rt.state.model.ink;
        // Rune's colors are linear already.
        let floor = [ink.background.r, ink.background.g, ink.background.b];
        let pool = [ink.accent.r, ink.accent.g, ink.accent.b];
        let uniform: [f32; 20] = [
            w, h, s, if dark { 1.0 } else { 0.0 },
            lamp[0], lamp[1], (w.max(h)) * 0.55, if dark { 0.02 } else { 0.014 },
            floor[0], floor[1], floor[2], if dark { 0.14 } else { 0.05 },
            // The pool is the lamp's own warmth, barely tinted toward the theme's accent.
            0.9 + 0.1 * pool[0], 0.85 + 0.1 * pool[1], 0.76 + 0.1 * pool[2], 0.0,
            if dark { 0.55 } else { 0.22 }, if dark { 0.013 } else { 0.005 }, if f.format.is_srgb() { 0.0 } else { 1.0 }, 1.0,
        ];
        let mut bytes = Vec::with_capacity(80);
        for v in uniform {
            bytes.extend_from_slice(&v.to_ne_bytes());
        }
        f.queue.write_buffer(&res.room.uniform, 0, &bytes);

        let ranges = f.ui.prepare_lists(f.device, f.queue, &mut rt.text.atlas, &[&base, &text], f.size);
        // Isolated layers (opacity, fades) are drawn into their own targets before any pass that composites them.
        f.ui.encode_layers(f.encoder);
        {
            // The table first, then the page over it.
            let mut p = pass(f.encoder, &res.base.view, Some([0.0; 4]));
            p.set_pipeline(&res.room.table);
            p.set_bind_group(0, &res.bind, &[]);
            p.draw(0..3, 0..1);
            f.ui.draw_range(&mut p, HDR, ranges[0].clone());
        }
        {
            let mut p = pass(f.encoder, &res.text.view, Some([0.0; 4]));
            f.ui.draw_range(&mut p, HDR, ranges[1].clone());
        }
        let lit = res.light.render(f.device, f.queue, f.encoder, &Scene { prims: &prims, lights: &lights, settings, emission: None }, &res.base.view, &res.text.view, &res.lit.view);
        if lit {
            let mut p = pass(f.encoder, f.target, Some([0.0; 4]));
            p.set_pipeline(&res.room.film);
            p.set_bind_group(0, &res.bind, &[]);
            p.draw(0..3, 0..1);
        } else {
            // No light drew (none can be on at once, but never leave the window empty): the page as Rune draws it.
            let clear = rt.clear_color();
            let mut p = pass(f.encoder, f.target, Some(clear));
            f.ui.draw_range(&mut p, f.format, ranges[0].clone());
            f.ui.draw_range(&mut p, f.format, ranges[1].clone());
        }
    }
}
