import { Entity, Color, Quat, Vec3, StandardMaterial } from 'playcanvas';

// A procedural navigation buoy that rides the FFT ocean. It touches the water only through
// water.getSurfaceAt(x, z) — no dependency on the vendored lib's internals — so if the ocean
// is ever swapped (license), this rig survives with a one-line change.
//
// These are the knobs. Edit them and the dev server hot-reloads; tune the framing/feel by eye.
export const BUOY = {
    position: [0, -55],     // world X, Z (metres). Y comes from the waves. Camera looks down -Z.
    scale: 1.5,             // overall size multiplier
    waterlineOffset: 0,     // metres; + raises the buoy out of the water, - sinks it
    sampleRadius: 1.1,      // metres; half-baseline between the fore/aft & port/starboard probes
    smoothTau: 0.22,        // seconds; response time of the height/tilt smoothing (probe is ~20 Hz)
    maxTilt: 18             // degrees; clamp on how far the buoy heels
};

// Palette (linear-ish RGB). Easy to retune — not exposed as runtime knobs on purpose.
const FLOAT_COLOR  = [0.62, 0.11, 0.09];  // signal red
const TOPMARK_COLOR = [0.62, 0.11, 0.09];
const MAST_COLOR   = [0.06, 0.07, 0.08];  // dark steel
const BEACON_COLOR = [1.0, 0.72, 0.20];   // amber light

const DEG2RAD = Math.PI / 180;

function makeMaterial({ diffuse, metalness = 0, gloss = 0.45, emissive = null, emissiveIntensity = 0 }) {
    const m = new StandardMaterial();
    m.diffuse = new Color(...diffuse);
    m.useMetalness = true;
    m.metalness = metalness;
    m.gloss = gloss;
    if (emissive) {
        m.emissive = new Color(...emissive);
        m.emissiveIntensity = emissiveIntensity;
    }
    m.update();
    return m;
}

function addPart(parent, type, material, scale, y) {
    const e = new Entity(type);
    e.addComponent('render', { type, material, castShadows: false });
    e.setLocalScale(scale[0], scale[1], scale[2]);
    e.setLocalPosition(0, y, 0);
    parent.addChild(e);
    return e;
}

/**
 * Build a buoy and attach it to the app. Call the returned object's update(dt) each frame,
 * after water.update(), so it reads the freshest wave field.
 *
 * @param {import('playcanvas').AppBase} app
 * @param {object} water - the Water instance (needs getSurfaceAt).
 * @param {Partial<typeof BUOY>} [opts]
 */
export function createBuoy(app, water, opts = {}) {
    const cfg = { ...BUOY, ...opts };

    const floatMat  = makeMaterial({ diffuse: FLOAT_COLOR, gloss: 0.4 });
    const topMat    = makeMaterial({ diffuse: TOPMARK_COLOR, gloss: 0.4 });
    const mastMat   = makeMaterial({ diffuse: MAST_COLOR, metalness: 0.9, gloss: 0.55 });
    const beaconMat = makeMaterial({ diffuse: [0.1, 0.08, 0.03], emissive: BEACON_COLOR, emissiveIntensity: 6 });

    const root = new Entity('Buoy');
    // Primitive default dims: cylinder r0.5 h1, cone baseR0.5 h1, sphere r0.5. Scale into metres.
    addPart(root, 'cylinder', floatMat,  [1.8, 1.4, 1.8], 0);      // float, half-submerged, spans -0.7..0.7
    addPart(root, 'cone',     topMat,    [1.1, 0.9, 1.1], 1.15);   // topmark, base at float top
    addPart(root, 'cylinder', mastMat,   [0.1, 0.7, 0.1], 1.95);   // mast
    addPart(root, 'sphere',   beaconMat, [0.32, 0.32, 0.32], 2.46);// beacon light
    root.setLocalScale(cfg.scale, cfg.scale, cfg.scale);
    app.root.addChild(root);

    // Smoothed state, so the 20 Hz probe readback doesn't make the buoy step.
    const state = { y: water.seaLevel, dhx: 0, dhz: 0, started: false };
    const _q = new Quat(), _axis = new Vec3(), _up = new Vec3(0, 1, 0), _n = new Vec3();

    function update(dt) {
        const [px, pz] = cfg.position;
        const r = cfg.sampleRadius * cfg.scale;

        // Wave height at the buoy centre and four points around it, on world axes.
        const hC = water.getSurfaceAt(px, pz).position.y;
        const hF = water.getSurfaceAt(px, pz + r).position.y;
        const hA = water.getSurfaceAt(px, pz - r).position.y;
        const hS = water.getSurfaceAt(px + r, pz).position.y;
        const hP = water.getSurfaceAt(px - r, pz).position.y;

        const targetY = hC + cfg.waterlineOffset;
        const dhx = (hS - hP) / (2 * r);   // dHeight/dx
        const dhz = (hF - hA) / (2 * r);   // dHeight/dz

        // dt-aware exponential smoothing. Snap on the first frame so it doesn't ease up from 0.
        const alpha = state.started ? 1 - Math.exp(-dt / cfg.smoothTau) : 1;
        state.started = true;
        state.y   += (targetY - state.y) * alpha;
        state.dhx += (dhx - state.dhx) * alpha;
        state.dhz += (dhz - state.dhz) * alpha;

        root.setPosition(px, state.y, pz);

        // Align the buoy's up-axis to the surface normal from the smoothed slopes, tilt clamped.
        _n.set(-state.dhx, 1, -state.dhz).normalize();
        const tilt = Math.acos(Math.max(-1, Math.min(1, _n.y)));
        const maxT = cfg.maxTilt * DEG2RAD;
        if (tilt > maxT) {
            const k = Math.tan(maxT) / Math.tan(Math.max(tilt, 1e-4));
            _n.set(-state.dhx * k, 1, -state.dhz * k).normalize();
        }
        _axis.cross(_up, _n);
        if (_axis.length() > 1e-5) {
            const a = Math.acos(Math.max(-1, Math.min(1, _up.dot(_n)))) * 180 / Math.PI;
            root.setRotation(_q.setFromAxisAngle(_axis.normalize(), a));
        } else {
            root.setRotation(Quat.IDENTITY);
        }
    }

    return { entity: root, update, config: cfg };
}
