// One shader, in the selection panel in place of the selection: opened from
// its row there (its arrow), and back to the selection with ‹. Where it's
// from, whether it's on, what it's changing (ringed on the map meanwhile, in
// place of the selection), where it sits in the stack, and for vibes' own
// shaders, taking it out of the room. Muting it, switching it back on where
// it's kept off, and taking it out are pending edits like any other.

import { useState } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import type { ShaderSketch } from "../../shared/vibes.ts";
import { drafts, type Layer } from "../draft.ts";
import { ChevronLeftIcon, OpenIcon, TrashIcon } from "../icons.tsx";
import { navigate } from "../route.ts";
import { useLiveMode } from "../settings.ts";
import { reachOf } from "../sim.ts";
import { count, listOf, ordinal } from "../words.ts";

/** Its head: back to the selection, its name, and where it's from. */
export function ShaderTitle({ layer, onBack }: { layer: Layer; onBack: () => void }) {
  const sketch = layer.node.sketch;
  return (
    <>
      <button className="icon-button shader-back" onClick={onBack} aria-label="Back to the selection" title="Back to the selection">
        <ChevronLeftIcon />
      </button>
      <div className="selection-title">
        <h2>{layer.name}</h2>
        <p className="muted">
          {/* A sketch's, vibes made (with its own key, which arclamp names as who did). */}
          {sketch ? `@ ${sketch.commit.slice(0, 7)}` : `Made outside vibes · by ${layer.by}`}
          {sketch?.deleted && <span className="layer-badge">deleted</span>}
          {sketch?.edited && (
            <span className="layer-badge" title="Changed since vibes built it, so it isn't what its sketch's commit says">
              edited
            </span>
          )}
        </p>
      </div>
    </>
  );
}

interface BodyProps {
  layer: Layer;
  /** The stack as the draft has it, top first (without what it takes out). */
  stack: Layer[];
  /** Whether the draft takes it out. */
  removing: boolean;
  trying: ReadonlySet<number>;
  /** Every light, for where it is. */
  lights: LightInfo[];
}

export function ShaderBody({ layer, stack, removing, trying, lights }: BodyProps) {
  const { key, node, muted } = layer;
  const sketch = node.sketch;
  const reach = reachOf(layer, trying);
  const at = stack.findIndex((l) => l.key === key);
  return (
    <div className="shader-body">
      {removing && (
        <div className="shader-note">
          <span>Comes out of the room when you apply.</span>
          <button className="quiet" onClick={() => drafts.keep(key)}>
            Keep it
          </button>
        </div>
      )}
      {node.state !== "running" && (
        <p className="shader-error">
          {node.state === "restarting" ? "Restarting" : "Failing"}
          {node.error ? `: ${node.error}` : ""}
        </p>
      )}
      <ul className="shader-facts">
        <li>
          <span className="fact">
            <span className="fact-name">{muted ? "Muted" : "On"}</span>
            <span className="fact-meta">
              {muted ? "Off everywhere" : layer.mask.length > 0 ? "Everywhere it isn't switched off" : "Everywhere"}
            </span>
          </span>
          <button
            className={`switch ${muted ? "off" : "on"}`}
            role="switch"
            aria-checked={!muted}
            aria-label={`${layer.name}, everywhere`}
            title={muted ? `Unmute ${layer.name}` : `Mute ${layer.name} everywhere`}
            onClick={() => drafts.patchShader(key, { muted: !muted })}
          >
            <span className="switch-knob" />
          </button>
        </li>
        <li>
          <span className="fact">
            <span className="fact-name">
              {reach.length === 0 ? "Not changing any lights" : `${muted ? "Would change" : "Changing"} ${count(reach.length, "light")}`}
            </span>
            <span className="fact-meta">{reach.length === 0 ? "Nothing it's put out lately differs from what's under it" : placesOf(reach, lights)}</span>
          </span>
        </li>
        {layer.mask.length > 0 && (
          <li>
            <span className="fact">
              <span className="fact-name">Switched off on {count(layer.mask.length, "light")}</span>
              <span className="fact-meta">{placesOf(layer.mask, lights)}</span>
            </span>
            <button className="quiet" onClick={() => drafts.patchShader(key, { mask: [] })} title={`Switch ${layer.name} back on everywhere it's switched off`}>
              Switch on
            </button>
          </li>
        )}
        {at >= 0 && (
          <li>
            <span className="fact">
              <span className="fact-name">{stack.length === 1 ? "The only shader" : `${ordinal(stack.length - at)} of ${stack.length}, from the bottom`}</span>
              <span className="fact-meta">
                Over {stack[at + 1]?.name ?? "room tone"}
                {at > 0 ? ` · under ${stack[at - 1]!.name}` : " · on top"}
              </span>
            </span>
          </li>
        )}
      </ul>
      <div className="shader-actions">
        {sketch?.name != null && <OpenCode sketch={sketch} />}
        {sketch ? (
          !removing && <RemoveShader layer={layer} />
        ) : (
          <p className="muted">Made outside vibes, so only whoever made it can take it out. Mute it to keep it off.</p>
        )}
      </div>
    </div>
  );
}

/** Where some lights are: "on the 4th floor", "on the 4th & 5th floors". */
function placesOf(ids: readonly number[], lights: LightInfo[]): string {
  const want = new Set(ids);
  const floors = new Set<number>();
  let off = 0;
  for (const l of lights) {
    if (!want.has(l.id)) continue;
    if (l.coords) floors.add(l.coords.floor);
    else off++;
  }
  const on = [...floors].sort((a, b) => a - b).map(ordinal);
  const parts = on.length > 0 ? [`on the ${listOf(on)} ${on.length === 1 ? "floor" : "floors"}`] : [];
  if (off > 0) parts.push(`${off} not on the map`);
  return parts.join(" · ");
}

/** The sketch it was built from: at the commit it was built from, or, deleted, among the deleted ones in the library, to restore. */
function OpenCode({ sketch }: { sketch: ShaderSketch }) {
  const label = sketch.deleted ? `Find ${sketch.name} among the deleted sketches` : `Open ${sketch.name} at ${sketch.commit.slice(0, 7)}, the commit this was built from`;
  return (
    <button
      className="quiet shader-action"
      title={label}
      onClick={() => navigate(sketch.deleted ? `/sketches?deleted=${sketch.id}` : `/sketches/${sketch.id}?commit=${sketch.commit}`)}
    >
      <OpenIcon /> {sketch.deleted ? "Find its sketch" : "Open its code"}
    </button>
  );
}

/**
 * Taking it out of the room. Previewing, that's a pending edit like any
 * other, to keep or apply; live, it goes out straight away, so it asks first.
 */
function RemoveShader({ layer }: { layer: Layer }) {
  const live = useLiveMode();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className="quiet danger shader-action" onClick={() => (live ? setAsking(true) : drafts.remove(layer.key))}>
        <TrashIcon /> Remove from the room
      </button>
    );
  }
  return (
    <div className="confirm-delete">
      <span>
        Take <b>{layer.name}</b> out of the room?
      </span>
      <button className="quiet danger" onClick={() => drafts.remove(layer.key)}>
        Take it out
      </button>
      <button className="quiet" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  );
}
