import {
    Texture, PIXELFORMAT_RGBA8, FILTER_LINEAR, ADDRESS_CLAMP_TO_EDGE
} from 'playcanvas';

/**
 * @typedef {object} ShoreMap
 * @property {Texture} texture - RGBA map of the coast, see {@link bakeShoreMap}.
 * @property {number[]} origin - World XZ of the map's lower corner.
 * @property {number[]} size - World XZ extent the map covers, in metres.
 * @property {number} maxDepth - Depth in metres that R = 1 represents.
 * @property {number} seaLevel - World Y used when baking. Re-bake after changing the water level.
 * @property {() => void} destroy - Dispose the caller-owned texture after detaching the map.
 */

/**
 * Bake the coast into a texture the water shader can read anywhere on the surface.
 *
 * Open-ocean waves know nothing about the land they are running into. What makes a coast read as a
 * coast is everything that happens in the last few metres of depth: the swell shortens and steepens,
 * crests turn until they run parallel to the shore, they break, and the foam left behind washes up
 * and drains back. All of that is driven by one quantity — how deep the water is — which the surface
 * shader has no way to know from the wave simulation alone.
 *
 * So it is baked once, from whatever function describes the sea bed:
 *
 *   r  water depth, normalised against `maxDepth`; 0 is dry land
 *   gb the offshore direction (the normalised gradient of depth), packed into 0..1
 *   a  a smooth land mask, 1 in open water and 0 above the waterline
 *
 * Depth doubles as the phase variable for the shore waves. Lines of constant depth follow the
 * coastline, so a wave whose phase is a function of depth is automatically parallel to the shore and
 * wraps around headlands and sandbars without any extra work — which is the effect wave refraction
 * has in the real world, arrived at from the other end.
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @param {object} options - Bake settings.
 * @param {number[]} options.origin - World XZ of the lower corner of the area to cover.
 * @param {number[]} options.size - World XZ extent to cover, in metres.
 * @param {(x: number, z: number) => number} options.heightAt - Sea-bed height at a world position.
 * @param {number} [options.seaLevel] - World Y of the undisturbed surface.
 * @param {number} [options.maxDepth] - Depth that saturates the depth channel. Only the shallows
 * matter, so keep this small — 40 m spends the whole channel on the surf zone.
 * @param {number} [options.resolution] - Texels per side.
 * @returns {ShoreMap} The baked map and the transform that places it in the world.
 */
export function bakeShoreMap(device, options) {
    if (!options || typeof options !== 'object') throw new TypeError('Water: shore bake options are required');
    const {
        origin, size, heightAt,
        seaLevel = 0, maxDepth = 40, resolution = 512
    } = options;

    validatePair(origin, 'origin', false);
    validatePair(size, 'size', true);
    if (typeof heightAt !== 'function') throw new TypeError('Water: shore heightAt must be a function');
    if (!Number.isFinite(seaLevel)) throw new TypeError('Water: shore seaLevel must be finite');
    if (!Number.isFinite(maxDepth) || maxDepth <= 0) throw new RangeError('Water: shore maxDepth must be positive');
    if (!Number.isInteger(resolution) || resolution < 2 || resolution > (device.maxTextureSize || 16384)) {
        throw new RangeError('Water: shore resolution must be an integer from 2 to the device texture limit');
    }

    const n = resolution;
    const depth = new Float32Array(n * n);
    const stepX = size[0] / (n - 1);
    const stepZ = size[1] / (n - 1);

    for (let j = 0; j < n; j++) {
        const z = origin[1] + j * stepZ;
        for (let i = 0; i < n; i++) {
            const x = origin[0] + i * stepX;
            const height = heightAt(x, z);
            if (!Number.isFinite(height)) throw new TypeError(`Water: shore heightAt returned a non-finite height at (${x}, ${z})`);
            depth[j * n + i] = Math.max(seaLevel - height, 0);
        }
    }

    const data = new Uint8Array(n * n * 4);
    const at = (i, j) => depth[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];

    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const d = depth[j * n + i];

            // central differences give the direction the sea bed falls away in
            let gx = (at(i + 1, j) - at(i - 1, j)) / (2 * stepX);
            let gz = (at(i, j + 1) - at(i, j - 1)) / (2 * stepZ);
            const len = Math.hypot(gx, gz);
            if (len > 1e-6) { gx /= len; gz /= len; } else { gx = 0; gz = 0; }

            const k = (j * n + i) * 4;
            data[k] = Math.min(1, d / maxDepth) * 255;
            data[k + 1] = (gx * 0.5 + 0.5) * 255;
            data[k + 2] = (gz * 0.5 + 0.5) * 255;
            // a metre of water is already sea; the mask only needs to cut the dry land out
            data[k + 3] = Math.min(1, d / 0.6) * 255;
        }
    }

    const texture = new Texture(device, {
        name: 'waterShoreMap', width: n, height: n, format: PIXELFORMAT_RGBA8,
        mipmaps: false, minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
        levels: [data]
    });
    let destroyed = false;
    return Object.freeze({
        texture, origin: Object.freeze(origin.slice()), size: Object.freeze(size.slice()), maxDepth, seaLevel,
        get destroyed() { return destroyed; },
        destroy() { if (!destroyed) { destroyed = true; texture.destroy(); } }
    });
}

function validatePair(value, label, positive) {
    if (!Array.isArray(value) || value.length !== 2 ||
        !value.every(n => Number.isFinite(n) && (!positive || n > 0))) {
        throw new TypeError(`Water: shore ${label} must contain two finite ${positive ? 'positive ' : ''}numbers`);
    }
}

/** Internal guard also permits externally generated maps following the documented data contract. */
export function validateShoreMap(map, seaLevel) {
    if (!map || typeof map !== 'object' || !map.texture || map.destroyed) throw new TypeError('Water: expected a live shore map or null');
    validatePair(map.origin, 'origin', false);
    validatePair(map.size, 'size', true);
    if (!Number.isFinite(map.maxDepth) || map.maxDepth <= 0) throw new RangeError('Water: shore maxDepth must be positive');
    if (!Number.isFinite(map.seaLevel) || map.seaLevel !== seaLevel) {
        throw new RangeError('Water: shore map must be baked at the water seaLevel');
    }
}

/** A 1x1 stand-in meaning "deep water everywhere", bound when no coast has been supplied. */
export function createDeepWaterMap(device) {
    const texture = new Texture(device, {
        name: 'waterShoreMapNone', width: 1, height: 1, format: PIXELFORMAT_RGBA8,
        mipmaps: false, minFilter: FILTER_LINEAR, magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE,
        levels: [new Uint8Array([255, 128, 128, 255])]
    });
    return texture;
}
