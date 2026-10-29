import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** What the button shows. */
  label: ReactNode;
  /** Its accessible name, when the label alone doesn't say. */
  name?: string;
  className?: string;
  /** Which edge of the button the panel lines up with. */
  align?: "start" | "end";
  children: ReactNode;
}

/** A button that opens a small panel beneath it; closes on outside click or Escape. */
export function Menu({ label, name, className, align = "start", children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    // Any press outside, finger or mouse: pointerdown, in the capture phase,
    // since the map cancels the mouse events a touch would otherwise make.
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <span className={`menu ${align}`} ref={ref}>
      <button className={className} aria-expanded={open} aria-label={name} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className="menu-panel">{children}</div>}
    </span>
  );
}
