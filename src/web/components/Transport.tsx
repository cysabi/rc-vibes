// The show clock's transport (shared/show.ts), along the top of the map:
// play and stop, where the piece is, the beat (a dot for each of a bar's
// four, lit on the one it's on), the tempo (typed, or tapped), and Sync
// (this beat's a bar's first). Each acts on the room's one clock at once,
// live mode or not: it's the room's, never a pending edit. A press is put in
// arclamp's time as it happened (rtime.ts), so it lands where it was meant
// however long it takes to get there. The time and beat shown are the
// room's, by arclamp's time: the map plays the room a moment later.
//
// Keys, away from anything typed in: P plays or stops, T taps, B syncs.

import { useEffect, useRef, useState } from "react";
import { BEATS_PER_BAR, beatAt, MAX_BPM, MIN_BPM, tappedBpm, timeAt, type TransportAction } from "../../shared/show.ts";
import { MoreIcon, PlayIcon, StopIcon } from "../icons.tsx";
import { rNow, rOfEvent, useTimeSync, type TimeSync } from "../rtime.ts";
import { sendTransport, useShowClock } from "../scene.ts";
import { useAdminMode } from "../settings.ts";
import { Menu } from "./Menu.tsx";

// Taps further apart than this start a tempo over; the last this many make it.
const TAP_GAP_MS = 2000;
const TAPS = 8;
const NUDGE_STEP_MS = 10;
// A beat's dot is bright this much of a beat after it comes.
const FRESH = 0.2;

/** A piece's time as m:ss.s. */
export const clockText = (t: number) => {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

const bpmText = (bpm: number | null) => (bpm === null ? "" : bpm.toFixed(1).replace(/\.0$/, ""));

/** How near this page is to arclamp's time, for admin mode. */
function syncText(s: TimeSync): string {
  if (s.offset === null) return "Not yet in time with the room.";
  const vibes = s.vibesError === null ? "vibes hasn't reached arclamp yet" : `vibes ±${s.vibesError.toFixed(1)} ms from arclamp`;
  return `This page is ±${(s.error ?? 0).toFixed(1)} ms from vibes; ${vibes}.`;
}

export function Transport() {
  const clock = useShowClock();
  const admin = useAdminMode();
  const sync = useTimeSync();
  const time = useRef<HTMLSpanElement>(null);
  const dots = useRef<HTMLSpanElement>(null);
  const taps = useRef<number[]>([]);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Where the piece is, and the beat, each frame, straight into the page.
  useEffect(() => {
    let raf = requestAnimationFrame(function step() {
      const now = rNow();
      if (time.current) time.current.textContent = clockText(timeAt(clock, now));
      if (dots.current) {
        const beat = clock.bpm === null ? null : beatAt(clock, now);
        const on = beat === null ? -1 : (((Math.floor(beat) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR);
        [...dots.current.children].forEach((d, i) => d.classList.toggle("on", i === on));
        dots.current.classList.toggle("fresh", beat !== null && beat - Math.floor(beat) < FRESH);
      }
      raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  const act = (a: TransportAction) =>
    sendTransport(a).then(
      () => setError(null),
      (err: Error) => setError(err.message),
    );
  const playStop = (e: { timeStamp: number }) => act({ do: clock.playing ? "stop" : "play", at: rOfEvent(e) });
  const syncNow = (e: { timeStamp: number }) => {
    if (clock.bpm !== null) void act({ do: "downbeat", at: rOfEvent(e) });
  };
  const tap = (e: { timeStamp: number }) => {
    const t = performance.timeOrigin + e.timeStamp;
    const list = taps.current;
    if (list.length > 0 && t - list[list.length - 1]! > TAP_GAP_MS) list.length = 0;
    list.push(t);
    if (list.length > TAPS) list.shift();
    const bpm = tappedBpm(list);
    if (bpm !== null) void act({ do: "tempo", bpm, at: rOfEvent(e), onBeat: true });
  };
  const typedBpm = () => {
    if (typed === null) return;
    const bpm = Number(typed);
    setTyped(null);
    if (typed.trim() !== "" && bpm >= MIN_BPM && bpm <= MAX_BPM && bpm !== clock.bpm) void act({ do: "tempo", bpm, at: rNow() });
  };

  // P, T and B, away from anything typed in.
  const keys = useRef({ playStop, tap, syncNow });
  keys.current = { playStop, tap, syncNow };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable], .cm-editor")) return;
      const k = keys.current;
      if (e.key === "p") void k.playStop(e);
      else if (e.key === "t") k.tap(e);
      else if (e.key === "b") k.syncNow(e);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="transport" role="group" aria-label="Show clock">
      <button className="transport-button play" onClick={(e) => void playStop(e)} aria-label={clock.playing ? "Stop" : "Play"} title={clock.playing ? "Stop (P)" : "Play (P)"}>
        {clock.playing ? <StopIcon /> : <PlayIcon />}
      </button>
      <span className="transport-time" ref={time} title="Where the piece is">
        {clockText(timeAt(clock, rNow()))}
      </span>
      <span className={`transport-beats${clock.bpm === null ? " none" : ""}`} ref={dots} aria-hidden="true">
        {Array.from({ length: BEATS_PER_BAR }, (_, i) => (
          <span key={i} />
        ))}
      </span>
      <label className="transport-bpm" title="The tempo, in beats a minute">
        <input
          inputMode="decimal"
          aria-label="Tempo, in beats a minute"
          placeholder="–"
          value={typed ?? bpmText(clock.bpm)}
          onFocus={() => setTyped(bpmText(clock.bpm))}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={typedBpm}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setTyped(null);
              e.currentTarget.blur();
            }
          }}
        />
        <span>BPM</span>
      </label>
      <button className="transport-button" onClick={tap} title="Tap the beat to set the tempo (T)">
        Tap
      </button>
      <button className="transport-button" onClick={syncNow} disabled={clock.bpm === null} title="Now is a bar's first beat (B)">
        Sync
      </button>
      <Menu align="end" className="transport-button more" title="More for the show clock" label={<MoreIcon />}>
        <p className="menu-heading">Show clock</p>
        <button className="menu-item" onClick={() => void act({ do: "seek", at: rNow(), t: 0 })}>
          Back to the start
        </button>
        <div className="menu-field">
          <span>
            Nudge: {clock.nudge > 0 ? "+" : ""}
            {clock.nudge} ms
            <small>Moves the room's beat later, for sound that reaches the room late (or earlier).</small>
          </span>
          <span className="transport-nudge">
            <button className="transport-button" onClick={() => void act({ do: "nudge", ms: clock.nudge - NUDGE_STEP_MS })} aria-label="Earlier">
              −
            </button>
            <button className="transport-button" onClick={() => void act({ do: "nudge", ms: clock.nudge + NUDGE_STEP_MS })} aria-label="Later">
              +
            </button>
          </span>
        </div>
        {admin && <p className="menu-note">{syncText(sync)}</p>}
      </Menu>
      {error && (
        <span className="transport-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
