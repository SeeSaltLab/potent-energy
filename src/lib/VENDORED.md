# Vendored code — `src/lib/water/` and `src/lib/sky/`

Copied wholesale from the **marklundin/water** project.

- Upstream: https://github.com/marklundin/water
- Pinned commit: `bd86098d4d1d05236979c3b8cd2b27573df9ca62`
- Copied on: 2026-09-16
- What was taken: `src/water/**` and `src/sky/**` only (the reusable renderers).
  The demo, coast/bathymetry pipeline, and Poly Haven (CC0) assets were **not** copied.
- Runtime dependency: `playcanvas` (peer `^2.22.0`, installed `2.22.2`).

## ⚠️ LICENSE — BLOCKER BEFORE LAUNCH
The upstream repo has **NO license file** (GitHub reports `license: null`). Under default
copyright that means **all rights reserved** — this code may **not** be shipped on a
commercial/client site without the author's written permission.

The bundled Poly Haven textures upstream are CC0, and `docs/licenses/*` cover the PlayCanvas
engine and decoders — **none of that licenses Mark Lundin's water/sky source.**

**Action required before this goes live:** obtain written permission / a commercial license
from Mark Lundin, OR replace this renderer with an MIT-licensed ocean. This is a prototype
until that is resolved.

## Local changes
- **Mouse-repulsion ripples** (2026-09-16): built, then reverted the same day — a texture
  read/write collision in the ripple sim (not in this vendored code) corrupted every frame's
  render on WebGPU. Cut in favour of the amplitude interaction below rather than debugging
  further. No trace of it remains in these files.
- **`setAmplitude()`** (2026-09-16): one small, marked method added to `water/Water.js` — search
  for "not part of the original marklundin/water lib". Lets `src/lib/mouseAmplitude.js` (our code)
  drive `waves.amplitude` continuously from pointer speed without the buoyancy-probe reset that
  `Water#set()` triggers on every `waves` change (see the method's JSDoc for why). No shader files
  are touched by this feature. **Currently unwired** (2026-09-17, at Piyush's request) — the
  method and `mouseAmplitude.js` are both still here, just not called from `openWater.js`. Re-wire
  by importing `createMouseAmplitude` there again and calling `.update(step)` in the render loop.
- **`setWake()` + ship-wake shading** (2026-09-17): one marked method added to `water/Water.js`
  (search "not part of the original marklundin/water lib") plus matching edits in both
  `shaders/waterSurface.glsl.js` and its WGSL twin. Rejected a render-target/accumulation trail
  for this — see the ripple note above, same risk class. Instead it's fully analytic/stateless:
  `carrier.js` computes the ship's live stern position/heading/travel and calls `water.setWake()`
  every frame. In the **vertex shader**, the wake locally damps wave displacement (same mechanism
  the existing shore-shoaling code uses for shallow water, just retargeted) so the mesh itself
  calms behind the hull. In the **fragment shader**, the wake locally lowers the `jac` (folding)
  signal that already drives whitecaps everywhere else on the ocean, so the foam renders through
  that same proven pipeline (bubble texture, distance fade, aerated lighting) instead of a
  separate painted mask. `carrier.js` scales wake strength by the ship's *instantaneous* speed, not
  distance travelled, so it visibly reacts to scroll.
  - **Reverted 2026-09-17**: a follow-up pass added real geometric chop (travelling sine waves in
    the vertex shader) and a backward-streaming foam sample (`uWakeTurb`) for a more prominent
    trail. The streaming sample used `textureSample` inside a non-uniform branch (the wake's
    `along > 0 && along < length` check depends on the per-fragment `vSampleXZ` varying), which
    WGSL's uniformity analysis rejects — Chrome's WebGPU backend refused to build the pipeline
    ("Invalid RenderPipeline ... Node: Water"). Fixed once (switched to `textureSampleLevel`), but
    still wasn't landing right for Piyush, so the whole prominence pass was reverted rather than
    keep iterating — back to the version described above. If revisiting, the uniformity fix is
    still correct and worth keeping; the geometric-chop idea itself may need a different look, not
    just a bug fix.
- Everything else is untouched. The open-water bootstrap lives in `src/lib/openWater.js` (our
  code), using the "Breeze" preset = the repo's "Open water" study.
