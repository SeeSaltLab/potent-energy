/**
 * The supported water configuration. Partial objects are accepted by the constructor, set() and
 * reset(). Colours are linear RGB; distances are metres; headings are degrees.
 *
 * @typedef {object} WaterConfig
 * @property {number} seaLevel - World Y of the undisturbed surface.
 * @property {'low'|'medium'|'high'} quality - A matched FFT, tessellation and reflection budget.
 * @property {{speed:number, direction:number}} wind - Wind sea, with speed in metres per second.
 * @property {{strength:number, direction:number}} swell - Independent long-period wave energy.
 * @property {{amplitude:number, choppiness:number}} waves - Displacement and crest-shape multipliers.
 * @property {number} roughness - Microfacet roughness, from 0 to 1.
 * @property {{color:number[], visibility:number}} volume - Scattered colour and approximate green
 * channel 1/e attenuation distance. Extinction is [3.2, 1, 0.6] / visibility in inverse metres.
 * @property {number} foam - Foam coverage multiplier. Zero removes foam.
 * @property {{enabled:boolean, strength:number, scale:number}} caustics - Focused light, with scale
 * setting the inverse filtering footprint in metres; the pattern follows the FFT waves. Opt-in.
 * @property {number} seed - Reproducible unsigned 32-bit wave seed.
 * @property {number} timeScale - Simulation speed. Zero pauses water animation.
 */
export const WATER_DEFAULTS = freezeConfig({
    seaLevel: 0,
    quality: 'medium',
    wind: { speed: 9, direction: 35 },
    swell: { strength: 0.6, direction: -20 },
    waves: { amplitude: 1, choppiness: 1.4 },
    roughness: 0.06,
    volume: { color: [0.003, 0.075, 0.11], visibility: 10 },
    foam: 1,
    caustics: { enabled: false, strength: 1, scale: 0.2 },
    seed: 1337,
    timeScale: 1
});

/** Internal configuration helpers. The package exposes defaults, not the merge machinery. */
export function freezeConfig(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freezeConfig);
        Object.freeze(value);
    }
    return value;
}

const isObject = value => value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function mergeConfig(base, patch, path = '') {
    if (!isObject(patch)) throw new TypeError(`Water: ${path || 'configuration'} must be a plain object`);
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const name = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(base, key)) throw new TypeError(`Water: unknown configuration field "${name}"`);
        if (value === undefined) continue;
        if (isObject(base[key])) result[key] = mergeConfig(base[key], value, name);
        else if (Array.isArray(base[key])) {
            if (!Array.isArray(value)) throw new TypeError(`Water: ${name} must be an array`);
            result[key] = value.slice();
        } else {
            if (typeof value !== typeof base[key]) throw new TypeError(`Water: ${name} must be a ${typeof base[key]}`);
            result[key] = value;
        }
    }
    return result;
}

const RANGES = {
    seaLevel: [-Infinity, Infinity],
    'wind.speed': [0, 40], 'wind.direction': [-Infinity, Infinity],
    'swell.strength': [0, 3], 'swell.direction': [-Infinity, Infinity],
    'waves.amplitude': [0, 3], 'waves.choppiness': [0, 2.5],
    roughness: [0, 1], 'volume.visibility': [0.1, 1000],
    foam: [0, 2], 'caustics.strength': [0, 4], 'caustics.scale': [0.01, 2],
    seed: [0, 0xffffffff], timeScale: [0, 10]
};

function validateNumbers(value, path = '') {
    for (const [key, item] of Object.entries(value)) {
        const name = path ? `${path}.${key}` : key;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            validateNumbers(item, name);
        } else if (typeof item === 'number') {
            const [min, max] = RANGES[name];
            if (!Number.isFinite(item) || item < min || item > max) {
                throw new RangeError(`Water: ${name} must be finite and in [${min}, ${max}]`);
            }
        }
    }
}

/** Validate an entire partial update before changing the live instance. */
export function resolveWaterConfig(patch = {}, base = WATER_DEFAULTS) {
    const next = mergeConfig(base, patch);
    validateNumbers(next);
    if (!['low', 'medium', 'high'].includes(next.quality)) {
        throw new RangeError('Water: quality must be low, medium or high');
    }
    if (!Number.isInteger(next.seed)) throw new RangeError('Water: seed must be an unsigned 32-bit integer');
    const color = next.volume.color;
    if (color.length !== 3 || !Array.from(color).every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
        throw new TypeError('Water: volume.color must contain three linear RGB values in [0, 1]');
    }
    // Normalize equivalent headings so repeating a full turn does not regenerate the spectrum.
    for (const key of ['wind', 'swell']) {
        const direction = ((next[key].direction + 180) % 360 + 360) % 360 - 180;
        if (direction !== next[key].direction) next[key] = { ...next[key], direction };
    }
    return freezeConfig(next);
}

export function configEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && configEqual(a[key], b[key]));
}
