import { Color, Entity, StandardMaterial } from 'playcanvas';

// Placeholder for the onshore LNG terminal / oil-shore base (storyboard frames 3-5, the
// "Terminal World" in the architecture doc) — the fixed-position landfall the ship approaches.
// A plain box for now; Piyush is providing a real GLB later. When it arrives, swap the box out
// for the same Asset('container') load path carrier.js uses (URL under public/models/) — the
// position/scale config below stays the same, so nothing else needs to change.
export const SHORE_BASE = {
    position: [-800, -175], // world X, Z (metres). Placed further down -Z (the direction the ship's
                            // bow faces / "ahead") so the camera can later travel from ship to shore.
    size: [520, 200, 140],  // width (X), height (Y), depth (Z) in metres — rough terminal footprint
    y: 80,                  // centre height above sea level (metres); box straddles the waterline
    color: [0.42, 0.45, 0.48]
};

/**
 * Add the placeholder shore-base box to the scene. Static (doesn't ride the waves — it's a
 * fixed installation), so there's no per-frame update to call.
 *
 * @param {import('playcanvas').AppBase} app
 * @param {object} water - the Water instance (for seaLevel).
 * @param {Partial<typeof SHORE_BASE>} [opts]
 */
export function createShoreBase(app, water, opts = {}) {
    const cfg = { ...SHORE_BASE, ...opts };

    const entity = new Entity('ShoreBase');
    entity.addComponent('render', { type: 'box' });

    const material = new StandardMaterial();
    material.diffuse = new Color(cfg.color[0], cfg.color[1], cfg.color[2]);
    material.gloss = 0.3;
    material.metalness = 0;
    material.useMetalness = true;
    material.update();
    entity.render.material = material;

    app.root.addChild(entity);

    // Read cfg live so the control panel can retune position/size/height by eye.
    function apply() {
        entity.setLocalScale(cfg.size[0], cfg.size[1], cfg.size[2]);
        entity.setPosition(cfg.position[0], water.seaLevel + cfg.y, cfg.position[1]);
        material.diffuse.set(cfg.color[0], cfg.color[1], cfg.color[2]);
        material.update();
    }
    apply();

    return { entity, material, config: cfg, apply };
}
