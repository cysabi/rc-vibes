import type { CSSProperties } from "react";

/** A person as the first letter of their name in a circle; ringed in a color, if given (someone else here: shared/presence.ts). */
export function Avatar({ name, small, color }: { name: string; small?: boolean; color?: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  const className = ["avatar", small && "small", color && "ringed"].filter(Boolean).join(" ");
  return (
    <span className={className} style={color ? ({ "--ring": color } as CSSProperties) : undefined} aria-hidden="true">
      {letter}
    </span>
  );
}
