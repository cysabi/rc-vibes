// What each arclamp light type is, and how its channels look as light.
//
// Color bulbs (br30) and 4×1 panels take the Lemtone channels a, b,
// brightness and fidelity, and solve them on the bulb. Old bulbs are relays
// with one channel, on: 1 is on and 0 is off (on at ON_THRESHOLD or more),
// and show as a 2700 K incandescent when on.

import type { Channels } from "./arclamp.ts";
import { whiteAB, type Lemtone } from "./lemtone.ts";

/** arclamp turns an old bulb on when its on channel is at least this (rclamp sink.OnThreshold). */
export const ON_THRESHOLD = 0.5;

/** An old bulb's light when on: a 2700 K incandescent, assumed ~800 lm until they're measured. */
const OLD_BULB: Lemtone = (() => {
  const [a, b] = whiteAB(2700);
  return { a, b, brightness: 0.8, fidelity: 1 };
})();

/**
 * Some fixtures come in orientations, each its own arclamp light type with
 * the same channels: "4x1" is a 1 ft × 4 ft panel standing vertically on the
 * plan, "4x1-horizontal" the same panel turned on its side.
 */
const ORIENTATIONS: Record<string, string[]> = { "4x1": ["4x1", "4x1-horizontal"] };

/** The hardware a light type is, whatever its orientation: "4x1-horizontal" → "4x1". */
export function baseType(type: string): string {
  for (const [base, types] of Object.entries(ORIENTATIONS)) if (types.includes(type)) return base;
  return type;
}

/** The other orientations a light of this type could be turned to (empty if it can't turn). */
export const orientationsOf = (type: string): string[] => ORIENTATIONS[baseType(type)] ?? [];

/** On/off only: the old bulbs. */
export const isBinary = (type: string) => baseType(type) === "relay";

/** Footprint on the plan in millimeters, for fixtures drawn at their real size. */
export function footprintOf(type: string): { width: number; height: number } | null {
  if (baseType(type) !== "4x1") return null;
  const FOOT = 304.8;
  return type === "4x1-horizontal" ? { width: 4 * FOOT, height: FOOT } : { width: FOOT, height: 4 * FOOT };
}

/** The channel values that ask a color light for `t`; null for old bulbs, which only switch. */
export function channelsFor(t: Lemtone, type: string): Channels | null {
  return isBinary(type) ? null : { a: t.a, b: t.b, brightness: t.brightness, fidelity: t.fidelity };
}

/** The channel values that switch an old bulb on or off. */
export const switchChannels = (on: boolean): Channels => ({ on: on ? 1 : 0 });

/** Whether an old bulb with these channels is on. */
export const isOn = (channels: Channels | undefined) => (channels?.on ?? 0) >= ON_THRESHOLD;

/** What a color light's channels ask for, dark or not; null for old bulbs. */
export function requestedOf(channels: Channels | undefined, type: string): Lemtone | null {
  if (!channels || isBinary(type)) return null;
  return { a: channels.a ?? 0, b: channels.b ?? 0, brightness: channels.brightness ?? 0, fidelity: channels.fidelity ?? 1 };
}

/** The light a set of channel values makes, or null when it's dark. */
export function lemtoneOf(channels: Channels | undefined, type: string): Lemtone | null {
  if (isBinary(type)) return isOn(channels) ? OLD_BULB : null;
  const t = requestedOf(channels, type);
  return t && t.brightness > 0 ? t : null;
}
