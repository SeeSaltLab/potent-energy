import { Mesh, BoundingBox, Vec3 } from 'playcanvas';

/**
 * Camera-centred polar grid. Vertex density falls off geometrically with radius which gives a
 * near-constant screen-space triangle size for a surface viewed from above, without the
 * T-junction cracks of a clipmap. The mesh is translated (never rotated) to follow the camera
 * each frame; the wave field is sampled in world space so the tessellation just slides under it.
 *
 * @param {import('playcanvas').GraphicsDevice} device
 * @param {object} [opts]
 * @param {number} [opts.sectors=256]   angular subdivisions
 * @param {number} [opts.rings=320]     radial subdivisions
 * @param {number} [opts.innerRadius=0.5] radius of the first ring (m)
 * @param {number} [opts.outerRadius=20000] radius of the last ring (m)
 * @param {number} [opts.maxWaveHeight=30] used for the bounding box only
 */
export function createWaterMesh(device, opts = {}) {
    const sectors = opts.sectors ?? 256;
    const rings = opts.rings ?? 320;
    const r0 = opts.innerRadius ?? 0.5;
    const r1 = opts.outerRadius ?? 20000;
    const growth = Math.pow(r1 / r0, 1 / (rings - 1));

    const positions = [];
    const indices = [];

    // centre vertex + fan
    positions.push(0, 0, 0);
    for (let j = 0; j < rings; j++) {
        const r = r0 * Math.pow(growth, j);
        for (let i = 0; i < sectors; i++) {
            const a = (i / sectors) * Math.PI * 2;
            positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
        }
    }
    const ringBase = j => 1 + j * sectors;
    for (let i = 0; i < sectors; i++) {
        const i2 = (i + 1) % sectors;
        indices.push(0, ringBase(0) + i2, ringBase(0) + i);
    }
    for (let j = 0; j < rings - 1; j++) {
        const a = ringBase(j), b = ringBase(j + 1);
        for (let i = 0; i < sectors; i++) {
            const i2 = (i + 1) % sectors;
            // alternate the diagonal for a more isotropic triangulation
            if ((i + j) & 1) {
                indices.push(a + i, b + i2, b + i, a + i, a + i2, b + i2);
            } else {
                indices.push(a + i, a + i2, b + i, a + i2, b + i2, b + i);
            }
        }
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update();
    const h = opts.maxWaveHeight ?? 30;
    mesh.aabb = new BoundingBox(new Vec3(0, 0, 0), new Vec3(r1, h, r1));
    return mesh;
}
