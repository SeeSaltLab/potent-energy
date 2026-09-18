// Wave probe — native WGSL for WebGPU. Mirrors waveProbe.glsl.js.

export const PROBE_VS_WGSL = /* wgsl */`
attribute aPosition: vec2f;

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(input.aPosition, 0.0, 1.0);
    return output;
}
`;

export const PROBE_FS_WGSL = /* wgsl */`
var uQuery: texture_2d<f32>;
var uDisp0: texture_2d<f32>;
var uDisp0Sampler: sampler;
var uDisp1: texture_2d<f32>;
var uDisp1Sampler: sampler;
var uDisp2: texture_2d<f32>;
var uDisp2Sampler: sampler;
var uDisp3: texture_2d<f32>;
var uDisp3Sampler: sampler;
var uDeriv0: texture_2d<f32>;
var uDeriv0Sampler: sampler;
var uDeriv1: texture_2d<f32>;
var uDeriv1Sampler: sampler;
var uDeriv2: texture_2d<f32>;
var uDeriv2Sampler: sampler;
var uDeriv3: texture_2d<f32>;
var uDeriv3Sampler: sampler;
uniform uCascadeInv: array<vec4f, 4>;
uniform uNumCascades: i32;
uniform uLambda: f32;
uniform uDisplacementScale: f32;
uniform uSeaLevel: f32;

fn sampleDisp(p: vec2f) -> vec3f {
    var d = textureSampleLevel(uDisp0, uDisp0Sampler, p * uniform.uCascadeInv[0].w, 0.0).xyz;
    if (uniform.uNumCascades > 1) { d += textureSampleLevel(uDisp1, uDisp1Sampler, p * uniform.uCascadeInv[1].w, 0.0).xyz; }
    if (uniform.uNumCascades > 2) { d += textureSampleLevel(uDisp2, uDisp2Sampler, p * uniform.uCascadeInv[2].w, 0.0).xyz; }
    if (uniform.uNumCascades > 3) { d += textureSampleLevel(uDisp3, uDisp3Sampler, p * uniform.uCascadeInv[3].w, 0.0).xyz; }
    return d * uniform.uDisplacementScale;
}

fn sampleDeriv(p: vec2f) -> vec4f {
    var d = textureSampleLevel(uDeriv0, uDeriv0Sampler, p * uniform.uCascadeInv[0].w, 0.0);
    if (uniform.uNumCascades > 1) { d += textureSampleLevel(uDeriv1, uDeriv1Sampler, p * uniform.uCascadeInv[1].w, 0.0); }
    if (uniform.uNumCascades > 2) { d += textureSampleLevel(uDeriv2, uDeriv2Sampler, p * uniform.uCascadeInv[2].w, 0.0); }
    if (uniform.uNumCascades > 3) { d += textureSampleLevel(uDeriv3, uDeriv3Sampler, p * uniform.uCascadeInv[3].w, 0.0); }
    return d * uniform.uDisplacementScale;
}

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let texel = vec2i(pcPosition.xy);
    let q = textureLoad(uQuery, texel, 0);
    if (q.z < 0.5) {
        output.color = vec4f(uniform.uSeaLevel, 0.0, 0.0, 0.0);
        return output;
    }

    let queryXZ = q.xy;
    var p = queryXZ;
    for (var i = 0; i < 4; i++) {
        p = queryXZ - sampleDisp(p).xz;
    }
    let d = sampleDisp(p);
    let der = sampleDeriv(p);
    let slope = vec2f(der.x / (1.0 + uniform.uLambda * der.z), der.y / (1.0 + uniform.uLambda * der.w));
    output.color = vec4f(uniform.uSeaLevel + d.y, slope.x, slope.y, 1.0);
    return output;
}
`;
