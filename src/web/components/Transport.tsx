// The show clock's row (shared/show.ts), in the scenes drawer along the
// bottom of the map (ScenesDrawer.tsx): the transport (play or stop, where
// the piece is, click it to set; back to the start) and the tempo (a light
// on the beat, warm on a bar's first; the beats a minute, click to type;
// Tap; Sync, this beat's a bar's first), and the nudge, and ending the show.
// It's there for everyone while a show's on; with none, the clock rests
// (shared/show.ts). A show starts (and ends, too) from the account menu:
// ShowMenuItem, in it and the row's own menu.
// Each acts on the room's one clock at once, live mode or not: it's the
// room's, never a pending edit. A press is put in arclamp's time as it
// happened (rtime.ts), so it lands where it was meant however long it takes
// to get there: Tap and Sync as the finger comes down, not up. The time and
// beat shown are the room's, by arclamp's time: the map plays the room a
// moment later.
//
// Keys, away from anything typed in, while the row's there: P plays or
// stops, T taps, B syncs.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { BEATS_PER_BAR, beatAt, MAX_BPM, MIN_BPM, tappedBpm, timeAt, type TransportAction } from "../../shared/show.ts";
import { MoreIcon } from "../icons.tsx";
import { rNow, rOfEvent } from "../rtime.ts";
import { sendTransport, useShowClock, useShowOn } from "../scene.ts";
import { Menu } from "./Menu.tsx";

// Taps further apart than this start a tempo over; the last this many make it.
const TAP_GAP_MS = 2000;
const TAPS = 8;
const NUDGE_STEP_MS = 10;

/** A piece's time as m:ss.s. */
export const clockText = (t: number) => {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

/** A time typed as m:ss (or seconds), in seconds; null if it isn't one. */
export function parseClockText(text: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d*)?)\s*$/.exec(text);
  if (!m) return null;
  const t = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return Number.isFinite(t) ? t : null;
}

const bpmText = (bpm: number) => (Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1));

/** A button's press, at its moment: a pointer's as it comes down; a click's only if the keyboard made it (Enter or Space). */
export const press = (act: (e: { timeStamp: number }) => void) => ({
  onPointerDown: (p: { button: number; timeStamp: number }) => {
    if (p.button === 0) act(p);
  },
  onClick: (c: MouseEvent) => {
    if (c.detail === 0) act(c);
  },
});

/** A menu's item starting a show, for the whole room, or, with one on, ending it. */
export function ShowMenuItem() {
  const on = useShowOn();
  const [error, setError] = useState<string | null>(null);
  const act = (e: MouseEvent) =>
    void sendTransport({ do: on ? "end" : "start", at: rOfEvent(e) }).then(
      () => setError(null),
      (err: Error) => setError(err.message),
    );
  return (
    <>
      <button
        className="menu-item"
        onClick={act}
        aria-label={on ? "End show: for everyone, the dock goes, and the clock rests at 120 beats a minute" : "Start show: for everyone, the show clock's dock, the piece at 0:00, the beat going on"}
      >
        {on ? "End show" : "Start show"}
      </button>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** The show's row of the drawer (ScenesDrawer.tsx), while a show's on: the transport, the tempo, and the show's menu. */
export function Transport() {
  const clock = useShowClock();
  const time = useRef<HTMLButtonElement>(null);
  const light = useRef<HTMLSpanElement>(null);
  const taps = useRef<number[]>([]);
  const [typedTime, setTypedTime] = useState<string | null>(null);
  const [typedBpm, setTypedBpm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Where the piece is, and the light on the beat (bright on it, fading to
  // the next; warm on a bar's first), each frame, straight into the page.
  useEffect(() => {
    let raf = requestAnimationFrame(function step() {
      const now = rNow();
      if (time.current) time.current.textContent = clockText(timeAt(clock, now));
      if (light.current) {
        const beat = clock.bpm === null ? null : beatAt(clock, now);
        const into = beat === null ? 1 : beat - Math.floor(beat);
        light.current.style.opacity = String(0.15 + 0.85 * (1 - into) ** 2);
        light.current.classList.toggle("bar", beat !== null && ((Math.floor(beat) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0);
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
  const playStop = (e: { timeStamp: number }) => void act({ do: clock.playing ? "stop" : "play", at: rOfEvent(e) });
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

  const timeKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const t = parseClockText(typedTime ?? "");
      if (t !== null) void act({ do: "seek", at: rOfEvent(e), t });
      setTypedTime(null);
    }
    if (e.key === "Escape") setTypedTime(null);
  };
  const bpmKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const bpm = Number(typedBpm);
      if (typedBpm?.trim() && bpm >= MIN_BPM && bpm <= MAX_BPM) void act({ do: "tempo", bpm: Math.round(bpm * 10) / 10, at: rOfEvent(e) });
      setTypedBpm(null);
    }
    if (e.key === "Escape") setTypedBpm(null);
  };

  // P, T and B, away from anything typed in.
  const keys = useRef({ playStop, tap, syncNow });
  keys.current = { playStop, tap, syncNow };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable], .cm-editor")) return;
      const k = keys.current;
      if (e.key === "p") k.playStop(e);
      else if (e.key === "t") k.tap(e);
      else if (e.key === "b") k.syncNow(e);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="dock-bar">
      <div className="transport" role="group" aria-label="The show clock: every sketch that follows it agrees where the piece is">
        <button className="transport-button" {...press(playStop)} aria-label={clock.playing ? "Stop the show clock (P)" : "Start the show clock (P)"}>
          {clock.playing ? "❚❚" : "▶"}
        </button>
        {typedTime === null ? (
          <button className="transport-time mono" ref={time} onClick={() => setTypedTime(clockText(timeAt(clock, rNow())))} aria-label="Set the time (m:ss)">
            {clockText(timeAt(clock, rNow()))}
          </button>
        ) : (
          <input
            className="transport-time mono"
            autoFocus
            value={typedTime}
            size={5}
            onChange={(e) => setTypedTime(e.target.value)}
            onKeyDown={timeKey}
            onBlur={() => setTypedTime(null)}
            aria-label="The time, m:ss"
          />
        )}
        <button className="transport-button restart" onClick={(e) => void act({ do: "seek", at: rOfEvent(e), t: 0 })} aria-label="Back to the start">
          ⟲
        </button>
      </div>
      <div className="tempo" role="group" aria-label="Tempo">
        <span className="tempo-light-slot" aria-hidden="true">
          <span ref={light} className="tempo-light" />
        </span>
        {typedBpm === null ? (
          <button className="tempo-bpm mono" onClick={() => setTypedBpm(clock.bpm === null ? "120" : bpmText(clock.bpm))} aria-label="The tempo, in beats a minute: click to type one">
            {clock.bpm === null ? "—" : bpmText(clock.bpm)}
            <small> BPM</small>
          </button>
        ) : (
          <input
            className="tempo-bpm mono"
            autoFocus
            value={typedBpm}
            size={5}
            inputMode="decimal"
            onChange={(e) => setTypedBpm(e.target.value)}
            onKeyDown={bpmKey}
            onBlur={() => setTypedBpm(null)}
            aria-label="Beats a minute"
          />
        )}
        <button className="tempo-tap" {...press(tap)} aria-label="Tap on the beat (T): from the third tap, the tempo">
          Tap
        </button>
        <button className="tempo-sync" {...press(syncNow)} disabled={clock.bpm === null} aria-label="Sync (B): now is a bar's first beat">
          Sync
        </button>
      </div>
      {error && (
        <span className="dock-error" role="alert">
          {error}
        </span>
      )}
      <span className="dock-spacer" />
      <div className="dock-more">
        <Menu align="end" side="above" className="transport-button" name="Nudge the show clock, or end the show" label={<MoreIcon />}>
          <p className="menu-heading">Show</p>
          <div className="menu-field">
            <span>
              Nudge: {clock.nudge > 0 ? "+" : ""}
              {clock.nudge} ms
              <small>Moves the room's beat later, for sound that reaches the room late (or earlier).</small>
            </span>
            <span className="dock-nudge">
              <button className="transport-button" onClick={() => void act({ do: "nudge", ms: clock.nudge - NUDGE_STEP_MS })} aria-label="Earlier">
                −
              </button>
              <button className="transport-button" onClick={() => void act({ do: "nudge", ms: clock.nudge + NUDGE_STEP_MS })} aria-label="Later">
                +
              </button>
            </span>
          </div>
          <ShowMenuItem />
        </Menu>
      </div>
    </div>
  );
}
