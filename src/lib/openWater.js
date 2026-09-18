import {
    AppBase, AppOptions, createGraphicsDevice, Entity, Color, Vec3, Quat,
    RenderComponentSystem, CameraComponentSystem, LightComponentSystem, ScriptComponentSystem,
    ContainerHandler, TextureHandler, FOG_EXP2, DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2
} from 'playcanvas';
import { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import { Water } from './water/index.js';
import { Sky } from './sky/index.js';
import { createCarrier } from './carrier.js';
import { createShoreBase } from './shoreBase.js';

// "Open water" study, ported from marklundin/water demo/presets.js ("Breeze").
// Wind-driven waves and long swell against an open horizon; caustics off (no seabed).
const WATER = {
    wind:     { speed: 9, direction: 35 },
    swell:    { strength: 0.6, direction: -20 },
    waves:    { amplitude: 0.55, choppiness: 1.4 },
    roughness: 0.06,
    volume:   { color: [0.003, 0.075, 0.11], visibility: 10 },
    foam:      1,
    caustics: { enabled: false },
    quality:  'medium'
};
const SKY = { sunElevation: 25, sunAzimuth: 165, haze: 0.5, exposure: 0.6 };
const GRADE = { saturation: 1.05, contrast: 1.03, bloom: 0.025 };

// The water mesh follows the camera, so camera XZ doesn't reveal new "terrain" — but the
// carrier sits at a fixed world position, so x/z here is how scroll (see scrollCamera.js)
// dollies the camera toward or past it.
const VIEW = {
    height: 6,        // metres above sea level
    pitch: -5,        // degrees; negative tips the horizon up so more sea shows. Ignored while lookAt is set.
    yawSwing: 14,     // degrees of slow left/right drift. Ignored while lookAt is set.
    yawRate: 0.035,   // radians/sec of the drift oscillation
    bob: 0.12,        // metres of vertical swell on the camera
    x: 0,             // world X (metres). Static by default; scroll-tweened by scrollCamera.js.
    z: 0,             // world Z (metres). Camera looks down -Z, so more negative = further "in".
    lookAt: null      // [x,y,z] world point to face, or null for the pitch/yawSwing idle sway above.
                       // scrollCamera.js sets this so camera position sweeps read as "orbiting".
};

export async function mountOpenWater(canvas) {
    // WebGPU (compute FFT) with a WebGL2 (fragment FFT) fallback.
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
        antialias: false,
        alpha: false
    });
    device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);
    console.log(`[openWater] device: ${device.isWebGPU ? 'WebGPU' : 'WebGL2'}`);

    const app = new AppBase(canvas);
    const opts = new AppOptions();
    opts.graphicsDevice = device;
    opts.componentSystems = [
        RenderComponentSystem, CameraComponentSystem, LightComponentSystem, ScriptComponentSystem
    ];
    opts.resourceHandlers = [ContainerHandler, TextureHandler];
    app.init(opts);
    app.setCanvasFillMode('FILL_WINDOW');
    app.setCanvasResolution('AUTO');
    window.addEventListener('resize', () => app.resizeCanvas());

    // ---- camera ----
    const camera = new Entity('Camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.02, 0.04, 0.08),
        nearClip: 0.25,
        farClip: 60000,
        fov: 48
    });
    camera.setPosition(VIEW.x, VIEW.height, VIEW.z);
    camera.setLocalEulerAngles(VIEW.pitch, 0, 0);
    app.root.addChild(camera);

    // ---- post: HDR camera frame. The water writes linear radiance into the scene colour
    // buffer and reads it back for refraction / screen-space reflection, so it needs the
    // scene colour + depth maps and a single tone-map at the end. ----
    camera.addComponent('script');
    const frame = camera.script.create(CameraFrame);
    frame.rendering.renderFormat = 'rgba16';
    frame.rendering.samples = 4;
    frame.rendering.sceneColorMap = true;
    frame.rendering.sceneDepthMap = true;
    frame.rendering.toneMapping = 'aces2';
    frame.rendering.sharpness = 0.15;
    frame.bloom.enabled = true;
    frame.bloom.intensity = GRADE.bloom;
    frame.vignette.enabled = true;
    frame.vignette.inner = 0.5;
    frame.vignette.outer = 1.35;
    frame.vignette.curvature = 0.7;
    frame.vignette.intensity = 0.2;
    frame.grading.enabled = true;
    frame.grading.saturation = GRADE.saturation;
    frame.grading.contrast = GRADE.contrast;

    // ---- sky + sun ----
    const sun = new Entity('Sun');
    sun.addComponent('light', { type: 'directional', castShadows: false });
    app.root.addChild(sun);

    const sky = new Sky(app, SKY);
    const water = new Water(app, WATER);
    const carrier = createCarrier(app, water);
    const shoreBase = createShoreBase(app, water);

    const _axis = new Vec3(), _up = new Vec3(0, 1, 0), _q = new Quat();
    const horizon = new Color(0.45, 0.5, 0.55);
    // Set by the control panel to art-direct the sun's hue. null = physically derived (default).
    const lightOverride = { color: null };

    // Point the directional light at the sun and colour it from the atmosphere. Without this
    // there is no sun glint on the water. (Mirrors the demo's syncSun.)
    const syncSun = () => {
        const d = sky.getSunDirection();
        _axis.cross(_up, d);
        const angle = Math.acos(Math.max(-1, Math.min(1, _up.dot(d)))) * 180 / Math.PI;
        if (_axis.length() > 1e-5) sun.setRotation(_q.setFromAxisAngle(_axis.normalize(), angle));
        else sun.setRotation(Quat.IDENTITY);
        const c = sky.getSunColor();
        const mx = Math.max(c.r, c.g, c.b, 1e-3);
        // Override replaces hue only; brightness stays physically derived from elevation/haze.
        sun.light.color = lightOverride.color || new Color(c.r / mx, c.g / mx, c.b / mx);
        sun.light.intensity = mx;
        if (sky.ready) {
            water.setEnvironment(sky.environment);
            // Image-based lighting for the carrier (and any future opaque props). The sky's
            // prefiltered RGBP atlas is exactly the format scene.envAtlas expects.
            if (sky.environment.atlas) app.scene.envAtlas = sky.environment.atlas;
        }
    };
    // Subscribe before the first frame: GPU environment creation is deferred to the next update.
    sky.onUpdate = () => {
        syncSun();
        sky.readHorizonColor().then(h => { if (h) horizon.set(...h); });
    };
    syncSun();

    // Aerial perspective: fade the distant sea into the sky haze.
    app.scene.fog.type = FOG_EXP2;
    app.scene.fog.color = horizon;

    // ---- loop: slow cinematic drift so the open horizon reads as motion ----
    let t = 0;
    app.on('update', (dt) => {
        const step = Math.min(dt, 0.05);
        t += step;
        camera.setPosition(VIEW.x, VIEW.height + Math.sin(t * 0.2) * VIEW.bob, VIEW.z);
        if (VIEW.lookAt) {
            camera.lookAt(VIEW.lookAt[0], VIEW.lookAt[1], VIEW.lookAt[2]);
        } else {
            camera.setLocalEulerAngles(VIEW.pitch, Math.sin(t * VIEW.yawRate) * VIEW.yawSwing, 0);
        }
        water.update(step, camera);
        carrier.update(step);
        app.scene.fog.density = sky.aerialDensity;
        app.scene.fog.color.copy(horizon);
    });

    app.start();
    return { app, water, sky, carrier, shoreBase, camera, frame, view: VIEW, lightOverride };
}
