// Backend defects. There is exactly one: it makes the platform itself lose
// concurrent updates, so a test can tell "the MCP layer lost it" (violated)
// from "the platform's own API loses it too" (platform).

import type { BackendOps } from "../http.js";
import { lostUpdate } from "./lost-update.js";

export interface BackendDefect {
  name: string;
  summary: string;
  apply(ops: BackendOps): void;
}

export const BACKEND_DEFECTS: BackendDefect[] = [lostUpdate];

export function applyBackendDefects(names: string[], ops: BackendOps): void {
  for (const name of names) {
    const defect = BACKEND_DEFECTS.find((d) => d.name === name);
    if (!defect) {
      throw new Error(`unknown backend defect "${name}"; known: ${BACKEND_DEFECTS.map((d) => d.name).join(", ")}`);
    }
    defect.apply(ops);
  }
}
