/** Wave-driven, filtered inverse-refraction caustics shared by surface and opaque receivers. */
export const CAUSTICS_GLSL = /* glsl */`
uniform sampler2D uCaustWave0;
uniform sampler2D uCaustWave1;
uniform vec2 uCaustWaveScales;
uniform vec3 uCaustWaveSettings; // amplitude, choppiness, texture resolution

vec3 waterCausticSunRay(vec3 sunDirection) {
    return refract(-sunDirection, vec3(0.0, 1.0, 0.0), 0.75187969);
}
vec3 waterCausticNormal(vec2 p, float footprint) {
    vec4 d = vec4(0.0);
    d += textureLod(uCaustWave0, p * uCaustWaveScales.x, max(0.0, log2(max(footprint * uCaustWaveScales.x * uCaustWaveSettings.z, 1.0))));
    d += textureLod(uCaustWave1, p * uCaustWaveScales.y, max(0.0, log2(max(footprint * uCaustWaveScales.y * uCaustWaveSettings.z, 1.0))));
    d *= uCaustWaveSettings.x;
    vec2 slope = d.xy / max(vec2(1.0) + d.zw * uCaustWaveSettings.y, vec2(0.2));
    return normalize(vec3(-slope.x, 1.0, -slope.y));
}
vec2 waterCausticOffset(vec2 p, float depth, float footprint, vec3 sun) {
    vec3 ray = refract(-sun, waterCausticNormal(p, footprint), 0.75187969);
    return ray.xz * depth / max(-ray.y, 0.2);
}
float waterCausticFocus(vec2 entry, float depth, float scale, vec3 sun, float pixelMetres) {
    if (uCaustWaveSettings.x <= 0.0 || depth <= 0.0) return 1.0;
    // Filter to the solar disc / pixel footprint. Scale selects a wave footprint, never a
    // second pattern frequency. Positions and time always come from the live FFT field.
    float epsilon = max(max(pixelMetres * 1.5, depth * 0.00465), 0.12 / max(scale, 0.1));
    vec3 flatRay = waterCausticSunRay(sun);
    vec2 receiver = entry + flatRay.xz * depth / max(-flatRay.y, 0.2);
    vec2 p = entry;
    // Bounded inverse refraction: follow the wave's ray landing toward this receiver.
    for (int i = 0; i < 2; i++) {
        vec2 error = p + waterCausticOffset(p, depth, epsilon, sun) - receiver;
        p -= clamp(error, vec2(-epsilon * 2.0), vec2(epsilon * 2.0)) * 0.65;
    }
    vec2 dx = (waterCausticOffset(p + vec2(epsilon, 0.0), depth, epsilon, sun)
             - waterCausticOffset(p - vec2(epsilon, 0.0), depth, epsilon, sun)) / (2.0 * epsilon);
    vec2 dz = (waterCausticOffset(p + vec2(0.0, epsilon), depth, epsilon, sun)
             - waterCausticOffset(p - vec2(0.0, epsilon), depth, epsilon, sun)) / (2.0 * epsilon);
    float determinant = (1.0 + dx.x) * (1.0 + dz.y) - dx.y * dz.x;
    // Finite source regularization: flat water returns exactly one, convergence brightens,
    // divergence darkens. Multiple overlapping ray paths are still an approximation.
    float irradiance = min(3.5, sqrt(1.05) / sqrt(determinant * determinant + 0.05));
    return mix(1.0, irradiance, 1.0 - smoothstep(0.3, 1.2, pixelMetres));
}
`;

export const CAUSTICS_WGSL = /* wgsl */`
var uCaustWave0: texture_2d<f32>;
var uCaustWave0Sampler: sampler;
var uCaustWave1: texture_2d<f32>;
var uCaustWave1Sampler: sampler;
uniform uCaustWaveScales: vec2f;
uniform uCaustWaveSettings: vec3f; // amplitude, choppiness, texture resolution

fn waterCausticSunRay(sunDirection: vec3f) -> vec3f {
    return refract(-sunDirection, vec3f(0.0, 1.0, 0.0), 0.75187969);
}
fn waterCausticNormal(p: vec2f, footprint: f32) -> vec3f {
    var d = vec4f(0.0);
    d += textureSampleLevel(uCaustWave0, uCaustWave0Sampler, p * uniform.uCaustWaveScales.x, max(0.0, log2(max(footprint * uniform.uCaustWaveScales.x * uniform.uCaustWaveSettings.z, 1.0))));
    d += textureSampleLevel(uCaustWave1, uCaustWave1Sampler, p * uniform.uCaustWaveScales.y, max(0.0, log2(max(footprint * uniform.uCaustWaveScales.y * uniform.uCaustWaveSettings.z, 1.0))));
    d *= uniform.uCaustWaveSettings.x;
    var slope = d.xy / max(vec2f(1.0) + d.zw * uniform.uCaustWaveSettings.y, vec2f(0.2));
    return normalize(vec3f(-slope.x, 1.0, -slope.y));
}
fn waterCausticOffset(p: vec2f, depth: f32, footprint: f32, sun: vec3f) -> vec2f {
    var ray = refract(-sun, waterCausticNormal(p, footprint), 0.75187969);
    return ray.xz * depth / max(-ray.y, 0.2);
}
fn waterCausticFocus(entry: vec2f, depth: f32, scale: f32, sun: vec3f, pixelMetres: f32) -> f32 {
    if (uniform.uCaustWaveSettings.x <= 0.0 || depth <= 0.0) { return 1.0; }
    // Filter to the solar disc / pixel footprint. Scale selects a wave footprint, never a
    // second pattern frequency. Positions and time always come from the live FFT field.
    var epsilon = max(max(pixelMetres * 1.5, depth * 0.00465), 0.12 / max(scale, 0.1));
    var flatRay = waterCausticSunRay(sun);
    var receiver = entry + flatRay.xz * depth / max(-flatRay.y, 0.2);
    var p = entry;
    // Bounded inverse refraction: follow the wave's ray landing toward this receiver.
    for (var i = 0; i < 2; i++) {
        var error = p + waterCausticOffset(p, depth, epsilon, sun) - receiver;
        p -= clamp(error, vec2f(-epsilon * 2.0), vec2f(epsilon * 2.0)) * 0.65;
    }
    var dx = (waterCausticOffset(p + vec2f(epsilon, 0.0), depth, epsilon, sun)
             - waterCausticOffset(p - vec2f(epsilon, 0.0), depth, epsilon, sun)) / (2.0 * epsilon);
    var dz = (waterCausticOffset(p + vec2f(0.0, epsilon), depth, epsilon, sun)
             - waterCausticOffset(p - vec2f(0.0, epsilon), depth, epsilon, sun)) / (2.0 * epsilon);
    var determinant = (1.0 + dx.x) * (1.0 + dz.y) - dx.y * dz.x;
    // Finite source regularization: flat water returns exactly one, convergence brightens,
    // divergence darkens. Multiple overlapping ray paths are still an approximation.
    var irradiance = min(3.5, sqrt(1.05) / sqrt(determinant * determinant + 0.05));
    return mix(1.0, irradiance, 1.0 - smoothstep(0.3, 1.2, pixelMetres));
}
`;

// Reuse the surface's derivative bindings: WGSL does not expand GLSL-style aliases.
export const SURFACE_CAUSTICS_GLSL = CAUSTICS_GLSL
    .replace(/uniform sampler2D uCaustWave[01];\n/g, '')
    .replace(/uCaustWave([01])/g, (_, i) => `uDeriv${Number(i) + 2}`);
export const SURFACE_CAUSTICS_WGSL = CAUSTICS_WGSL
    .replace(/var uCaustWave[01](?:Sampler)?: [^;]+;\n/g, '')
    .replace(/uCaustWave([01])/g, (_, i) => `uDeriv${Number(i) + 2}`);
