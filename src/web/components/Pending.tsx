import { useState } from "react";
import { applyDraft, drafts } from "../draft.ts";
import type { Scene } from "../scene.ts";

/**
 * Simulated mode's controls, floating over the bottom of the map: send the
 * pending changes to the room, or drop them.
 */
export function Pending({ live, pending }: { live: Scene; pending: number }) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      await applyDraft(live);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="pending" role="group" aria-label="Pending changes">
      <span className="pending-dot" aria-hidden="true" />
      <span className="pending-text">
        <strong>
          Previewing {pending} {pending === 1 ? "change" : "changes"}
        </strong>
        {error ? (
          <span className="bad" title={error}>
            Couldn't apply: {error}
          </span>
        ) : (
          <span>The room hasn't changed yet</span>
        )}
      </span>
      <button
        className="quiet"
        onClick={() => {
          setError(null);
          drafts.discard();
        }}
        disabled={applying}
      >
        Discard
      </button>
      <button className="primary apply" onClick={() => void apply()} disabled={applying}>
        {applying ? "Applying…" : "Apply to room"}
      </button>
    </div>
  );
}
