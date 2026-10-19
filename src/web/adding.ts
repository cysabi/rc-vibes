// Sketches being added (Draft.added): each one's branch's head, built on
// vibes' server (its builder), and watched until it's built, when its
// stamped script is fetched for the preview, or until it fails. Runs on the
// map's page, so a build started before a reload is picked up again after it.

import { useEffect } from "react";
import type { Build } from "../shared/vibes.ts";
import { request } from "./api.ts";
import { currentDraft, drafts, scriptOfBuild, useDraft, type Adding } from "./draft.ts";

const LOOK_MS = 1000;

// Asked for already (its answer on its way), so it isn't asked for twice.
const asking = new Set<string>();

const needsLooking = (a: Adding) => !a.build || a.build.state === "building" || (a.build.state === "built" && !scriptOfBuild(a.build.id));

const progress = (b: Build) => ({ id: b.id, commit: b.commit, state: b.state, error: b.error });

async function look(a: Adding) {
  if (asking.has(a.key)) return;
  asking.add(a.key);
  try {
    let build: Build;
    if (!a.build) {
      // Its branch's head.
      build = await request<Build>("POST", `/api/sketches/${encodeURIComponent(a.sketchId)}/builds`, { commit: a.branch });
    } else {
      build = await request<Build>("GET", `/api/sketches/${encodeURIComponent(a.sketchId)}/builds/${encodeURIComponent(a.build.id)}`);
    }
    // Let go of meanwhile (or discarded): nothing more to do.
    if (!currentDraft().added.some((x) => x.key === a.key)) return;
    if (build.state !== "built") {
      drafts.built(a.key, progress(build));
      return;
    }
    const res = await fetch(`/api/sketches/${encodeURIComponent(a.sketchId)}/builds/${encodeURIComponent(build.id)}/script`);
    if (!res.ok) throw new Error(`couldn't fetch its script (${res.status})`);
    drafts.built(a.key, progress(build), await res.text());
  } catch (err) {
    if (currentDraft().added.some((x) => x.key === a.key)) {
      drafts.built(a.key, { id: a.build?.id ?? "", commit: a.build?.commit ?? "", state: "failed", error: (err as Error).message });
    }
  } finally {
    asking.delete(a.key);
  }
}

/** Builds and fetches the sketches being added, while any need it. */
export function useAddingBuilds() {
  const draft = useDraft();
  const busy = draft.added.some(needsLooking);
  useEffect(() => {
    if (!busy) return;
    const lookAll = () => {
      for (const a of currentDraft().added) if (needsLooking(a)) void look(a);
    };
    lookAll();
    const t = window.setInterval(lookAll, LOOK_MS);
    return () => window.clearInterval(t);
  }, [busy, draft.added]);
}
