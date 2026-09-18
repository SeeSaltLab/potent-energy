import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { bindTheatreCamera } from './theatreCamera.js';

gsap.registerPlugin(ScrollTrigger);

// This file's only job is turning scroll position into a smoothed 0-1 progress value and
// mapping that onto the Theatre.js sequence. The camera path itself — position, look target,
// how many "scenes" it visits — is authored visually in @theatre/studio (see theatreCamera.js),
// not hardcoded here as a waypoints array. openWater.js's render loop reads VIEW's height/x/z
// (position) and lookAt (orientation) live every frame, unchanged.
export const SCROLL_CAMERA = {
    scrub: 1 // seconds of lag behind the scrollbar — smooths jitter, not a 1:1 snap
};

/**
 * Drive the Theatre.js-authored camera sequence from scroll, and (if a carrier is passed) feed
 * it live scroll velocity so it cruises faster while the page is actively scrolling. Call once,
 * after mountOpenWater() resolves.
 *
 * @param {object} view - the live VIEW config object (mountOpenWater's returned `.view`).
 * @param {ReturnType<import('./carrier.js').createCarrier>} [carrier] - mountOpenWater's
 *   returned `.carrier`. Omit to skip the scroll-speed boost (the ship still cruises at its own
 *   constant `cruiseSpeed`, just without the boost).
 * @param {Partial<typeof SCROLL_CAMERA>} [opts]
 */
export function bindScrollCamera(view, carrier, opts = {}) {
    const cfg = { ...SCROLL_CAMERA, ...opts };
    const theatre = bindTheatreCamera(view);
    const progress = { t: 0 };

    const tl = gsap.timeline({
        scrollTrigger: {
            trigger: document.body,
            start: 'top top',
            end: 'bottom bottom',
            scrub: cfg.scrub
        }
    });
    // ease: 'none' — in a *scrubbed* timeline, an eased tween decelerates to a stop at its end
    // and would fight the fact that this is the only leg; linear keeps this proxy's rate of
    // change proportional to scroll speed, which is what should drive the sequence.
    tl.to(progress, {
        t: 1, duration: 1, ease: 'none',
        onUpdate: () => theatre.setProgress(progress.t)
    });

    // The trigger's "bottom bottom" end position (#scroll-space's height, i.e. the full page
    // scroll range) isn't resolved yet on the same tick the timeline is created here — without
    // this, ScrollTrigger.end stays undefined and the whole sequence sits stuck at progress 0.
    ScrollTrigger.refresh();

    // Ship speed boost: read live off the ticker (not the scrub timeline's onUpdate, which only
    // fires while the scroll position is actually changing) so getVelocity() correctly decays
    // back to 0 a moment after the user stops scrolling, instead of freezing at its last value.
    if (carrier) {
        const st = tl.scrollTrigger;
        gsap.ticker.add(() => { carrier.config.scrollVelocity = st.getVelocity(); });
    }

    return { timeline: tl, theatre, config: cfg };
}
