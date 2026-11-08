// The room the map sits in. Two passes around rune-light's: `table` paints the surface everything stands on, under the page, and `film`
// finishes the lit frame for the window: a vignette, fine grain and the sRGB encode. Both are pure functions of the pixel and the uniforms
// (no time in the grain), so nothing crawls between frames.

struct Room {
    // window size in device px, device scale, 1 for a dark room
    size: vec4<f32>,
    // the lamp's place on the window (device px), how far its pool reaches, how bright it is
    lamp: vec4<f32>,
    // the table's own color (linear), and how much its grain shows
    floor: vec4<f32>,
    // the pool of light under the lamp (linear), unused
    pool: vec4<f32>,
    // vignette strength, grain strength, 1 to encode sRGB, exposure
    film: vec4<f32>,
};

@group(0) @binding(0) var<uniform> R: Room;
@group(0) @binding(1) var lit: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Smooth value noise: the stone's slow unevenness.
fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash(i);
    let b = hash(i + vec2<f32>(1.0, 0.0));
    let c = hash(i + vec2<f32>(0.0, 1.0));
    let d = hash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Interleaved gradient noise (Jimenez): a stable per-pixel pattern.
fn ign(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

fn to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

// The table: a dark matte surface, faintly uneven like stone, with a wide pool of light under the lamp.
@fragment
fn table(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = pos.xy;
    let s = R.size.z;
    let q = p / s;
    // Two octaves of slow unevenness, a hand's breadth wide, and a finer mottle.
    let uneven = (noise(q / 420.0) - 0.5) * 0.6 + (noise(q / 95.0 + 7.3) - 0.5) * 0.4;
    var c = R.floor.rgb * (1.0 + uneven * R.floor.a);
    // The lamp's pool: wide, soft, warm; its energy falls with distance squared like the light itself.
    let d = distance(p, R.lamp.xy) / max(R.lamp.z, 1.0);
    c = c + R.pool.rgb * R.lamp.w / (1.0 + 3.0 * d * d);
    return vec4<f32>(c, 1.0);
}

// The finish: the lit frame darkened toward the window's corners, a fine grain in the shadows, then encoded for the window.
@fragment
fn film(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = pos.xy;
    var c = textureLoad(lit, vec2<i32>(p), 0).rgb * R.film.w;
    let n = (p / R.size.xy - 0.5) * vec2<f32>(1.0, R.size.y / R.size.x) * 2.0;
    let r = length(n) * 0.72;
    c = c * (1.0 - R.film.x * r * r * r);
    // Grain lives in the dark: nothing on bright surfaces or text, so edges stay crisp.
    let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    let g = (hash(p) - 0.5) * R.film.y * max(0.0, 1.0 - luma * 6.0);
    c = max(c + vec3<f32>(g), vec3<f32>(0.0));
    if (R.film.z > 0.5) {
        let dn = (ign(p) - 0.5) / 255.0;
        return vec4<f32>(to_srgb(c) + vec3<f32>(dn), 1.0);
    }
    return vec4<f32>(c, 1.0);
}
