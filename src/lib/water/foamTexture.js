import {
    Texture, PIXELFORMAT_RGBA8, FILTER_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR, ADDRESS_REPEAT
} from 'playcanvas';

// Whitewater is not noise — it is bubbles. What reads as foam is a field of round cells packed at
// several sizes, torn into filaments at the edges. A value-noise fbm gives none of that structure,
// so this bakes a tiling cellular texture once at start-up instead of pulling in an image.
//
//   r  coarse bubble clusters, the shape the eye reads first
//   g  fine bubbles, the texture inside a clump
//   b  large-scale breakup, so a foam sheet is never uniform
//   a  a soft dilation of r, used to tint the water around a patch of foam

/** Deterministic 2D hash on a wrapped integer lattice. */
function hash2(ix, iy, period, seed) {
    let x = ((ix % period) + period) % period;
    let y = ((iy % period) + period) % period;
    let h = x * 374761393 + y * 668265263 + seed * 1442695041;
    h = (h ^ (h >> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    const a = ((h ^ (h >> 16)) >>> 0) / 4294967296;
    h = Math.imul(h ^ 0x9e3779b9, 2246822519) >>> 0;
    const b = ((h ^ (h >> 15)) >>> 0) / 4294967296;
    return [a, b];
}

/**
 * Tiling cellular (Worley) field: distance to the nearest jittered feature point, normalised so 0 is
 * a cell centre and 1 is a cell boundary. Wraps exactly at `cells`.
 */
function worley(u, v, cells, seed) {
    const x = u * cells;
    const y = v * cells;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let best = 1e9;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const [jx, jy] = hash2(ix + dx, iy + dy, cells, seed);
            const px = ix + dx + jx;
            const py = iy + dy + jy;
            const d = (x - px) * (x - px) + (y - py) * (y - py);
            if (d < best) best = d;
        }
    }
    return Math.min(Math.sqrt(best), 1);
}

/** Sum of tiling cellular octaves, each an inverted distance field so cells read as bubbles. */
function bubbles(u, v, baseCells, octaves, seed) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let cells = baseCells;
    for (let o = 0; o < octaves; o++) {
        sum += amp * (1 - worley(u, v, cells, seed + o * 71));
        norm += amp;
        amp *= 0.5;
        cells *= 2;
    }
    return sum / norm;
}

/**
 * Build the foam texture. Runs once, on the CPU, at start-up.
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @param {number} [size] - Edge length in texels; must be a power of two.
 * @returns {Texture} A tiling, mipmapped RGBA texture.
 */
export function createFoamTexture(device, size = 512) {
    const data = new Uint8Array(size * size * 4);
    const inv = 1 / size;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) * inv;
            const v = (y + 0.5) * inv;

            // coarse clumps: contrast-stretched so the field is mostly empty with dense islands
            let coarse = bubbles(u, v, 6, 3, 17);
            coarse = Math.min(1, Math.max(0, (coarse - 0.34) * 2.1));
            coarse = coarse * coarse * (3 - 2 * coarse);

            // fine bubbles inside a clump
            const fine = Math.min(1, Math.max(0, (bubbles(u, v, 22, 2, 53) - 0.3) * 1.8));

            // slow breakup, so a sheet of foam has holes and streaks in it
            const broad = 0.5 + 0.5 * Math.sin((1 - worley(u, v, 3, 91)) * 5.2 + u * 6.283) *
                Math.cos(v * 6.283 * 2 + (1 - worley(u, v, 4, 29)) * 4.0);

            // a soft halo around the clumps, for tinting the water a patch of foam sits in
            const halo = Math.min(1, Math.max(0, (bubbles(u, v, 5, 2, 17) - 0.18) * 1.5));

            const i = (y * size + x) * 4;
            data[i] = coarse * 255;
            data[i + 1] = fine * 255;
            data[i + 2] = broad * 255;
            data[i + 3] = halo * 255;
        }
    }

    const tex = new Texture(device, {
        name: 'waterFoam', width: size, height: size, format: PIXELFORMAT_RGBA8,
        mipmaps: true, minFilter: FILTER_LINEAR_MIPMAP_LINEAR, magFilter: FILTER_LINEAR,
        addressU: ADDRESS_REPEAT, addressV: ADDRESS_REPEAT, anisotropy: 2,
        levels: [data]
    });
    return tex;
}
