// Adding a sketch to the selected lights: a dialog over everything, with
// every sketch as a card, the latest changed first, searchable by name.
// Picking one hands it back (onPick); the selection panel adds it as a
// pending edit, built and previewed before it goes in. The last card makes a
// new sketch instead, as the library's New sketch does: named, then opened
// in its editor, not added (it's the starter's wave until it's made into
// something); so does a search that finds nothing, by that name.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useCreateSketch, useSketches } from "../api.ts";
import { CloseIcon, PlusIcon } from "../icons.tsx";
import { navigate } from "../route.ts";
import { ago, count } from "../words.ts";

interface Props {
  open: boolean;
  /** How many lights it'd go on. */
  lights: number;
  onPick: (sketch: { id: string; name: string }) => void;
  onClose: () => void;
}

export function AddSketch({ open, lights, onPick, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // The name of a new one, while it's being named.
  const [naming, setNaming] = useState<string | null>(null);
  const sketches = useSketches();
  const create = useCreateSketch();

  useEffect(() => {
    const d = dialog.current!;
    if (open && !d.open) {
      setQuery("");
      setNaming(null);
      create.reset();
      d.showModal();
      // Straight to searching (not the first button, the close).
      search.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
    // Only as it opens and shuts; create is the same mutation throughout.
  }, [open]);

  const wanted = query.trim().toLowerCase();
  const list = [...(sketches.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).filter((s) => s.name.toLowerCase().includes(wanted));
  const make = (name: string) => create.mutate(name, { onSuccess: (s) => navigate(`/sketches/${s.id}`) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (naming?.trim()) make(naming.trim());
  };

  return (
    <dialog
      ref={dialog}
      className="add-sketch"
      onClose={onClose}
      // A click on the backdrop (the dialog itself, outside its card) closes it.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      // Escape closes just this, not (as it would on the page) the selection too.
      onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}
      aria-label="Add a sketch"
    >
      <div className="add-sketch-card">
        <header className="add-sketch-head">
          <div>
            <h2>Add a sketch</h2>
            <p className="muted">
              To these {count(lights, "light")}. vibes builds its main, and the map shows it before it goes in.
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close" title="Close">
            <CloseIcon />
          </button>
        </header>
        <input ref={search} className="add-sketch-search" type="search" placeholder="Search sketches" value={query} onChange={(e) => setQuery(e.target.value)} />

        <div className="add-sketch-scroll">
          {sketches.isPending ? (
            <p className="add-sketch-quiet muted">Getting the sketches…</p>
          ) : list.length === 0 && wanted ? (
            // Nothing by that name: make it.
            <div className="add-sketch-none">
              <p>
                No sketch called <b>“{query.trim()}”</b> yet.
              </p>
              <button className="primary" disabled={create.isPending} onClick={() => make(query.trim())}>
                <PlusIcon /> Make “{query.trim()}”
              </button>
              <p className="muted">It starts as a slow wave, in its editor, to make it yours. Add it here once it is.</p>
            </div>
          ) : (
            <ul className="add-sketch-grid">
              {list.map((s) => (
                <li key={s.id}>
                  <button className="add-sketch-item" onClick={() => onPick({ id: s.id, name: s.name })}>
                    <span className="add-sketch-name">{s.name}</span>
                    <span className="add-sketch-meta">by {s.createdBy.name}</span>
                    <span className="add-sketch-meta">
                      changed {ago(s.updatedAt)} by {s.updatedBy}
                    </span>
                  </button>
                </li>
              ))}
              {/* A new one, last: a skeleton of a card, named here. */}
              <li>
                {naming === null ? (
                  <button className="add-sketch-item add-sketch-new" onClick={() => setNaming(query.trim())}>
                    <PlusIcon />
                    <span className="add-sketch-name">New sketch</span>
                    <span className="add-sketch-meta">A slow wave to start from</span>
                  </button>
                ) : (
                  <form className="add-sketch-item add-sketch-new naming" onSubmit={submit}>
                    <input autoFocus placeholder="Its name" value={naming} maxLength={80} onChange={(e) => setNaming(e.target.value)} />
                    <div className="add-sketch-naming-actions">
                      <button className="quiet" type="button" onClick={() => setNaming(null)}>
                        Cancel
                      </button>
                      <button className="primary" type="submit" disabled={!naming.trim() || create.isPending}>
                        Make it
                      </button>
                    </div>
                  </form>
                )}
              </li>
            </ul>
          )}
        </div>
        {create.isError && <p className="error-text">{create.error.message}</p>}
      </div>
    </dialog>
  );
}
