import { Vec3 } from 'playcanvas';

// Dev-only free-fly camera, for scouting scrollCamera.js's SCROLL_CAMERA.waypoints by eye instead
// of guessing height/x/z numbers blind. Press F to toggle; while active it overrides the camera
// transform every frame *after* openWater.js's own update handler runs (this module's app.on
// ('update', ...) is registered later, in the same 'update' event, so it simply overwrites
// whatever the scroll-driven VIEW logic set that frame) — openWater.js itself is untouched.
//
// Controls while active: WASD move, Q/E down/up, Shift to move faster, hold the left mouse
// button and drag to look around, C to capture the current spot.
//
// Capture logs (and copies to the clipboard) a ready-to-paste waypoint object, e.g.
//   { at: 0.42, height: 38.2, x: -180.4, z: -210.7 },
// `at` is read from the page's current scroll fraction — scroll to roughly where in the
// sequence this shot belongs, then fly to frame it, then press C.
const MOVE_SPEED = 40;   // m/s, world units per second
const BOOST_MULT = 4;    // Shift multiplier
const LOOK_SPEED = 0.15; // degrees of yaw/pitch per pixel of mouse drag

export function createFlyCamera(app, camera, canvas) {
    const state = { active: false, yaw: 0, pitch: 0, keys: new Set(), dragging: false, lastX: 0, lastY: 0 };
    const _fwd = new Vec3(), _right = new Vec3(), _up = new Vec3(0, 1, 0), _move = new Vec3();

    function syncFromCamera() {
        const e = camera.getEulerAngles();
        state.pitch = e.x;
        state.yaw = e.y;
    }

    function toggle() {
        state.active = !state.active;
        if (state.active) syncFromCamera();
        console.log(`[flyCamera] ${state.active ? 'ON — WASD/QE move, drag to look, Shift to boost, C to capture, F to exit' : 'OFF'}`);
    }

    function capture() {
        const p = camera.getPosition();
        const progress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const line = `{ at: ${progress.toFixed(2)}, height: ${p.y.toFixed(1)}, x: ${p.x.toFixed(1)}, z: ${p.z.toFixed(1)} },`;
        console.log('[flyCamera] waypoint (copied to clipboard):', line);
        navigator.clipboard?.writeText(line).catch(() => {});
    }

    function onKeyDown(e) {
        const k = e.key.toLowerCase();
        if (k === 'f') { toggle(); return; }
        if (!state.active) return;
        if (k === 'c') { capture(); return; }
        state.keys.add(k);
    }
    function onKeyUp(e) { state.keys.delete(e.key.toLowerCase()); }
    function onMouseDown(e) {
        if (!state.active) return;
        state.dragging = true;
        state.lastX = e.clientX;
        state.lastY = e.clientY;
    }
    function onMouseUp() { state.dragging = false; }
    function onMouseMove(e) {
        if (!state.active || !state.dragging) return;
        state.yaw -= (e.clientX - state.lastX) * LOOK_SPEED;
        state.pitch = Math.max(-89, Math.min(89, state.pitch - (e.clientY - state.lastY) * LOOK_SPEED));
        state.lastX = e.clientX;
        state.lastY = e.clientY;
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);

    app.on('update', (dt) => {
        if (!state.active) return;

        camera.setEulerAngles(state.pitch, state.yaw, 0);
        _fwd.copy(camera.forward);
        _right.copy(camera.right);

        _move.set(0, 0, 0);
        if (state.keys.has('w')) _move.add(_fwd);
        if (state.keys.has('s')) _move.sub(_fwd);
        if (state.keys.has('d')) _move.add(_right);
        if (state.keys.has('a')) _move.sub(_right);
        if (state.keys.has('e')) _move.add(_up);
        if (state.keys.has('q')) _move.sub(_up);
        if (_move.lengthSq() > 1e-6) _move.normalize();

        const speed = MOVE_SPEED * (state.keys.has('shift') ? BOOST_MULT : 1);
        const p = camera.getPosition();
        camera.setPosition(
            p.x + _move.x * speed * dt,
            p.y + _move.y * speed * dt,
            p.z + _move.z * speed * dt
        );
    });

    return { state, toggle, capture };
}
