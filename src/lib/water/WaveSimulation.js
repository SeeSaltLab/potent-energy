import {
    Texture, RenderTarget, Shader, Compute, ShaderUtils, RenderPassShaderQuad,
    PIXELFORMAT_RGBA32F, PIXELFORMAT_RGBA16F,
    FILTER_NEAREST, FILTER_LINEAR_MIPMAP_LINEAR, FILTER_LINEAR, ADDRESS_REPEAT, ADDRESS_CLAMP_TO_EDGE,
    SEMANTIC_POSITION, SHADERLANGUAGE_WGSL
} from 'playcanvas';

import { SIM_QUAD_VS, SPECTRUM_FS, EVOLVE_FS, FFT_FS, ASSEMBLE_FS } from './shaders/simCommon.glsl.js';
import { spectrumCS, evolveCS, fftCS, assembleCS } from './shaders/simCompute.wgsl.js';

/**
 * Default simulation parameters. Two JONSWAP spectra are summed: a local wind sea and a
 * long-period swell. Spectra are described by physical quantities (wind speed in m/s,
 * fetch in metres) following Horvath 2015.
 */
export const DEFAULT_WAVE_PARAMS = {
    size: 256,                     // FFT resolution per cascade (128 | 256 | 512)
    lengthScales: [1024, 256, 48, 8], // metres covered by each cascade (coarse -> fine)
    cascadeOverlap: 6,             // wavelength ratio used to split wave numbers between cascades
    depth: 500,                    // water depth (m) — TMA correction & dispersion
    gravity: 9.81,
    seed: 1337,
    choppiness: 1.4,               // horizontal displacement scale (lambda)
    foamDecay: 0.6,                // Jacobian recovery rate (1/s); lower = foam lingers longer
    timeScale: 1.0,
    wind: {
        scale: 1.0,
        windSpeed: 9.0,            // m/s
        windDirection: 35.0,       // degrees
        fetch: 120000,             // m
        spreadBlend: 0.9,
        swell: 0.25,
        peakEnhancement: 3.3,
        shortWavesFade: 0.015
    },
    swell: {
        scale: 0.6,
        windSpeed: 4.0,
        windDirection: -20.0,
        fetch: 500000,
        spreadBlend: 1.0,
        swell: 1.0,
        peakEnhancement: 3.3,
        shortWavesFade: 0.05
    }
};

function packSpectrum(s, g) {
    const alpha = 0.076 * Math.pow(s.windSpeed * s.windSpeed / (s.fetch * g), 0.22);
    const peakOmega = 22 * Math.pow(g * g / (s.windSpeed * s.fetch), 1 / 3);
    return {
        p0: [s.scale, s.windDirection * Math.PI / 180, s.spreadBlend, s.swell],
        p1: [alpha, peakOmega, s.peakEnhancement, s.shortWavesFade]
    };
}

function createTex(device, name, size, format, filter, address, storage, mipmaps = false) {
    return new Texture(device, {
        name, width: size, height: size, format,
        mipmaps,
        minFilter: mipmaps ? FILTER_LINEAR_MIPMAP_LINEAR : filter, magFilter: filter,
        anisotropy: mipmaps ? 16 : 1,   // the sea is seen at grazing angles: isotropic mips would blur it
        addressU: address, addressV: address,
        storage: !!storage
    });
}

/**
 * Cascaded FFT ocean simulation. Produces, per cascade, a displacement map
 * (x, y, z, turbulence) and a derivatives map (dy/dx, dy/dz, dx/dx, dz/dz) each frame.
 * Uses WebGPU compute when available, otherwise a WebGL2 MRT fragment pipeline.
 */
export class WaveSimulation {
    constructor(device, params = {}) {
        this.device = device;
        this.params = structuredClone(DEFAULT_WAVE_PARAMS);
        Object.assign(this.params, params);
        this.useCompute = !!device.supportsCompute;
        this.time = 0;
        this.frame = 0;
        this.cascades = [];
        this._spectrumDirty = true;
        this._build();
    }

    get numCascades() { return this.cascades.length; }
    get size() { return this.params.size; }

    /** Current displacement textures (one per cascade). */
    get displacementTextures() { return this.cascades.map(c => c.sampled ? c.sampled.displacement : c.displacement[c.pingIndex]); }
    /** Derivative textures (one per cascade). */
    get derivativeTextures() { return this.cascades.map(c => c.sampled ? c.sampled.derivatives : c.derivatives); }
    /** Length scales (metres) per cascade. */
    get lengthScales() { return this.params.lengthScales; }

    /** Mark the initial spectrum for regeneration (call after changing wind/swell/depth/seed). */
    invalidateSpectrum() { this._spectrumDirty = true; }

    /** Change FFT size / cascade layout: rebuilds all GPU resources. */
    rebuild(newParams = {}) {
        Object.assign(this.params, newParams);
        this.destroy();
        this.frame = 0;
        this._build();
    }

    _build() {
        const { device, params } = this;
        const N = params.size;
        if ((N & (N - 1)) !== 0 || N < 16 || N > 1024) throw new Error('Water: FFT size must be a power of two in [16, 1024]');
        if (this.useCompute) {
            const maxWG = device.limits?.maxComputeWorkgroupSizeX ?? 256;
            const maxShared = device.limits?.maxComputeWorkgroupStorageSize ?? 16384;
            if (N / 2 > maxWG || N * 32 > maxShared) {
                console.warn(`Water: FFT size ${N} exceeds compute limits, using fragment path`);
                this.useCompute = false;
            }
        }
        this.log2N = Math.log2(N) | 0;
        this.cascades = params.lengthScales.map((L, i) => this._createCascade(i, L));
        this._spectrumDirty = true;
        if (this.useCompute) this._buildCompute(); else this._buildFragment();
    }

    _createCascade(index, lengthScale) {
        const { device, params } = this;
        const N = params.size;
        const storage = this.useCompute;
        const c = {
            index, lengthScale, pingIndex: 0,
            spectrum: createTex(device, `oceanSpectrum${index}`, N, PIXELFORMAT_RGBA32F, FILTER_NEAREST, ADDRESS_CLAMP_TO_EDGE, storage),
            pingA: [0, 1].map(j => createTex(device, `oceanPingA${index}_${j}`, N, PIXELFORMAT_RGBA32F, FILTER_NEAREST, ADDRESS_CLAMP_TO_EDGE, storage)),
            pingB: [0, 1].map(j => createTex(device, `oceanPingB${index}_${j}`, N, PIXELFORMAT_RGBA32F, FILTER_NEAREST, ADDRESS_CLAMP_TO_EDGE, storage)),
            // The outputs carry a mip chain: the surface mesh gets coarser with distance, so the vertex
            // shader reads the displacement at the mip that matches its local spacing, and the
            // fragment shader's slopes are filtered the same way. Without it the grid point-samples
            // waves shorter than its spacing, and the alias pattern moves whenever the camera does.
            displacement: [0, 1].map(j => createTex(device, `oceanDisplacement${index}_${j}`, N, PIXELFORMAT_RGBA16F, FILTER_LINEAR, ADDRESS_REPEAT, storage, !storage)),
            derivatives: createTex(device, `oceanDerivatives${index}`, N, PIXELFORMAT_RGBA16F, FILTER_LINEAR, ADDRESS_REPEAT, storage, !storage),
            // WebGPU storage textures are bound as a single level, so the compute path writes plain
            // textures and copies them into these mipmapped ones for sampling
            sampled: storage ? {
                displacement: createTex(device, `oceanDisplacementMip${index}`, N, PIXELFORMAT_RGBA16F, FILTER_LINEAR, ADDRESS_REPEAT, false, true),
                derivatives: createTex(device, `oceanDerivativesMip${index}`, N, PIXELFORMAT_RGBA16F, FILTER_LINEAR, ADDRESS_REPEAT, false, true)
            } : null
        };
        // wave-number band handled by this cascade
        const k = params.cascadeOverlap;
        const scales = params.lengthScales;
        c.cutoffLow = index === 0 ? 0.0001 : 2 * Math.PI / scales[index] * k;
        c.cutoffHigh = index === scales.length - 1 ? 1e6 : 2 * Math.PI / scales[index + 1] * k;
        return c;
    }

    // ------------------------------------------------------------------ WebGPU compute
    _buildCompute() {
        const { device, params } = this;
        const N = params.size;
        const mk = (name, src) => new Shader(device, {
            name, shaderLanguage: SHADERLANGUAGE_WGSL, cshader: src, computeEntryPoint: 'main'
        });
        this.csSpectrum = mk('oceanSpectrumCS', spectrumCS(N));
        this.csEvolve = mk('oceanEvolveCS', evolveCS(N));
        this.csFFT = mk('oceanFFTCS', fftCS(N));
        this.csAssemble = mk('oceanAssembleCS', assembleCS(N));
        const groups = Math.ceil(N / 8);

        for (const c of this.cascades) {
            c.spectrumCompute = new Compute(device, this.csSpectrum, `oceanSpectrum${c.index}`);
            c.spectrumCompute.setParameter('uOut', c.spectrum);
            c.spectrumCompute.setupDispatch(groups, groups, 1);

            c.evolveCompute = new Compute(device, this.csEvolve, `oceanEvolve${c.index}`);
            c.evolveCompute.setParameter('uSpectrum', c.spectrum);
            c.evolveCompute.setParameter('uOut0', c.pingA[0]);
            c.evolveCompute.setParameter('uOut1', c.pingA[1]);
            c.evolveCompute.setupDispatch(groups, groups, 1);

            c.fftH = new Compute(device, this.csFFT, `oceanFFTH${c.index}`);
            c.fftH.setParameter('uVertical', 0);
            c.fftH.setParameter('uIn0', c.pingA[0]);
            c.fftH.setParameter('uIn1', c.pingA[1]);
            c.fftH.setParameter('uOut0', c.pingB[0]);
            c.fftH.setParameter('uOut1', c.pingB[1]);
            c.fftH.setupDispatch(N, 1, 1);

            c.fftV = new Compute(device, this.csFFT, `oceanFFTV${c.index}`);
            c.fftV.setParameter('uVertical', 1);
            c.fftV.setParameter('uIn0', c.pingB[0]);
            c.fftV.setParameter('uIn1', c.pingB[1]);
            c.fftV.setParameter('uOut0', c.pingA[0]);
            c.fftV.setParameter('uOut1', c.pingA[1]);
            c.fftV.setupDispatch(N, 1, 1);

            c.assembleCompute = [0, 1].map((j) => {
                const cs = new Compute(device, this.csAssemble, `oceanAssemble${c.index}_${j}`);
                cs.setParameter('uIn0', c.pingA[0]);
                cs.setParameter('uIn1', c.pingA[1]);
                cs.setParameter('uPrevDisplacement', c.displacement[1 - j]);
                cs.setParameter('uDisplacement', c.displacement[j]);
                cs.setParameter('uDerivatives', c.derivatives);
                cs.setupDispatch(groups, groups, 1);
                return cs;
            });
        }
    }

    _updateSpectrumCompute() {
        const { params } = this;
        const a = packSpectrum(params.wind, params.gravity);
        const b = packSpectrum(params.swell, params.gravity);
        const computes = [];
        for (const c of this.cascades) {
            const cs = c.spectrumCompute;
            cs.setParameter('uLengthScale', c.lengthScale);
            cs.setParameter('uCutoffLow', c.cutoffLow);
            cs.setParameter('uCutoffHigh', c.cutoffHigh);
            cs.setParameter('uDepth', params.depth);
            cs.setParameter('uGravity', params.gravity);
            cs.setParameter('uSeed', params.seed >>> 0);
            cs.setParameter('uSpecA0', a.p0); cs.setParameter('uSpecA1', a.p1);
            cs.setParameter('uSpecB0', b.p0); cs.setParameter('uSpecB1', b.p1);
            computes.push(cs);
        }
        this.device.computeDispatch(computes, 'oceanSpectrum');
    }

    _stepCompute(dt) {
        const { params } = this;
        const computes = [];
        for (const c of this.cascades) {
            const e = c.evolveCompute;
            e.setParameter('uLengthScale', c.lengthScale);
            e.setParameter('uDepth', params.depth);
            e.setParameter('uGravity', params.gravity);
            e.setParameter('uTime', this.time);
            computes.push(e);
        }
        this.device.computeDispatch(computes, 'oceanEvolve');
        this.device.computeDispatch(this.cascades.map(c => c.fftH), 'oceanFFTH');
        this.device.computeDispatch(this.cascades.map(c => c.fftV), 'oceanFFTV');
        const assembles = [];
        for (const c of this.cascades) {
            c.pingIndex = 1 - c.pingIndex;
            const cs = c.assembleCompute[c.pingIndex];
            cs.setParameter('uLambda', params.choppiness);
            cs.setParameter('uDeltaTime', dt);
            cs.setParameter('uFoamDecay', params.foamDecay);
            cs.setParameter('uFoamReset', this.frame < 2 ? 1 : 0);
            assembles.push(cs);
        }
        this.device.computeDispatch(assembles, 'oceanAssemble');
        // copy the results into the mipmapped sampling textures and rebuild their chains
        const N = params.size;
        const encoder = this.device.getCommandEncoder();
        for (const c of this.cascades) {
            for (const [src, dst] of [[c.displacement[c.pingIndex], c.sampled.displacement], [c.derivatives, c.sampled.derivatives]]) {
                encoder.copyTextureToTexture({ texture: src.impl.gpuTexture }, { texture: dst.impl.gpuTexture }, { width: N, height: N, depthOrArrayLayers: 1 });
                this.device.mipmapRenderer.generate(dst.impl);
            }
        }
    }

    // ------------------------------------------------------------------ WebGL2 fragment
    _buildFragment() {
        const { device } = this;
        const attributes = { aPosition: SEMANTIC_POSITION };
        const mk = (name, fs, outputs) => ShaderUtils.createShader(device, {
            uniqueName: name, attributes, vertexGLSL: SIM_QUAD_VS, fragmentGLSL: fs,
            fragmentOutputTypes: outputs
        });
        this.fsSpectrum = mk('oceanSpectrumFS', SPECTRUM_FS, ['vec4']);
        this.fsEvolve = mk('oceanEvolveFS', EVOLVE_FS, ['vec4', 'vec4']);
        this.fsFFT = mk('oceanFFTFS', FFT_FS, ['vec4', 'vec4']);
        this.fsAssemble = mk('oceanAssembleFS', ASSEMBLE_FS, ['vec4', 'vec4']);

        const mkPass = (shader, rt) => {
            const pass = new RenderPassShaderQuad(device);
            pass.shader = shader;
            pass.init(rt);
            return pass;
        };

        for (const c of this.cascades) {
            c.rtSpectrum = new RenderTarget({ name: `oceanSpectrumRT${c.index}`, colorBuffer: c.spectrum, depth: false });
            c.rtA = new RenderTarget({ name: `oceanPingART${c.index}`, colorBuffers: c.pingA, depth: false });
            c.rtB = new RenderTarget({ name: `oceanPingBRT${c.index}`, colorBuffers: c.pingB, depth: false });
            c.rtOut = [0, 1].map(j => new RenderTarget({
                name: `oceanOutRT${c.index}_${j}`, colorBuffers: [c.displacement[j], c.derivatives], depth: false,
                mipmaps: true   // the engine regenerates the chain when the pass ends
            }));
            c.spectrumPass = mkPass(this.fsSpectrum, c.rtSpectrum);
            c.evolvePass = mkPass(this.fsEvolve, c.rtA);
            c.fftPassA = mkPass(this.fsFFT, c.rtA);   // writes A (reads B)
            c.fftPassB = mkPass(this.fsFFT, c.rtB);   // writes B (reads A)
            c.assemblePass = c.rtOut.map(rt => mkPass(this.fsAssemble, rt));
        }
    }

    _updateSpectrumFragment() {
        const { device, params } = this;
        const scope = device.scope;
        const a = packSpectrum(params.wind, params.gravity);
        const b = packSpectrum(params.swell, params.gravity);
        scope.resolve('uSize').setValue(params.size);
        scope.resolve('uDepth').setValue(params.depth);
        scope.resolve('uGravity').setValue(params.gravity);
        scope.resolve('uSeed').setValue(params.seed | 0);
        scope.resolve('uSpecA0').setValue(a.p0); scope.resolve('uSpecA1').setValue(a.p1);
        scope.resolve('uSpecB0').setValue(b.p0); scope.resolve('uSpecB1').setValue(b.p1);
        for (const c of this.cascades) {
            scope.resolve('uLengthScale').setValue(c.lengthScale);
            scope.resolve('uCutoffLow').setValue(c.cutoffLow);
            scope.resolve('uCutoffHigh').setValue(c.cutoffHigh);
            c.spectrumPass.render();
        }
    }

    _stepFragment(dt) {
        const { device, params } = this;
        const scope = device.scope;
        const uIn0 = scope.resolve('uIn0'), uIn1 = scope.resolve('uIn1');
        const uStage = scope.resolve('uStage'), uVertical = scope.resolve('uVertical');
        scope.resolve('uSize').setValue(params.size);
        scope.resolve('uLog2Size').setValue(this.log2N);
        scope.resolve('uDepth').setValue(params.depth);
        scope.resolve('uGravity').setValue(params.gravity);
        scope.resolve('uTime').setValue(this.time);
        scope.resolve('uLambda').setValue(params.choppiness);
        scope.resolve('uDeltaTime').setValue(dt);
        scope.resolve('uFoamDecay').setValue(params.foamDecay);
        scope.resolve('uFoamReset').setValue(this.frame < 2 ? 1 : 0);

        for (const c of this.cascades) {
            scope.resolve('uLengthScale').setValue(c.lengthScale);
            scope.resolve('uSpectrum').setValue(c.spectrum);
            c.evolvePass.render();   // -> A

            let inA = true;
            for (let dir = 0; dir < 2; dir++) {
                uVertical.setValue(dir);
                for (let s = 0; s < this.log2N; s++) {
                    uStage.setValue(s);
                    const src = inA ? c.pingA : c.pingB;
                    uIn0.setValue(src[0]); uIn1.setValue(src[1]);
                    (inA ? c.fftPassB : c.fftPassA).render();
                    inA = !inA;
                }
            }
            // ensure the result is in A (even number of stages keeps it there; handle odd)
            const src = inA ? c.pingA : c.pingB;
            uIn0.setValue(src[0]); uIn1.setValue(src[1]);
            c.pingIndex = 1 - c.pingIndex;
            scope.resolve('uPrevDisplacement').setValue(c.displacement[1 - c.pingIndex]);
            c.assemblePass[c.pingIndex].render();
        }
    }

    /**
     * Advance the simulation. Call once per frame before rendering.
     * @param {number} dt - frame delta time in seconds
     */
    update(dt) {
        dt = Math.min(dt, 1 / 15) * this.params.timeScale;
        this.time += dt;
        if (this._spectrumDirty) {
            this._spectrumDirty = false;
            if (this.useCompute) this._updateSpectrumCompute(); else this._updateSpectrumFragment();
        }
        if (this.useCompute) this._stepCompute(dt); else this._stepFragment(dt);
        this.frame++;
    }

    destroy() {
        for (const c of this.cascades) {
            [c.spectrum, ...c.pingA, ...c.pingB, ...c.displacement, c.derivatives, c.sampled?.displacement, c.sampled?.derivatives].forEach(t => t?.destroy());
            [c.rtSpectrum, c.rtA, c.rtB, ...(c.rtOut || [])].forEach(rt => rt?.destroy());
            [c.spectrumPass, c.evolvePass, c.fftPassA, c.fftPassB, ...(c.assemblePass || [])].forEach(p => p?.quadRender?.destroy());
            [c.spectrumCompute, c.evolveCompute, c.fftH, c.fftV, ...(c.assembleCompute || [])].forEach(cs => cs?.destroy());
        }
        this.cascades = [];
        [this.csSpectrum, this.csEvolve, this.csFFT, this.csAssemble].forEach(sh => sh?.destroy());
        this.csSpectrum = this.csEvolve = this.csFFT = this.csAssemble = null;
    }
}
