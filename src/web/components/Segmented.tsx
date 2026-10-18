import type { CSSProperties } from "react";

interface Props<T> {
  label: string;
  options: { value: T; label: string }[];
  /** Null when none applies (e.g. a mixed selection), so nothing is highlighted. */
  value: T | null;
  onChange: (value: T) => void;
  className?: string;
  /** Options stacked top to bottom instead of side by side. */
  vertical?: boolean;
}

/** A segmented control: equal-width options, with a highlight that slides to the chosen one. */
export function Segmented<T extends string | number>({ label, options, value, onChange, className, vertical }: Props<T>) {
  const index = options.findIndex((o) => o.value === value);
  const style = { "--count": options.length, "--index": Math.max(index, 0) } as CSSProperties;
  return (
    <div
      className={`segmented${vertical ? " vertical" : ""} ${className ?? ""}`}
      role="radiogroup"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : undefined}
      style={style}
    >
      {index >= 0 && <span className="segmented-thumb" aria-hidden="true" />}
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
