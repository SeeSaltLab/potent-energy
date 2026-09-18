// Wave probe (GLSL). Evaluates the same cascaded displacement the surface vertex shader uses, for
// a grid of world-space XZ queries, and inverts the horizontal (choppy) displacement so the result
// is the surface point that actually ends up above the query position.
//
// Input  uQuery  : RGBA32F, (worldX, worldZ, active, unused) per texel
// Output          : RGBA32F, (surfaceY, slopeX, slopeZ, active) per texel
//
// Both the query fetch and the output use gl_FragCoord, which indexes the same memory row on WebGL
// and WebGPU, so a readback of the result lines up with the uploaded query buffer on both.

export const PROBE_VS = /* glsl */`
attribute vec2 aPosition;
void main(void) {
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const PROBE_FS = /* glsl */`
uniform sampler2D uQuery;
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform sampler2D uDisp3;
uniform sampler2D uDeriv0;
uniform sampler2D uDeriv1;
uniform sampler2D uDeriv2;
uniform sampler2D uDeriv3;
uniform vec4  uCascadeInv[4];   // w = 1 / lengthScale
uniform int   uNumCascades;
uniform float uLambda;
uniform float uDisplacementScale;
uniform float uSeaLevel;

vec3 sampleDisp(vec2 p) {
    vec3 d = textureLod(uDisp0, p * uCascadeInv[0].w, 0.0).xyz;
    if (uNumCascades > 1) d += textureLod(uDisp1, p * uCascadeInv[1].w, 0.0).xyz;
    if (uNumCascades > 2) d += textureLod(uDisp2, p * uCascadeInv[2].w, 0.0).xyz;
    if (uNumCascades > 3) d += textureLod(uDisp3, p * uCascadeInv[3].w, 0.0).xyz;
    return d * uDisplacementScale;
}

vec4 sampleDeriv(vec2 p) {
    vec4 d = textureLod(uDeriv0, p * uCascadeInv[0].w, 0.0);
    if (uNumCascades > 1) d += textureLod(uDeriv1, p * uCascadeInv[1].w, 0.0);
    if (uNumCascades > 2) d += textureLod(uDeriv2, p * uCascadeInv[2].w, 0.0);
    if (uNumCascades > 3) d += textureLod(uDeriv3, p * uCascadeInv[3].w, 0.0);
    return d * uDisplacementScale;
}

void main(void) {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    vec4 q = texelFetch(uQuery, texel, 0);
    if (q.z < 0.5) { gl_FragColor = vec4(uSeaLevel, 0.0, 0.0, 0.0); return; }

    vec2 target = q.xy;
    vec2 p = target;
    for (int i = 0; i < 4; i++) {
        p = target - sampleDisp(p).xz;
    }
    vec3 d = sampleDisp(p);
    vec4 der = sampleDeriv(p);
    vec2 slope = vec2(der.x / (1.0 + uLambda * der.z), der.y / (1.0 + uLambda * der.w));
    gl_FragColor = vec4(uSeaLevel + d.y, slope.x, slope.y, 1.0);
}
`;
