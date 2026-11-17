// The defect placement map (review B11): where each defect lands, so that
// overlaps under --defect all are known in advance, and the planned defects
// with their `requires` lists.
//
// The map of the defects that exist is computed, not written by hand: each
// defect is applied to a fresh correct build and every piece it changed (a
// tool's handler, description, schema or annotations; a validation step; a
// configuration rule) is recorded. Two defects on the same piece can mask each
// other when both are on.

import { createBuild } from "./mcp/build.js";
import { DEFECTS } from "./defects/index.js";
import { BACKEND_DEFECTS, type BackendSeam } from "./backend/defects/index.js";
import type { FeatureName } from "./profile.js";
import type { RequirementId } from "./requirements.js";
import type { FixturePropertyId } from "./fixture-properties.js";

/** A piece of the build: `tool:<name>.<part>`, `validation:<step>`, `config:<rule>` or `backend:<seam>`. */
export type Placement = string;

const TOOL_PARTS = ["handler", "description", "input", "annotations", "mutates"] as const;

/** The pieces one MCP-layer defect changes, found by applying it to a fresh correct build. */
export function placementsOf(defectName: string): Placement[] {
  const base = createBuild([]);
  const withDefect = createBuild([defectName]);
  const out: Placement[] = [];
  for (const [name, tool] of withDefect.tools) {
    const before = base.tools.get(name)!;
    for (const part of TOOL_PARTS) {
      const a = (tool as unknown as Record<string, unknown>)[part];
      const b = (before as unknown as Record<string, unknown>)[part];
      const same = part === "handler" ? a === b : JSON.stringify(a) === JSON.stringify(b);
      if (!same) out.push(`tool:${name}.${part}`);
    }
  }
  for (const step of Object.keys(withDefect.validation) as Array<keyof typeof base.validation>) {
    if (withDefect.validation[step] !== base.validation[step]) out.push(`validation:${step}`);
  }
  for (const rule of Object.keys(withDefect.configRules) as Array<keyof typeof base.configRules>) {
    if (withDefect.configRules[rule] !== base.configRules[rule]) out.push(`config:${rule}`);
  }
  return out;
}

export interface PlacementMap {
  /** Defect name → the pieces it changes. Backend defects as `backend:<seam>`. */
  byDefect: Record<string, Placement[]>;
  /** Piece → the defects that change it. */
  byPlacement: Record<Placement, string[]>;
  /** Pieces changed by more than one defect: where --defect all can mask. */
  shared: Record<Placement, string[]>;
}

export function placementMap(): PlacementMap {
  const byDefect: Record<string, Placement[]> = {};
  for (const d of DEFECTS) byDefect[d.name] = placementsOf(d.name);
  for (const d of BACKEND_DEFECTS) byDefect[`backend:${d.name}`] = d.seams.map((s) => `backend:${s}`);
  const byPlacement: Record<Placement, string[]> = {};
  for (const [name, places] of Object.entries(byDefect)) {
    for (const p of places) (byPlacement[p] ??= []).push(name);
  }
  const shared = Object.fromEntries(Object.entries(byPlacement).filter(([, names]) => names.length > 1));
  return { byDefect, byPlacement, shared };
}

/** A defect planned for a later release (the research plan's list, corrected by the source-checked review). */
export interface PlannedDefect {
  name: string;
  layer: "mcp" | "backend";
  /** What it trips: an FX- property, an MWS requirement, or both (the first is its own; the rest are overlaps). */
  trips: ReadonlyArray<FixturePropertyId | RequirementId>;
  /** Where it will land: `tool:<name>` for the MCP layer, `backend:<seam>` for the backend. */
  placement: readonly Placement[];
  /** Features it needs, plus `variant:<name>` where it is a defect of a variant. */
  requires: ReadonlyArray<FeatureName | `variant:${string}`>;
  since: string;
  summary: string;
}

export const PLANNED_DEFECTS: readonly PlannedDefect[] = [
  { name: "digest-of-current-state", layer: "backend", trips: ["FX-DIG-1"], placement: ["backend:digest"], requires: ["execution-records"], since: "0.2.0",
    summary: "The digest is computed over the object's current state, so it changes after a later update." },
  { name: "replay-digest-mismatch", layer: "backend", trips: ["FX-DIG-2"], placement: ["backend:digest", "backend:keyRecord"], requires: ["execution-records"], since: "0.2.0",
    summary: "A replay re-renders the result with a fresh timestamp, so its digest differs from the first answer's." },
  { name: "digest-not-canonical", layer: "backend", trips: ["FX-DIG-3"], placement: ["backend:digest"], requires: ["execution-records"], since: "0.2.0",
    summary: "The hash is over insertion-ordered JSON, so recomputation from the served bytes does not match." },
  { name: "lookup-wrong-record", layer: "backend", trips: ["FX-LOOK-1"], placement: ["backend:lookup"], requires: ["lookup"], since: "0.2.0",
    summary: "A lookup returns the most recent record whose key shares a prefix with the key asked for." },
  { name: "lookup-reexecutes", layer: "mcp", trips: ["FX-LOOK-2", "MWS-ANN-1"], placement: ["tool:get_operation"], requires: ["lookup"], since: "0.2.0",
    summary: "get_operation repeats the create when the key is unknown; a read-only tool changes state." },
  { name: "lookup-unscoped", layer: "backend", trips: ["FX-LOOK-3"], placement: ["backend:lookup"], requires: ["lookup", "principals"], since: "0.2.0",
    summary: "A lookup returns another principal's record." },
  { name: "key-record-not-durable", layer: "backend", trips: ["FX-DUR-1", "MWS-RETRY-2"], placement: ["backend:journal"], requires: ["durable"], since: "0.3.0",
    summary: "Data is journalled but key records stay in memory; after a whole-stack restart a repeat duplicates." },
  { name: "key-record-after-effect", layer: "backend", trips: ["FX-DUR-2"], placement: ["backend:journal"], requires: ["durable"], since: "0.3.0",
    summary: "The effect and its key record go in two journal lines: the persistence gap, done wrong." },
  { name: "journal-without-fsync", layer: "backend", trips: ["FX-DUR-3"], placement: ["backend:journal"], requires: ["durable"], since: "0.3.0",
    summary: "The answer is sent before the journal line is flushed." },
  { name: "key-expires-early", layer: "backend", trips: ["FX-KEY-1"], placement: ["backend:keyExpiry"], requires: ["retention"], since: "0.3.0",
    summary: "Keys are kept a thousandth of the stated retention." },
  { name: "retention-unstated", layer: "mcp", trips: ["FX-KEY-2"], placement: ["tool:create_ticket", "tool:create_project", "tool:add_comment"], requires: ["retention"], since: "0.3.0",
    summary: "The key-accepting tools' descriptions do not say how long a key is remembered." },
  { name: "in-flight-key-race", layer: "backend", trips: ["MWS-RETRY-2"], placement: ["backend:keyRecord"], requires: ["inflight"], since: "0.3.0",
    summary: "Check-then-act with no pending record: two overlapping same-key creates both apply." },
  { name: "in-flight-phantom-success", layer: "backend", trips: ["FX-KEY-3", "MWS-RES-1"], placement: ["backend:keyRecord"], requires: ["inflight"], since: "0.3.0",
    summary: "A same-key call during a pending one answers success at once, with no committed record." },
  { name: "in-progress-reported-not-applied", layer: "mcp", trips: ["MWS-RES-2"], placement: ["tool:create_ticket"], requires: ["inflight"], since: "0.3.0",
    summary: "The 409 for a pending key is reported as not applied, though the keyed write is about to apply (it is in_progress, outcome unknown)." },
  { name: "settle-miss-reported-not-applied", layer: "mcp", trips: ["MWS-RES-1"], placement: ["tool:create_ticket"], requires: ["lookup", "variant:settle-by-lookup"], since: "0.3.0",
    summary: "After a lost backend answer, a lookup miss is reported as not applied, though the held request can still land." },
  { name: "settled-reported-unknown", layer: "mcp", trips: ["FX-LOOK-4"], placement: ["tool:create_ticket"], requires: ["lookup", "variant:settle-by-lookup"], since: "0.3.0",
    summary: "The lookup finds the write applied, and the answer still says unknown." },
];

/** Planned correct variants (not defects), for the compatibility table and the placement map. */
export const PLANNED_VARIANTS: ReadonlyArray<{ name: string; since: string; layer: "mcp"; placement: readonly Placement[]; summary: string }> = [
  { name: "settle-by-lookup", since: "0.3.0", layer: "mcp", placement: ["tool:create_ticket"],
    summary: "After a lost backend answer, look the write up by key, behind a key fence so a late original is refused; a miss with no fence stays unknown." },
  { name: "key-store-durable", since: "0.3.0", layer: "mcp", placement: ["tool:create_ticket"],
    summary: "The MCP server keeps key, fingerprint, state and result in its own flushed journal, for a backend with no idempotency." },
  { name: "settle-by-client-reference", since: "0.3.0", layer: "mcp", placement: ["tool:create_ticket"],
    summary: "The MCP server writes the key into a backend field and settles a lost answer by reading it back." },
];

/** All backend seams a planned defect needs; each must be in BACKEND_SEAMS. */
export function plannedSeams(): BackendSeam[] {
  return [...new Set(PLANNED_DEFECTS.flatMap((d) => d.placement.filter((p) => p.startsWith("backend:")).map((p) => p.slice(8) as BackendSeam)))];
}
