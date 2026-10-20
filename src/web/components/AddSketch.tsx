// Adding a sketch to the selected lights: a dialog over everything, with
// every sketch as a card, the latest changed first, searchable by name.
// Picking one hands it back (onPick); the selection panel adds it as a
// pending edit, built and previewed before it goes in. The last card makes a
// new sketch instead, as the library's New sketch does: named, then opened
// in its editor, not added (it's the starter's wave until it's made into
// something); so does a search that finds nothing, by that name.
//
// What goes in is built from main, so first it asks vibes whether your editor
// has changes to the sketch that main hasn't (files not committed, commits
// not pushed). If it has, it asks whether to include them: pushed to main,
// then added; or added as main has it.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SketchChanges } from "../../shared/vibes.ts";
import { request, RequestError, useCreateSketch, useSketches } from "../api.ts";
import { CloseIcon, PlusIcon } from "../icons.tsx";
import { navigate } from "../route.ts";
import { ago, count, listOf } from "../words.ts";

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
  // A sketch picked whose changes in your editor main hasn't got: asking about them, and how pushing them goes.
  const [asking, setAsking] = useState<Asking | null>(null);

  useEffect(() => {
    const d = dialog.current!;
    if (open && !d.open) {
      setQuery("");
      setNaming(null);
      setAsking(null);
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
  const list = [...(sketches.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).filter((s) => s.name.toLowerCase().includes(wanted));
  const make = (name: string) => create.mutate(name, { onSuccess: (s) => navigate(`/sketches/${s.id}`) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (naming?.trim()) make(naming.trim());
  };

  // Picked: straight in, unless your editor has changes main hasn't.
  const pick = async (sketch: Picked) => {
    setAsking({ sketch, step: "checking" });
    const changes = await request<SketchChanges>("GET", `/api/sketches/${encodeURIComponent(sketch.id)}/changes`).catch((): SketchChanges => ({ unknown: true }));
    if (!("unknown" in changes) && changes.files === 0 && changes.commits === 0) {
      setAsking(null);
      onPick(sketch);
    } else setAsking({ sketch, step: "asking", changes });
  };
  // Your changes, pushed to main, then it added with them.
  const push = async (a: Asking) => {
    setAsking({ ...a, step: "pushing" });
    try {
      await request("POST", `/api/sketches/${encodeURIComponent(a.sketch.id)}/publish`, {});
      setAsking(null);
      onPick(a.sketch);
    } catch (err) {
      setAsking({ ...a, step: "refused", code: err instanceof RequestError ? err.code : "failed", error: (err as Error).message });
    }
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
          {asking ? (
            <Ask asking={asking} onPush={() => void push(asking)} onWithout={() => onPick(asking.sketch)} onBack={() => setAsking(null)} />
          ) : sketches.isPending ? (
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
                  <button className="add-sketch-item" onClick={() => void pick({ id: s.id, name: s.name })}>
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

interface Picked {
  id: string;
  name: string;
}

/** A sketch picked, and where asking about your changes to it has got to. */
type Asking =
  | { sketch: Picked; step: "checking" }
  | { sketch: Picked; step: "pushing" }
  | { sketch: Picked; step: "asking"; changes: SketchChanges }
  | { sketch: Picked; step: "refused"; code: string; error: string };

/** Whether to include your changes to the sketch picked: asked, being pushed, or why they couldn't be. */
function Ask({ asking, onPush, onWithout, onBack }: { asking: Asking; onPush: () => void; onWithout: () => void; onBack: () => void }) {
  const { name } = asking.sketch;
  if (asking.step === "checking" || asking.step === "pushing") {
    return <p className="add-sketch-quiet muted">{asking.step === "checking" ? `Looking for your changes to ${name}…` : "Pushing your changes to main…"}</p>;
  }
  const without = (
    <button className="quiet" onClick={onWithout}>
      Add without them
    </button>
  );
  const back = (
    <button className="quiet" onClick={onBack}>
      Back
    </button>
  );
  if (asking.step === "refused") {
    const why =
      asking.code === "clash"
        ? "They clash with what's been pushed to main since, so nothing was pushed. Open it, sync, and sort them out there, then add it."
        : asking.code === "busy"
          ? `${capitalized(asking.error)}: finish that in its editor first.`
          : `They couldn't be pushed: ${asking.error}`;
    return (
      <div className="add-sketch-none add-sketch-ask">
        <p>
          Your changes to <b>{name}</b> aren't on main.
        </p>
        <p className="muted">{why}</p>
        <div className="add-sketch-ask-actions">
          {back}
          {without}
          {asking.code === "failed" ? (
            <button className="primary" onClick={onPush}>
              Try again
            </button>
          ) : (
            <button className="primary" onClick={() => navigate(`/sketches/${asking.sketch.id}`)}>
              Open {name}
            </button>
          )}
        </div>
      </div>
    );
  }
  const { changes } = asking;
  const what =
    "unknown" in changes
      ? null
      : listOf([...(changes.files > 0 ? [count(changes.files, "changed file")] : []), ...(changes.commits > 0 ? [count(changes.commits, "commit")] : [])]);
  return (
    <div className="add-sketch-none add-sketch-ask">
      <p>
        Include your changes to <b>{name}</b>?
      </p>
      <p className="muted">
        {what
          ? `Your editor has ${what} that main hasn't, and main is what goes in the room. Pushing them puts them on main, for everyone.`
          : `vibes couldn't look at your editor's copy of ${name}. If you've changed it, pushing your changes puts them on main, for everyone, and in the room.`}
      </p>
      <div className="add-sketch-ask-actions">
        {back}
        {without}
        <button className="primary" onClick={onPush}>
          Push and add
        </button>
      </div>
    </div>
  );
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
