import {
    ShaderMaterial, StandardMaterial, MeshInstance, Entity, Vec3, Color,
    SEMANTIC_POSITION, BLEND_NORMAL, CULLFACE_NONE, LAYERID_WORLD
} from 'playcanvas';

import { attachReceiver, bindCausticWaves } from './receiver.js';
import { WaveSimulation } from './WaveSimulation.js';
import { createWaterMesh } from './WaterMesh.js';
import { WaveProbe } from './WaveProbe.js';
import { createFoamTexture } from './foamTexture.js';
import { createDeepWaterMap, validateShoreMap } from './shoreMap.js';
import { WATER_VS, WATER_FS } from './shaders/waterSurface.glsl.js';
import { WATER_VS_WGSL, WATER_FS_WGSL } from './shaders/waterSurface.wgsl.js';

import { resolveWaterConfig, configEqual } from './config.js';
export { WATER_DEFAULTS } from './config.js';
/** @typedef {import('./config.js').WaterConfig} WaterConfig */

// Implementation choices are deliberately not a second public configuration surface.
const QUALITY_TIERS = {
    low: { resolution: 128, sectors: 128, rings: 192, reflectionSteps: 12 },
    medium: { resolution: 256, sectors: 256, rings: 320, reflectionSteps: 18 },
    high: { resolution: 512, sectors: 384, rings: 420, reflectionSteps: 28 }
};
const CASCADE_LENGTHS = [1024, 256, 48, 8];
const CASCADE_FADE_START = 12;
const CASCADE_FADE_END = 30;
const SURFACE_RADIUS = 20000;
const SOLAR_ANGULAR_RADIUS = 0.00465;
const EARTH_GRAVITY = 9.81;
const DEEP_WATER_DEPTH = 500;
const FOAM_CASCADE_WEIGHTS = [1, 1, 0.4, 0.1];
const FOAM_COLOR = [0.92, 0.96, 1];
const CREST_SCATTER_COLOR = [0.06, 0.55, 0.45];
const CREST_SCATTER_PARAMS = [0.35, 6, 0.6, 0.35]; // strength, angular exponent, height, normal bias
const REFRACTION_PARAMS = [0.7, 0.12, 4, 0]; // offset, distance blur, offset depth limit
const FOAM_SURFACE_PARAMS = [0.68, 3, 0.07, 1]; // Jacobian threshold, edge, frequency, contact depth
const SHORE_RESPONSE = [1, 0.4, 0.6]; // surf, swash, shoaling
const CAUSTIC_DEPTH_FADE = 0.09;

/**
 * A configurable, physically-based water surface.
 *
 * A cascaded FFT wave simulation (WebGPU compute, with a WebGL2 fragment fallback) drives a
 * camera-following polar mesh. Everything about the look and the sea state lives in one config
 * object which can be patched at any time with {@link Water#set}.
 *
 * ```js
 * const water = new Water(app, { wind: { speed: 14 } });
 * app.on('update', dt => water.update(dt, camera));
 * water.set({ volume: { visibility: 20 } });
 * const y = water.getHeightAt(x, z);   // for buoyancy
 * ```
 */
export class Water {
    /**
     * @param {import('playcanvas').AppBase} app - The application.
     * @param {Partial<WaterConfig>} [config] - Partial configuration; anything omitted uses the default.
     */
    constructor(app, config = {}) {
        this._app = app;
        this._device = app.graphicsDevice;

        this._config = resolveWaterConfig(config);
        this._time = 0;
        this._sunDirection = new Vec3(0, 1, 0);
        this._sunColor = new Color(1, 1, 1);
        this._hazeDensity = 0;
        this._destroyed = false;
        this._cascadeData = new Float32Array(16);
        this._envAtlas = null;
        this._skyRadiance = null;
        this._environmentExposure = 1;
        this._rebuildSim = false;
        this._rebuildMesh = false;

        this._simulation = new WaveSimulation(this._device, this._simParams());

        this._material = new ShaderMaterial({
            uniqueName: 'WaterSurface',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexGLSL: WATER_VS,
            fragmentGLSL: WATER_FS,
            vertexWGSL: WATER_VS_WGSL,
            fragmentWGSL: WATER_FS_WGSL
        });
        // rendered in the transparent pass so the scene colour / depth grab includes everything below
        this._material.blendType = BLEND_NORMAL;
        this._material.depthWrite = true;
        this._material.cull = CULLFACE_NONE;
        this._material.setDefine('{ENV_DECODE}', 'decodeRGBP');

        this._foamTexture = createFoamTexture(this._device);
        this._material.setParameter('uFoamTex', this._foamTexture);

        this._deepWaterMap = createDeepWaterMap(this._device);
        /** @type {import('./shoreMap.js').ShoreMap|null} */
        this._shoreMap = null;
        this._material.setParameter('uShoreMap', this._deepWaterMap);
        this._material.setParameter('uShoreArea', [0, 0, 1, 1]);

        // length = 0 draws nothing; see setWake() below.
        this._material.setParameter('uWakeShip', [0, 0, 1, 0]);
        this._material.setParameter('uWakeParams', [0, 4, 0.35, 1]);

        this._mesh = createWaterMesh(this._device, this._meshParams());
        this._builtMeshParams = this._meshParams();
        this._meshInstance = new MeshInstance(this._mesh, this._material);
        this._meshInstance.cull = false;
        this._meshInstance.castShadow = false;
        this._meshInstance.receiveShadow = false;

        this._entity = new Entity('Water');
        this._entity.addComponent('render', {
            meshInstances: [this._meshInstance], layers: [LAYERID_WORLD], castShadows: false
        });
        app.root.addChild(this._entity);

        this._probe = new WaveProbe(this);
    }

    /** Whether the wave simulation is running on WebGPU compute shaders. */
    get usesCompute() { return this._simulation.useCompute; }

    /** @type {WaterConfig} Immutable snapshot. Use set() or reset() to change it. */
    get config() { return this._config; }

    /** Elapsed simulation seconds, including timeScale and the simulation's delta clamp. */
    get time() { return this._time; }

    /** Copy of the light direction supplied to setEnvironment(). */
    get sunDirection() { return this._sunDirection.clone(); }

    /** Copy of the linear irradiance supplied to setEnvironment(). */
    get sunColor() { return this._sunColor.clone(); }

    /** Surface Y of the undisturbed water plane. */
    get seaLevel() { return this.config.seaLevel; }

    /**
     * Patch the configuration. Only the fields present in the patch change, and the minimum amount
     * of GPU work is redone. FFT layout and tessellation changes rebuild on the next update();
     * only changes to wind, swell or seed regenerate the initial spectrum.
     * Invalid patches throw before any state changes. Arrays are replaced in full.
     *
     * @param {Partial<WaterConfig>} patch - The fields to change.
     */
    set(patch) {
        this._assertAlive();
        return this._setConfig(resolveWaterConfig(patch, this.config));
    }

    /** Replace all settings with defaults plus config. Assigned environment and shore map remain. */
    reset(config = {}) {
        this._assertAlive();
        return this._setConfig(resolveWaterConfig(config));
    }

    _setConfig(next) {
        if (this._shoreMap && next.seaLevel !== this._shoreMap.seaLevel) {
            throw new RangeError('Water: detach the shore map before changing seaLevel, then bake and attach a map at the new level');
        }
        const before = this.config;
        if (configEqual(before, next)) return this;
        this._config = next;
        const params = this._simParams();
        const current = this._simulation.params;
        this._rebuildSim = ['size', 'lengthScales', 'cascadeOverlap'].some(key => !configEqual(current[key], params[key]));
        if (!this._rebuildSim) {
            const spectrumChanged = ['wind', 'swell', 'depth', 'gravity', 'seed'].some(key => !configEqual(current[key], params[key]));
            Object.assign(current, params);
            if (spectrumChanged) this._simulation.invalidateSpectrum();
        }
        this._rebuildMesh = !configEqual(this._builtMeshParams, this._meshParams());
        if (['seaLevel', 'waves', 'wind', 'swell', 'seed'].some(key => !configEqual(before[key], next[key]))) this._probe.rebuild();
        return this;
    }

    _assertAlive() {
        if (this._destroyed) throw new Error('Water: this instance has been destroyed');
    }

    /** Apply any deferred resource rebuild. Called at the top of {@link Water#update}. */
    _applyPendingRebuilds() {
        if (this._rebuildSim) {
            this._simulation.rebuild(this._simParams());
            this._probe.rebuild();
            this._rebuildSim = false;
        }
        if (this._rebuildMesh) {
            const old = this._mesh;
            this._mesh = createWaterMesh(this._device, this._meshParams());
            this._meshInstance.mesh = this._mesh;
            this._builtMeshParams = this._meshParams();
            this._rebuildMesh = false;
            old.destroy();
        }
    }

    /** Translate the public config into the flat parameter block the simulation expects. */
    _simParams() {
        const cfg = this.config;
        const q = QUALITY_TIERS[cfg.quality];
        const speed = cfg.wind.speed;
        return {
            size: q.resolution,
            lengthScales: CASCADE_LENGTHS.slice(),
            cascadeOverlap: 6,
            depth: DEEP_WATER_DEPTH,
            gravity: EARTH_GRAVITY,
            seed: cfg.seed,
            choppiness: cfg.waves.choppiness,
            foamDecay: 0.8,
            timeScale: cfg.timeScale,
            wind: {
                scale: speed === 0 ? 0 : 1, windSpeed: Math.max(speed, 0.1), windDirection: cfg.wind.direction,
                fetch: Math.max(10000, Math.min(1000000, 120000 * (speed / 9) ** 2)),
                spreadBlend: 0.9, swell: 0.25, peakEnhancement: 3.3, shortWavesFade: 0.0075
            },
            swell: {
                scale: cfg.swell.strength, windSpeed: 6, windDirection: cfg.swell.direction,
                fetch: 800000, spreadBlend: 1, swell: 1, peakEnhancement: 3.3, shortWavesFade: 0.05
            }
        };
    }

    _meshParams() {
        const q = QUALITY_TIERS[this.config.quality];
        return { sectors: q.sectors, rings: q.rings, outerRadius: SURFACE_RADIUS };
    }

    /**
     * Give the water a coast to break on.
     *
     * Pass a map baked by {@link import('./shoreMap.js').bakeShoreMap} and the shore model turns on:
     * the swell shoals and rears as the bed rises, breaks into shore-parallel bands of surf, and
     * leaves foam washing on the sand. Pass null to go back to open ocean. The map remains owned
     * by the caller: detach it before calling map.destroy(). It must be baked at this sea level.
     *
     * @param {import('./shoreMap.js').ShoreMap|null} map - The baked coast, or null.
     */
    setShoreMap(map) {
        this._assertAlive();
        if (map !== null) validateShoreMap(map, this.seaLevel);
        this._shoreMap = map;
        this._material.setParameter('uShoreMap', map ? map.texture : this._deepWaterMap);
        this._material.setParameter('uShoreArea', map
            ? [map.origin[0], map.origin[1], 1 / map.size[0], 1 / map.size[1]]
            : [0, 0, 1, 1]);
        return this;
    }

    /**
     * Fast path for continuously driving wave amplitude (e.g. from live pointer input) without
     * the buoyancy-probe reset that set() triggers on any 'waves' change — WaveProbe already
     * re-reads amplitude every frame on its own (see its uDisplacementScale push in update()), so
     * that reset is never needed here and would otherwise snap floating objects to sea level on
     * every call. Added for the mouse-driven amplitude interaction — not part of the original
     * marklundin/water lib.
     *
     * @param {number} value - New waves.amplitude, validated against the same range as set().
     */
    setAmplitude(value) {
        this._assertAlive();
        this._config = resolveWaterConfig({ waves: { amplitude: value } }, this._config);
    }

    /**
     * Drive a ship's wake foam trail directly, bypassing set() — same fast path as
     * setAmplitude(), a plain material parameter push with no config diff or rebuild. The wake
     * is computed analytically in the surface shader from these five numbers each frame (no
     * render target, see src/lib/VENDORED.md for why that was ruled out). Added for the LNG
     * carrier's cruise wake — not part of the original marklundin/water lib.
     *
     * @param {object} wake
     * @param {number} wake.x - World X the wake trails from (typically the ship's stern).
     * @param {number} wake.z - World Z of the same point.
     * @param {number} wake.dirX - X of the ship's forward heading, unit length.
     * @param {number} wake.dirZ - Z of the ship's forward heading, unit length.
     * @param {number} wake.length - Metres of wake behind that point. 0 hides it entirely.
     * @param {number} [wake.halfWidth] - Half-width of the wake at its origin, in metres.
     * @param {number} [wake.spread] - tan() of the half-angle the wake widens by per metre of length.
     * @param {number} [wake.strength] - Overall intensity multiplier.
     */
    setWake({ x, z, dirX, dirZ, length, halfWidth = 4, spread = 0.35, strength = 1 }) {
        this._assertAlive();
        this._material.setParameter('uWakeShip', [x, z, dirX, dirZ]);
        this._material.setParameter('uWakeParams', [Math.max(length, 0), halfWidth, spread, strength]);
    }

    /**
     * Assign the environment the surface reflects and the sun it is lit by.
     *
     * @param {object} environment - Caller-owned illumination resources, independent of any sky library.
     * @param {import('playcanvas').Texture} environment.atlas - Prefiltered PlayCanvas RGBP atlas.
     * @param {Vec3} environment.sunDirection - Direction towards the sun.
     * @param {Color} environment.sunColor - Linear solar irradiance, already including exposure.
     * @param {import('playcanvas').Texture} [environment.radiance] - Linear, sun-free equirectangular sky.
     * @param {number} [environment.exposure=1] - Scale for atlas and equirectangular radiance.
     * @param {number} [environment.hazeDensity=0] - Aerial extinction in inverse metres.
     */
    setEnvironment(environment) {
        this._assertAlive();
        if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('Water: environment must be an object');
        const allowed = ['atlas', 'radiance', 'sunDirection', 'sunColor', 'exposure', 'hazeDensity'];
        for (const key of Object.keys(environment)) if (!allowed.includes(key)) throw new TypeError(`Water: unknown environment field "${key}"`);
        const { atlas, radiance = null, sunDirection, sunColor, exposure = 1, hazeDensity = 0 } = environment;
        if (!atlas || typeof atlas !== 'object') throw new TypeError('Water: atlas must be a prefiltered texture');
        if (radiance !== null && typeof radiance !== 'object') throw new TypeError('Water: radiance must be a linear equirectangular texture');
        if (![exposure, hazeDensity].every(v => Number.isFinite(v) && v >= 0)) throw new RangeError('Water: exposure and hazeDensity must be finite and non-negative');
        if (!sunDirection || ![sunDirection.x, sunDirection.y, sunDirection.z].every(Number.isFinite) ||
            Math.hypot(sunDirection.x, sunDirection.y, sunDirection.z) === 0) {
            throw new TypeError('Water: sunDirection must be a finite non-zero vector');
        }
        if (!sunColor || ![sunColor.r, sunColor.g, sunColor.b].every(v => Number.isFinite(v) && v >= 0)) {
            throw new TypeError('Water: sunColor must contain finite non-negative linear RGB values');
        }
        this._envAtlas = atlas;
        this._skyRadiance = radiance;
        this._environmentExposure = exposure;
        this._hazeDensity = hazeDensity;
        this._material.setParameter('texture_envAtlas', atlas);
        this._material.setParameter('uSkyRadiance', radiance || atlas);
        this._material.setParameter('uHasSkyRadiance', radiance ? 1 : 0);
        this._material.setParameter('uEnvironmentExposure', exposure);
        this._sunDirection.copy(sunDirection).normalize();
        this._sunColor.copy(sunColor);
        return this;
    }

    /**
     * The surface height at a world XZ position, in metres. Backed by an asynchronous GPU readback,
     * updated at most once every three frames. New queries return seaLevel until the first readback.
     * Suitable for approximate buoyancy, not exact collision. Queries evaluate the FFT field and do
     * not include the visual shoreline deformation or distance filtering applied to the mesh.
     *
     * @param {number} x - World X.
     * @param {number} z - World Z.
     * @returns {number} World Y of the surface.
     */
    getHeightAt(x, z) {
        return this.getSurfaceAt(x, z).position.y;
    }

    /**
     * Full surface state at a world XZ position: the displaced point and its normal. Use this to
     * float and tilt an object convincingly. See {@link Water#getHeightAt} for the latency caveat.
     *
     * @param {number} x - World X.
     * @param {number} z - World Z.
     * @returns {{position: Vec3, normal: Vec3}} Borrowed query result updated in place; clone to retain.
     */
    getSurfaceAt(x, z) {
        this._assertAlive();
        if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('Water: query coordinates must be finite numbers');
        return this._probe.sample(x, z);
    }

    /**
     * Whether a world position is below the water surface, accounting for the waves.
     *
     * @param {Vec3} position - World position to test.
     * @returns {boolean} True when submerged.
     */
    isSubmerged(position) {
        return position.y < this.getHeightAt(position.x, position.z);
    }

    /** Opt an opaque StandardMaterial into underwater attenuation and wave caustics.
     * Returns a detach function. Material and texture ownership remain with the caller.
     * Its fog chunk is reserved while attached; call detach before destroying the material.
     */
    addReceiver(material) {
        this._assertAlive();
        if (!(material instanceof StandardMaterial)) {
            throw new TypeError('Water.addReceiver requires a StandardMaterial');
        }
        this._receivers ??= new Map();
        if (this._receivers.has(material)) return this._receivers.get(material);
        const restore = attachReceiver(material);
        const detach = () => {
            if (!this._receivers.delete(material)) return;
            restore();
        };
        this._receivers.set(material, detach);
        this._bindReceiver(material);
        return detach;
    }

    _bindReceiver(material) {
        const cfg = this.config, vol = cfg.volume, c = cfg.caustics;
        const sd = this._sunDirection, sc = this._sunColor;
        bindCausticWaves(material, this._simulation, cfg);
        material.setParameter('uReceiverExtinction', [3.2, 1, 0.6].map(e => e / vol.visibility));
        material.setParameter('uReceiverScatter', vol.color);
        material.setParameter('uReceiverSun', [sd.x, sd.y, sd.z]);
        material.setParameter('uReceiverSunColor', [sc.r, sc.g, sc.b]);
        material.setParameter('uReceiverParams', [cfg.seaLevel, c.enabled ? c.strength : 0, c.scale, this._skyRadiance ? this._environmentExposure : 0]);
        material.setParameter('uReceiverSky', this._skyRadiance || this._deepWaterMap);
    }

    /**
     * Step the simulation and push uniforms. Call once per frame from the app's `update` event,
     * before rendering.
     *
     * @param {number} dt - Frame delta time in seconds.
     * @param {import('playcanvas').Entity} cameraEntity - Camera the surface follows and fades against.
     */
    update(dt, cameraEntity) {
        this._assertAlive();
        if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Water: dt must be a finite non-negative number of seconds');
        if (!cameraEntity || typeof cameraEntity.getPosition !== 'function') throw new TypeError('Water: update requires a camera entity');
        this._applyPendingRebuilds();
        const cfg = this.config;
        const sim = this._simulation;
        sim.update(dt);
        this._time = sim.time;
        this._probe.update();

        // the surface disc follows the camera in XZ; the wave field is sampled in world space so the
        // tessellation just slides underneath it
        const cp = cameraEntity.getPosition();
        this._entity.setPosition(cp.x, 0, cp.z);

        const m = this._material;
        const disp = sim.displacementTextures;
        const deriv = sim.derivativeTextures;
        const scales = sim.lengthScales;
        const n = disp.length;
        for (let i = 0; i < 4; i++) {
            const j = Math.min(i, n - 1);
            m.setParameter(`uDisp${i}`, disp[j]);
            m.setParameter(`uDeriv${i}`, deriv[j]);
            const L = scales[j];
            this._cascadeData[i * 4 + 0] = L;
            this._cascadeData[i * 4 + 1] = L * CASCADE_FADE_START;
            this._cascadeData[i * 4 + 2] = L * CASCADE_FADE_END;
            this._cascadeData[i * 4 + 3] = 1 / L;
        }
        m.setParameter('uCascade[0]', this._cascadeData);   // WebGL names the array uniform 'uCascade[0]'
        m.setParameter('uCascade', this._cascadeData);      // WebGPU reflects it as 'uCascade'
        m.setParameter('uNumCascades', n);
        // vertex spacing of the polar grid as a fraction of radius: the larger of the radial and
        // angular steps. The vertex shader turns it into a mip level per cascade.
        const mp = this._meshParams();
        const growth = Math.log(mp.outerRadius / 0.5) / (mp.rings - 1);
        m.setParameter('uMeshLod', [Math.max(growth, 2 * Math.PI / mp.sectors), 0.5, this._simulation.params.size, 0]);
        m.setParameter('uWaterRadius', mp.outerRadius);
        m.setParameter('uLambda', cfg.waves.choppiness);
        m.setParameter('uDisplacementScale', cfg.waves.amplitude);
        m.setParameter('uSeaLevel', cfg.seaLevel);
        m.setParameter('uTime', this.time);

        const sd = this._sunDirection, sc = this._sunColor;
        m.setParameter('uSunDir', [sd.x, sd.y, sd.z]);
        m.setParameter('uSunColor', [sc.r, sc.g, sc.b]);
        m.setParameter('uSunRadius', SOLAR_ANGULAR_RADIUS);

        const vol = cfg.volume;
        m.setParameter('uExtinction', [3.2 / vol.visibility, 1 / vol.visibility, 0.6 / vol.visibility]);
        m.setParameter('uScatterColor', vol.color);
        m.setParameter('uScatterStrength', 1);
        m.setParameter('uSSSColor', CREST_SCATTER_COLOR);
        m.setParameter('uSSSParams', CREST_SCATTER_PARAMS);

        m.setParameter('uSurfaceParams', [cfg.roughness, 0.15, 1, 1]);
        m.setParameter('uRefractionParams', REFRACTION_PARAMS);
        m.setParameter('uSSRParams', [0.9, 220, QUALITY_TIERS[cfg.quality].reflectionSteps, 1.5]);

        bindCausticWaves(m, sim, cfg);
        const c = cfg.caustics;
        for (const receiver of this._receivers?.keys() ?? []) this._bindReceiver(receiver);
        m.setParameter('uCausticsParams', [c.enabled ? c.strength : 0, c.scale, CAUSTIC_DEPTH_FADE]);

        const active = this._shoreMap ? 1 : 0;
        m.setParameter('uShoreParams', [this._shoreMap ? this._shoreMap.maxDepth : 1, 5, 0.16, 2.4]);
        m.setParameter('uShoreParams2', [...SHORE_RESPONSE, active]);

        m.setParameter('uFoamParams', FOAM_SURFACE_PARAMS);
        m.setParameter('uFoamColor', FOAM_COLOR);
        m.setParameter('uFoamStrength', cfg.foam);
        m.setParameter('uFoamCascadeWeights', FOAM_CASCADE_WEIGHTS);
        m.setParameter('uFogDensity', this._hazeDensity);
        m.setParameter('uSkyRadiance', this._skyRadiance || this._envAtlas || this._deepWaterMap);
        m.setParameter('uHasSkyRadiance', this._skyRadiance ? 1 : 0);
        m.setParameter('uEnvironmentExposure', this._environmentExposure);
    }

    /** Release owned resources. Safe to call twice. Supplied environment and shore maps survive. */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const detach of [...(this._receivers?.values() ?? [])]) detach();
        this._probe.destroy();
        // RenderComponent destroys its mesh instances. Detach the mesh so its ownership stays here.
        this._meshInstance.mesh = null;
        this._entity.destroy();
        this._foamTexture.destroy();
        this._deepWaterMap.destroy();
        this._simulation.destroy();
        this._mesh.destroy();
        this._material.destroy();
        this._shoreMap = null;
        this._envAtlas = null;
        this._skyRadiance = null;
    }
}
