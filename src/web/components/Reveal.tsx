// What opens under a row (room tone's color, a shader's parameters), easing
// open and shut: its height grows from nothing as it fades in, and shrinks
// back as it fades out, kept until it's gone. With reduced motion, it's just
// there, or not.

import { useEffect, useRef, useState, type ReactNode } from "react";

// A little longer than the CSS transition: if its end never comes (reduced
// motion, a tab in the background), it's let go anyway.
const GONE_MS = 400;

export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  // Whether it's there at all, and whether it's open (the two differ while it eases).
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const last = useRef(children);
  if (open) last.current = children;

  useEffect(() => {
    if (open) {
      setMounted(true);
      // In shut first, then open, so the browser has something to ease from.
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
      return () => cancelAnimationFrame(raf);
    }
    setExpanded(false);
    const gone = window.setTimeout(() => setMounted(false), GONE_MS);
    return () => window.clearTimeout(gone);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={expanded ? "reveal open" : "reveal"}>
      {/* While it shuts, what it last showed. */}
      <div className="reveal-inner">{open ? children : last.current}</div>
    </div>
  );
}
