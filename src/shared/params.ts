// Params: numbers a sketch declares (param() in @roobscoob/vibes) that vibes
// changes while it runs, by light or for everywhere. What's declared comes
// from the sketch's build (the builder loads the script and reads them); the
// values are each instance's, kept in vibes' database and sent to its shader
// over arclamp's udp as packets, one param's whole state each. This mirrors
// packages/vibes/src/param.ts, which the library keeps on its own, since it's
// published apart from vibes.

/** A param as declared. */
export interface ParamSpec {
  name: string;
  default: number;
  min: number;
  max: number;
  step: number;
  label: string;
  /** Whether it can be set per light; else it's one knob for the instance. */
  perLight: boolean;
}

/** A param's values: for everywhere, and per light (by id); either may be unset, and the default stands in. */
export interface ParamValues {
  all?: number;
  lights?: Record<string, number>;
}

/** An instance's values, by param name. */
export type ParamTable = Record<string, ParamValues>;

/** A shader's params as the feed has them: what its sketch declares, and its values. */
export interface ShaderParams {
  specs: ParamSpec[];
  values: ParamTable;
}

/** A param's name: a word. */
export const PARAM_NAME = /^[A-Za-z][\w-]{0,39}$/;

/** The most params a sketch may declare, and the most lights one may have values for. */
export const MAX_PARAMS = 64;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The value a light reads: its own, else everywhere's, else the default, within the range. */
export function valueFor(spec: ParamSpec, values: ParamValues | undefined, lightId: number): number {
  const own = values?.lights?.[String(lightId)];
  const v = finite(own) ? own : finite(values?.all) ? values.all : spec.default;
  return Math.min(spec.max, Math.max(spec.min, v));
}

/** Values with only what's set, each within the spec's range. */
export function cleanValues(spec: ParamSpec, values: ParamValues): ParamValues {
  const within = (v: number) => Math.min(spec.max, Math.max(spec.min, v));
  const out: ParamValues = {};
  if (finite(values.all)) out.all = within(values.all);
  if (values.lights && typeof values.lights === "object") {
    const lights: Record<string, number> = {};
    for (const [id, v] of Object.entries(values.lights)) if (finite(v)) lights[id] = within(v);
    if (Object.keys(lights).length > 0) out.lights = lights;
  }
  return out;
}

/**
 * A change to a param's values: a part given replaces that part (null unsets
 * it); lights given are merged with those set already, each null taking one
 * away. Setting a section leaves the rest as they were.
 */
export interface ParamPatch {
  all?: number | null;
  lights?: Record<string, number | null> | null;
}

/** The values after a patch, cleaned. */
export function patchValues(spec: ParamSpec, prev: ParamValues | undefined, patch: ParamPatch): ParamValues {
  const lights: Record<string, number> = patch.lights === null ? {} : { ...(prev?.lights ?? {}) };
  if (patch.lights) {
    for (const [id, v] of Object.entries(patch.lights)) {
      if (v === null) delete lights[id];
      else lights[id] = v;
    }
  }
  const all = patch.all === undefined ? prev?.all : patch.all === null ? undefined : patch.all;
  return cleanValues(spec, { all, lights });
}

/** A value as a knob shows it: as many decimals as its step has. */
export function paramText(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step))));
  return v.toFixed(decimals);
}

/** One param's packet, as the library takes it (takePacket in param.ts): its whole state, as JSON text. */
export const packetOf = (seq: number, name: string, values: ParamValues): string =>
  JSON.stringify({ vibes: "params", v: 1, seq, name, ...(values.all !== undefined ? { all: values.all } : {}), ...(values.lights ? { lights: values.lights } : {}) });
