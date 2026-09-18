import { Pane } from 'tweakpane';
import { Color } from 'playcanvas';

// Tweakpane sidebar for tuning the scene by eye. Binds to the live objects mountOpenWater()
// returns: water/sky go through their validated set()/setParams() (config is frozen, so direct
// binding can't mutate it); VIEW, frame and carrier.config are plain mutable objects the render
// loop already reads every frame, so the panel binds them directly.
export function createControlPanel({ water, sky, carrier, shoreBase, frame, view, lightOverride }) {
    const pane = new Pane({ title: 'Scene' });

    // ---- sky / sun ----
    const skyFolder = pane.addFolder({ title: 'Sky & Sun' });
    const skyState = { ...sky.params };
    const pushSky = () => sky.setParams(skyState);
    skyFolder.addBinding(skyState, 'sunElevation', { min: -10, max: 90, step: 0.5 }).on('change', pushSky);
    skyFolder.addBinding(skyState, 'sunAzimuth', { min: -180, max: 180, step: 1 }).on('change', pushSky);
    skyFolder.addBinding(skyState, 'haze', { min: 0, max: 5, step: 0.05 }).on('change', pushSky);
    skyFolder.addBinding(skyState, 'exposure', { min: 0, max: 3, step: 0.01 }).on('change', pushSky);

    const overrideState = { enabled: false, color: { r: 1, g: 0.9, b: 0.75 } };
    skyFolder.addBinding(overrideState, 'enabled', { label: 'Override sun colour' }).on('change', (ev) => {
        lightOverride.color = ev.value ? new Color(overrideState.color.r, overrideState.color.g, overrideState.color.b) : null;
    });
    skyFolder.addBinding(overrideState, 'color', { label: 'Sun colour', color: { type: 'float' } }).on('change', (ev) => {
        if (overrideState.enabled) lightOverride.color = new Color(ev.value.r, ev.value.g, ev.value.b);
    });

    // ---- water ----
    const waterFolder = pane.addFolder({ title: 'Water' });
    const c = water.config.volume.color;
    const waterState = {
        windSpeed: water.config.wind.speed, windDirection: water.config.wind.direction,
        swellStrength: water.config.swell.strength, swellDirection: water.config.swell.direction,
        choppiness: water.config.waves.choppiness,
        roughness: water.config.roughness, foam: water.config.foam,
        visibility: water.config.volume.visibility,
        volumeColor: { r: c[0], g: c[1], b: c[2] },
        quality: water.config.quality
    };
    const pushWater = () => water.set({
        wind: { speed: waterState.windSpeed, direction: waterState.windDirection },
        swell: { strength: waterState.swellStrength, direction: waterState.swellDirection },
        waves: { choppiness: waterState.choppiness },
        roughness: waterState.roughness,
        foam: waterState.foam,
        volume: { visibility: waterState.visibility, color: [waterState.volumeColor.r, waterState.volumeColor.g, waterState.volumeColor.b] },
        quality: waterState.quality
    });
    waterFolder.addBinding(waterState, 'windSpeed', { min: 0, max: 25, step: 0.5, label: 'Wind speed' }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'windDirection', { min: -180, max: 180, step: 1, label: 'Wind dir' }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'swellStrength', { min: 0, max: 3, step: 0.05, label: 'Swell strength' }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'swellDirection', { min: -180, max: 180, step: 1, label: 'Swell dir' }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'choppiness', { min: 0, max: 2.5, step: 0.05 }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'roughness', { min: 0, max: 1, step: 0.01 }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'foam', { min: 0, max: 2, step: 0.05 }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'visibility', { min: 1, max: 60, step: 1 }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'volumeColor', { label: 'Water colour', color: { type: 'float' } }).on('change', pushWater);
    waterFolder.addBinding(waterState, 'quality', { options: { Low: 'low', Medium: 'medium', High: 'high' } }).on('change', pushWater);

    // ---- camera / motion (VIEW is read directly by the render loop, so bind it live) ----
    const cameraFolder = pane.addFolder({ title: 'Camera', expanded: false });
    cameraFolder.addBinding(view, 'height', { min: 1, max: 30, step: 0.5 });
    cameraFolder.addBinding(view, 'pitch', { min: -30, max: 30, step: 0.5 });
    cameraFolder.addBinding(view, 'yawSwing', { min: 0, max: 45, step: 1, label: 'Yaw swing' });
    cameraFolder.addBinding(view, 'yawRate', { min: 0, max: 0.2, step: 0.005, label: 'Yaw rate' });
    cameraFolder.addBinding(view, 'bob', { min: 0, max: 1, step: 0.01 });
    cameraFolder.addBinding(view, 'x', { min: -300, max: 300, step: 5 });
    cameraFolder.addBinding(view, 'z', { min: -300, max: 300, step: 5 });

    // ---- post / grade (CameraFrame's own live properties) ----
    const gradeFolder = pane.addFolder({ title: 'Post / Grade', expanded: false });
    gradeFolder.addBinding(frame.bloom, 'intensity', { min: 0, max: 0.2, step: 0.005, label: 'Bloom' });
    gradeFolder.addBinding(frame.grading, 'saturation', { min: 0, max: 2, step: 0.01 });
    gradeFolder.addBinding(frame.grading, 'contrast', { min: 0, max: 2, step: 0.01 });
    gradeFolder.addBinding(frame.vignette, 'intensity', { min: 0, max: 1, step: 0.01, label: 'Vignette' });

    // ---- carrier (carrier.config is the live per-instance object the update loop reads) ----
    const carrierFolder = pane.addFolder({ title: 'Carrier', expanded: false });
    const carrierPos = { x: carrier.config.position[0], z: carrier.config.position[1] };
    carrierFolder.addBinding(carrierPos, 'x', { min: -500, max: 500, step: 5 }).on('change', (ev) => {
        carrier.config.position[0] = ev.value;
    });
    carrierFolder.addBinding(carrierPos, 'z', { min: -1000, max: -50, step: 5, label: 'Distance (-Z)' }).on('change', (ev) => {
        carrier.config.position[1] = ev.value;
    });
    carrierFolder.addBinding(carrier.config, 'heading', { min: 0, max: 360, step: 1 });
    carrierFolder.addBinding(carrier.config, 'scale', { min: 1, max: 20, step: 0.1 });
    carrierFolder.addBinding(carrier.config, 'waterlineOffset', { min: -10, max: 10, step: 0.1, label: 'Waterline' });
    carrierFolder.addBinding(carrier.config, 'sampleRadius', { min: 0.5, max: 15, step: 0.1, label: 'Sample radius' });
    carrierFolder.addBinding(carrier.config, 'smoothTau', { min: 0.1, max: 5, step: 0.05, label: 'Smoothing' });
    carrierFolder.addBinding(carrier.config, 'maxTilt', { min: 0, max: 20, step: 0.5, label: 'Max tilt' });
    // cruiseSpeed/scrollBoost/wake* are scroll-choreography knobs, not ambient ones — tuned by
    // editing CARRIER in carrier.js directly, same convention as scrollCamera.js. Not on the panel.

    // ---- shore base (placeholder box; shoreBase.apply() re-reads its config after each change) ----
    if (shoreBase) {
        const sbFolder = pane.addFolder({ title: 'Shore Base', expanded: false });
        const sbPos = { x: shoreBase.config.position[0], z: shoreBase.config.position[1] };
        const sbSize = { w: shoreBase.config.size[0], h: shoreBase.config.size[1], d: shoreBase.config.size[2] };
        sbFolder.addBinding(sbPos, 'x', { min: -800, max: 800, step: 5 }).on('change', (ev) => {
            shoreBase.config.position[0] = ev.value; shoreBase.apply();
        });
        sbFolder.addBinding(sbPos, 'z', { min: -1500, max: 0, step: 5, label: 'Distance (-Z)' }).on('change', (ev) => {
            shoreBase.config.position[1] = ev.value; shoreBase.apply();
        });
        sbFolder.addBinding(shoreBase.config, 'y', { min: -20, max: 80, step: 1, label: 'Height' }).on('change', () => shoreBase.apply());
        sbFolder.addBinding(sbSize, 'w', { min: 10, max: 600, step: 5, label: 'Width' }).on('change', (ev) => {
            shoreBase.config.size[0] = ev.value; shoreBase.apply();
        });
        sbFolder.addBinding(sbSize, 'h', { min: 5, max: 200, step: 5, label: 'Tall' }).on('change', (ev) => {
            shoreBase.config.size[1] = ev.value; shoreBase.apply();
        });
        sbFolder.addBinding(sbSize, 'd', { min: 10, max: 600, step: 5, label: 'Depth' }).on('change', (ev) => {
            shoreBase.config.size[2] = ev.value; shoreBase.apply();
        });
    }

    return pane;
}
