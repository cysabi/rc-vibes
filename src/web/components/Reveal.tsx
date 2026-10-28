// What opens under a row (room tone's color, a shader's parameters), easing
// open and shut: its height grows from nothing to what it takes as it fades
// in, and shrinks back as it fades out, kept until it's gone. Open, its
// height is its own again, so it follows whatever's in it. With reduced
// motion, it's just there, or not.

import { useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";

// A little longer than the CSS transition: if its end never comes (reduced
// motion, a tab in the background), it settles anyway.
const SETTLE_MS = 450;

export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  // Whether it's there at all, and its height: in px while it eases, its own ("auto") once open.
  const [mounted, setMounted] = useState(open);
  const [height, setHeight] = useState<number | "auto">(open ? "auto" : 0);
  const inner = useRef<HTMLDivElement>(null);
  const last = useRef(children);
  if (open) last.current = children;
  // What it was last asked to be, so a change is told from a render.
  const was = useRef(open);

  useLayoutEffect(() => {
    if (open) {
      if (!mounted) {
        // In shut first, so there's something to ease from; back here once it is.
        setMounted(true);
        return;
      }
      if (was.current) return;
      was.current = true;
      const to = inner.current!.offsetHeight;
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setHeight(to)));
      const settle = window.setTimeout(() => setHeight("auto"), SETTLE_MS);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(settle);
      };
    }
    if (!was.current || !mounted) return;
    was.current = false;
    // From its height now (set, so there's something to ease from) to nothing, then gone.
    setHeight(inner.current!.offsetHeight);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setHeight(0)));
    const gone = window.setTimeout(() => setMounted(false), SETTLE_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(gone);
    };
  }, [open, mounted]);

  // Open and there: its own height from here on, so what's in it can grow and shrink.
  const settled = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.propertyName === "height" && open) setHeight("auto");
  };

  if (!mounted) return null;
  return (
    <div className={height === 0 ? "reveal" : "reveal open"} style={height === "auto" ? undefined : { height }} onTransitionEnd={settled}>
      {/* While it shuts, what it last showed. */}
      <div className="reveal-inner" ref={inner}>
        {open ? children : last.current}
      </div>
    </div>
  );
}
