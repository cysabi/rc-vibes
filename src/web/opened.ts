// Which rows are open under themselves: any number at once, each opening
// and shutting on its own.

import { useState } from "react";

export function useOpened(initial: string[] = []) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initial));
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  /** Just these open, every other shut. */
  const only = (keys: Iterable<string>) => setOpen(new Set(keys));
  return { isOpen: (key: string) => open.has(key), toggle, only };
}
