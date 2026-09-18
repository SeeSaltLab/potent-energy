import { Asset, BoundingBox, Entity, Quat, Vec3 } from 'playcanvas';

// The LNG carrier hero prop. Rides the FFT ocean the same way buoy.js did — reading only
// water.getSurfaceAt(x, z), so it survives an ocean swap — but sampled across a much wider
// baseline (hull-length scale, not buoy scale) for pitch/roll instead of a tight probe.
//
// The GLB is authored at ~29.3 x 7.9 x 5.0 units (bow-stern axis = local X). CARRIER.scale
// maps that to a real-world ~290m hull. Tune by eye; dev server hot-reloads this file.
export const CARRIER = {
    url: '/models/PotentEnergy_LNG_Carrier.glb',
    position: [-225, -430], // world X, Z (metres). Y comes from the waves. Camera looks down -Z.
    heading: 173,           // degrees; yaw around Y from the model's authored forward (local +X)
    scale: 9.3,             // authored units -> metres (290m target length / 29.3 authored length)
    waterlineOffset: -7.2,  // metres; + raises the hull out of the water, - sinks it
    sampleRadius: 6.0,      // authored-space units; half-baseline between the fore/aft & port/starboard probes (scaled by `scale` below, mirrors buoy.js)
    smoothTau: 3.4,         // seconds; response time of the height/tilt smoothing — a hull this size shouldn't jitter
    maxTilt: 7.5,           // degrees; clamp on how far the hull heels (buoy's 18° reads toy-like at this scale)

    // Forward cruise: the hull always creeps ahead along `heading` at `cruiseSpeed`, and scroll
    // activity adds a temporary boost on top (scrollCamera.js feeds `scrollVelocity` live, same
    // "live external field" pattern as VIEW in openWater.js — don't hand-tune it).
    cruiseSpeed: 0,         // m/s; constant baseline forward speed. Set to 0 for now so the ship
                            // holds position while the camera path is authored against it (was 0.6
                            // — restore to bring the constant cruise back).
    scrollBoost: 0,         // extra m/s per px/s of scroll velocity. Also 0 for now so the ship
                            // stays put during scroll too (was 0.0015 — restore alongside cruiseSpeed).
    boostTau: 0.5,          // seconds; smoothing on the scroll-driven boost, so it eases in/out
    scrollVelocity: 0,      // px/s, live — set every frame by scrollCamera.js. Not for hand-tuning.

    // Wake: a Kelvin-style V of foam trailing the stern, computed analytically in the water
    // shader (see waterSurface.glsl.js/.wgsl.js) from the numbers below, pushed every frame via
    // water.setWake(). Only visible once the hull has actually travelled — see update() below.
    wakeSternOffset: 120,   // metres behind the hull centre the wake originates from (~half hull length)
    wakeMaxLength: 130,     // metres of wake visible behind the stern, regardless of total travel
    wakeHalfWidth: 5,       // metres; wake half-width right at the stern
    wakeSpread: 0.3,        // tan() of the half-angle the wake widens by per metre behind the stern
    wakeStrength: 1,        // wake intensity at wakeReferenceSpeed — scaled by instantaneous speed below
    wakeReferenceSpeed: 1.5 // m/s; speed at which the wake reaches full wakeStrength (below it fades, above it can go slightly past 1x)
};

const DEG2RAD = Math.PI / 180;

/**
 * Load the LNG carrier GLB and attach it to the app. Call the returned object's update(dt)
 * each frame, after water.update(), so it reads the freshest wave field.
 *
 * @param {import('playcanvas').AppBase} app
 * @param {object} water - the Water instance (needs getSurfaceAt).
 * @param {Partial<typeof CARRIER>} [opts]
 */
export function createCarrier(app, water, opts = {}) {
    const cfg = { ...CARRIER, ...opts };

    const root = new Entity('Carrier');
    app.root.addChild(root);

    // Smoothed state, so the 20 Hz probe readback doesn't make the hull step.
    const state = { y: water.seaLevel, dhx: 0, dhz: 0, started: false, loaded: false, travel: 0, cruiseBoost: 0 };
    const _q = new Quat(), _axis = new Vec3(), _up = new Vec3(0, 1, 0), _n = new Vec3();
    const _heading = new Quat(), _final = new Quat(), _forward = new Vec3();

    const asset = new Asset('lng-carrier', 'container', { url: cfg.url });
    app.assets.add(asset);
    app.assets.load(asset);

    asset.once('load', () => {
        const model = asset.resource.instantiateRenderEntity({ castShadows: false });
        root.addChild(model);
        root.setLocalScale(cfg.scale, cfg.scale, cfg.scale); // applied again every frame in update(), but set now so the AABB below reads real-world size
        state.loaded = true;

        // Merged world-space AABB, for tuning scale/position by the numbers instead of guessing.
        const box = new BoundingBox();
        let first = true;
        model.findComponents('render').forEach((r) => {
            r.meshInstances.forEach((mi) => {
                if (first) { box.copy(mi.aabb); first = false; }
                else box.add(mi.aabb);
            });
        });
        if (!first) {
            const s = box.halfExtents;
            console.log(
                `[carrier] world-space size (m): ${(s.x * 2).toFixed(1)} x ${(s.y * 2).toFixed(1)} x ${(s.z * 2).toFixed(1)}` +
                ` — center y: ${box.center.y.toFixed(1)}`
            );
        }
    });
    asset.once('error', (err) => console.error('[carrier] failed to load GLB:', err));

    function update(dt) {
        if (!state.loaded) return;

        root.setLocalScale(cfg.scale, cfg.scale, cfg.scale);

        // Forward speed = constant cruise + a smoothed boost from scroll activity (either
        // direction of scroll reads as "more happening", so it's the magnitude that counts).
        const rawBoost = Math.abs(cfg.scrollVelocity) * cfg.scrollBoost;
        const alphaB = 1 - Math.exp(-dt / cfg.boostTau);
        state.cruiseBoost += (rawBoost - state.cruiseBoost) * alphaB;
        state.travel += (cfg.cruiseSpeed + state.cruiseBoost) * dt;

        // Heading quat computed early so `travel` can push the hull along its own forward
        // (local +X) axis — reused again below for the final rotation.
        _heading.setFromEulerAngles(0, cfg.heading, 0);
        _heading.transformVector(Vec3.RIGHT, _forward);
        const px = cfg.position[0] + _forward.x * state.travel;
        const pz = cfg.position[1] + _forward.z * state.travel;
        const r = cfg.sampleRadius * cfg.scale;

        // Wave height at the hull centre and four points around it, on world axes.
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

        // Wave-tilt from the smoothed slopes, clamped, same as buoy.js.
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
            _q.setFromAxisAngle(_axis.normalize(), a);
        } else {
            _q.copy(Quat.IDENTITY);
        }
        // Heading first (the hull's own orientation, computed above), then the world-space
        // wave tilt on top.
        root.setRotation(_final.mul2(_q, _heading));

        // Wake trails from a point behind the stern, not the hull centre — otherwise the foam
        // starts under the ship instead of behind it. Length caps at wakeMaxLength regardless of
        // total travel, same as a real wake: it's always just the recent distance, not the whole trip.
        // Strength scales with *instantaneous* speed (not distance travelled), so the wake visibly
        // intensifies while scrolling and settles back at idle cruise — otherwise it looks the same
        // whether the ship is crawling or surging, which is the opposite of "reacting to movement".
        const speedFactor = Math.min(1.6, Math.max(0.2, (cfg.cruiseSpeed + state.cruiseBoost) / cfg.wakeReferenceSpeed));
        water.setWake({
            x: px - _forward.x * cfg.wakeSternOffset,
            z: pz - _forward.z * cfg.wakeSternOffset,
            dirX: _forward.x,
            dirZ: _forward.z,
            length: Math.min(state.travel, cfg.wakeMaxLength),
            halfWidth: cfg.wakeHalfWidth,
            spread: cfg.wakeSpread,
            strength: cfg.wakeStrength * speedFactor
        });
    }

    return { entity: root, update, config: cfg };
}
