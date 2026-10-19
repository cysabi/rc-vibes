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

/** Back. */
export const ChevronLeftIcon = () => (
  <Svg>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
);

/** A pencil, for editing. */
export const PencilIcon = () => (
  <Svg>
    <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5V10.5ZM8.5 4.5l3 3" />
  </Svg>
);

/** A rail: a track with a stop across each end. */
export const RailIcon = () => (
  <Svg>
    <path d="M3 13 13 3M1.6 11.6l2.8 2.8M11.6 1.6l2.8 2.8" />
  </Svg>
);

/** Turn: an arrow round a quarter turn. */
export const TurnIcon = () => (
  <Svg>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
  </Svg>
);

export const UndoIcon = () => (
  <Svg>
    <path d="M5 3 2.5 5.5 5 8M2.5 5.5h7a4 4 0 0 1 0 8H7" />
  </Svg>
);

export const DownloadIcon = () => (
  <Svg>
    <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />
  </Svg>
);

export const TrashIcon = () => (
  <Svg>
    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4" />
  </Svg>
);

/** A box with an arrow out of its corner: open it elsewhere. */
export const OpenIcon = () => (
  <Svg>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
);

/** An i in a circle, for notes. */
export const InfoIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 7.2v4M8 4.9v.1" />
  </Svg>
);
