/**
 * The seven verdicts and the result record. A result is about one requirement on one write path
 * (resource, tool, arm), from one scenario at one version. There is no aggregate: no total, no
 * percentage, no pass count, anywhere.
 */

import { PLATFORM_LISTED, requirement, type RequirementId } from '../requirements.js';

export const VERDICTS = ['violated', 'platform', 'held', 'not observed', 'not tested', 'not applicable', 'self-attested'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The fixed sentence a `not observed` result from barrier pairs is printed with. */
export const NOT_OBSERVED_SENTENCE = 'No lost update was seen in these simultaneous pairs. This does not show the server is safe under concurrency. To force the interleaving, configure backend.gate.';
/** The caveat every `violated` result from deliberately simultaneous calls carries. */
export const VIOLATED_CAVEAT = 'Reproduced with deliberately simultaneous or deliberately stale calls; this says nothing about how often it happens in normal use.';

export interface WritePath {
  resource: string;
  /** The tool under test (or the tool the requirement is about). */
  tool: string;
  /** `mcp`: through the server. The control arm only attributes; it is never itself judged. */
  arm: 'mcp';
}

export const writePathKey = (w: WritePath): string => `${w.resource}:${w.tool}`;

export interface Result {
  requirement: RequirementId;
  level: 'MUST' | 'SHOULD';
  write_path: WritePath;
  scenario: { id: string; version: string };
  verdict: Verdict;
  /** One or two sentences: why this verdict. */
  reason: string;
  /** Counts and measured numbers behind the verdict (pairs run, overlapped, bounds, cases …). */
  numbers: Record<string, unknown>;
  /** Step ids in the capture and history that show it (the smallest failing trace first). */
  steps: string[];
  notes: string[];
  /** What defines this record's test (report/testhash.ts, `mws-test-hash/1`); stamped at the end of a run. Absent in files written before it. */
  test_hash?: string;
  /** For a requirement that judges part of the tool entry (testhash.ts subjectFacets): the hash without that part. */
  test_hash_core?: string;
  /**
   * Spec 8.2 rule 3: for a requirement that lists platform, a violated or platform record carries one of
   * server (a control arm ran and the platform API did not show the behavior), platform (it did), or
   * unresolved (no control arm ran, so the behavior may be the backend's). Null for every other record.
   */
  attribution: 'server' | 'platform' | 'unresolved' | null;
  /**
   * The cell this record belongs to (docs/CELLS.md): `<requirement>@<tool>` for a MUST requirement on a declared write tool, or
   * `<requirement>@(server)` for a server-level MUST requirement. Set by the cell pass at the end of a run (checks/cells.ts), never
   * by a check: a check only names the tool in write_path, and every record for that requirement and tool, under any resource or
   * scenario, lands in the same cell. Absent on records that belong to no cell (SHOULD requirements, read tools, the catalog).
   */
  cell?: string;
  /** Evidence validity (report/validity.ts): present on every `violated` record, absent otherwise. */
  validity?: Validity;
}

/**
 * Whether a `violated` record counts toward a rating (docs/CELLS.md, "Validity"). `valid`: it counts. `platform`: it counts, and
 * is printed as "attribution unresolved" (no control arm decided whether the backend does the same). `harness-suspect`: it does
 * not count until a re-run reproduces it; `failed` names the rules it did not meet.
 */
export interface Validity {
  class: 'valid' | 'platform' | 'harness-suspect';
  counts: boolean;
  /** The validity rules (V-*) the record did not meet; empty for valid and platform. */
  failed: string[];
  /** The violation was seen under a fault the gate injected (a status the real backend may never send); printed, not disqualifying. */
  synthetic_fault: boolean;
  /** What the check stated about its evidence, where it said (Evidence below); null members were not stated. */
  evidence: Evidence;
}

/** What a check can state about the evidence behind a `violated` record (all optional; the validity pass fills what it can see). */
export interface Evidence {
  /** Every write the violation rests on was acknowledged as a success by the server. */
  acknowledged?: boolean | null;
  /** The final state was read back after the writes. */
  read_back?: boolean | null;
  /** The violation was provoked with a fault the gate injected. */
  synthetic_fault?: boolean | null;
  /** Where the evidence is when it is not a call trace (validity.ts STEPS_EXEMPT): the catalog, the launch observation, the ledger. */
  basis?: string;
}

export function result(id: RequirementId, wp: WritePath, scenario: { id: string; version: string }, verdict: Verdict, reason: string, o: { numbers?: Record<string, unknown>; steps?: string[]; notes?: string[]; attribution?: 'server' | 'platform' | 'unresolved'; evidence?: Evidence } = {}): Result {
  const notes = [...(o.notes ?? [])];
  const listed = PLATFORM_LISTED.includes(id);
  const attribution = !listed || (verdict !== 'violated' && verdict !== 'platform') ? null : verdict === 'platform' ? 'platform' : (o.attribution ?? 'unresolved');
  // why: the general note says no control arm ran; where one ran and the record already says why it does not decide (too few
  // overlapped pairs, not the same schedule), that note would be untrue (gate-2 Grafana 3 on d3b536f).
  if (attribution === 'unresolved' && !notes.some((n) => /attribution stays unresolved/i.test(n))) notes.push(RULE3_NOTE);
  const out: Result = { attribution, requirement: id, level: requirement(id).level, write_path: wp, scenario, verdict, reason, numbers: o.numbers ?? {}, steps: o.steps ?? [], notes };
  // why: F6: a check that knows its evidence says so here; the validity pass (report/validity.ts) completes the block at the end of the run.
  if (verdict === 'violated' && o.evidence) out.validity = { class: 'valid', counts: true, failed: [], synthetic_fault: o.evidence.synthetic_fault === true, evidence: { ...o.evidence } };
  return out;
}

export const RULE3_NOTE = 'Attribution: unresolved. No control arm ran, so the behavior may be the backend\'s (spec 8.2, rule 3).';

/** A requirement the suite did not run in this release or this run, with the reason. */
export interface NotRun {
  requirement: RequirementId;
  verdict: 'not tested' | 'not applicable';
  reason: string;
}
