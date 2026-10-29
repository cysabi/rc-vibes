// The sketches library: a dialog over everything, every sketch as a card,
// the latest changed first, searchable by name. Each card adds its sketch to
// the room (onPick: the sketches panel adds it as a pending edit, built and
// previewed before it goes in), opens its code in its editor, or, from its
// menu, renames it, forks it (a new sketch, a git clone of it, named here and
// opened in its editor), or deletes it. The last card makes a new sketch,
// named, then opened in its editor, not added (it's the starter's wave
// until it's made into something); so does a search that finds nothing, by
// that name. Deleted sketches are another view of the dialog, swapped in
// (and back) by the button beside its close: each to restore.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_SKETCHES, defaultSketch } from "../../shared/default-sketches.ts";
import type { Sketch } from "../../shared/vibes.ts";
import { useCreateSketch, useDeletedSketches, useDeleteSketch, useForkSketch, useRenameSketch, useRestoreSketch, useSketches } from "../api.ts";
import { CloseIcon, ForkIcon, PencilIcon, PlusIcon, TrashIcon } from "../icons.tsx";
import { navigate } from "../route.ts";
import { ago } from "../words.ts";
import { CardMenu } from "./CardMenu.tsx";

interface Props {
  open: boolean;
  onPick: (sketch: { id: string; name: string }) => void;
  onClose: () => void;
}

export function AddSketch({ open, onPick, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // The name of a new one, while it's being named.
  const [naming, setNaming] = useState<string | null>(null);
  const sketches = useSketches();
  const deleted = useDeletedSketches();
  const create = useCreateSketch();
  // Which view: every sketch, or the ones deleted, to restore.
  const [view, setView] = useState<"library" | "deleted">("library");

  useEffect(() => {
    const d = dialog.current!;
    if (open && !d.open) {
      setQuery("");
      setNaming(null);
      setView("library");
      create.reset();
      d.showModal();
      // Straight to searching (not the first button, the close), with a
      // mouse. On a touch screen that would open the on-screen keyboard over
      // half the screen before anyone asked to type: tapping the search does.
      if (matchMedia("(pointer: fine)").matches) search.current?.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    } else if (!open && d.open) {
      d.close();
    }
    // Only as it opens and shuts; create is the same mutation throughout.
  }, [open]);

  const wanted = query.trim().toLowerCase();
  const matching = [...(sketches.data ?? [])].filter((s) => s.name.toLowerCase().includes(wanted));
  // vibes' own (shared/default-sketches.ts), in their own section first, in their order; then everyone's, the latest changed first.
  const defaults = DEFAULT_SKETCHES.flatMap((d) => matching.filter((s) => s.id === d.id));
  const list = matching.filter((s) => !s.builtIn).sort((a, b) => b.updatedAt - a.updatedAt);
  const gone = (deleted.data ?? []).filter((s) => s.name.toLowerCase().includes(wanted));
  const anyGone = (deleted.data?.length ?? 0) > 0;
  const swap = (to: "library" | "deleted") => {
    setView(to);
    setNaming(null);
  };
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
      aria-label="Sketches library"
    >
      <div className="add-sketch-card">
        <header className="add-sketch-head">
          <div>
            <h2>{view === "deleted" ? "Recently Deleted" : "Sketches Library"}</h2>
            <p className="muted"></p>
          </div>
          <div className="add-sketch-head-actions">
            {/* The other view: the deleted ones (while there are any), or back to every sketch. */}
            {view === "deleted" ? (
              <button className="add-sketch-swap" onClick={() => swap("library")}>
                Back to library
              </button>
            ) : (
              anyGone && (
                <button className="icon-button" onClick={() => swap("deleted")} aria-label="Recently deleted">
                  <TrashIcon />
                </button>
              )
            )}
            <button className="icon-button" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
        </header>
        <input
          ref={search}
          className="add-sketch-search"
          type="search"
          placeholder={view === "deleted" ? "Search deleted sketches" : "Search sketches"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="add-sketch-scroll">
          {view === "deleted" ? (
            gone.length > 0 ? (
              <Deleted sketches={gone} />
            ) : (
              <p className="add-sketch-quiet muted">{wanted ? `No deleted sketch called “${query.trim()}”.` : "Nothing's been deleted."}</p>
            )
          ) : sketches.isPending ? (
            <p className="add-sketch-quiet muted">Getting the sketches…</p>
          ) : list.length === 0 && defaults.length === 0 && wanted ? (
            // Nothing by that name: make it (or, if one by it was deleted, restore that).
            <div className="add-sketch-none">
              <p>
                No sketch called <b>“{query.trim()}”</b> yet.
              </p>
              <button className="primary" disabled={create.isPending} onClick={() => make(query.trim())}>
                <PlusIcon /> Make “{query.trim()}”
              </button>
              <p className="muted">It starts as a slow wave, in its editor, to make it yours. Add it here once it is.</p>
              {gone.length > 0 && (
                <button className="quiet" onClick={() => swap("deleted")}>
                  {gone.length === 1 ? "A deleted sketch matches" : `${gone.length} deleted sketches match`}
                </button>
              )}
            </div>
          ) : (
            <>
              {defaults.length > 0 && (
                <section className="add-sketch-section">
                  <h3 className="label">Default Sketches</h3>
                  <ul className="add-sketch-grid">
                    {defaults.map((s) => (
                      <li key={s.id}>
                        <Card sketch={s} onAdd={() => onPick({ id: s.id, name: s.name })} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {defaults.length > 0 && <h3 className="label add-sketch-section-head">Sketches</h3>}
              <ul className="add-sketch-grid">
                {list.map((s) => (
                  <li key={s.id}>
                    <Card sketch={s} onAdd={() => onPick({ id: s.id, name: s.name })} />
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
            </>
          )}
        </div>
        {create.isError && <p className="error-text">{create.error.message}</p>}
      </div>
    </dialog>
  );
}

/**
 * A sketch's card: its name and who's had it, then Add and View Code, and a
 * menu (CardMenu.tsx) to rename it (in place), fork it (named in place, then
 * opened), or delete it (asked once more).
 */
function Card({ sketch, onAdd }: { sketch: Sketch; onAdd: () => void }) {
  const rename = useRenameSketch();
  const fork = useForkSketch();
  const remove = useDeleteSketch();
  // Naming (renaming it, or its fork), with the name as typed; deleting, asked once more.
  const [naming, setNaming] = useState<{ what: "rename" | "fork"; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const error = rename.error ?? fork.error ?? remove.error;
  const busy = rename.isPending || fork.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = naming?.name.trim();
    if (!naming || !name) return;
    if (naming.what === "fork") fork.mutate({ id: sketch.id, name }, { onSuccess: (s) => navigate(`/sketches/${s.id}`) });
    else if (name === sketch.name) setNaming(null);
    else rename.mutate({ id: sketch.id, name }, { onSuccess: () => setNaming(null) });
  };

  return (
    <div className="add-sketch-item sketch-card">
      {naming !== null ? (
        <form className="sketch-rename" onSubmit={submit}>
          <input
            autoFocus
            value={naming.name}
            maxLength={80}
            aria-label={naming.what === "fork" ? "The fork's name" : "New name"}
            onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
          />
          <div className="add-sketch-naming-actions">
            <button className="quiet" type="button" onClick={() => setNaming(null)}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={!naming.name.trim() || busy}>
              {naming.what === "fork" ? "Fork" : "Rename"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <span className="add-sketch-name">{sketch.name}</span>
          {sketch.builtIn ? (
            // vibes' own: no one made it, and it changes with vibes.
            <span className="add-sketch-meta">{defaultSketch(sketch.id)?.about ?? "Part of vibes"}</span>
          ) : (
            <>
              <span className="add-sketch-meta">by {sketch.createdBy.name}</span>
              <span className="add-sketch-meta">
                changed {ago(sketch.updatedAt)} by {sketch.updatedBy}
              </span>
            </>
          )}
        </>
      )}
      {deleting ? (
        <div className="sketch-card-confirm">
          <span>Delete for everyone? Anyone can restore it.</span>
          <button className="quiet danger" disabled={remove.isPending} onClick={() => remove.mutate(sketch.id)}>
            Delete it
          </button>
          <button className="quiet" onClick={() => setDeleting(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="sketch-card-actions">
          <button className="primary" onClick={onAdd}>
            Add
          </button>
          {/* vibes' own has no code to view, rename, fork or delete. */}
          {!sketch.builtIn && (
            <>
              <button className="quiet" onClick={() => navigate(`/sketches/${sketch.id}`)}>
                View Code
              </button>
              <CardMenu
                name={`More for ${sketch.name}`}
                items={[
                  { label: "Rename", icon: <PencilIcon />, onSelect: () => setNaming({ what: "rename", name: sketch.name }) },
                  { label: "Fork", icon: <ForkIcon />, onSelect: () => setNaming({ what: "fork", name: `${sketch.name} fork` }) },
                  { label: "Delete", icon: <TrashIcon />, danger: true, onSelect: () => setDeleting(true) },
                ]}
              />
            </>
          )}
        </div>
      )}
      {error && <span className="error-text">{error.message}</span>}
    </div>
  );
}

/** The deleted sketches, the dialog's other view: anyone can restore them, for everyone. */
function Deleted({ sketches }: { sketches: Sketch[] }) {
  const restore = useRestoreSketch();
  return (
    <section className="add-sketch-deleted">
      <ul>
        {sketches.map((s) => (
          <li key={s.id}>
            <span className="add-sketch-deleted-text">
              <span className="add-sketch-name">{s.name}</span>
              <span className="add-sketch-meta">
                deleted {ago(s.deleted!.at)} by {s.deleted!.by}
              </span>
            </span>
            <button className="quiet" disabled={restore.isPending} onClick={() => restore.mutate(s.id)}>
              Restore
            </button>
          </li>
        ))}
      </ul>
      {restore.isError && <p className="error-text">Couldn't restore it: {restore.error.message}</p>}
    </section>
  );
}
