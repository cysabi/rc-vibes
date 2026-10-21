// The lights that solve lemtones, each on its own calibration from
// rc-bulb-firmware, with Walter's solve (solver.ts): the color bulbs (br30;
// bulb.model.ts) and the 4×1 panels (panel.model.ts). fixtures.ts says which
// light types are which.

import { MODEL as BULB_MODEL } from "./bulb.model.ts";
import { MODEL as PANEL_MODEL } from "./panel.model.ts";
import { solverOf, type Solver } from "./solver.ts";

export type Device = "bulb" | "panel";

export const DEVICES: readonly Device[] = ["bulb", "panel"];

export const SOLVERS: Record<Device, Solver> = { bulb: solverOf(BULB_MODEL), panel: solverOf(PANEL_MODEL) };
