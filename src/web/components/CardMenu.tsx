// A sketch card's menu (AddSketch.tsx): a "more" button that opens a short
// list of what else can be done to the sketch. The list is a popover, in the
// browser's top layer, so it shows over the library's dialog and isn't cut
// off by the scrolling grid it's in, or by the card's blurred glass (which
// would otherwise hold anything fixed inside it). It sits under the button,
// its right edges lined up, or above it when there's no room below.
//
// It closes when one of its items is chosen (before the item does its
// thing), on a click anywhere else or Escape (the browser's own light
// dismiss), and when the grid scrolls or the window resizes, rather than
// floating away from its card. Opened from the keyboard, the first item has
// focus, and the arrow keys (Home and End too) move between them.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { MoreIcon } from "../icons.tsx";

export interface CardMenuItem {
  label: string;
  icon?: ReactNode;
  /** Takes something away: after a divider, red when pointed at. */
  danger?: boolean;
  onSelect: () => void;
}

const GAP = 6;
// Less room than this under its button (px), and it opens above instead.
const ROOM = 180;

export function CardMenu({ name, items }: { name: string; items: CardMenuItem[] }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Opened by the keyboard (a click with no pointer): the first item takes focus.
  const byKeyboard = useRef(false);

  /**
   * Under the button (or above it, without room below), right edges lined
   * up: placed by its edges nearest the button, so it needn't be measured,
   * just before it shows (so it never shows anywhere else first).
   */
  const place = () => {
    const b = button.current?.getBoundingClientRect();
    const p = panel.current;
    if (!b || !p) return;
    const below = innerHeight - b.bottom >= ROOM;
    p.style.right = `${innerWidth - b.right}px`;
    p.style.top = below ? `${b.bottom + GAP}px` : "auto";
    p.style.bottom = below ? "auto" : `${innerHeight - b.top + GAP}px`;
    p.dataset.side = below ? "below" : "above";
  };

  const menuItems = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>(".card-menu-item") ?? [])];

  // Open, it follows nothing: anything that would move its button closes it.
  useEffect(() => {
    if (!open) return;
    if (byKeyboard.current) menuItems()[0]?.focus({ preventScroll: true });
    const close = () => panel.current?.hidePopover();
    addEventListener("resize", close);
    // Any scroll but the panel's own (it doesn't, but just in case).
    const scrolled = (e: Event) => e.target !== panel.current && close();
    addEventListener("scroll", scrolled, true);
    return () => {
      removeEventListener("resize", close);
      removeEventListener("scroll", scrolled, true);
    };
  }, [open]);

  const choose = (item: CardMenuItem) => {
    panel.current?.hidePopover();
    button.current?.focus();
    item.onSelect();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = menuItems();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      e.key === "ArrowDown" ? (at + 1) % all.length : e.key === "ArrowUp" ? (at - 1 + all.length) % all.length : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    all[to]?.focus();
  };

  const firstDanger = items.findIndex((i) => i.danger);
  return (
    <>
      <button
        ref={button}
        className="icon-button card-menu-button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        onClick={(e: MouseEvent) => (byKeyboard.current = e.detail === 0)}
      >
        <MoreIcon />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="menu"
        aria-label={name}
        className="card-menu"
        onBeforeToggle={(e) => e.newState === "open" && place()}
        onToggle={(e) => setOpen(e.newState === "open")}
        onKeyDown={onKeyDown}
      >
        {items.map((item, i) => (
          <div key={item.label} className="card-menu-row">
            {i === firstDanger && i > 0 && <hr className="card-menu-divider" />}
            <button role="menuitem" className={item.danger ? "card-menu-item danger" : "card-menu-item"} onClick={() => choose(item)}>
              <span className="card-menu-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
