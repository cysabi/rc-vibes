import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** CSS background for the track. */
  track: string;
  /** What the value reads as, e.g. "B1.6". */
  display: string;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  /** Positions (in value units) marked on the track, in a color if given. */
  marks?: { at: number; title: string; color?: string }[];
  ends?: [ReactNode, ReactNode];
  dim?: boolean;
}

/** A horizontal slider whose track can carry a gradient. Drag, click, or use arrow keys. */
export function Slider({ label, value, min, max, step, track, display, onChange, onCommit, marks, ends, dim }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fraction = (value - min) / (max - min);

  const valueAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round((min + f * (max - min)) / step) * step;
  };

  const down = (e: PointerEvent) => {
    dragging.current = true;
    ref.current!.setPointerCapture(e.pointerId);
    onChange(valueAt(e.clientX));
  };
  const move = (e: PointerEvent) => dragging.current && onChange(valueAt(e.clientX));
  const up = (e: PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit(valueAt(e.clientX));
  };

  const key = (e: KeyboardEvent) => {
    const big = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step * big;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step * big;
    if (e.key === "Home") next = min;
    if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    next = Math.min(max, Math.max(min, Math.round(next / step) * step));
    onChange(next);
    onCommit(next);
  };

  return (
    <div className={dim ? "slider dim" : "slider"}>
      <div className="field-head">
        <span className="label">{label}</span>
        <span className="mono">{display}</span>
      </div>
      <div
        ref={ref}
        className="slider-track"
        style={{ background: track }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        {marks?.map((m, i) => (
          <span
            key={`${i}:${m.title}`}
            className={m.color ? "slider-mark colored" : "slider-mark"}
            title={m.title}
            style={{ left: `${((m.at - min) / (max - min)) * 100}%`, background: m.color }}
          />
        ))}
        <span className="slider-thumb" style={{ left: `${fraction * 100}%` }} />
      </div>
      {ends && (
        <div className="slider-ends">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
    </div>
  );
}
