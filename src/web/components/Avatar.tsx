/** A person as the first letter of their name in a circle. */
export function Avatar({ name, small }: { name: string; small?: boolean }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={small ? "avatar small" : "avatar"} aria-hidden="true">
      {letter}
    </span>
  );
}
