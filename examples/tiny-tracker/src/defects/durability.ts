// The MCP-layer defects of the 0.3.0 durability stream. They need the inflight
// feature, so they are listed here and not yet in DEFECTS (./index.ts): adding a
// feature-gated defect there changes the Phase 0 tests that hold "no defect
// needs a feature" and run every defect with no features. The lane lead moves
// them into DEFECTS when those tests learn about features (see the stream notes).

import type { Defect } from "./types.js";
import { defect as inProgressReportedNotApplied } from "./in-progress-reported-not-applied.js";
import { defect as settleMissReportedNotApplied } from "./settle-miss-reported-not-applied.js";

export const DURABILITY_MCP_DEFECTS: Defect[] = [inProgressReportedNotApplied, settleMissReportedNotApplied];
