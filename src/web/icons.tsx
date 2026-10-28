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

/** Three dots in a row: more for something (what can be done to it). */
export const MoreIcon = () => (
  <Svg strokeWidth="0" fill="currentColor">
    {[3.5, 8, 12.5].map((x) => (
      <circle key={x} cx={x} cy="8" r="1.25" />
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

/** What it looks like: a wheel with a few lights on it. */
export const LookIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <circle cx="6" cy="6.5" r="1.2" fill="currentColor" strokeWidth="0" />
    <circle cx="10.3" cy="7.3" r="1.2" fill="currentColor" strokeWidth="0" />
    <circle cx="8" cy="10.7" r="1.2" fill="currentColor" strokeWidth="0" />
  </Svg>
);

/** Copy: one square over another. */
export const CopyIcon = () => (
  <Svg>
    <rect x="6" y="6" width="8" height="8" rx="1.5" />
    <path d="M4 10H3.5A1.5 1.5 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2h5A1.5 1.5 0 0 1 10 3.5V4" />
  </Svg>
);

/** Code: angle brackets round a slash, </>. */
export const CodeIcon = () => (
  <Svg>
    <path d="M5 4.5 1.5 8 5 11.5M11 4.5 14.5 8 11 11.5M9.2 3 6.8 13" />
  </Svg>
);

/** Save: Lucide's floppy disk, on its own 24px grid. */
export const SaveIcon = () => (
  <Svg viewBox="0 0 24 24" strokeWidth="2">
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
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

/** A pencil, for editing (renaming). */
export const PencilIcon = () => (
  <Svg>
    <path d="M10.5 3 13 5.5 5.5 13H3v-2.5L10.5 3ZM9 4.5 11.5 7" />
  </Svg>
);

/** A fork: two branches coming off one, for a copy of a sketch of its own. */
export const ForkIcon = () => (
  <Svg>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="11.5" cy="3.5" r="1.5" />
    <circle cx="8" cy="12.5" r="1.5" />
    <path d="M4.5 5v1a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5M8 8v3" />
  </Svg>
);

/** Lucide's pencil ruler, on its own 24px grid: editing the lights (admin mode). */
export const PencilRulerIcon = () => (
  <Svg viewBox="0 0 24 24" strokeWidth="2">
    <path d="M13 7 8.7 2.7a2.41 2.41 0 0 0-3.4 0L2.7 5.3a2.41 2.41 0 0 0 0 3.4L7 13" />
    <path d="m8 6 2-2" />
    <path d="m18 16 2-2" />
    <path d="m17 11 4.3 4.3c.94.94.94 2.46 0 3.4l-2.6 2.6c-.94.94-2.46.94-3.4 0L11 17" />
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Svg>
);

/** A dashed box round a light: the lights a shader's on, to pick on the map. */
export const DomainIcon = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" strokeDasharray="2.2 2.2" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);

/** A target: a layer's lights alone, everything else out of sight. */
export const FocusIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
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
