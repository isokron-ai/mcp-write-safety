// Backend defects: the backend's own defect registry.
//
// Most of the planned fixture defects live in the backend (digest, key record,
// lookup, journal, key expiry), so the backend has the same machinery as the
// MCP layer:
//
//   seams    each defect replaces one or more named seams of BackendOps; a
//            seam that is not wired yet cannot take a defect (refused at start)
//   requires the features a defect needs; refused at start when they are off
//   banner   a backend defect build prints a banner on stderr, and when the
//            build descriptor is mirrored it names the defects with a
//            `backend:` prefix in the MCP instructions
//   refusal  unknown names, unwired seams, missing features and a non-loopback
//            bind all stop the process (exit 2)
//
// Today there is exactly one backend defect, lost-update: it makes the
// platform itself lose concurrent updates, so a test can tell "the MCP layer
// lost it" (violated) from "the platform's own API loses it too" (platform).

import type { BackendOps } from "../http.js";
import type { FeatureName } from "../../profile.js";
import type { RequirementId } from "../../requirements.js";
import type { FixturePropertyId } from "../../fixture-properties.js";
import { lostUpdate } from "./lost-update.js";

/** Named places in the backend a defect may replace. */
export const BACKEND_SEAMS = {
  patchTicket: { wired: true, since: "0.1.0", note: "PATCH /tickets/:id: read, check the version, write, with no await between" },
  inputRules: { wired: true, since: "0.2.0", note: "Idempotency-key format and well-formed strings (feature strict-input)" },
  digest: { wired: false, since: "0.2.0", note: "The canonical bytes and digest of a committed result (execution records)" },
  keyRecord: { wired: true, since: "0.1.0", note: "Reading and completing a key record, scoped by principal (src/backend/seams.ts); pending and tombstone states from 0.3.0" },
  lookup: { wired: false, since: "0.2.0", note: "GET /operations/:key" },
  journal: { wired: false, since: "0.3.0", note: "The JSONL journal: one commit line per transaction, flushed before the answer" },
  keyExpiry: { wired: false, since: "0.3.0", note: "Key retention and tombstones" },
} as const satisfies Record<string, { wired: boolean; since: string; note: string }>;

export type BackendSeam = keyof typeof BACKEND_SEAMS;

export interface BackendDefect {
  name: string;
  summary: string;
  /** The requirement or fixture property it demonstrates. lost-update is MWS-CONC-3 context for the `platform` verdict. */
  context: RequirementId | FixturePropertyId;
  /** The seams it replaces. */
  seams: readonly BackendSeam[];
  /** Features it needs (empty: none). */
  requires: readonly FeatureName[];
  apply(ops: BackendOps): void;
}

export const BACKEND_DEFECTS: BackendDefect[] = [lostUpdate];

/** The banner a backend defect build prints on stderr (the MCP layer's banner names them with a backend: prefix). */
export function backendBanner(names: readonly string[]): string {
  return `backend defects on: ${names.map((n) => `backend:${n}`).join(", ")}`;
}

export interface BackendDefectContext {
  /** Active features. */
  features: readonly string[];
  /** The address the backend binds to. Backend defect builds bind loopback only. */
  host?: string;
}

/** Why a set of backend defects cannot start; empty when it can. */
export function backendDefectRefusals(names: readonly string[], ctx: BackendDefectContext): string[] {
  const out: string[] = [];
  for (const name of names) {
    const defect = BACKEND_DEFECTS.find((d) => d.name === name);
    if (!defect) {
      out.push(`unknown backend defect "${name}"; known: ${BACKEND_DEFECTS.map((d) => d.name).join(", ")}`);
      continue;
    }
    const unwired = defect.seams.filter((s) => !BACKEND_SEAMS[s].wired);
    if (unwired.length > 0) out.push(`backend defect "${name}" replaces seam(s) not built in this version: ${unwired.join(", ")}`);
    const missing = defect.requires.filter((f) => !ctx.features.includes(f));
    if (missing.length > 0) out.push(`backend defect "${name}" needs the feature(s) ${missing.join(", ")}; name them with --features`);
  }
  if (names.length > 0 && ctx.host !== undefined && !["127.0.0.1", "localhost", "::1"].includes(ctx.host)) {
    out.push(`a backend with defects binds 127.0.0.1 only, not ${ctx.host}`);
  }
  return out;
}

export function applyBackendDefects(names: string[], ops: BackendOps, features: readonly string[] = []): void {
  const refusals = backendDefectRefusals(names, { features });
  if (refusals.length > 0) throw new Error(refusals.join("; "));
  for (const name of names) BACKEND_DEFECTS.find((d) => d.name === name)!.apply(ops);
}
