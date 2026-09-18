import { SURFACE_CAUSTICS_GLSL } from './caustics.js';

// Ocean surface shader (GLSL, WebGL2). A WGSL twin lives in oceanSurface.wgsl.js.
//
// Physically-based water shading:
//   · Fresnel (IOR 1.333) with roughness-aware Schlick
//   · GGX sun highlight widened by the sun's angular radius
//   · pre-filtered environment reflection + screen-space reflections of scene geometry
//   · Beer-Lambert absorption and in-scatter against the scene colour/depth grab
//   · animated caustics projected onto the refracted geometry
//   · crest subsurface scattering
//   · Jacobian whitecaps, wave-driven lacing and shoreline foam
//   · from below: Snell's window with total internal reflection

export const WATER_VS = /* glsl */`
attribute vec3 vertex_position;

uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform vec3 view_position;

uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform sampler2D uDisp3;
uniform vec4 uCascade[4];      // (lengthScale, fadeStart, fadeEnd, 1/lengthScale)
uniform int  uNumCascades;
uniform float uSeaLevel;
uniform float uDisplacementScale;
uniform vec4 uMeshLod;         // (grid spacing per metre of radius, inner radius, sim size, -)
// Declared identically in both stages: the engine hoists uniforms from vertex and fragment
// sources into one shared block, and two spellings of the same uniform become a redefinition.
// uShoreArea    (originX, originZ, 1/sizeX, 1/sizeZ)
// uShoreParams  (maxDepth, crest spacing in m of depth, speed, break depth)
// uShoreParams2 (foam, swash, shoaling, enabled)
uniform sampler2D uShoreMap;
uniform vec4 uShoreArea;
uniform vec4 uShoreParams;
uniform vec4 uShoreParams2;
// uWakeShip   (originX, originZ, dirX, dirZ) — a ship's stern position and unit heading
// uWakeParams (length, halfWidth, spread, strength)
uniform vec4 uWakeShip;
uniform vec4 uWakeParams;

varying vec3 vWorldPos;
varying vec4 vClipPos;
varying vec2 vSampleXZ;
varying vec2 vShore;          // (water depth in m, land mask)

float cascadeWeight(int i, float dist) {
    if (i == 0) return 1.0;
    return 1.0 - smoothstep(uCascade[i].y, uCascade[i].z, dist);
}

void main(void) {
    vec3 base = (matrix_model * vec4(vertex_position, 1.0)).xyz;
    base.y = uSeaLevel;
    float dist = distance(base, view_position);

    // The mesh is a camera-centred polar grid whose spacing grows with radius, so past a few
    // metres it cannot carry the shorter waves in a cascade. Point-sampling them anyway aliases,
    // and because the grid slides under the wave field the alias pattern moves with the camera.
    // So each cascade is read at the mip whose texel matches the local grid spacing: the geometry
    // carries what the mesh can represent and the normal map carries the rest.
    float spacing = max(length(vertex_position.xz) * uMeshLod.x, uMeshLod.y);
    float lod0 = log2(max(spacing * uCascade[0].w * uMeshLod.z, 1.0));
    float lod1 = log2(max(spacing * uCascade[1].w * uMeshLod.z, 1.0));
    float lod2 = log2(max(spacing * uCascade[2].w * uMeshLod.z, 1.0));
    float lod3 = log2(max(spacing * uCascade[3].w * uMeshLod.z, 1.0));
    vec3 disp = vec3(0.0);
    disp += textureLod(uDisp0, base.xz * uCascade[0].w, lod0).xyz * cascadeWeight(0, dist);
    if (uNumCascades > 1) disp += textureLod(uDisp1, base.xz * uCascade[1].w, lod1).xyz * cascadeWeight(1, dist);
    if (uNumCascades > 2) disp += textureLod(uDisp2, base.xz * uCascade[2].w, lod2).xyz * cascadeWeight(2, dist);
    if (uNumCascades > 3) disp += textureLod(uDisp3, base.xz * uCascade[3].w, lod3).xyz * cascadeWeight(3, dist);

    // ---- the coast ----
    vec2 shoreUv = (base.xz - uShoreArea.xy) * uShoreArea.zw;
    vec4 shore = texture(uShoreMap, clamp(shoreUv, 0.0, 1.0));
    // Outside a supplied bathymetry map the surface is open ocean, not its clamped edge.
    if (any(lessThan(shoreUv, vec2(0.0))) || any(greaterThan(shoreUv, vec2(1.0)))) shore = vec4(1.0, 0.5, 0.5, 1.0);
    float depth = shore.x * uShoreParams.x;
    float landMask = shore.w;
    vShore = vec2(depth, landMask);

    if (uShoreParams2.w > 0.5) {
        // A wave cannot be taller than the water it is standing in: as the bed rises the swell has
        // to give up its amplitude, and it does so by rearing up first. Both halves matter — without
        // the damping the sea saws straight through the beach, without the rearing there is no surf.
        float shoal = clamp(depth / max(uShoreParams.w * 2.5, 0.5), 0.0, 1.0);
        float rear = 1.0 + uShoreParams2.z * (1.0 - shoal) * shoal * 4.0;
        disp.y *= shoal * rear;
        disp.xz *= mix(0.35, 1.0, shoal);
        disp *= landMask;
    }

    // ---- ship wake: a moving hull churns its own water flat, the same way the coast above
    // damps it in shallow water — same mechanism, new trigger region. See the FS twin for the
    // foam that rides on top of this.
    if (uWakeParams.x > 0.0) {
        vec2 wakeRel = base.xz - uWakeShip.xy;
        vec2 wakeDir = uWakeShip.zw;
        float wakeAlong = -dot(wakeRel, wakeDir);
        float wakeLateral = dot(wakeRel, vec2(-wakeDir.y, wakeDir.x));
        if (wakeAlong > 0.0 && wakeAlong < uWakeParams.x) {
            float wakeHalfW = uWakeParams.y + wakeAlong * uWakeParams.z;
            float wakeD = abs(wakeLateral) / max(wakeHalfW, 1e-3);
            float wakeCalm = (1.0 - smoothstep(0.0, 0.9, wakeD)) * (1.0 - smoothstep(0.0, uWakeParams.x, wakeAlong));
            disp *= mix(1.0, 0.3, clamp(wakeCalm * uWakeParams.w, 0.0, 1.0));
        }
    }

    vec3 worldPos = base + disp * uDisplacementScale;
    // The wave field is a function of the *undisplaced* point: the surface at base.xz has moved to
    // worldPos, but its slope, its folding and the foam riding on it all belong to base.xz. Reading
    // them back at worldPos.xz instead offsets everything by the horizontal displacement — metres,
    // on a choppy sea — which is what puts whitecaps in the troughs instead of on the crest faces.
    vSampleXZ = base.xz;
    vWorldPos = worldPos;
    vClipPos = matrix_viewProjection * vec4(worldPos, 1.0);
    gl_Position = vClipPos;
}
`;

export const WATER_FS = /* glsl */`
#include "decodePS"
#include "gammaPS"
#include "tonemappingPS"
#include "fogPS"
#include "screenDepthPS"
#include "sphericalPS"
#include "envAtlasPS"

uniform sampler2D uSceneColorMap;
uniform sampler2D texture_envAtlas;
uniform sampler2D uFoamTex;

uniform vec3 view_position;
uniform mat4 matrix_viewProjection;

uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;
uniform sampler2D uDisp3;
uniform sampler2D uDeriv0;
uniform sampler2D uDeriv1;
uniform sampler2D uDeriv2;
uniform sampler2D uDeriv3;
uniform vec4 uCascade[4];
uniform int  uNumCascades;
uniform float uLambda;
uniform float uDisplacementScale;
uniform float uTime;

uniform vec3  uSunDir;          // towards the sun (world)
uniform vec3  uSunColor;        // sun irradiance (linear)
uniform float uSunRadius;       // tan(angular radius) used to widen the highlight

uniform vec3  uExtinction;      // per-channel extinction 1/m
uniform vec3  uScatterColor;    // volumetric in-scatter albedo
uniform float uScatterStrength;
uniform vec3  uSSSColor;
uniform vec4  uSSSParams;       // (strength, power, height scale, normal distortion)
uniform vec4  uSurfaceParams;   // (roughness, roughnessDistance, envStrength, specularStrength)
uniform vec4  uRefractionParams;// (strength, blur, max thickness for distortion, unused)
uniform vec4  uFoamParams;      // (bias, sharpness, tiling, shoreDistance)
uniform vec3  uFoamColor;
uniform float uFoamStrength;
uniform vec4  uFoamCascadeWeights;
uniform sampler2D uSkyRadiance;
uniform float uHasSkyRadiance;
uniform float uEnvironmentExposure;
uniform float uWaterRadius;
uniform float uFogDensity;      // aerial perspective towards the sky colour in the view direction
uniform vec4  uSSRParams;       // (intensity, maxDistance, steps, thickness tolerance)
uniform vec3  uCausticsParams;  // (intensity, inverse footprint, depth fade 1/m)
uniform float uSeaLevel;
uniform sampler2D uShoreMap;
uniform vec4 uShoreArea;
uniform vec4 uShoreParams;
uniform vec4 uShoreParams2;
uniform vec4 uWakeShip;    // (originX, originZ, dirX, dirZ) — a ship's stern position and unit heading
uniform vec4 uWakeParams;  // (length, halfWidth, spread, strength)

varying vec3 vWorldPos;
varying vec4 vClipPos;
varying vec2 vSampleXZ;
varying vec2 vShore;

#define F0 0.02
#define IOR_AIR_WATER 0.75187969   // 1.0 / 1.333
#define IOR_WATER_AIR 1.333

${SURFACE_CAUSTICS_GLSL}

float cascadeWeight(int i, float dist) {
    if (i == 0) return 1.0;
    return 1.0 - smoothstep(uCascade[i].y, uCascade[i].z, dist);
}

// environment reflection from the prefiltered atlas (roughness in [0,1])
vec3 sampleEnv(vec3 dir, float roughness) {
    vec3 d = normalize(dir) * vec3(-1.0, 1.0, 1.0);
    vec2 uv = toSphericalUv(d);
    float level = clamp(roughness * 5.0, 0.0, 5.0);
    float il = floor(level);
    vec2 uvA = il == 0.0 ? mapShinyUv(uv, 0.0) : mapRoughnessUv(uv, il);
    vec2 uvB = mapRoughnessUv(uv, il + 1.0);
    vec3 a = {ENV_DECODE}(texture(texture_envAtlas, uvA));
    vec3 b = {ENV_DECODE}(texture(texture_envAtlas, uvB));
    return mix(a, b, level - il) * uEnvironmentExposure;
}
// Aerial light uses the unfiltered sky, not a roughness-convolved reflection that mixes
// planetary ground into the horizon. Generic environments can use the atlas fallback.
vec3 sampleAerial(vec3 dir) {
    if (uHasSkyRadiance > 0.5) return textureLod(uSkyRadiance, toSphericalUv(normalize(dir) * vec3(-1.0, 1.0, 1.0)), 0.0).rgb * uEnvironmentExposure;
    return sampleEnv(dir, 0.0);
}
vec3 sampleAmbient(vec3 dir) {
    vec3 d = normalize(dir) * vec3(-1.0, 1.0, 1.0);
    vec2 uv = mapUv(toSphericalUv(d), vec4(128.0, 256.0 + 128.0, 64.0, 32.0) / atlasSize);
    return {ENV_DECODE}(texture(texture_envAtlas, uv)) * uEnvironmentExposure;
}

// GGX specular for a directional light with angular size widening (Karis 2013)
float ggxSpecular(vec3 N, vec3 V, vec3 L, float roughness) {
    float a = roughness * roughness;
    float aWide = clamp(a + uSunRadius, 0.0, 1.0);
    // The widened GGX distribution is already normalized; retain its integrated energy.
    vec3 H = (V + L) / max(length(V + L), 1e-5);
    float NdotH = max(dot(N, H), 0.0);
    float NdotV = max(dot(N, V), 1e-4);
    float NdotL = max(dot(N, L), 0.0);
    float a2 = aWide * aWide;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * d * d);
    float k = aWide * 0.5;
    float Vis = 1.0 / ((NdotV * (1.0 - k) + k) * (NdotL * (1.0 - k) + k));   // Smith-Schlick, includes 1/(4 NdotV NdotL)
    return D * Vis * 0.25 * NdotL;
}

// ---- screen-space reflections against the opaque colour/depth grab ----
// Marches the reflected ray in world space with a geometrically growing step, then bisects the
// crossing. Returns the reflected colour; 'mask' is the confidence (0 = miss, fall back to the sky).
vec3 traceSSR(vec3 origin, vec3 dir, float roughness, float dither, out float mask) {
    mask = 0.0;
    int steps = int(uSSRParams.z);
    float stride = uSSRParams.y * 0.14 / (pow(1.14, float(steps)) - 1.0);
    float tol = uSSRParams.w;

    vec3 prev = origin;
    float t = stride * (0.5 + dither);
    float grow = 1.0;
    for (int i = 0; i < 40; i++) {
        if (i >= steps || t > uSSRParams.y) break;
        vec3 p = origin + dir * t;
        vec4 clip = matrix_viewProjection * vec4(p, 1.0);
        if (clip.w <= 0.0) break;
        vec2 uv = getGrabScreenPos(clip);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

        float sceneD = getLinearScreenDepth(uv);
        float rayD = getLinearDepth(p);
        float delta = rayD - sceneD;
        if (delta > 0.0 && delta < tol + stride * grow) {
            // bisect between prev (in front) and p (behind) for a tighter hit
            vec3 a = prev, b = p;
            for (int j = 0; j < 5; j++) {
                vec3 m = (a + b) * 0.5;
                vec4 mc = matrix_viewProjection * vec4(m, 1.0);
                vec2 muv = getGrabScreenPos(mc);
                if (getLinearDepth(m) - getLinearScreenDepth(muv) > 0.0) b = m; else a = m;
            }
            vec4 hc = matrix_viewProjection * vec4(b, 1.0);
            uv = getGrabScreenPos(hc);
            // fade at the screen border, at grazing rays and with distance travelled
            vec2 edge = smoothstep(vec2(0.0), vec2(0.12), uv) * smoothstep(vec2(0.0), vec2(0.12), 1.0 - uv);
            mask = edge.x * edge.y * (1.0 - smoothstep(0.6, 1.0, t / uSSRParams.y));
            vec3 hitColor = textureLod(uSceneColorMap, uv, min(roughness * 8.0, 4.0)).rgb;
            #ifdef SCENE_COLORMAP_GAMMA
                hitColor = decodeGamma(hitColor);
            #endif
            return hitColor;
        }
        prev = p;
        grow *= 1.14;
        t += stride * grow;
    }
    return vec3(0.0);
}

void main(void) {
    vec3 worldPos = vWorldPos;
    vec3 camToPos = worldPos - view_position;
    float dist = max(length(camToPos), 1e-4);
    vec3 V = -camToPos / dist;
    bool underwater = view_position.y < uSeaLevel;

    // ---- normal from summed slope derivatives ----
    // slopes follow the cascade LOD; the folding (Jacobian) does not — see the WGSL twin
    vec4 dsum = vec4(0.0);
    float wsum = 0.0;
    float jac = 1.0;
    float w;
    vec2 cuv;
    w = cascadeWeight(0, dist); cuv = vSampleXZ * uCascade[0].w; dsum += texture(uDeriv0, cuv) * w; jac += (texture(uDisp0, cuv).w - 1.0) * uFoamCascadeWeights.x; wsum += w;
    if (uNumCascades > 1) { w = cascadeWeight(1, dist); cuv = vSampleXZ * uCascade[1].w; dsum += texture(uDeriv1, cuv) * w; jac += (texture(uDisp1, cuv).w - 1.0) * uFoamCascadeWeights.y; wsum += w; }
    if (uNumCascades > 2) { w = cascadeWeight(2, dist); cuv = vSampleXZ * uCascade[2].w; dsum += texture(uDeriv2, cuv) * w; jac += (texture(uDisp2, cuv).w - 1.0) * uFoamCascadeWeights.z; wsum += w; }
    if (uNumCascades > 3) { w = cascadeWeight(3, dist); cuv = vSampleXZ * uCascade[3].w; dsum += texture(uDeriv3, cuv) * w; jac += (texture(uDisp3, cuv).w - 1.0) * uFoamCascadeWeights.w; wsum += w; }
    dsum *= uDisplacementScale;
    float detail = wsum / float(uNumCascades);
    // A folded FFT surface has no single-valued slope. Bound its horizontal Jacobian
    // before division so breaking crests stay finite rather than flipping inside out.
    vec2 slope = dsum.xy / max(vec2(1.0) + uLambda * dsum.zw, vec2(0.1));
    vec3 Nup = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 N = underwater ? -Nup : Nup;
    // keep the normal facing the viewer (steep backfaces of choppy waves)
    float NdotVraw = dot(N, V);
    if (NdotVraw < 0.02) N = normalize(N + V * (0.02 - NdotVraw));
    float NdotV = max(dot(N, V), 1e-4);

    // ---- roughness increases as high-frequency cascades fade ----
    float roughness = clamp(uSurfaceParams.x + uSurfaceParams.y * (1.0 - detail), 0.02, 1.0);
    // geometric specular anti-aliasing (Tokuyoshi & Kaplanyan): fold normal variance within the pixel into roughness
    vec3 dndx = dFdx(N), dndy = dFdy(N);
    float nVar = 0.25 * (dot(dndx, dndx) + dot(dndy, dndy));
    roughness = sqrt(clamp(roughness * roughness + min(2.0 * nVar, 0.2), 0.0, 1.0));

    // ---- Fresnel (Schlick) ----
    // Plain Schlick, not the roughness-capped variant: that one is an ambient-occlusion
    // approximation, and capping grazing reflectance at (1 - roughness) means a rough sea reflects
    // only half the sky at the horizon. The far water then comes out darker than the sky above it,
    // which is what draws a line along the horizon. Roughness belongs in the lobe, not here.
    float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);

    // ---- refraction / underwater volume ----
    vec2 screenUv = getGrabScreenPos(vClipPos);
    float surfaceDepth = getLinearDepth(worldPos);
    float sceneDepth = getLinearScreenDepth(screenUv);
    float thickness = max(sceneDepth - surfaceDepth, 0.0);
    // Reconstruct the opaque receiver at the original pixel. Distance to its tangent plane
    // makes the contact band stable when the camera turns; eye-depth thickness does not.
    vec3 opaquePos = view_position + camToPos * (sceneDepth / max(surfaceDepth, 1e-4));
    vec3 receiverCross = cross(dFdx(opaquePos), dFdy(opaquePos));
    vec3 receiverNormal = receiverCross * inversesqrt(max(dot(receiverCross, receiverCross), 1e-8));
    float contactDistance = abs(dot(opaquePos - worldPos, receiverNormal));
    float contactNearby = 1.0 - smoothstep(2.0, 4.0, length(opaquePos - worldPos));

    // Project the refracted ray into the camera, so distortion follows camera heading/roll.
    vec3 camFwd = -vec3(matrix_view[0].z, matrix_view[1].z, matrix_view[2].z);
    vec3 refrDir = refract(-V, N, underwater ? IOR_WATER_AIR : IOR_AIR_WATER);
    vec3 offsetPoint = worldPos + refrDir * min(thickness, uRefractionParams.z);
    vec2 offset = (getGrabScreenPos(matrix_viewProjection * vec4(offsetPoint, 1.0)) - screenUv) * uRefractionParams.x;
    offset = clamp(offset, vec2(-0.05), vec2(0.05));
    vec2 refrUv = clamp(screenUv + offset, vec2(0.001), vec2(0.999));
    float refrDepth = getLinearScreenDepth(refrUv);
    if (refrDepth < surfaceDepth) { refrUv = screenUv; refrDepth = sceneDepth; }
    thickness = max(refrDepth - surfaceDepth, 0.0);
    float opticalDistance = thickness / max(dot(refrDir, camFwd), 0.15);
    float lod = min(opticalDistance * uRefractionParams.y, 4.0);
    vec3 sceneColor = textureLod(uSceneColorMap, refrUv, lod).rgb;
    #ifdef SCENE_COLORMAP_GAMMA
        sceneColor = decodeGamma(sceneColor);
    #endif

    vec3 ambientUp = sampleAmbient(vec3(0.0, 1.0, 0.0));
    vec3 sunE = uSunColor;
    float sunUp = clamp(uSunDir.y, 0.0, 1.0);

    // Pixel derivatives stay outside divergent branches for both rendering backends.
    float causticPixelMetres = max(length(dFdx(opaquePos.xz)), length(dFdy(opaquePos.xz)));
    // Shared, bounded wave-ray focusing modulates the receiver's existing light.
    if (uCausticsParams.x > 0.0 && uDisplacementScale > 0.0 && thickness > 0.0 && !underwater && sunUp > 0.0) {
        vec3 hit = worldPos + refrDir * opticalDistance;
        float depthBelow = max(uSeaLevel - hit.y, 0.0);
        vec3 sunRay = waterCausticSunRay(uSunDir);
        float lightPath = depthBelow / max(-sunRay.y, 0.1);
        vec2 entry = hit.xz - sunRay.xz * lightPath;
        float focus = waterCausticFocus(entry, depthBelow, uCausticsParams.y,
            uSunDir, causticPixelMetres);
        float facing = max(dot(receiverNormal, -sunRay), 0.0);
        float direct = dot(sunE, vec3(0.2126, 0.7152, 0.0722)) * facing;
        float diffuseSky = dot(ambientUp, vec3(0.2126, 0.7152, 0.0722)) * 3.14159265;
        float directFraction = direct / max(direct + diffuseSky, 1e-5);
        float fade = exp(-depthBelow * uCausticsParams.z) * smoothstep(0.02, 0.35, sunUp) * detail;
        float amount = uCausticsParams.x * min(uDisplacementScale, 1.0) * fade * directFraction;
        sceneColor *= max(vec3(0.0), vec3(1.0) + (focus - 1.0) * amount * exp(-uExtinction * lightPath));
    }

    // ---- subsurface scattering through crests (Atlas / Sea of Thieves style) ----
    float waveHeight = max(worldPos.y - uSeaLevel, 0.0);
    vec3 Ls = normalize(-uSunDir + Nup * uSSSParams.w);
    float sssView = pow(clamp(dot(V, Ls), 0.0, 1.0), uSSSParams.y);
    float sssHeight = clamp(waveHeight * uSSSParams.z, 0.0, 1.0);
    vec3 sss = uSSSColor * (sunE * sssView * sssHeight * uSSSParams.x * sunUp + ambientUp * sssHeight * uSSSParams.x * 0.25);

    vec3 scatterRadiance = uScatterColor * uScatterStrength * (ambientUp + sunE * sunUp * 0.3183) + sss;
    vec3 T = exp(-uExtinction * opticalDistance);
    vec3 refracted = sceneColor * T + scatterRadiance * (1.0 - T);

    vec3 windowRay = refract(-V, N, IOR_WATER_AIR);
    float sunWindowCos = dot(windowRay / max(length(windowRay), 1e-5), uSunDir);
    float sunWindowEdge = max(fwidth(sunWindowCos), 1e-6);
    vec3 color;
    if (underwater) {
        // ---- looking up from below: Snell's window, total internal reflection outside it ----
        vec3 up = refract(-V, N, IOR_WATER_AIR);
        float tir = dot(up, up) < 1e-5 ? 1.0 : 0.0;
        vec3 skyThroughSurface = vec3(0.0);
        if (tir < 0.5) {
            skyThroughSurface = sampleEnv(up, roughness) * uSurfaceParams.z;
            // sun disc seen through the window
            float sunCos = sunWindowCos;
            float radius = max(uSunRadius, 1e-4);
            float edge = sunWindowEdge;
            float disc = smoothstep(cos(radius) - edge, cos(radius) + edge, sunCos);
            skyThroughSurface += sunE * disc / max(3.14159265 * radius * radius, 1e-6);
        }
        // the water below the surface, mirrored back down when past the critical angle
        vec3 mirrored = scatterRadiance;
        // Exact dielectric Fresnel approaches one smoothly at the critical angle.
        float cosT = sqrt(max(1.0 - IOR_WATER_AIR * IOR_WATER_AIR * (1.0 - NdotV * NdotV), 0.0));
        float rs = (IOR_WATER_AIR * NdotV - cosT) / max(IOR_WATER_AIR * NdotV + cosT, 1e-5);
        float rp = (NdotV - IOR_WATER_AIR * cosT) / max(NdotV + IOR_WATER_AIR * cosT, 1e-5);
        float fUp = mix(0.5 * (rs * rs + rp * rp), 1.0, tir);
        color = mix(skyThroughSurface, mirrored, fUp);
    } else {
        vec3 R = reflect(-V, N);
        vec3 envRefl = sampleEnv(R, roughness) * uSurfaceParams.z;
        // only worth tracing when the ray stays low enough to plausibly meet geometry
        if (uSSRParams.x > 0.0 && roughness < 0.3 && R.y < 0.4) {
            float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453 + uTime);
            float mask;
            vec3 ssr = traceSSR(worldPos, R, roughness, dither, mask);
            mask *= uSSRParams.x * (1.0 - smoothstep(0.15, 0.35, roughness));
            envRefl = mix(envRefl, ssr, clamp(mask, 0.0, 1.0));
        }
        float spec = ggxSpecular(N, V, uSunDir, roughness) * uSurfaceParams.w;
        vec3 H = (V + uSunDir) / max(length(V + uSunDir), 1e-5);
        float FH = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
        vec3 sunSpec = sunE * spec * FH;
        color = refracted * (1.0 - fresnel) + envRefl * fresnel + sunSpec;
    }

    // ---- foam: whitecaps where the surface is folding, plus a shoreline band ----
    vec2 foamUv = vSampleXZ * uFoamParams.z;
    // two scales drifting apart, so the bubble field never reads as a repeating tile
    vec4 fa = texture(uFoamTex, foamUv + vec2(uTime * 0.011, uTime * 0.006));
    vec4 fb = texture(uFoamTex, foamUv * 2.83 - vec2(uTime * 0.019, uTime * -0.013));
    float clumps = fa.r * 0.62 + fb.r * 0.38;
    float bubbles = fa.g * 0.5 + fb.g * 0.5;
    float lace = clamp(clumps * mix(0.72, 1.28, fa.b) + bubbles * 0.22, 0.0, 1.0);

    // ---- ship wake: fold the surface locally (the same signal a breaking crest lowers), inside
    // a Kelvin-style V trailing the stern, so the wake rides the whitecap system below — its
    // bubble texture, distance fade and aerated lighting — instead of a separate painted mask.
    // Computed analytically from the ship's live position/heading each frame rather than
    // accumulated into a texture (a render-target trail was tried for mouse ripples and
    // corrupted every frame's render on WebGPU — see src/lib/VENDORED.md).
    if (uWakeParams.x > 0.0) {
        vec2 wakeRel = vSampleXZ - uWakeShip.xy;
        vec2 wakeDir = uWakeShip.zw;
        vec2 wakePerp = vec2(-wakeDir.y, wakeDir.x);
        float along = -dot(wakeRel, wakeDir);      // metres behind the ship (0 at the stern)
        if (along > 0.0 && along < uWakeParams.x) {
            float halfW = uWakeParams.y + along * uWakeParams.z;
            // warp the edge with the same bubble noise the whitecaps use, so it churns instead
            // of reading as a smooth rendered V
            float lateral = dot(wakeRel, wakePerp) + (fa.b - 0.5) * halfW * 0.6;
            float d = abs(lateral) / max(halfW, 1e-3);
            // calmer turbulent water right behind the hull, plus the two divergent arms
            float centerFold = (1.0 - smoothstep(0.0, 0.6, d)) * (1.0 - smoothstep(0.0, uWakeParams.x * 0.4, along));
            float armFold = smoothstep(0.5, 0.7, d) * (1.0 - smoothstep(0.7, 1.1, d));
            float tailFade = 1.0 - smoothstep(uWakeParams.x * 0.7, uWakeParams.x, along);
            jac -= clamp(centerFold * 0.5 + armFold, 0.0, 1.0) * tailFade * uWakeParams.w;
        }
    }

    float foamMask = clamp((uFoamParams.x - jac) * uFoamParams.y, 0.0, 1.0);
    float whitecap = foamMask * smoothstep(1.0 - foamMask * 1.15, max(1.0 - foamMask * 0.22, 1.001 - foamMask * 1.15), lace);
    whitecap *= mix(0.72, 1.0, bubbles);
    // Past a couple of kilometres a whitecap is smaller than a pixel. The mip-averaged texture put
    // through the threshold above still reports ~40% coverage there, and foam lit by a dull sky is
    // darker than the horizon glow behind it — which is what paints a dark band along the horizon
    // on a stormy sea. So the resolved coverage is faded with distance instead.
    whitecap *= 1.0 - 0.75 * smoothstep(700.0, 2600.0, dist);

    float shore = (1.0 - smoothstep(0.02, 0.55, contactDistance)) * contactNearby;
    float shoreBands = 0.5 + 0.5 * sin(contactDistance * 9.0 - uTime * 1.3 + fa.b * 5.0);
    float shoreFoam = shore * shore * clamp((lace * 0.9 + shoreBands * 0.5 + shore * 0.6 - 0.78) * 3.2, 0.0, 1.0);

    // ---- surf: bands of broken water riding the shoaling swell in towards the beach ----
    float surfFoam = 0.0;
    if (uShoreParams2.w > 0.5) {
        float depth = vShore.x;
        vec4 sh = texture(uShoreMap, clamp((vSampleXZ - uShoreArea.xy) * uShoreArea.zw, 0.0, 1.0));
        vec2 offshore = sh.yz * 2.0 - 1.0;

        // Depth is the phase variable, so a crest is a line of constant depth: parallel to the shore
        // wherever the shore happens to run, and bending around a headland the way refraction does.
        float phase = depth / max(uShoreParams.y, 0.05) + uTime * uShoreParams.z;
        // break the bands up so they are not perfectly regular
        phase += (fa.b - 0.5) * 0.35 + dot(vSampleXZ, offshore) * 0.004;
        float band = 0.5 - 0.5 * cos(phase * 6.28318530718);

        // waves break where the water gets too shallow to hold them, and the foam lingers after
        float breaking = 1.0 - smoothstep(uShoreParams.w * 0.3, uShoreParams.w * 1.4, depth);
        float crest = pow(band, 3.0);
        float surf = crest * breaking;

        // swash: the sheet of foam left on the sand, always there, thickest at the waterline
        // swash: a lace a metre or two wide that runs up the sand and drains back, not a sheet
        float swashPulse = 0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * 0.9 + fa.b * 6.0 + depth * 4.0));
        float swash = uShoreParams2.y * (1.0 - smoothstep(0.0, uShoreParams.w * 0.2, depth)) * swashPulse;

        surfFoam = clamp((surf + swash) * lace * 1.15 * uShoreParams2.x, 0.0, 1.0);
        surfFoam *= vShore.y;
    }

    float foam = clamp((whitecap + shoreFoam + surfFoam) * uFoamStrength, 0.0, 1.0);
    if (underwater) foam *= 0.25;

    // the water immediately around a foam patch is aerated: lighter, and less transparent
    float aerate = clamp((fa.a * 0.7 + fb.a * 0.3) * foamMask * uFoamStrength - 0.25, 0.0, 1.0) * 0.22;
    float NdotL = max(dot(Nup, uSunDir), 0.0);
    vec3 foamLit = uFoamColor * (ambientUp + sunE * (NdotL * 0.85 + 0.15) * 0.3183);
    // wet foam has a sheen: at grazing angles it mirrors the sky like the water around it
    if (!underwater) foamLit = mix(foamLit, sampleEnv(reflect(-V, Nup), 0.35), fresnel * 0.55);
    color = mix(color, foamLit * 0.55, aerate * (1.0 - foam));
    color = mix(color, foamLit, foam);

    if (!underwater) {
        // Exponential atmospheric extinction, plus a separate coverage fade at the finite
        // mesh boundary. Sampling the actual horizon removes the old fixed-elevation stripe.
        vec3 apDir = normalize(vec3(camToPos.x, max(camToPos.y, 0.0), camToPos.z));
        vec3 horizonSky = sampleAerial(apDir);
        float coverage = 1.0 - smoothstep(uWaterRadius * 0.72, uWaterRadius * 0.98, dist);
        color = mix(horizonSky, color, exp(-uFogDensity * dist) * coverage);
    } else {
        // seen through the water body: absorb along the view ray
        color = mix(scatterRadiance, color, exp(-uExtinction * dist));
    }
    // The surface dissolves where the water runs out of depth, so the shoreline is a wet gradient
    // rather than a cut; the foam lying in the swash stays.
    float alpha = 1.0;
    if (!underwater) alpha = clamp(smoothstep(0.0, 0.08, mix(1.0, contactDistance, contactNearby)) + foam * 0.7, 0.0, 1.0);
    // Keep HDR output representable in half-float targets, independently of the camera grade.
    gl_FragColor = vec4(gammaCorrectOutput(toneMap(clamp(color, 0.0, 60000.0))), alpha);
}
`;
