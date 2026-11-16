// DEFECT stale-unannounced -- MWS-CONC-5 (SHOULD)
// Where the backend cannot detect that an object changed since the caller's
// read, the description of a tool that deletes or replaces it says that stale
// writes are not detected.
//
// WRONG ON PURPOSE. Correct code: deleteProject's description in
// src/mcp/tools/projects.ts.
//
// What goes wrong: projects carry no version the backend checks, so
// delete_project cannot refuse a delete made from a stale read. The correct
// description says so; this one does not, so a caller assumes a protection
// that does not exist.
//
// Mirrors: the guidance under MWS-CONC-2 and Annex B-8 (say what is not
// protected); PostHog's versioned tool that ignored the version on some
// objects (classed as a design gap).
//   https://isokron.ai/research/posthog-mcp-server-audit#what-held-up

import type { Defect } from "./types.js";
import { patchTool } from "./types.js";

export const defect: Defect = {
  name: "stale-unannounced",
  requirement: "MWS-CONC-5",
  summary: "delete_project's description does not say that stale deletes are not detected",
  mirrors: "Annex B-8; PostHog design gap",
  replaces: "deleteProject's description (src/mcp/tools/projects.ts)",
  apply(build) {
    // DEFECT: the disclosure sentence is gone.
    patchTool(build, "delete_project", { description: "Delete a project that has no tickets. Delete its tickets first with delete_tickets." });
  },
};
