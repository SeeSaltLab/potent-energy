import {
    Texture, RenderTarget, ShaderUtils, drawQuadWithShader, EnvLighting,
    PIXELFORMAT_RGBA16F, FILTER_LINEAR, ADDRESS_CLAMP_TO_EDGE, ADDRESS_REPEAT,
    TEXTUREPROJECTION_EQUIRECT, SEMANTIC_POSITION, Vec3, Color
} from 'playcanvas';

import {
    ATMOS_VS, ATMOS_VS_WGSL,
    TRANSMITTANCE_FS, TRANSMITTANCE_FS_WGSL,
    MULTISCATTER_FS, MULTISCATTER_FS_WGSL,
    SKY_FS, SKY_FS_WGSL,
    sunTransmittanceCPU
} from './atmosphere.js';
import { DEFAULT_SKY_PARAMS, resolveSkyParams } from './params.js';

export { DEFAULT_SKY_PARAMS } from './params.js';

const SOLAR_IRRADIANCE = 18;
const AEROSOL_ASYMMETRY = 0.82;
const SUN_SOLID_ANGLE = Math.PI * Math.sin(0.00465) ** 2;

/**
 * Independent Earth atmosphere and environment lighting for PlayCanvas.
 *
 * The visible sky includes the sun. The environment excludes its disc because direct lighting
 * should supply solar illumination separately. Use getSunDirection()/getSunColor() for that light.
 * No camera, water surface, scene geometry, post processing, or directional light is created.
 *
 * GPU work runs in the next app frame, including the initial build. Assign onUpdate immediately
 * after construction to receive the first completed environment as well as subsequent changes.
 * Pass { attachToScene: false } as the third argument to manage scene assignment yourself.
 */
export class Sky {
    constructor(app, params = {}, { attachToScene = true } = {}) {
        this._params = resolveSkyParams(params);
        if (typeof attachToScene !== 'boolean') throw new TypeError('attachToScene must be a boolean.');
        this.app = app;
        this.device = app.graphicsDevice;
        this._attachToScene = attachToScene;
        this._destroyed = false;
        this._previousScene = null;
        this._appliedExposure = null;
        this._ready = false;
        const device = this.device;

        const mkEquirect = (name, w, h) => new Texture(device, {
            name, width: w, height: h, format: PIXELFORMAT_RGBA16F, mipmaps: false,
            minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
            addressU: ADDRESS_REPEAT, addressV: ADDRESS_CLAMP_TO_EDGE,
            projection: TEXTUREPROJECTION_EQUIRECT
        });
        const mkLut = (name, w, h) => new Texture(device, {
            name, width: w, height: h, format: PIXELFORMAT_RGBA16F, mipmaps: false,
            minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.transmittanceLut = mkLut('skyTransmittanceLUT', 256, 64);
        this.multiScatterLut = mkLut('skyMultiScatterLUT', 64, 32);
        this.rtTransmittance = new RenderTarget({ name: 'skyTransmittanceRT', colorBuffer: this.transmittanceLut, depth: false });
        this.rtMultiScatter = new RenderTarget({ name: 'skyMultiScatterRT', colorBuffer: this.multiScatterLut, depth: false });
        // Resolve the narrow sky band above the geometric horizon instead of averaging it with ground.
        this.lightingEquirect = mkEquirect('skyLightingEquirect', 2048, 1024);
        // Four thousand longitude samples keep the half-degree solar disc round after filtering.
        this.skyboxEquirect = mkEquirect('skyboxEquirect', 4096, 2048);
        this.rtLighting = new RenderTarget({ name: 'skyLightingRT', colorBuffer: this.lightingEquirect, depth: false });
        this.rtSkybox = new RenderTarget({ name: 'skyboxRT', colorBuffer: this.skyboxEquirect, depth: false });

        const mk = (name, glsl, wgsl) => ShaderUtils.createShader(device, {
            uniqueName: name,
            attributes: { aPosition: SEMANTIC_POSITION },
            vertexGLSL: ATMOS_VS, fragmentGLSL: glsl,
            vertexWGSL: ATMOS_VS_WGSL, fragmentWGSL: wgsl
        });
        this.transmittanceShader = mk('skyTransmittance', TRANSMITTANCE_FS, TRANSMITTANCE_FS_WGSL);
        this.multiScatterShader = mk('skyMultiScatter', MULTISCATTER_FS, MULTISCATTER_FS_WGSL);
        this.skyShader = mk('skyMarch', SKY_FS, SKY_FS_WGSL);

        this.sunDir = new Vec3();
        this.sunColor = new Color();
        this.envAtlas = null;
        this.lightingSource = null;
        this.skyboxCubemap = null;
        this.onUpdate = null;
        this._dirty = true;
        this._mediumDirty = true;
        this._skyDirty = true;
        this._updateSun();
        this._onFrame = () => {
            if (this._dirty && !this._destroyed) {
                this._dirty = false;
                this._rebuild();
            }
        };
        app.on('update', this._onFrame);
    }

    /** Immutable current configuration. Use setParams to change it. */
    get params() { return this._params; }
    get ready() { return this._ready; }
    getParams() { return { ...this._params }; }

    /** Linear lighting outputs. Radiance excludes the solar disc; exposure is applied by consumers. */
    get environment() {
        return Object.freeze({
            atlas: this.envAtlas,
            radiance: this._ready ? this.lightingEquirect : null,
            sunDirection: this.getSunDirection(),
            sunColor: this.getSunColor(),
            exposure: this._params.exposure,
            hazeDensity: this.aerialDensity
        });
    }

    /** Luminance-weighted atmospheric extinction at the observer, in inverse metres. */
    get aerialDensity() {
        const molecular = (5.802e-3 * 0.2126 + 13.558e-3 * 0.7152 + 33.1e-3 * 0.0722) * Math.exp(-0.01 / 8);
        const aerosol = 4.440e-3 * this._params.haze * Math.exp(-0.01 / 1.2);
        return (molecular + aerosol) / 1000;
    }

    /** Validate and merge an update; expensive work is coalesced into the next app frame. */
    setParams(patch) {
        if (this._destroyed) throw new Error('Sky has been destroyed.');
        const next = resolveSkyParams(patch, this._params);
        const changed = Object.keys(next).filter(key => next[key] !== this._params[key]);
        if (!changed.length) return this;
        this._mediumDirty ||= changed.includes('haze');
        this._skyDirty ||= changed.some(key => key !== 'exposure');
        this._params = next;
        this._dirty = true;
        this._updateSun();
        return this;
    }

    /** Apply a complete configuration from defaults, so omitted fields cannot leak between scenes. */
    resetParams(patch = {}) {
        return this.setParams(resolveSkyParams(patch));
    }

    _updateSun() {
        const p = this._params;
        const el = p.sunElevation * Math.PI / 180;
        const az = p.sunAzimuth * Math.PI / 180;
        this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
        const T = sunTransmittanceCPU([this.sunDir.x, this.sunDir.y, this.sunDir.z], { rayleigh: 1, mie: p.haze, ozone: 1 });
        const k = SOLAR_IRRADIANCE * p.exposure;
        this.sunColor.set(T[0] * k, T[1] * k, T[2] * k);
    }

    _setAtmosphere() {
        const p = this._params;
        const scope = this.device.scope;
        scope.resolve('uRayleigh').setValue(1);
        scope.resolve('uMie').setValue(p.haze);
        scope.resolve('uOzone').setValue(1);
        scope.resolve('uGroundAlbedo').setValue(0.1);
    }

    _setSky(withDisc) {
        const { sunDir } = this;
        const scope = this.device.scope;
        scope.resolve('uTransmittance').setValue(this.transmittanceLut);
        scope.resolve('uMultiScatter').setValue(this.multiScatterLut);
        scope.resolve('uSunDir').setValue([sunDir.x, sunDir.y, sunDir.z]);
        scope.resolve('uSunIntensity').setValue(SOLAR_IRRADIANCE);
        scope.resolve('uMieG').setValue(AEROSOL_ASYMMETRY);
        scope.resolve('uSunDisc').setValue(withDisc ? SOLAR_IRRADIANCE / SUN_SOLID_ANGLE : 0);
    }

    _rebuild() {
        const { device, app } = this;
        this._setAtmosphere();
        if (this._mediumDirty) {
            drawQuadWithShader(device, this.rtTransmittance, this.transmittanceShader);
            device.scope.resolve('uTransmittance').setValue(this.transmittanceLut);
            drawQuadWithShader(device, this.rtMultiScatter, this.multiScatterShader);
            this._mediumDirty = false;
        }

        let oldSource, oldAtlas, oldSkybox;
        if (this._skyDirty) {
            this._setSky(false);
            drawQuadWithShader(device, this.rtLighting, this.skyShader);
            this._setSky(true);
            drawQuadWithShader(device, this.rtSkybox, this.skyShader);
            oldSource = this.lightingSource;
            oldAtlas = this.envAtlas;
            oldSkybox = this.skyboxCubemap;
            // Recreate prefiltered targets: updating them in place can alias engine render passes.
            this.lightingSource = EnvLighting.generateLightingSource(this.lightingEquirect, { size: 256 });
            this.envAtlas = EnvLighting.generateAtlas(this.lightingSource, { numReflectionSamples: 1024, numAmbientSamples: 2048 });
            this.skyboxCubemap = EnvLighting.generateSkyboxCubemap(this.skyboxEquirect, 1024);
            this._skyDirty = false;
        }
        if (this._attachToScene) {
            const scene = app.scene;
            this._previousScene ??= {
                envAtlas: scene.envAtlas,
                prefilteredCubemaps: [...scene.prefilteredCubemaps],
                skybox: scene.skybox,
                intensity: scene.skyboxIntensity,
                mip: scene.skyboxMip
            };
            scene.envAtlas = this.envAtlas;
            scene.skybox = this.skyboxCubemap;
            scene.skyboxIntensity = this._params.exposure;
            scene.skyboxMip = 0;
            this._appliedExposure = this._params.exposure;
        }
        this._ready = true;
        // Notify before releasing the previous atlas so consumers can detach it safely.
        try {
            this.onUpdate?.(this);
        } finally {
            oldSource?.destroy();
            oldAtlas?.destroy();
            oldSkybox?.destroy();
        }
    }

    /** Average linear radiance just above the horizon, before exposure. Null before the first frame. */
    readHorizonColor() { return this._readRow((this.lightingEquirect.height >> 1) - 1); }
    /** Average linear radiance 25 degrees below the zenith, before exposure. */
    readZenithColor() { return this._readRow(Math.round(this.lightingEquirect.height * 0.14)); }

    async _readRow(y) {
        if (!this._ready || this._destroyed) return null;
        const t = this.lightingEquirect;
        const W = t.width;
        const data = await t.read(0, y, W, 1);
        if (!data || this._destroyed) return null;
        const values = data instanceof Uint16Array ? data : new Uint16Array(data.buffer ?? data, data.byteOffset ?? 0, W * 4);
        const h2f = (h) => {
            const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
            if (e === 0) return s * m * 2 ** -24;
            if (e === 31) return 0;
            return s * (1 + m / 1024) * 2 ** (e - 15);
        };
        const c = [0, 0, 0];
        for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) c[k] += h2f(values[x * 4 + k]);
        return c.map(v => v / W);
    }

    /** Release owned resources; restore scene lighting only where this sky still owns it. */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._ready = false;
        this.app.off('update', this._onFrame);
        const scene = this.app.scene, previous = this._previousScene;
        if (previous) {
            if (scene.envAtlas === this.envAtlas) {
                if (previous.prefilteredCubemaps.length) scene.prefilteredCubemaps = previous.prefilteredCubemaps;
                else scene.envAtlas = previous.envAtlas;
            }
            if (scene.skybox === this.skyboxCubemap) {
                scene.skybox = previous.skybox;
                if (scene.skyboxIntensity === this._appliedExposure) scene.skyboxIntensity = previous.intensity;
                if (scene.skyboxMip === 0) scene.skyboxMip = previous.mip;
            }
        }
        [this.rtLighting, this.rtSkybox, this.rtTransmittance, this.rtMultiScatter].forEach(rt => rt?.destroy());
        [this.lightingEquirect, this.skyboxEquirect, this.transmittanceLut, this.multiScatterLut,
            this.lightingSource, this.envAtlas, this.skyboxCubemap].forEach(t => t?.destroy());
        this.onUpdate = null;
    }

    /** Direction towards the sun in world space. The returned vector belongs to the caller. */
    getSunDirection() { return this.sunDir.clone(); }
    /** Direct solar irradiance in linear scene units, including atmospheric extinction and exposure. */
    getSunColor() { return this.sunColor.clone(); }
}
