import { CAUSTICS_GLSL, CAUSTICS_WGSL } from './shaders/caustics.js';

const attached = new WeakSet();

/** Short-wave curvature dominates shallow caustics. Bind the two finest live FFT bands,
 * leaving a StandardMaterial enough samplers for its own PBR maps and cascaded shadows. */
export function bindCausticWaves(material, simulation, config) {
    const scales = [];
    for (let i = 0; i < 2; i++) {
        const j = Math.max(0, simulation.lengthScales.length - 2 + i);
        material.setParameter(`uCaustWave${i}`, simulation.derivativeTextures[j]);
        scales.push(1 / simulation.lengthScales[j]);
    }
    material.setParameter('uCaustWaveScales', scales);
    material.setParameter('uCaustWaveSettings', [config.waves.amplitude, config.waves.choppiness, simulation.params.size]);
}

const FOG_GLSL = /* glsl */`
uniform vec3 fog_color;
#if FOG == LINEAR
uniform float fog_start;
uniform float fog_end;
#else
uniform float fog_density;
#endif
uniform vec3 uReceiverExtinction;
uniform vec3 uReceiverScatter;
uniform vec3 uReceiverSun;
uniform vec3 uReceiverSunColor;
uniform vec4 uReceiverParams; // sea level, caustic strength, footprint scale, exposure
uniform sampler2D uReceiverSky;
float dBlendModeFogFactor = 1.0;
${CAUSTICS_GLSL}
vec3 addFog(vec3 color) {
    float distanceMetres = distance(view_position, vPositionW);
    if (view_position.y >= uReceiverParams.x) {
        #if FOG == NONE
            return color;
        #elif FOG == LINEAR
            float transmittance = clamp((fog_end - distanceMetres) / max(fog_end - fog_start, 0.001), 0.0, 1.0);
        #elif FOG == EXP
            float transmittance = exp(-distanceMetres * fog_density);
        #else
            float transmittance = exp(-pow(distanceMetres * fog_density, 2.0));
        #endif
        #if FOG != NONE
        return mix(fog_color * dBlendModeFogFactor, color, transmittance);
        #endif
    }
    float depth = max(uReceiverParams.x - vPositionW.y, 0.0);
    float pixelMetres = max(length(dFdx(vPositionW.xz)), length(dFdy(vPositionW.xz)));
    vec3 sunRay = waterCausticSunRay(uReceiverSun);
    float sunPath = depth / max(-sunRay.y, 0.2);
    vec3 ambient = textureLod(uReceiverSky, vec2(0.5, 0.1), 0.0).rgb * uReceiverParams.w;
    float sunUp = max(uReceiverSun.y, 0.0);
    if (uReceiverParams.y > 0.0 && depth > 0.0 && sunUp > 0.0) {
        vec2 entry = vPositionW.xz - sunRay.xz * sunPath;
        float focus = waterCausticFocus(entry, depth, uReceiverParams.z, uReceiverSun, pixelMetres);
        float direct = dot(uReceiverSunColor, vec3(0.2126, 0.7152, 0.0722)) * sunUp;
        float fraction = direct / max(direct + dot(ambient, vec3(0.2126, 0.7152, 0.0722)) * 3.14159, 0.001);
        color *= max(0.0, 1.0 + (focus - 1.0) * uReceiverParams.y * fraction);
    }
    // Light loses red on its way to the floor as well as on its way back to the viewer.
    color *= exp(-uReceiverExtinction * sunPath);
    float cameraDepth = max(uReceiverParams.x - view_position.y, 0.0);
    if (vPositionW.y > uReceiverParams.x) distanceMetres *= cameraDepth / max(vPositionW.y - view_position.y, 0.001);
    vec3 scatter = uReceiverScatter * (ambient + uReceiverSunColor * sunUp * 0.3183)
        * exp(-uReceiverExtinction * cameraDepth);
    vec3 transmittance = exp(-uReceiverExtinction * distanceMetres);
    return color * transmittance + scatter * (vec3(1.0) - transmittance);
}
`;

const FOG_WGSL = /* wgsl */`
uniform fog_color: vec3f;
#if FOG == LINEAR
uniform fog_start: f32;
uniform fog_end: f32;
#else
uniform fog_density: f32;
#endif
uniform uReceiverExtinction: vec3f;
uniform uReceiverScatter: vec3f;
uniform uReceiverSun: vec3f;
uniform uReceiverSunColor: vec3f;
uniform uReceiverParams: vec4f;
var uReceiverSky: texture_2d<f32>;
var uReceiverSkySampler: sampler;
var<private> dBlendModeFogFactor: f32 = 1.0;
${CAUSTICS_WGSL}
fn addFog(source: vec3f) -> vec3f {
    var color = source;
    var distanceMetres = distance(uniform.view_position, vPositionW);
    if (uniform.view_position.y >= uniform.uReceiverParams.x) {
        #if FOG == NONE
            return color;
        #elif FOG == LINEAR
            let transmittance = clamp((uniform.fog_end - distanceMetres) / max(uniform.fog_end - uniform.fog_start, 0.001), 0.0, 1.0);
        #elif FOG == EXP
            let transmittance = exp(-distanceMetres * uniform.fog_density);
        #else
            let transmittance = exp(-pow(distanceMetres * uniform.fog_density, 2.0));
        #endif
        #if FOG != NONE
        return mix(uniform.fog_color * dBlendModeFogFactor, color, transmittance);
        #endif
    }
    let depth = max(uniform.uReceiverParams.x - vPositionW.y, 0.0);
    let pixelMetres = max(length(dpdx(vPositionW.xz)), length(dpdy(vPositionW.xz)));
    let sunRay = waterCausticSunRay(uniform.uReceiverSun);
    let sunPath = depth / max(-sunRay.y, 0.2);
    let ambient = textureSampleLevel(uReceiverSky, uReceiverSkySampler, vec2f(0.5, 0.1), 0.0).rgb * uniform.uReceiverParams.w;
    let sunUp = max(uniform.uReceiverSun.y, 0.0);
    if (uniform.uReceiverParams.y > 0.0 && depth > 0.0 && sunUp > 0.0) {
        let entry = vPositionW.xz - sunRay.xz * sunPath;
        let focus = waterCausticFocus(entry, depth, uniform.uReceiverParams.z, uniform.uReceiverSun, pixelMetres);
        let direct = dot(uniform.uReceiverSunColor, vec3f(0.2126, 0.7152, 0.0722)) * sunUp;
        let fraction = direct / max(direct + dot(ambient, vec3f(0.2126, 0.7152, 0.0722)) * 3.14159, 0.001);
        color *= max(0.0, 1.0 + (focus - 1.0) * uniform.uReceiverParams.y * fraction);
    }
    color *= exp(-uniform.uReceiverExtinction * sunPath);
    let cameraDepth = max(uniform.uReceiverParams.x - uniform.view_position.y, 0.0);
    if (vPositionW.y > uniform.uReceiverParams.x) { distanceMetres *= cameraDepth / max(vPositionW.y - uniform.view_position.y, 0.001); }
    let scatter = uniform.uReceiverScatter * (ambient + uniform.uReceiverSunColor * sunUp * 0.3183)
        * exp(-uniform.uReceiverExtinction * cameraDepth);
    let transmittance = exp(-uniform.uReceiverExtinction * distanceMetres);
    return color * transmittance + scatter * (vec3f(1.0) - transmittance);
}
`;

export function attachReceiver(material) {
    if (attached.has(material)) throw new Error('Material already belongs to another water receiver');
    attached.add(material);
    const { glsl, wgsl } = material.shaderChunks;
    const previous = [glsl.get('fogPS'), wgsl.get('fogPS')];
    glsl.set('fogPS', FOG_GLSL);
    wgsl.set('fogPS', FOG_WGSL);
    material.update();
    return () => {
        attached.delete(material);
        for (const [i, chunks] of [glsl, wgsl].entries()) {
            if (previous[i] === undefined) chunks.delete('fogPS');
            else chunks.set('fogPS', previous[i]);
        }
        for (const name of ['uCaustWave0', 'uCaustWave1', 'uCaustWaveScales', 'uCaustWaveSettings', 'uReceiverExtinction', 'uReceiverScatter', 'uReceiverSun', 'uReceiverSunColor', 'uReceiverParams', 'uReceiverSky']) material.deleteParameter(name);
        material.update();
    };
}
