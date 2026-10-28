// How far each opened row's head has been pushed down its row, stuck to the
// top of a panel's scroll as what it shows scrolls up under it: --stuck-by
// on the row, which cuts what it shows off at the head's bottom (and moves
// the hairline under the head along with it), so the head needn't cover it.

import { useEffect, type RefObject } from "react";

export function useStuckHeads(scroller: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const mark = () => {
      frame = 0;
      for (const row of el.querySelectorAll<HTMLElement>(".layer")) {
        const head = row.querySelector<HTMLElement>(":scope > .layer-head");
        const by = row.classList.contains("open") && head ? Math.max(0, head.getBoundingClientRect().top - row.getBoundingClientRect().top) : 0;
        const value = by > 0.5 ? `${by}px` : "";
        // Only when it changes: setting it is itself a change to the rows, which is watched.
        if (row.style.getPropertyValue("--stuck-by") !== value) {
          if (value) row.style.setProperty("--stuck-by", value);
          else row.style.removeProperty("--stuck-by");
        }
      }
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(mark);
    };
    el.addEventListener("scroll", soon, { passive: true });
    // Rows opening and shutting (and easing as they do), and the panel resizing.
    const changes = new MutationObserver(soon);
    changes.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    const sizes = new ResizeObserver(soon);
    sizes.observe(el);
    mark();
    return () => {
      el.removeEventListener("scroll", soon);
      changes.disconnect();
      sizes.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller]);
}
