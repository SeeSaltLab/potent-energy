import { getProject, types, val } from '@theatre/core';
// Static default import (not a dynamic import()): this is Theatre.js's documented Vite pattern.
// @theatre/studio has `sideEffects: false`, so in a production build `import.meta.env.DEV` is
// statically false, the guard block below becomes dead code, and this unused import is
// tree-shaken out entirely — studio never ships.
//
// CJS interop: Vite's dev dep-optimizer does `export default require_dist()`, which hands back
// the raw CJS module.exports ({ __esModule: true, default: <studio>, ... }) *without* unwrapping,
// so the real studio sits at `.default` here. A production Rollup build may unwrap it. Resolve
// defensively (`.initialize` present = already unwrapped) so it's correct in both.
import studioImport from '@theatre/studio';
const studio = studioImport && studioImport.initialize ? studioImport : studioImport?.default;
import cameraState from './cameraState.json';

// The camera path (position + look target, over as many "scenes" as the page grows into) is
// authored visually in @theatre/studio instead of hand-maintained as a {at, height, x, z}[]
// array — that array approach doesn't scale past a handful of waypoints, a real timeline editor
// does. @theatre/studio is dev-only and tree-shaken from the production bundle entirely (see
// CLAUDE.md); only @theatre/core (Apache-licensed) ships.
//
// Workflow: run the dev server — the Studio panel appears automatically. Drag keyframes on the
// 'Camera' object's height/x/z/targetX/targetY/targetZ tracks on the 'Hero' sheet's timeline;
// edits auto-save to this browser's localStorage as you go. When happy, click the project name
// in Studio's Outline panel -> Export, and overwrite cameraState.json with the downloaded file
// so the tuned path becomes the shipped default (no code changes needed after that).
// {} until the first Studio export is saved over cameraState.json — an empty object isn't a
// valid saved-state shape, so only pass `state` once there's actually something in the file.
const hasSavedState = Object.keys(cameraState).length > 0;
const project = getProject('Potent', hasSavedState ? { state: cameraState } : undefined);
const sheet = project.sheet('Hero');

const cameraObj = sheet.object('Camera', {
    height: types.number(450, { range: [0, 600] }),
    x: types.number(-250, { range: [-600, 600] }),
    z: types.number(-245, { range: [-600, 600] }),
    targetX: types.number(-250, { range: [-600, 600] }),
    targetY: types.number(15, { range: [-50, 100] }),
    targetZ: types.number(-245, { range: [-600, 600] })
});

if (import.meta.env.DEV) {
    studio.initialize();
}

/**
 * Wire the Theatre.js-authored camera path to a live VIEW config object (mountOpenWater's
 * returned `.view` — openWater.js's render loop already reads its height/x/z/lookAt every frame,
 * so nothing else needs to change there).
 *
 * @param {object} view
 * @returns {{ sheet: import('@theatre/core').ISheet, setProgress: (t: number) => void }}
 */
export function bindTheatreCamera(view) {
    const lookAt = [0, 0, 0];
    view.lookAt = lookAt;

    cameraObj.onValuesChange((values) => {
        view.height = values.height;
        view.x = values.x;
        view.z = values.z;
        lookAt[0] = values.targetX;
        lookAt[1] = values.targetY;
        lookAt[2] = values.targetZ;
    });

    return {
        sheet,
        /** @param {number} t - 0-1 progress through the page. */
        setProgress(t) {
            const length = val(sheet.sequence.pointer.length) || 10;
            sheet.sequence.position = t * length;
        }
    };
}
