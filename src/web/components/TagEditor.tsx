// Tags for the lights selected in Edit lights: every tag on any of them (read
// as words, with the tag itself on hover), with how many carry it when not
// all do. A tag's × takes it off all of them, clicking one that only some
// carry puts it on the rest, and the box adds a new one to all of them.

import { useState, type FormEvent } from "react";
import { MAX_TAGS, normalizeTag, tagLabel } from "../../shared/tags.ts";
import type { TagChange } from "../../shared/vibes.ts";
import { CloseIcon, PlusIcon } from "../icons.tsx";

interface Props {
  /** The selected lights, with their tags as they are now. */
  lights: { id: number; tags: string[] }[];
  /** Every tag on any light, for suggestions. */
  known: string[];
  /** The lights whose tags change, each with its whole new set. */
  onChange: (changes: TagChange[]) => void;
}

export function TagEditor({ lights, known, onChange }: Props) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const n = lights.length;
  const counts = new Map<string, number>();
  for (const l of lights) for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts].sort(([a], [b]) => tagLabel(a).localeCompare(tagLabel(b)));

  /** Put a tag on every selected light, or take it off every one. */
  const set = (tag: string, on: boolean) => {
    const changes = lights
      .filter((l) => l.tags.includes(tag) !== on)
      .map((l) => ({ id: l.id, tags: on ? [...l.tags, tag] : l.tags.filter((t) => t !== tag) }));
    if (changes.length > 0) onChange(changes);
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const tag = normalizeTag(typed);
    if (!tag) return setError("Tags are lowercase letters, digits, - and _, up to 32 long.");
    if (lights.some((l) => !l.tags.includes(tag) && l.tags.length >= MAX_TAGS)) return setError(`A light can have at most ${MAX_TAGS} tags.`);
    set(tag, true);
    setTyped("");
    setError(null);
  };

  return (
    <section className="tag-editor" aria-label="Tags">
      <div className="tag-editor-head">
        <span className="label">Tags</span>
        <span className="muted">
          {n} {n === 1 ? "light" : "lights"}
        </span>
      </div>
      {tags.length > 0 && (
        <div className="tags">
          {tags.map(([tag, count]) => (
            <span key={tag} className={count < n ? "tag partial" : "tag"}>
              {count < n ? (
                <button className="tag-name" onClick={() => set(tag, true)} title={`${tag}: tag all ${n}`}>
                  {tagLabel(tag)}
                  <span className="tag-count">
                    {count}/{n}
                  </span>
                </button>
              ) : (
                <span className="tag-name" title={tag}>
                  {tagLabel(tag)}
                </span>
              )}
              <button className="tag-remove" onClick={() => set(tag, false)} aria-label={`Take ${tagLabel(tag)} off`} title={`Take ${tagLabel(tag)} off`}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      <form className="tag-add" onSubmit={add}>
        <input
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
          placeholder="Add a tag"
          aria-label="Add a tag"
          list="known-tags"
          maxLength={40}
          autoComplete="off"
        />
        <datalist id="known-tags">
          {known
            .filter((t) => (counts.get(t) ?? 0) < n)
            .map((t) => (
              <option key={t} value={t} />
            ))}
        </datalist>
        <button className="icon-button" type="submit" disabled={!typed.trim()} aria-label="Add the tag">
          <PlusIcon />
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
