// Numbers and lists, as words.

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** "Couches", "Couches & Lobby", "Couches, Kitchen & Lobby", "Couches, Kitchen & 3 more". */
export function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} & ${names.length - 2} more`;
}

/** "1 light", "3 lights". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How long ago, roughly: "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24 * 7, "week"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return unit === "day" && n === 1 ? "yesterday" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
