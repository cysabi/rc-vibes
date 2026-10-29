// What can be done to one shader, from its row in the layers panel
// (ShadersPanel.tsx): its code, a copy of it (updating it to its sketch's
// latest is ShadersPanel's NewChanges), building it again (one that couldn't go in, or build) and taking it out
// (however it was put in: one made outside vibes, vibes can't put back, so
// that asks first). Taking it out is a pending edit like any other;
// updating, trying again and letting go of one on its way in happen at once.

import { useState } from "react";
import type { Instance, ShaderSketch } from "../../shared/vibes.ts";
import { isDefaultSketch } from "../../shared/default-sketches.ts";
import { sameValue, valuesAt, type ParamValue } from "../../shared/params.ts";
import { request, useBranchHead } from "../api.ts";
import { currentDraft, domainOf, drafts, layersOf, reachOf, type Adding, type Layer } from "../draft.ts";
import { CodeIcon, CopyIcon, TrashIcon } from "../icons.tsx";
import { navigate } from "../route.ts";
import { invalidateScene, type Scene } from "../scene.ts";
import { useLiveMode } from "../settings.ts";

/**
 * One on its way in (building, or that couldn't go in): trying again (at
 * its branch's head, so a fix pushed there is what's built) or letting it go.
 */
export function ComingActions({ instance }: { instance: Instance }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await invalidateScene();
    } finally {
      setBusy(false);
    }
  };
  // Put in afresh, from its branch's head, on the same lights; then this one let go.
  const retry = () =>
    act(async () => {
      await request<Instance>("POST", "/api/instances", { sketch: instance.sketchId, branch: instance.branch, home: instance.home });
      await request("DELETE", `/api/shaders/${instance.id}`);
    });
  return (
    <>
      {/* vibes' own sketch's code is vibes': nothing to open. */}
      {!isDefaultSketch(instance.sketchId) && (
        <button className="quiet shader-action" onClick={() => navigate(`/sketches/${instance.sketchId}`)}>
          <CodeIcon /> Open Sketch
        </button>
      )}
      {instance.state === "failed" && <Rebuild commit={instance.commit} branch={instance.branch} head={instance.head} disabled={busy} onClick={() => void retry()} />}
      <button
        className="quiet danger shader-action shader-delete"
        disabled={busy}
        aria-label={instance.state === "failed" ? "Let it go" : "Stop putting it in"}
        onClick={() => void act(() => request("DELETE", `/api/shaders/${instance.id}`))}
      >
        <TrashIcon />
      </button>
    </>
  );
}

/**
 * One you're adding (a pending edit): its sketch, building it again (at the
 * branch's head) after it couldn't build, and not adding it after all.
 */
export function AddingActions({ adding }: { adding: Adding }) {
  const build = adding.build;
  const head = useBranchHead(adding.sketchId, adding.branch);
  return (
    <>
      {!isDefaultSketch(adding.sketchId) && (
        <button className="quiet shader-action" onClick={() => navigate(`/sketches/${adding.sketchId}`)}>
          <CodeIcon /> Open Sketch
        </button>
      )}
      {build?.state === "failed" && <Rebuild commit={build.commit} branch={adding.branch} head={head} onClick={() => drafts.rebuild(adding.key)} />}
      <button className="quiet danger shader-action shader-delete" aria-label="Don't add it" onClick={() => drafts.unadd(adding.key)}>
        <TrashIcon />
      </button>
    </>
  );
}

/**
 * Building again, after it couldn't build or go in: always its branch's head.
 * While that's still the commit that failed, it's "Build again" (for a
 * hiccup: a fix needs pushing first); once the branch has moved on, "Build
 * latest".
 */
function Rebuild({ commit, branch, head, disabled, onClick }: { commit: string; branch: string; head: string | null; disabled?: boolean; onClick: () => void }) {
  const latest = head !== null && commit !== "" && head !== commit;
  return (
    <button
      className="quiet shader-action"
      disabled={disabled}
      onClick={onClick}
    >
      {latest ? "Build latest" : "Build again"}
    </button>
  );
}

/** The sketch it was built from, at the commit it was built from. Deleted, its page says so, and restores it. */
export function OpenCode({ sketch }: { sketch: ShaderSketch }) {
  return (
    <button className="quiet shader-action" onClick={() => navigate(sketch.deleted ? `/sketches/${sketch.id}` : `/sketches/${sketch.id}?commit=${sketch.commit}`)}>
      <CodeIcon /> {sketch.deleted ? "Restore its sketch" : "Open Sketch"}
    </button>
  );
}

/**
 * Taking it out of the room. Previewing, that's a pending edit like any
 * other, to keep or apply; live, it goes out straight away, so it asks first.
 * One made outside vibes (no sketch), vibes can't put back once it's out, so
 * that asks first either way. Taken out, it's shown going (and can be kept)
 * until it's gone.
 */
export function RemoveShader({ layer }: { layer: Layer }) {
  const live = useLiveMode();
  const [asking, setAsking] = useState(false);
  const outside = layer.sketch === null;
  const out = () => drafts.remove(layer.key);
  if (!asking) {
    return (
      <button className="quiet danger shader-action shader-delete" aria-label="Delete" onClick={() => (live || outside ? setAsking(true) : out())}>
        <TrashIcon />
      </button>
    );
  }
  return (
    <div className="confirm-delete">
      <span>
        Take <b>{layer.name}</b> out of the room?
        {outside && ` It was made outside vibes (by ${layer.by}), so vibes can't put it back.`}
      </span>
      <button className="quiet danger" onClick={out}>
        Take it out
      </button>
      <button className="quiet" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  );
}

/**
 * A copy of a sketch's shader: the same sketch, from the same branch, added
 * (a pending edit, built and previewed as any) on the lights it's on (or,
 * off everywhere, those it reaches), its params as they are there, just
 * above it in the stack.
 */
export function CloneShader({ layer, scene, all, onCloned }: { layer: Layer; scene: Scene; all: readonly number[]; onCloned?: (key: string) => void }) {
  const sketch = layer.sketch;
  if (!sketch || sketch.deleted) return null;
  const clone = () => {
    const on = domainOf(layer);
    const home = on.length > 0 ? on : reachOf(layer).length > 0 ? [...reachOf(layer)] : [...all];
    const inHome = new Set(home);
    const key = drafts.add({
      sketchId: sketch.id,
      sketchName: sketch.name ?? layer.name,
      branch: layer.instance?.branch || "main",
      home,
      mask: all.filter((id) => !inHome.has(id)),
    });
    // Its params, light by light, where they aren't the default.
    for (const spec of layer.params?.declared ?? []) {
      const values = valuesAt(spec, layer.params!.values[spec.name], home);
      const changes = home.flatMap((id, i) => (sameValue(values[i]!, spec.default) ? [] : [[id, values[i]!] as [number, ParamValue]]));
      if (changes.length > 0) drafts.setParam(key, spec.name, changes);
    }
    // Just above the one it's a copy of (the stack's top first).
    const keys = layersOf(scene, currentDraft())
      .map((l) => l.key)
      .filter((k) => k !== key);
    const at = keys.indexOf(layer.key);
    if (at >= 0) drafts.reorder([...keys.slice(0, at), key, ...keys.slice(at)]);
    onCloned?.(key);
  };
  return (
    <button className="quiet shader-action" onClick={clone}>
      <CopyIcon /> Clone
    </button>
  );
}
