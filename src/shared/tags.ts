// Light tags: free-form labels in arclamp's lights.json that shaders see on
// every light (`light.tags.includes("kitchen")`). arclamp takes any string;
// vibes keeps them easy to match in code: lowercase letters, digits, - and _.

export const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_TAGS = 16;

/** What someone typed, as a tag ("Back Wall" → "back-wall"), or null if it can't be one. */
export function normalizeTag(typed: string): string | null {
  const tag = typed.trim().toLowerCase().replace(/\s+/g, "-");
  return TAG.test(tag) ? tag : null;
}

/**
 * A tag as people read it: "dining-room" → "Dining Room", "kitchen_2" →
 * "Kitchen 2". Only for showing; the tag itself is what shaders match.
 */
export function tagLabel(tag: string): string {
  return tag
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The main space: the open floor (couches, dining room, presentation space,
 * kitchen, lobby), as against the named rooms. A light with any of these tags
 * is in it. What vibes starts with selected.
 */
export const MAIN_SPACE_TAGS = new Set(["couches", "dining-room", "presentation-space", "kitchen", "lobby", "dave"]);

export const inMainSpace = (tags: readonly string[] | null | undefined) => (tags ?? []).some((t) => MAIN_SPACE_TAGS.has(t));

/** Whether two lights' tags are the same, in any order. */
export function sameTags(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const x = new Set(a ?? []);
  const y = new Set(b ?? []);
  return x.size === y.size && [...x].every((t) => y.has(t));
}
