/** Sun placement, atmospheric visibility, and one common scene exposure. */
export const DEFAULT_SKY_PARAMS = Object.freeze({
    sunElevation: 25,      // degrees, positive above the horizon
    sunAzimuth: 165,       // degrees, 0 is +Z, 90 is +X
    haze: 1,              // aerosol density relative to the Earth reference atmosphere
    exposure: 0.55        // common scale for sky radiance and direct sunlight
});

const RANGES = {
    sunElevation: [-90, 90],
    sunAzimuth: [-Infinity, Infinity],
    haze: [0, 20],
    exposure: [0, 100]
};

/** Validate a complete update before changing any live state. */
export function resolveSkyParams(patch, base = DEFAULT_SKY_PARAMS) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('Sky parameters must be an object.');
    }
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (!Object.hasOwn(RANGES, key)) throw new TypeError(`Unknown sky parameter: ${key}`);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new TypeError(`Sky parameter ${key} must be a finite number.`);
        }
        const [min, max] = RANGES[key];
        if (value < min || value > max) {
            throw new RangeError(`Sky parameter ${key} must be between ${min} and ${max}.`);
        }
        next[key] = key === 'sunAzimuth' ? ((value + 180) % 360 + 360) % 360 - 180 : value;
    }
    return Object.freeze(next);
}
