import {
    Texture, RenderTarget, ShaderUtils, RenderPassShaderQuad, Vec3,
    PIXELFORMAT_RGBA32F, FILTER_NEAREST, ADDRESS_CLAMP_TO_EDGE, SEMANTIC_POSITION
} from 'playcanvas';

import { PROBE_VS, PROBE_FS } from './shaders/waveProbe.glsl.js';
import { PROBE_VS_WGSL, PROBE_FS_WGSL } from './shaders/waveProbe.wgsl.js';

const GRID = 16;                 // 16 x 16 = 256 simultaneous query points
const SLOTS = GRID * GRID;
const READ_INTERVAL = 3;          // frames between readbacks

/**
 * CPU-side queries of the GPU wave field, for buoyancy and submersion tests.
 *
 * Each query point registered by {@link WaveProbe#sample} occupies one texel of a small query
 * texture. A quad pass evaluates the same cascaded displacement the vertex shader uses — including
 * the inverse of the horizontal (choppy) displacement, solved by fixed-point iteration — and the
 * result is read back asynchronously. Callers therefore get a value that is one or two frames old,
 * which is invisible for floating objects and not suitable for exact collision.
 *
 * Points are keyed on their XZ position, so asking about the same point every frame reuses its slot
 * and costs nothing; slots not asked about for a while are recycled.
 */
export class WaveProbe {
    /** @param {import('./Water.js').Water} water - The water instance to sample. */
    constructor(water) {
        this.water = water;
        this.device = water._device;

        this.queryData = new Float32Array(SLOTS * 4);
        this.resultData = new Float32Array(SLOTS * 4);
        /** @type {Map<string, {slot: number, lastUsed: number, result: {position: Vec3, normal: Vec3}}>} */
        this.entries = new Map();
        this.slotOwner = new Array(SLOTS).fill(null);
        this.nextSlot = 0;
        this.frame = 0;
        this.pending = false;
        this.lastRead = -99;
        this._generation = 0;
        this._destroyed = false;
        this._zero = { position: new Vec3(), normal: new Vec3(0, 1, 0) };

        this._build();
    }

    _build() {
        const device = this.device;
        this.queryTex = new Texture(device, {
            name: 'waveProbeQuery', width: GRID, height: GRID, format: PIXELFORMAT_RGBA32F,
            mipmaps: false, minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.queryTex.lock().set(this.queryData);
        this.queryTex.unlock();

        this.resultTex = new Texture(device, {
            name: 'waveProbeResult', width: GRID, height: GRID, format: PIXELFORMAT_RGBA32F,
            mipmaps: false, minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.rt = new RenderTarget({ name: 'waveProbeRT', colorBuffer: this.resultTex, depth: false });

        const shader = ShaderUtils.createShader(device, {
            uniqueName: 'waveProbe',
            attributes: { aPosition: SEMANTIC_POSITION },
            vertexGLSL: PROBE_VS, fragmentGLSL: PROBE_FS,
            vertexWGSL: PROBE_VS_WGSL, fragmentWGSL: PROBE_FS_WGSL,
            fragmentOutputTypes: ['vec4']
        });
        this.pass = new RenderPassShaderQuad(device);
        this.pass.shader = shader;
        this.pass.init(this.rt);
        this._cascadeData = new Float32Array(16);
    }

    /** Rebuild after the simulation's cascade layout changed. */
    rebuild() {
        // In-flight results describe the previous configuration; never publish them over the reset.
        this._generation++;
        this.resultData.fill(0);
        for (const entry of this.entries.values()) {
            entry.result.position.y = this.water.seaLevel;
            entry.result.normal.set(0, 1, 0);
        }
        this.lastRead = -99;
    }

    /**
     * Surface point and normal at a world XZ position.
     *
     * @param {number} x - World X.
     * @param {number} z - World Z.
     * @returns {{position: Vec3, normal: Vec3}} A per-query object, updated in place each frame.
     */
    sample(x, z) {
        // quantise the key so a slowly drifting query keeps its slot
        const key = `${Math.round(x * 4)}:${Math.round(z * 4)}`;
        let e = this.entries.get(key);
        if (!e) {
            const slot = this._acquireSlot(key);
            if (slot < 0) {
                this._zero.position.set(x, this.water.config.seaLevel, z);
                return this._zero;
            }
            e = { slot, lastUsed: this.frame, result: { position: new Vec3(x, this.water.config.seaLevel, z), normal: new Vec3(0, 1, 0) } };
            this.entries.set(key, e);
        }
        e.lastUsed = this.frame;
        e.result.position.x = x;
        e.result.position.z = z;
        this.queryData[e.slot * 4 + 0] = x;
        this.queryData[e.slot * 4 + 1] = z;
        this.queryData[e.slot * 4 + 2] = 1;
        return e.result;
    }

    _acquireSlot(key) {
        for (let i = 0; i < SLOTS; i++) {
            const s = (this.nextSlot + i) % SLOTS;
            const owner = this.slotOwner[s];
            if (owner === null) { this.slotOwner[s] = key; this.nextSlot = s + 1; return s; }
            const e = this.entries.get(owner);
            if (!e || this.frame - e.lastUsed > 30) {
                if (e) this.entries.delete(owner);
                this.slotOwner[s] = key;
                this.nextSlot = s + 1;
                return s;
            }
        }
        return -1;
    }

    /** Run one probe pass and pick up the previous readback. Called by {@link Water#update}. */
    update() {
        this.frame++;
        if (this.entries.size === 0) return;

        const water = this.water;
        const sim = water._simulation;
        const cfg = water.config;
        const scope = this.device.scope;

        this.queryTex.lock().set(this.queryData);
        this.queryTex.unlock();

        const disp = sim.displacementTextures;
        const deriv = sim.derivativeTextures;
        const scales = sim.lengthScales;
        const n = disp.length;
        for (let i = 0; i < 4; i++) {
            const j = Math.min(i, n - 1);
            scope.resolve(`uDisp${i}`).setValue(disp[j]);
            scope.resolve(`uDeriv${i}`).setValue(deriv[j]);
            this._cascadeData[i * 4 + 3] = 1 / scales[j];
        }
        scope.resolve('uCascadeInv').setValue(this._cascadeData);
        scope.resolve('uCascadeInv[0]').setValue(this._cascadeData);
        scope.resolve('uQuery').setValue(this.queryTex);
        scope.resolve('uNumCascades').setValue(n);
        scope.resolve('uLambda').setValue(cfg.waves.choppiness);
        scope.resolve('uDisplacementScale').setValue(cfg.waves.amplitude);
        scope.resolve('uSeaLevel').setValue(cfg.seaLevel);
        this.pass.render();

        // One readback in flight at a time, and no more than every READ_INTERVAL frames: the staging
        // buffer a read maps is recycled by the device, and issuing them back to back trips its
        // validation. 20 Hz is far more than a floating object needs.
        if (!this.pending && this.frame - this.lastRead >= READ_INTERVAL) {
            this.pending = true;
            this.lastRead = this.frame;
            const generation = this._generation;
            const owners = Array.from(this.entries.entries());
            this.resultTex.read(0, 0, GRID, GRID, { renderTarget: this.rt, data: this.resultData, frequent: true })
                .then(() => {
                    this.pending = false;
                    if (!this._destroyed && generation === this._generation) this._publish(owners);
                })
                .catch(() => { this.pending = false; });
        }
    }

    _publish(owners) {
        const d = this.resultData;
        for (const [key, e] of owners) {
            if (this.entries.get(key) !== e) continue; // a slot was recycled during the GPU read
            const i = e.slot * 4;
            e.result.position.y = d[i + 0];
            e.result.normal.set(-d[i + 1], 1, -d[i + 2]).normalize();
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._generation++;
        this.pass?.quadRender?.destroy();
        this.rt?.destroy();
        this.queryTex?.destroy();
        this.resultTex?.destroy();
        this.entries.clear();
    }
}
