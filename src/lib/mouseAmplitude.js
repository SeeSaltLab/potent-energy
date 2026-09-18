// Wave amplitude driven by pointer speed: moving the mouse whips up the sea, and it settles back
// to calm when the pointer slows or leaves. Couples to the ocean only through
// water.setAmplitude() — a small, marked addition to the vendored Water class (see its JSDoc) —
// so this survives if the vendored ocean is ever swapped.
export const MOUSE_AMPLITUDE = {
    base: 0.55,          // waves.amplitude at rest — matches openWater.js's WATER.waves.amplitude
    max: 1.4,            // waves.amplitude at full pointer speed (Water's validated range is [0, 3])
    speedForMax: 900,    // px/s of pointer movement that reaches `max` — lower = more responsive
    easePower: 1.3,      // >1 ease-in: ordinary movement stays subtle; only fast swipes ramp toward max
    attackTau: 0.7,      // seconds; how fast amplitude rises toward a higher target
    releaseTau: 3.2      // seconds; how fast it settles back down when the pointer slows/stops
};

/**
 * @param {import('playcanvas').AppBase} app
 * @param {import('./water/Water.js').Water} water
 * @param {Partial<typeof MOUSE_AMPLITUDE>} [opts]
 */
export function createMouseAmplitude(app, water, opts = {}) {
    const cfg = { ...MOUSE_AMPLITUDE, ...opts };
    const canvas = app.graphicsDevice.canvas;

    const pointer = { x: null, y: null };
    const last = { x: 0, y: 0, valid: false };
    let amplitude = cfg.base;

    const onMove = (e) => {
        const rect = canvas.getBoundingClientRect();
        pointer.x = e.clientX - rect.left;
        pointer.y = e.clientY - rect.top;
    };
    const onLeave = () => { pointer.x = null; pointer.y = null; };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    function update(dt) {
        const step = Math.max(dt, 1e-4);
        let target = cfg.base;

        if (pointer.x !== null) {
            if (last.valid) {
                const speed = Math.hypot(pointer.x - last.x, pointer.y - last.y) / step;
                // ease-out power curve: a slow drift already reads as a real bump, a fast swipe
                // still tops out at `max` — plain linear (speed/speedForMax) felt dead at normal
                // mouse speeds since most everyday movement sits well under speedForMax.
                const t = Math.min(speed / cfg.speedForMax, 1);
                const eased = Math.pow(t, cfg.easePower);
                target = cfg.base + eased * (cfg.max - cfg.base);
            }
            last.x = pointer.x; last.y = pointer.y; last.valid = true;
        } else {
            last.valid = false;
        }

        const tau = target > amplitude ? cfg.attackTau : cfg.releaseTau;
        amplitude += (target - amplitude) * (1 - Math.exp(-step / tau));
        water.setAmplitude(amplitude);
    }

    function destroy() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerleave', onLeave);
    }

    return { update, destroy, config: cfg, get amplitude() { return amplitude; } };
}
