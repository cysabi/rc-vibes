// One shader, in the selection panel in place of the selection: opened from
// its row there (its arrow), and back to the selection with ‹. Whether it's
// on (on everywhere it can light, or off: muted or masked, it's all off),
// anything that's become of it (failing, updating), where it's about (its
// home, which it can move to the selection, or where its code's lit; ringed
// on the map meanwhile), where it sits in the stack, its code, updating it
// to its sketch's latest commit, and, for vibes' own, taking it out. On, off
// and taking it out are pending edits like any other; moving home and
// updating happen at once. One on its way in (an instance building, or that
// couldn't go in) has a panel of its own (ComingTitle, ComingBody), and so
// does one you're adding, not yet applied (AddingTitle, AddingBody).

import { useState } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { tagLabel } from "../../shared/tags.ts";
import type { Instance, ShaderSketch } from "../../shared/vibes.ts";
import { request, useSketch } from "../api.ts";
import { drafts, reachOf, switchEverywhere, switchState, type Adding, type Layer } from "../draft.ts";
import { ChevronLeftIcon, OpenIcon, TrashIcon } from "../icons.tsx";
import { navigate } from "../route.ts";
import { invalidateScene } from "../scene.ts";
import { useLiveMode } from "../settings.ts";
import { count, listOf, ordinal } from "../words.ts";

/** Its head: back to the selection, its name, and where it's from. */
export function ShaderTitle({ layer, onBack }: { layer: Layer; onBack: () => void }) {
  const sketch = layer.node.sketch;
  return (
    <>
      <BackButton onBack={onBack} />
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
  /** Every light, for where they are. */
  lights: LightInfo[];
  /** The selection behind the panel: a home it can move to. */
  selected: number[];
}

export function ShaderBody({ layer, stack, removing, lights, selected }: BodyProps) {
  const { key, node, instance } = layer;
  const sketch = node.sketch;
  const reach = reachOf(layer);
  const state = switchState(layer);
  const masked = new Set(layer.mask);
  const onFor = layer.muted ? 0 : reach.filter((id) => !masked.has(id)).length;
  const all = lights.map((l) => l.id);
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
      <Status layer={layer} />
      <ul className="shader-facts">
        <li>
          <span className="fact">
            <span className="fact-name">{state === "on" ? "On" : state === "off" ? "Off" : "On for some of its lights"}</span>
            <span className="fact-meta">
              {state === "off"
                ? "Off everywhere"
                : state === "mixed"
                  ? `On for ${onFor} of its ${count(reach.length, "light")}`
                  : instance
                    ? "On for all of its home"
                    : "On everywhere its code lights"}
            </span>
          </span>
          <button
            className={`switch ${state}`}
            role="switch"
            aria-checked={state === "on" ? true : state === "off" ? false : "mixed"}
            aria-label={`${layer.name}, everywhere`}
            title={state === "on" ? `Switch ${layer.name} off everywhere` : `Switch ${layer.name} on everywhere it can light`}
            onClick={() => drafts.patchShader(key, switchEverywhere(layer, state !== "on", all))}
          >
            <span className="switch-knob" />
          </button>
        </li>
        {instance ? (
          <Home instance={instance} lights={lights} selected={selected} />
        ) : (
          <li>
            <span className="fact">
              <span className="fact-name">{reach.length === 0 ? "Hasn't lit anything yet" : `Lights ${count(reach.length, "light")}`}</span>
              <span className="fact-meta">{reach.length === 0 ? "Where its code lights shows here once it has" : `${placesOf(reach, lights)}, where its code has lit`}</span>
            </span>
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
        {instance && <Update instance={instance} />}
        {sketch ? (
          !removing && <RemoveShader layer={layer} />
        ) : (
          <p className="muted">Made outside vibes, so only whoever made it can take it out. Switch it off to keep it off.</p>
        )}
      </div>
    </div>
  );
}

/** Anything that's become of it: failing, restarting, updating, or couldn't. */
function Status({ layer }: { layer: Layer }) {
  const { node, instance } = layer;
  if (node.state !== "running") {
    return (
      <p className="shader-error">
        {node.state === "restarting" ? "Restarting" : "Failing"}
        {node.error ? `: ${node.error}` : ""}
      </p>
    );
  }
  if (instance?.next?.state === "building") {
    return <p className="shader-status">Updating to {instance.next.commit.slice(0, 7)}: building it, while this one keeps running.</p>;
  }
  if (instance?.next?.state === "failed") return <Failure what={`Couldn't update to ${instance.next.commit.slice(0, 7)}`} error={instance.next.error} />;
  if (instance?.error) return <Failure what={capitalized(instance.error)} error={null} />;
  return null;
}

/**
 * Something that went wrong: what, and why: the first line of the error, with
 * the rest (a compiler's picture of the line it choked on, say) below it as
 * it was written, scrolling if it's long.
 */
function Failure({ what, error }: { what: string; error: string | null }) {
  const [first, ...rest] = (error ?? "").trim().split("\n");
  const more = rest.join("\n").trim();
  return (
    <div className="shader-failure">
      <p className="shader-error">
        {what}
        {first ? `: ${first}` : ""}
      </p>
      {more && <pre className="shader-log">{more}</pre>}
    </div>
  );
}

/** An instance's home, and moving it to the selection. */
function Home({ instance, lights, selected }: { instance: Instance; lights: LightInfo[]; selected: number[] }) {
  const [moving, setMoving] = useState(false);
  const same = selected.length === instance.home.length && selected.every((id) => instance.home.includes(id));
  const move = async () => {
    setMoving(true);
    try {
      await request("PUT", `/api/instances/${instance.id}/home`, { home: selected });
      await invalidateScene();
    } finally {
      setMoving(false);
    }
  };
  return (
    <li>
      <span className="fact">
        <span className="fact-name">Home: {homeName(instance.home, lights)}</span>
        <span className="fact-meta">The lights it was put on, and all it can light</span>
      </span>
      {!same && selected.length > 0 && (
        <button className="quiet" disabled={moving} onClick={() => void move()} title={`Make its home the ${count(selected.length, "selected light")}`}>
          Move here
        </button>
      )}
    </li>
  );
}

/** Its sketch's latest commit, when that's not what it runs: built, then swapped in. */
function Update({ instance }: { instance: Instance }) {
  const sketch = useSketch(instance.sketchId);
  const [asked, setAsked] = useState(false);
  const head = sketch.data?.head;
  if (!head || head === instance.commit || instance.next?.state === "building") return null;
  const update = async () => {
    setAsked(true);
    try {
      await request("POST", `/api/instances/${instance.id}/update`, {});
      await invalidateScene();
    } finally {
      setAsked(false);
    }
  };
  return (
    <button className="quiet shader-action" disabled={asked} onClick={() => void update()} title={`Build ${head.slice(0, 7)}, main's latest, and swap it in`}>
      Update to {head.slice(0, 7)}
    </button>
  );
}

/** The head of one on its way in: back to the selection, its sketch's name, and its commit. */
export function ComingTitle({ instance, onBack }: { instance: Instance; onBack: () => void }) {
  return (
    <>
      <BackButton onBack={onBack} />
      <div className="selection-title">
        <h2>{instance.sketchName ?? "Unknown sketch"}</h2>
        <p className="muted">
          @ {instance.commit.slice(0, 7)}
          <span className="layer-badge">{instance.state === "failed" ? "couldn't go in" : "building"}</span>
        </p>
      </div>
    </>
  );
}

/**
 * One on its way in: building, or why it couldn't go in, and trying again or
 * letting it go. Tried again, it's a new instance, which the panel goes on
 * showing (onRetried, with its key).
 */
export function ComingBody({ instance, lights, onRetried }: { instance: Instance; lights: LightInfo[]; onRetried: (key: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      const done = await fn();
      await invalidateScene();
      return done;
    } finally {
      setBusy(false);
    }
  };
  // Put in afresh, on the same lights, then this one let go.
  const retry = async () => {
    const made = await act(async () => {
      const again = await request<Instance>("POST", "/api/instances", { sketch: instance.sketchId, commit: instance.commit, home: instance.home });
      await request("DELETE", `/api/instances/${instance.id}`);
      return again;
    });
    onRetried(`i:${made.id}`);
  };
  return (
    <div className="shader-body">
      {instance.state === "failed" ? (
        <Failure what="Couldn't go in" error={instance.error} />
      ) : (
        <p className="shader-status">Building {instance.commit.slice(0, 7)}. It goes in on top once it's built.</p>
      )}
      <ul className="shader-facts">
        <li>
          <span className="fact">
            <span className="fact-name">Home: {homeName(instance.home, lights)}</span>
            <span className="fact-meta">Put in by {instance.by.name}</span>
          </span>
        </li>
      </ul>
      <div className="shader-actions">
        <button className="quiet shader-action" onClick={() => navigate(`/sketches/${instance.sketchId}`)}>
          <OpenIcon /> Open its sketch
        </button>
        {instance.state === "failed" && (
          <button className="quiet shader-action" disabled={busy} onClick={() => void retry()}>
            Try again
          </button>
        )}
        <button className="quiet danger shader-action" disabled={busy} onClick={() => void act(() => request("DELETE", `/api/instances/${instance.id}`))}>
          <TrashIcon /> {instance.state === "failed" ? "Let it go" : "Stop putting it in"}
        </button>
      </div>
    </div>
  );
}

/** The head of one you're adding: back to the selection, its sketch's name, and how its build's going. */
export function AddingTitle({ adding, onBack }: { adding: Adding; onBack: () => void }) {
  const build = adding.build;
  return (
    <>
      <BackButton onBack={onBack} />
      <div className="selection-title">
        <h2>{adding.sketchName}</h2>
        <p className="muted">
          {build?.state === "built" ? `@ ${build.commit.slice(0, 7)}` : "main"}
          {build?.state === "failed" ? (
            <span className="layer-badge">couldn't build</span>
          ) : (
            <span className="layer-badge previewing">{build?.state === "built" ? "new here" : "building"}</span>
          )}
        </p>
      </div>
    </>
  );
}

/**
 * One you're adding (a pending edit): its main building on the server, then
 * previewed on the map until you apply, or why it couldn't build, and trying
 * again or not adding it after all.
 */
export function AddingBody({ adding, lights, onGone }: { adding: Adding; lights: LightInfo[]; onGone: () => void }) {
  const build = adding.build;
  return (
    <div className="shader-body">
      {build?.state === "failed" ? (
        <Failure what="Couldn't build main" error={build.error} />
      ) : build?.state === "built" ? (
        <p className="shader-status">The map shows {build.commit.slice(0, 7)}, main's latest. It goes in, on top, when you apply.</p>
      ) : (
        <p className="shader-status">Building main. The map shows it once it's built, before it goes in.</p>
      )}
      <ul className="shader-facts">
        <li>
          <span className="fact">
            <span className="fact-name">Home: {homeName(adding.home, lights)}</span>
            <span className="fact-meta">The lights it goes on, and all it can light</span>
          </span>
        </li>
      </ul>
      <div className="shader-actions">
        <button className="quiet shader-action" onClick={() => navigate(`/sketches/${adding.sketchId}`)}>
          <OpenIcon /> Open its sketch
        </button>
        {build?.state === "failed" && (
          <button className="quiet shader-action" onClick={() => drafts.rebuild(adding.key)}>
            Try again
          </button>
        )}
        <button
          className="quiet danger shader-action"
          onClick={() => {
            drafts.unadd(adding.key);
            onGone();
          }}
        >
          <TrashIcon /> Don't add it
        </button>
      </div>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="icon-button shader-back" onClick={onBack} aria-label="Back to the selection" title="Back to the selection">
      <ChevronLeftIcon />
    </button>
  );
}

/** A home, by the tags it's exactly made of, else how many lights where: "Couches & Kitchen", "12 lights on the 4th floor". */
function homeName(home: readonly number[], lights: LightInfo[]): string {
  const inHome = new Set(home);
  const byTag = new Map<string, number[]>();
  for (const l of lights) for (const t of l.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), l.id]);
  const whole = [...byTag].filter(([, ids]) => ids.every((id) => inHome.has(id)));
  const covered = new Set(whole.flatMap(([, ids]) => ids));
  if (whole.length > 0 && home.every((id) => covered.has(id))) {
    return listOf(whole.map(([t]) => tagLabel(t)).sort((a, b) => a.localeCompare(b)));
  }
  return `${count(home.length, "light")} ${placesOf(home, lights)}`;
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

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
