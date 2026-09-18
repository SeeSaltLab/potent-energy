import { SURFACE_CAUSTICS_WGSL } from './caustics.js';

// Ocean surface shader — native WGSL for WebGPU. Mirrors oceanSurface.glsl.js exactly.

export const WATER_VS_WGSL = /* wgsl */`
attribute vertex_position: vec3f;

uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
uniform view_position: vec3f;
uniform uCascade: array<vec4f, 4>;
uniform uNumCascades: i32;
uniform uSeaLevel: f32;
uniform uDisplacementScale: f32;
uniform uShoreArea: vec4f;
uniform uShoreParams: vec4f;
uniform uShoreParams2: vec4f;
uniform uMeshLod: vec4f;      // (grid spacing per metre of radius, inner radius, sim size, -)
uniform uWakeShip: vec4f;    // (originX, originZ, dirX, dirZ) — a ship's stern position and unit heading
uniform uWakeParams: vec4f;  // (length, halfWidth, spread, strength)

var uShoreMap: texture_2d<f32>;
var uShoreMapSampler: sampler;
var uDisp0: texture_2d<f32>;
var uDisp0Sampler: sampler;
var uDisp1: texture_2d<f32>;
var uDisp1Sampler: sampler;
var uDisp2: texture_2d<f32>;
var uDisp2Sampler: sampler;
var uDisp3: texture_2d<f32>;
var uDisp3Sampler: sampler;

varying vWorldPos: vec3f;
varying vClipPos: vec4f;
varying vSampleXZ: vec2f;
varying vShore: vec2f;

fn cascadeWeight(i: i32, dist: f32) -> f32 {
    if (i == 0) { return 1.0; }
    return 1.0 - smoothstep(uniform.uCascade[i].y, uniform.uCascade[i].z, dist);
}

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    var base = (uniform.matrix_model * vec4f(input.vertex_position, 1.0)).xyz;
    base.y = uniform.uSeaLevel;
    let dist = distance(base, uniform.view_position);

    // The grid's spacing here, in metres, against each cascade's texel: the mip whose texel is
    // the spacing holds only the waves this vertex density can represent. See the GLSL twin.
    let spacing = max(length(input.vertex_position.xz) * uniform.uMeshLod.x, uniform.uMeshLod.y);
    let lod0 = log2(max(spacing * uniform.uCascade[0].w * uniform.uMeshLod.z, 1.0));
    let lod1 = log2(max(spacing * uniform.uCascade[1].w * uniform.uMeshLod.z, 1.0));
    let lod2 = log2(max(spacing * uniform.uCascade[2].w * uniform.uMeshLod.z, 1.0));
    let lod3 = log2(max(spacing * uniform.uCascade[3].w * uniform.uMeshLod.z, 1.0));
    var disp = vec3f(0.0);
    disp += textureSampleLevel(uDisp0, uDisp0Sampler, base.xz * uniform.uCascade[0].w, lod0).xyz * cascadeWeight(0, dist);
    if (uniform.uNumCascades > 1) { disp += textureSampleLevel(uDisp1, uDisp1Sampler, base.xz * uniform.uCascade[1].w, lod1).xyz * cascadeWeight(1, dist); }
    if (uniform.uNumCascades > 2) { disp += textureSampleLevel(uDisp2, uDisp2Sampler, base.xz * uniform.uCascade[2].w, lod2).xyz * cascadeWeight(2, dist); }
    if (uniform.uNumCascades > 3) { disp += textureSampleLevel(uDisp3, uDisp3Sampler, base.xz * uniform.uCascade[3].w, lod3).xyz * cascadeWeight(3, dist); }

    // ---- the coast; see the GLSL twin ----
    let shoreUv = (base.xz - uniform.uShoreArea.xy) * uniform.uShoreArea.zw;
    var shore = textureSampleLevel(uShoreMap, uShoreMapSampler, clamp(shoreUv, vec2f(0.0), vec2f(1.0)), 0.0);
    if (any(shoreUv < vec2f(0.0)) || any(shoreUv > vec2f(1.0))) { shore = vec4f(1.0, 0.5, 0.5, 1.0); }
    let depth = shore.x * uniform.uShoreParams.x;
    output.vShore = vec2f(depth, shore.w);

    if (uniform.uShoreParams2.w > 0.5) {
        let shoal = clamp(depth / max(uniform.uShoreParams.w * 2.5, 0.5), 0.0, 1.0);
        let rear = 1.0 + uniform.uShoreParams2.z * (1.0 - shoal) * shoal * 4.0;
        disp.y *= shoal * rear;
        disp = vec3f(disp.x * mix(0.35, 1.0, shoal), disp.y, disp.z * mix(0.35, 1.0, shoal));
        disp *= shore.w;
    }

    // ship wake — see the GLSL twin
    if (uniform.uWakeParams.x > 0.0) {
        let wakeRel = base.xz - uniform.uWakeShip.xy;
        let wakeDir = uniform.uWakeShip.zw;
        let wakeAlong = -dot(wakeRel, wakeDir);
        let wakeLateral = dot(wakeRel, vec2f(-wakeDir.y, wakeDir.x));
        if (wakeAlong > 0.0 && wakeAlong < uniform.uWakeParams.x) {
            let wakeHalfW = uniform.uWakeParams.y + wakeAlong * uniform.uWakeParams.z;
            let wakeD = abs(wakeLateral) / max(wakeHalfW, 1e-3);
            let wakeCalm = (1.0 - smoothstep(0.0, 0.9, wakeD)) * (1.0 - smoothstep(0.0, uniform.uWakeParams.x, wakeAlong));
            disp *= mix(1.0, 0.3, clamp(wakeCalm * uniform.uWakeParams.w, 0.0, 1.0));
        }
    }

    let worldPos = base + disp * uniform.uDisplacementScale;
    // see the GLSL twin: slope, folding and foam are functions of the undisplaced point
    output.vSampleXZ = base.xz;
    output.vWorldPos = worldPos;
    output.vClipPos = uniform.matrix_viewProjection * vec4f(worldPos, 1.0);
    output.position = output.vClipPos;
    return output;
}
`;

export const WATER_FS_WGSL = /* wgsl */`
#include "decodePS"
#include "gammaPS"
#include "tonemappingPS"
#include "fogPS"
#include "screenDepthPS"
#include "sphericalPS"
#include "envAtlasPS"

var uSceneColorMap: texture_2d<f32>;
var uSceneColorMapSampler: sampler;
var texture_envAtlas: texture_2d<f32>;
var texture_envAtlas_sampler: sampler;
var uFoamTex: texture_2d<f32>;
var uFoamTexSampler: sampler;

uniform view_position: vec3f;
uniform matrix_viewProjection: mat4x4f;

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
uniform uCascade: array<vec4f, 4>;
uniform uNumCascades: i32;
uniform uLambda: f32;
uniform uDisplacementScale: f32;
uniform uTime: f32;

uniform uSunDir: vec3f;
uniform uSunColor: vec3f;
uniform uSunRadius: f32;

uniform uExtinction: vec3f;
uniform uScatterColor: vec3f;
uniform uScatterStrength: f32;
uniform uSSSColor: vec3f;
uniform uSSSParams: vec4f;
uniform uSurfaceParams: vec4f;
uniform uRefractionParams: vec4f;
uniform uFoamParams: vec4f;
uniform uFoamColor: vec3f;
uniform uFoamStrength: f32;
uniform uFoamCascadeWeights: vec4f;
var uSkyRadiance: texture_2d<f32>;
var uSkyRadianceSampler: sampler;
uniform uHasSkyRadiance: f32;
uniform uEnvironmentExposure: f32;
uniform uWaterRadius: f32;
uniform uFogDensity: f32;
uniform uSSRParams: vec4f;
uniform uCausticsParams: vec3f;
uniform uSeaLevel: f32;
uniform uShoreArea: vec4f;
uniform uShoreParams: vec4f;
uniform uShoreParams2: vec4f;
var uShoreMap: texture_2d<f32>;
var uShoreMapSampler: sampler;
uniform uWakeShip: vec4f;    // (originX, originZ, dirX, dirZ) — a ship's stern position and unit heading
uniform uWakeParams: vec4f;  // (length, halfWidth, spread, strength)

varying vWorldPos: vec3f;
varying vClipPos: vec4f;
varying vSampleXZ: vec2f;
varying vShore: vec2f;

const F0: f32 = 0.02;
const IOR_AIR_WATER: f32 = 0.75187969;
const IOR_WATER_AIR: f32 = 1.333;

${SURFACE_CAUSTICS_WGSL}

fn cascadeWeight(i: i32, dist: f32) -> f32 {
    if (i == 0) { return 1.0; }
    return 1.0 - smoothstep(uniform.uCascade[i].y, uniform.uCascade[i].z, dist);
}

fn sampleEnv(dir: vec3f, roughness: f32) -> vec3f {
    let d = normalize(dir) * vec3f(-1.0, 1.0, 1.0);
    let uv = toSphericalUv(d);
    let level = clamp(roughness * 5.0, 0.0, 5.0);
    let il = floor(level);
    let uvA = select(mapRoughnessUv(uv, il), mapShinyUv(uv, 0.0), il == 0.0);
    let uvB = mapRoughnessUv(uv, il + 1.0);
    let a = {ENV_DECODE}(textureSampleLevel(texture_envAtlas, texture_envAtlas_sampler, uvA, 0.0));
    let b = {ENV_DECODE}(textureSampleLevel(texture_envAtlas, texture_envAtlas_sampler, uvB, 0.0));
    return mix(a, b, level - il) * uniform.uEnvironmentExposure;
}
fn sampleAerial(dir: vec3f) -> vec3f {
    if (uniform.uHasSkyRadiance > 0.5) {
        return textureSampleLevel(uSkyRadiance, uSkyRadianceSampler, toSphericalUv(normalize(dir) * vec3f(-1.0, 1.0, 1.0)), 0.0).rgb * uniform.uEnvironmentExposure;
    }
    return sampleEnv(dir, 0.0);
}
fn sampleAmbient(dir: vec3f) -> vec3f {
    let d = normalize(dir) * vec3f(-1.0, 1.0, 1.0);
    let uv = mapUv(toSphericalUv(d), vec4f(128.0, 256.0 + 128.0, 64.0, 32.0) / atlasSize);
    return {ENV_DECODE}(textureSampleLevel(texture_envAtlas, texture_envAtlas_sampler, uv, 0.0)) * uniform.uEnvironmentExposure;
}

fn ggxSpecular(N: vec3f, V: vec3f, L: vec3f, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let aWide = clamp(a + uniform.uSunRadius, 0.0, 1.0);
    // The widened GGX distribution is already normalized.
    let H = (V + L) / max(length(V + L), 1e-5);
    let NdotH = max(dot(N, H), 0.0);
    let NdotV = max(dot(N, V), 1e-4);
    let NdotL = max(dot(N, L), 0.0);
    let a2 = aWide * aWide;
    let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    let D = a2 / (3.14159265 * d * d);
    let k = aWide * 0.5;
    let Vis = 1.0 / ((NdotV * (1.0 - k) + k) * (NdotL * (1.0 - k) + k));
    return D * Vis * 0.25 * NdotL;
}

struct SsrResult { color: vec3f, mask: f32 }

// ---- screen-space reflections against the opaque colour/depth grab ----
fn traceSSR(origin: vec3f, dir: vec3f, roughness: f32, dither: f32) -> SsrResult {
    var res: SsrResult;
    res.color = vec3f(0.0);
    res.mask = 0.0;
    let steps = i32(uniform.uSSRParams.z);
    let stride = uniform.uSSRParams.y * 0.14 / (pow(1.14, f32(steps)) - 1.0);
    let tol = uniform.uSSRParams.w;

    var prev = origin;
    var t = stride * (0.5 + dither);
    var grow = 1.0;
    for (var i = 0; i < 40; i++) {
        if (i >= steps || t > uniform.uSSRParams.y) { break; }
        let p = origin + dir * t;
        let clip = uniform.matrix_viewProjection * vec4f(p, 1.0);
        if (clip.w <= 0.0) { break; }
        var uv = getGrabScreenPos(clip);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }

        let sceneD = getLinearScreenDepth(uv);
        let rayD = getLinearDepth(p);
        let delta = rayD - sceneD;
        if (delta > 0.0 && delta < tol + stride * grow) {
            var a = prev;
            var b = p;
            for (var j = 0; j < 5; j++) {
                let m = (a + b) * 0.5;
                let mc = uniform.matrix_viewProjection * vec4f(m, 1.0);
                let muv = getGrabScreenPos(mc);
                if (getLinearDepth(m) - getLinearScreenDepth(muv) > 0.0) { b = m; } else { a = m; }
            }
            let hc = uniform.matrix_viewProjection * vec4f(b, 1.0);
            uv = getGrabScreenPos(hc);
            let edge = smoothstep(vec2f(0.0), vec2f(0.12), uv) * smoothstep(vec2f(0.0), vec2f(0.12), vec2f(1.0) - uv);
            res.mask = edge.x * edge.y * (1.0 - smoothstep(0.6, 1.0, t / uniform.uSSRParams.y));
            res.color = textureSampleLevel(uSceneColorMap, uSceneColorMapSampler, uv, min(roughness * 8.0, 4.0)).rgb;
            #ifdef SCENE_COLORMAP_GAMMA
                res.color = decodeGamma3(res.color);
            #endif
            return res;
        }
        prev = p;
        grow *= 1.14;
        t += stride * grow;
    }
    return res;
}

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let worldPos = input.vWorldPos;
    let camToPos = worldPos - uniform.view_position;
    let dist = max(length(camToPos), 1e-4);
    let V = -camToPos / dist;
    let underwater = uniform.view_position.y < uniform.uSeaLevel;

    // Slopes follow the cascade LOD. The folding (Jacobian) does not: whitecaps are a property of
    // the sea state, so every cascade counts at every distance — the maps are mipmapped, so a far
    // sample is the local average — or the whitecap coverage would change with the camera.
    var dsum = vec4f(0.0);
    var wsum = 0.0;
    var jac = 1.0;
    var w: f32;
    var cuv: vec2f;
    w = cascadeWeight(0, dist); cuv = input.vSampleXZ * uniform.uCascade[0].w;
    dsum += textureSample(uDeriv0, uDeriv0Sampler, cuv) * w; jac += (textureSample(uDisp0, uDisp0Sampler, cuv).w - 1.0) * uniform.uFoamCascadeWeights.x; wsum += w;
    if (uniform.uNumCascades > 1) { w = cascadeWeight(1, dist); cuv = input.vSampleXZ * uniform.uCascade[1].w;
        dsum += textureSample(uDeriv1, uDeriv1Sampler, cuv) * w; jac += (textureSample(uDisp1, uDisp1Sampler, cuv).w - 1.0) * uniform.uFoamCascadeWeights.y; wsum += w; }
    if (uniform.uNumCascades > 2) { w = cascadeWeight(2, dist); cuv = input.vSampleXZ * uniform.uCascade[2].w;
        dsum += textureSample(uDeriv2, uDeriv2Sampler, cuv) * w; jac += (textureSample(uDisp2, uDisp2Sampler, cuv).w - 1.0) * uniform.uFoamCascadeWeights.z; wsum += w; }
    if (uniform.uNumCascades > 3) { w = cascadeWeight(3, dist); cuv = input.vSampleXZ * uniform.uCascade[3].w;
        dsum += textureSample(uDeriv3, uDeriv3Sampler, cuv) * w; jac += (textureSample(uDisp3, uDisp3Sampler, cuv).w - 1.0) * uniform.uFoamCascadeWeights.w; wsum += w; }
    dsum *= uniform.uDisplacementScale;
    let detail = wsum / f32(uniform.uNumCascades);
    let slope = dsum.xy / max(vec2f(1.0) + uniform.uLambda * dsum.zw, vec2f(0.1));
    let Nup = normalize(vec3f(-slope.x, 1.0, -slope.y));
    var N = select(Nup, -Nup, underwater);
    let NdotVraw = dot(N, V);
    if (NdotVraw < 0.02) { N = normalize(N + V * (0.02 - NdotVraw)); }
    let NdotV = max(dot(N, V), 1e-4);

    var roughness = clamp(uniform.uSurfaceParams.x + uniform.uSurfaceParams.y * (1.0 - detail), 0.02, 1.0);
    let dndx = dpdx(N); let dndy = dpdy(N);
    let nVar = 0.25 * (dot(dndx, dndx) + dot(dndy, dndy));
    roughness = sqrt(clamp(roughness * roughness + min(2.0 * nVar, 0.2), 0.0, 1.0));

    // plain Schlick — see the GLSL twin on why the roughness-capped variant darkens the horizon
    let fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);

    let screenUv = getGrabScreenPos(input.vClipPos);
    let surfaceDepth = getLinearDepth(worldPos);
    let sceneDepth = getLinearScreenDepth(screenUv);
    var thickness = max(sceneDepth - surfaceDepth, 0.0);
    let opaquePos = uniform.view_position + camToPos * (sceneDepth / max(surfaceDepth, 1e-4));
    let receiverCross = cross(dpdx(opaquePos), dpdy(opaquePos));
    let receiverNormal = receiverCross * inverseSqrt(max(dot(receiverCross, receiverCross), 1e-8));
    let contactDistance = abs(dot(opaquePos - worldPos, receiverNormal));
    let contactNearby = 1.0 - smoothstep(2.0, 4.0, length(opaquePos - worldPos));

    let camFwd = -vec3f(uniform.matrix_view[0].z, uniform.matrix_view[1].z, uniform.matrix_view[2].z);
    let refrDir = refract(-V, N, select(IOR_AIR_WATER, IOR_WATER_AIR, underwater));
    let offsetPoint = worldPos + refrDir * min(thickness, uniform.uRefractionParams.z);
    var offset = (getGrabScreenPos(uniform.matrix_viewProjection * vec4f(offsetPoint, 1.0)) - screenUv) * uniform.uRefractionParams.x;
    offset = clamp(offset, vec2f(-0.05), vec2f(0.05));
    var refrUv = clamp(screenUv + offset, vec2f(0.001), vec2f(0.999));
    var refrDepth = getLinearScreenDepth(refrUv);
    if (refrDepth < surfaceDepth) { refrUv = screenUv; refrDepth = sceneDepth; }
    thickness = max(refrDepth - surfaceDepth, 0.0);
    let opticalDistance = thickness / max(dot(refrDir, camFwd), 0.15);
    let lod = min(opticalDistance * uniform.uRefractionParams.y, 4.0);
    var sceneColor = textureSampleLevel(uSceneColorMap, uSceneColorMapSampler, refrUv, lod).rgb;
    #ifdef SCENE_COLORMAP_GAMMA
        sceneColor = decodeGamma3(sceneColor);
    #endif

    let ambientUp = sampleAmbient(vec3f(0.0, 1.0, 0.0));
    let sunE = uniform.uSunColor;
    let sunUp = clamp(uniform.uSunDir.y, 0.0, 1.0);

    let causticPixelMetres = max(length(dpdx(opaquePos.xz)), length(dpdy(opaquePos.xz)));
    if (uniform.uCausticsParams.x > 0.0 && uniform.uDisplacementScale > 0.0 && thickness > 0.0 && !underwater && sunUp > 0.0) {
        let hit = worldPos + refrDir * opticalDistance;
        let depthBelow = max(uniform.uSeaLevel - hit.y, 0.0);
        let sunRay = waterCausticSunRay(uniform.uSunDir);
        let lightPath = depthBelow / max(-sunRay.y, 0.1);
        let entry = hit.xz - sunRay.xz * lightPath;
        let focus = waterCausticFocus(entry, depthBelow, uniform.uCausticsParams.y,
            uniform.uSunDir, causticPixelMetres);
        let facing = max(dot(receiverNormal, -sunRay), 0.0);
        let direct = dot(sunE, vec3f(0.2126, 0.7152, 0.0722)) * facing;
        let diffuseSky = dot(ambientUp, vec3f(0.2126, 0.7152, 0.0722)) * 3.14159265;
        let directFraction = direct / max(direct + diffuseSky, 1e-5);
        let fade = exp(-depthBelow * uniform.uCausticsParams.z) * smoothstep(0.02, 0.35, sunUp) * detail;
        let amount = uniform.uCausticsParams.x * min(uniform.uDisplacementScale, 1.0) * fade * directFraction;
        sceneColor *= max(vec3f(0.0), vec3f(1.0) + (focus - 1.0) * amount * exp(-uniform.uExtinction * lightPath));
    }

    let waveHeight = max(worldPos.y - uniform.uSeaLevel, 0.0);
    let Ls = normalize(-uniform.uSunDir + Nup * uniform.uSSSParams.w);
    let sssView = pow(clamp(dot(V, Ls), 0.0, 1.0), uniform.uSSSParams.y);
    let sssHeight = clamp(waveHeight * uniform.uSSSParams.z, 0.0, 1.0);
    let sss = uniform.uSSSColor * (sunE * sssView * sssHeight * uniform.uSSSParams.x * sunUp + ambientUp * sssHeight * uniform.uSSSParams.x * 0.25);

    let scatterRadiance = uniform.uScatterColor * uniform.uScatterStrength * (ambientUp + sunE * sunUp * 0.3183) + sss;
    let T = exp(-uniform.uExtinction * opticalDistance);
    let refracted = sceneColor * T + scatterRadiance * (1.0 - T);

    let windowRay = refract(-V, N, IOR_WATER_AIR);
    let sunWindowCos = dot(windowRay / max(length(windowRay), 1e-5), uniform.uSunDir);
    let sunWindowEdge = max(fwidth(sunWindowCos), 1e-6);
    var color: vec3f;
    if (underwater) {
        let up = refract(-V, N, IOR_WATER_AIR);
        let tir = select(0.0, 1.0, dot(up, up) < 1e-5);
        var skyThroughSurface = vec3f(0.0);
        if (tir < 0.5) {
            skyThroughSurface = sampleEnv(up, roughness) * uniform.uSurfaceParams.z;
            let sunCos = sunWindowCos;
            let radius = max(uniform.uSunRadius, 1e-4);
            let edge = sunWindowEdge;
            let disc = smoothstep(cos(radius) - edge, cos(radius) + edge, sunCos);
            skyThroughSurface += sunE * disc / max(3.14159265 * radius * radius, 1e-6);
        }
        let mirrored = scatterRadiance;
        let cosT = sqrt(max(1.0 - IOR_WATER_AIR * IOR_WATER_AIR * (1.0 - NdotV * NdotV), 0.0));
        let rs = (IOR_WATER_AIR * NdotV - cosT) / max(IOR_WATER_AIR * NdotV + cosT, 1e-5);
        let rp = (NdotV - IOR_WATER_AIR * cosT) / max(NdotV + IOR_WATER_AIR * cosT, 1e-5);
        let fUp = mix(0.5 * (rs * rs + rp * rp), 1.0, tir);
        color = mix(skyThroughSurface, mirrored, fUp);
    } else {
        var R = reflect(-V, N);
        var envRefl = sampleEnv(R, roughness) * uniform.uSurfaceParams.z;
        if (uniform.uSSRParams.x > 0.0 && roughness < 0.3 && R.y < 0.4) {
            let dither = fract(sin(dot(pcPosition.xy, vec2f(12.9898, 78.233))) * 43758.5453 + uniform.uTime);
            let ssr = traceSSR(worldPos, R, roughness, dither);
            let m = ssr.mask * uniform.uSSRParams.x * (1.0 - smoothstep(0.15, 0.35, roughness));
            envRefl = mix(envRefl, ssr.color, clamp(m, 0.0, 1.0));
        }
        let spec = ggxSpecular(N, V, uniform.uSunDir, roughness) * uniform.uSurfaceParams.w;
        let H = (V + uniform.uSunDir) / max(length(V + uniform.uSunDir), 1e-5);
        let FH = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
        let sunSpec = sunE * spec * FH;
        color = refracted * (1.0 - fresnel) + envRefl * fresnel + sunSpec;
    }

    // see the GLSL twin
    let foamUv = input.vSampleXZ * uniform.uFoamParams.z;
    let fa = textureSample(uFoamTex, uFoamTexSampler, foamUv + vec2f(uniform.uTime * 0.011, uniform.uTime * 0.006));
    let fb = textureSample(uFoamTex, uFoamTexSampler, foamUv * 2.83 - vec2f(uniform.uTime * 0.019, uniform.uTime * -0.013));
    let clumps = fa.r * 0.62 + fb.r * 0.38;
    let bubbles = fa.g * 0.5 + fb.g * 0.5;
    let lace = clamp(clumps * mix(0.72, 1.28, fa.b) + bubbles * 0.22, 0.0, 1.0);

    // ship wake: fold the surface locally, so it rides the whitecap system below — see the GLSL twin
    if (uniform.uWakeParams.x > 0.0) {
        let wakeRel = input.vSampleXZ - uniform.uWakeShip.xy;
        let wakeDir = uniform.uWakeShip.zw;
        let wakePerp = vec2f(-wakeDir.y, wakeDir.x);
        let along = -dot(wakeRel, wakeDir);
        if (along > 0.0 && along < uniform.uWakeParams.x) {
            let halfW = uniform.uWakeParams.y + along * uniform.uWakeParams.z;
            let lateral = dot(wakeRel, wakePerp) + (fa.b - 0.5) * halfW * 0.6;
            let d = abs(lateral) / max(halfW, 1e-3);
            let centerFold = (1.0 - smoothstep(0.0, 0.6, d)) * (1.0 - smoothstep(0.0, uniform.uWakeParams.x * 0.4, along));
            let armFold = smoothstep(0.5, 0.7, d) * (1.0 - smoothstep(0.7, 1.1, d));
            let tailFade = 1.0 - smoothstep(uniform.uWakeParams.x * 0.7, uniform.uWakeParams.x, along);
            jac -= clamp(centerFold * 0.5 + armFold, 0.0, 1.0) * tailFade * uniform.uWakeParams.w;
        }
    }

    let foamMask = clamp((uniform.uFoamParams.x - jac) * uniform.uFoamParams.y, 0.0, 1.0);
    var whitecap = foamMask * smoothstep(1.0 - foamMask * 1.15, max(1.0 - foamMask * 0.22, 1.001 - foamMask * 1.15), lace);
    whitecap *= mix(0.72, 1.0, bubbles);
    whitecap *= 1.0 - 0.75 * smoothstep(700.0, 2600.0, dist);   // see the GLSL twin

    let shore = (1.0 - smoothstep(0.02, 0.55, contactDistance)) * contactNearby;
    let shoreBands = 0.5 + 0.5 * sin(contactDistance * 9.0 - uniform.uTime * 1.3 + fa.b * 5.0);
    let shoreFoam = shore * shore * clamp((lace * 0.9 + shoreBands * 0.5 + shore * 0.6 - 0.78) * 3.2, 0.0, 1.0);

    // ---- surf; see the GLSL twin ----
    var surfFoam = 0.0;
    if (uniform.uShoreParams2.w > 0.5) {
        let sdepth = input.vShore.x;
        let sh = textureSampleLevel(uShoreMap, uShoreMapSampler, clamp((input.vSampleXZ - uniform.uShoreArea.xy) * uniform.uShoreArea.zw, vec2f(0.0), vec2f(1.0)), 0.0);
        let offshore = sh.yz * 2.0 - 1.0;

        var phase = sdepth / max(uniform.uShoreParams.y, 0.05) + uniform.uTime * uniform.uShoreParams.z;
        phase += (fa.b - 0.5) * 0.35 + dot(input.vSampleXZ, offshore) * 0.004;
        let band = 0.5 - 0.5 * cos(phase * 6.28318530718);

        let breaking = 1.0 - smoothstep(uniform.uShoreParams.w * 0.3, uniform.uShoreParams.w * 1.4, sdepth);
        let crest = pow(band, 3.0);
        let surf = crest * breaking;
        // swash: a lace a metre or two wide that runs up the sand and drains back, not a sheet
        let swashPulse = 0.4 + 0.6 * (0.5 + 0.5 * sin(uniform.uTime * 0.9 + fa.b * 6.0 + sdepth * 4.0));
        let swash = uniform.uShoreParams2.y * (1.0 - smoothstep(0.0, uniform.uShoreParams.w * 0.2, sdepth)) * swashPulse;

        surfFoam = clamp((surf + swash) * lace * 1.15 * uniform.uShoreParams2.x, 0.0, 1.0) * input.vShore.y;
    }

    var foam = clamp((whitecap + shoreFoam + surfFoam) * uniform.uFoamStrength, 0.0, 1.0);
    if (underwater) { foam *= 0.25; }

    let aerate = clamp((fa.a * 0.7 + fb.a * 0.3) * foamMask * uniform.uFoamStrength - 0.25, 0.0, 1.0) * 0.22;
    let NdotL = max(dot(Nup, uniform.uSunDir), 0.0);
    var foamLit = uniform.uFoamColor * (ambientUp + sunE * (NdotL * 0.85 + 0.15) * 0.3183);
    if (!underwater) { foamLit = mix(foamLit, sampleEnv(reflect(-V, Nup), 0.35), fresnel * 0.55); }
    color = mix(color, foamLit * 0.55, aerate * (1.0 - foam));
    color = mix(color, foamLit, foam);

    if (!underwater) {
        let apDir = normalize(vec3f(camToPos.x, max(camToPos.y, 0.0), camToPos.z));
        let horizonSky = sampleAerial(apDir);
        let coverage = 1.0 - smoothstep(uniform.uWaterRadius * 0.72, uniform.uWaterRadius * 0.98, dist);
        color = mix(horizonSky, color, exp(-uniform.uFogDensity * dist) * coverage);
    } else {
        color = mix(scatterRadiance, color, exp(-uniform.uExtinction * dist));
    }
    // The surface dissolves where the water runs out of depth, so the shoreline is a wet gradient
    // rather than a cut; the foam lying in the swash stays.
    var alpha = 1.0;
    if (!underwater) { alpha = clamp(smoothstep(0.0, 0.08, mix(1.0, contactDistance, contactNearby)) + foam * 0.7, 0.0, 1.0); }
    output.color = vec4f(gammaCorrectOutput(toneMap(clamp(color, vec3f(0.0), vec3f(60000.0)))), alpha);
    return output;
}
`;
