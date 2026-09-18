// WGSL compute kernels for the ocean spectrum / FFT simulation (WebGPU path).
// Same math and data layout as simCommon.glsl.js — see that file for the derivation.

const SIM_MATH_WGSL = /* wgsl */`
const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;

fn pcg3d(vIn: vec3u) -> vec3u {
    var v = vIn * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> vec3u(16u);
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
fn hash3(p: vec3u) -> vec3f {
    return vec3f(pcg3d(p)) * (1.0 / 4294967296.0);
}
fn gaussian2(texel: vec2u, seed: u32) -> vec2f {
    let r = hash3(vec3u(texel, seed));
    let u1 = max(r.x, 1e-7);
    let u2 = r.y;
    let mag = sqrt(-2.0 * log(u1));
    return vec2f(mag * cos(TWO_PI * u2), mag * sin(TWO_PI * u2));
}
fn dispersion(k: f32, g: f32, depth: f32) -> f32 {
    return sqrt(g * k * tanh(min(k * depth, 20.0)));
}
fn dispersionDerivative(k: f32, g: f32, depth: f32) -> f32 {
    let th = tanh(min(k * depth, 20.0));
    let ch = cosh(min(k * depth, 20.0));
    return g * (depth * k / (ch * ch) + th) / dispersion(k, g, depth) * 0.5;
}
fn normalisationFactor(s: f32) -> f32 {
    let s2 = s * s; let s3 = s2 * s; let s4 = s3 * s;
    if (s < 5.0) { return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163; }
    return -4.80e-08 * s4 + 1.07e-05 * s3 - 9.53e-04 * s2 + 5.90e-02 * s + 3.93e-01;
}
fn cosine2s(theta: f32, s: f32) -> f32 {
    return normalisationFactor(s) * pow(abs(cos(0.5 * theta)), 2.0 * s);
}
fn spreadPower(omega: f32, peakOmega: f32) -> f32 {
    if (omega > peakOmega) { return 9.77 * pow(abs(omega / peakOmega), -2.5); }
    return 6.97 * pow(abs(omega / peakOmega), 5.0);
}
fn directionSpectrum(theta: f32, omega: f32, p0: vec4f, p1: vec4f) -> f32 {
    let s = spreadPower(omega, p1.y) + 16.0 * tanh(min(omega / p1.y, 20.0)) * p0.w * p0.w;
    let c = cos(theta);
    return mix(2.0 / PI * c * c, cosine2s(theta - p0.y, s), p0.z);
}
fn tmaCorrection(omega: f32, g: f32, depth: f32) -> f32 {
    let omegaH = omega * sqrt(depth / g);
    if (omegaH <= 1.0) { return 0.5 * omegaH * omegaH; }
    if (omegaH < 2.0) { return 1.0 - 0.5 * (2.0 - omegaH) * (2.0 - omegaH); }
    return 1.0;
}
fn jonswap(omega: f32, g: f32, depth: f32, p0: vec4f, p1: vec4f) -> f32 {
    let peakOmega = p1.y;
    let sigma = select(0.09, 0.07, omega <= peakOmega);
    let d = (omega - peakOmega) / (sigma * peakOmega);
    let r = exp(-0.5 * d * d);
    let invOmega = 1.0 / omega;
    let pk = peakOmega * invOmega;
    return p0.x * tmaCorrection(omega, g, depth) * p1.x * g * g
         * invOmega * invOmega * invOmega * invOmega * invOmega
         * exp(-1.25 * pk * pk * pk * pk)
         * pow(abs(p1.z), r);
}
fn shortWavesFade(k: f32, p1: vec4f) -> f32 {
    return exp(-p1.w * p1.w * k * k);
}
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn cconj(a: vec2f) -> vec2f { return vec2f(a.x, -a.y); }
fn cmul4(b: vec4f, w: vec2f) -> vec4f {
    return vec4f(b.x * w.x - b.y * w.y, b.x * w.y + b.y * w.x,
                 b.z * w.x - b.w * w.y, b.z * w.y + b.w * w.x);
}
`;

export function spectrumCS(N) {
    return /* wgsl */`
${SIM_MATH_WGSL}
uniform uLengthScale: f32;
uniform uCutoffLow: f32;
uniform uCutoffHigh: f32;
uniform uDepth: f32;
uniform uGravity: f32;
uniform uSeed: u32;
uniform uSpecA0: vec4f;
uniform uSpecA1: vec4f;
uniform uSpecB0: vec4f;
uniform uSpecB1: vec4f;
var uOut: texture_storage_2d<rgba32float, write>;

fn h0(texel: vec2i) -> vec2f {
    let n = ${N};
    let deltaK = TWO_PI / uniform.uLengthScale;
    let nx = select(texel.x - n, texel.x, texel.x < n / 2);
    let nz = select(texel.y - n, texel.y, texel.y < n / 2);
    let k = vec2f(f32(nx), f32(nz)) * deltaK;
    let kLen = length(k);
    if (kLen < uniform.uCutoffLow || kLen > uniform.uCutoffHigh || kLen < 1e-6) { return vec2f(0.0); }
    let kAngle = atan2(k.y, k.x);
    let omega = dispersion(kLen, uniform.uGravity, uniform.uDepth);
    let dOmegadk = dispersionDerivative(kLen, uniform.uGravity, uniform.uDepth);
    var spectrum = jonswap(omega, uniform.uGravity, uniform.uDepth, uniform.uSpecA0, uniform.uSpecA1)
                 * directionSpectrum(kAngle, omega, uniform.uSpecA0, uniform.uSpecA1)
                 * shortWavesFade(kLen, uniform.uSpecA1);
    if (uniform.uSpecB0.x > 0.0) {
        spectrum += jonswap(omega, uniform.uGravity, uniform.uDepth, uniform.uSpecB0, uniform.uSpecB1)
                  * directionSpectrum(kAngle, omega, uniform.uSpecB0, uniform.uSpecB1)
                  * shortWavesFade(kLen, uniform.uSpecB1);
    }
    let xi = gaussian2(vec2u(texel), uniform.uSeed);
    return xi * 0.5 * sqrt(spectrum * abs(dOmegadk) / kLen * deltaK * deltaK);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let n = ${N};
    let texel = vec2i(gid.xy);
    if (texel.x >= n || texel.y >= n) { return; }
    let mirror = vec2i((n - texel.x) % n, (n - texel.y) % n);
    let a = h0(texel);
    let b = h0(mirror);
    textureStore(uOut, texel, vec4f(a, cconj(b)));
}
`;
}

export function evolveCS(N) {
    return /* wgsl */`
${SIM_MATH_WGSL}
uniform uLengthScale: f32;
uniform uDepth: f32;
uniform uGravity: f32;
uniform uTime: f32;
var uSpectrum: texture_2d<f32>;
var uOut0: texture_storage_2d<rgba32float, write>;
var uOut1: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let n = ${N};
    let texel = vec2i(gid.xy);
    if (texel.x >= n || texel.y >= n) { return; }
    let s = textureLoad(uSpectrum, texel, 0);
    let deltaK = TWO_PI / uniform.uLengthScale;
    let nx = select(texel.x - n, texel.x, texel.x < n / 2);
    let nz = select(texel.y - n, texel.y, texel.y < n / 2);
    let k = vec2f(f32(nx), f32(nz)) * deltaK;
    let kLen = length(k);
    let invK = select(0.0, 1.0 / kLen, kLen > 1e-6);
    let omega = dispersion(max(kLen, 1e-6), uniform.uGravity, uniform.uDepth);
    let phase = omega * uniform.uTime;
    let e = vec2f(cos(phase), sin(phase));
    let h = cmul(s.xy, e) + cmul(s.zw, cconj(e));
    let ih = vec2f(-h.y, h.x);

    // see the GLSL twin: +i (k/|k|) h so that positive choppiness crowds points onto the crests
    let Dx  = k.x * invK * ih;
    let Dz  = k.y * invK * ih;
    let Dy  = h;
    let dyx = k.x * ih;
    let dyz = k.y * ih;
    let dxx = -k.x * k.x * invK * h;
    let dzz = -k.y * k.y * invK * h;
    let dxz = -k.x * k.y * invK * h;

    textureStore(uOut0, texel, vec4f(Dx + vec2f(-Dz.y, Dz.x),  Dy + vec2f(-dxz.y, dxz.x)));
    textureStore(uOut1, texel, vec4f(dyx + vec2f(-dyz.y, dyz.x), dxx + vec2f(-dzz.y, dzz.x)));
}
`;
}

// One workgroup per row (or column); the entire 1D inverse FFT runs in workgroup memory.
// Each thread performs one butterfly per stage, so workgroup size = N/2.
export function fftCS(N) {
    const log2N = Math.log2(N) | 0;
    const WG = N / 2;
    return /* wgsl */`
${SIM_MATH_WGSL}
uniform uVertical: u32;
var uIn0: texture_2d<f32>;
var uIn1: texture_2d<f32>;
var uOut0: texture_storage_2d<rgba32float, write>;
var uOut1: texture_storage_2d<rgba32float, write>;

var<workgroup> s0: array<vec4f, ${N}>;
var<workgroup> s1: array<vec4f, ${N}>;

fn bitReverse(xIn: u32) -> u32 {
    var x = xIn;
    var r = 0u;
    for (var i = 0u; i < ${log2N}u; i++) {
        r = (r << 1u) | (x & 1u);
        x >>= 1u;
    }
    return r;
}

fn coord(line: u32, i: u32) -> vec2i {
    if (uniform.uVertical == 1u) { return vec2i(i32(line), i32(i)); }
    return vec2i(i32(i), i32(line));
}

@compute @workgroup_size(${WG}, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
    let line = wid.x;
    let t = lid.x;

    // load with bit-reversal permutation
    for (var i = t; i < ${N}u; i += ${WG}u) {
        let src = bitReverse(i);
        s0[i] = textureLoad(uIn0, coord(line, src), 0);
        s1[i] = textureLoad(uIn1, coord(line, src), 0);
    }
    workgroupBarrier();

    for (var stage = 0u; stage < ${log2N}u; stage++) {
        let hs = 1u << stage;
        let len = hs << 1u;
        // butterfly index t -> element pair (i0, i1)
        let j = t & (hs - 1u);
        let i0 = ((t >> stage) << (stage + 1u)) + j;
        let i1 = i0 + hs;
        let ang = TWO_PI * f32(j) / f32(len);
        let w = vec2f(cos(ang), sin(ang));
        let a0 = s0[i0]; let b0 = cmul4(s0[i1], w);
        let a1 = s1[i0]; let b1 = cmul4(s1[i1], w);
        workgroupBarrier();
        s0[i0] = a0 + b0; s0[i1] = a0 - b0;
        s1[i0] = a1 + b1; s1[i1] = a1 - b1;
        workgroupBarrier();
    }

    for (var i = t; i < ${N}u; i += ${WG}u) {
        textureStore(uOut0, coord(line, i), s0[i]);
        textureStore(uOut1, coord(line, i), s1[i]);
    }
}
`;
}

export function assembleCS(N) {
    return /* wgsl */`
uniform uLambda: f32;
uniform uDeltaTime: f32;
uniform uFoamDecay: f32;
uniform uFoamReset: f32;
var uIn0: texture_2d<f32>;
var uIn1: texture_2d<f32>;
var uPrevDisplacement: texture_2d<f32>;
var uDisplacement: texture_storage_2d<rgba16float, write>;
var uDerivatives: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let n = ${N};
    let texel = vec2i(gid.xy);
    if (texel.x >= n || texel.y >= n) { return; }
    let a = textureLoad(uIn0, texel, 0);
    let b = textureLoad(uIn1, texel, 0);
    let Dx = a.x; let Dz = a.y; let Dy = a.z; let dxz = a.w;
    let dyx = b.x; let dyz = b.y; let dxx = b.z; let dzz = b.w;
    let lambda = uniform.uLambda;
    let jacobian = (1.0 + lambda * dxx) * (1.0 + lambda * dzz) - lambda * lambda * dxz * dxz;
    let prev = textureLoad(uPrevDisplacement, texel, 0).w;
    var turb = min(jacobian, prev + uniform.uDeltaTime * uniform.uFoamDecay / max(jacobian, 0.5));
    if (uniform.uFoamReset > 0.5) { turb = jacobian; }
    textureStore(uDisplacement, texel, vec4f(lambda * Dx, Dy, lambda * Dz, turb));
    textureStore(uDerivatives, texel, vec4f(dyx, dyz, dxx, dzz));
}
`;
}
