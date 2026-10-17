// Small line icons, drawn on a 16px grid with currentColor strokes.

import type { SVGProps } from "react";

const Svg = (props: SVGProps<SVGSVGElement>) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  />
);

export const EyeIcon = () => (
  <Svg>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const EyeOffIcon = () => (
  <Svg>
    <path d="M6.2 3.7A6 6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.7 2.2M10.6 11.9A6 6 0 0 1 8 12.5C3.9 12.5 1.5 8 1.5 8a12 12 0 0 1 2.4-2.9" />
    <path d="M2 2l12 12" />
  </Svg>
);

export const GripIcon = () => (
  <Svg strokeWidth="0" fill="currentColor">
    {[4, 8, 12].map((y) => (
      <g key={y}>
        <circle cx="6" cy={y} r="1.1" />
        <circle cx="10" cy={y} r="1.1" />
      </g>
    ))}
  </Svg>
);

export const PlusIcon = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const BackIcon = () => (
  <Svg>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const MinusIcon = () => (
  <Svg>
    <path d="M3 8h10" />
  </Svg>
);

/** Fit to view: four corners pointing out. */
export const FitIcon = () => (
  <Svg>
    <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
  </Svg>
);

/** Points up; rotate it to point down. */
export const ChevronUpIcon = () => (
  <Svg width="12" height="12">
    <path d="M4 10l4-4 4 4" />
  </Svg>
);
