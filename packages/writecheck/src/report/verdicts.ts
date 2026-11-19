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
}

export function result(id: RequirementId, wp: WritePath, scenario: { id: string; version: string }, verdict: Verdict, reason: string, o: { numbers?: Record<string, unknown>; steps?: string[]; notes?: string[]; attribution?: 'server' | 'platform' | 'unresolved' } = {}): Result {
  const notes = [...(o.notes ?? [])];
  const listed = PLATFORM_LISTED.includes(id);
  const attribution = !listed || (verdict !== 'violated' && verdict !== 'platform') ? null : verdict === 'platform' ? 'platform' : (o.attribution ?? 'unresolved');
  // why: the general note says no control arm ran; where one ran and the record already says why it does not decide (too few
  // overlapped pairs, not the same schedule), that note would be untrue (gate-2 Grafana 3 on d3b536f).
  if (attribution === 'unresolved' && !notes.some((n) => /attribution stays unresolved/i.test(n))) notes.push(RULE3_NOTE);
  return { attribution, requirement: id, level: requirement(id).level, write_path: wp, scenario, verdict, reason, numbers: o.numbers ?? {}, steps: o.steps ?? [], notes };
}

export const RULE3_NOTE = 'Attribution: unresolved. No control arm ran, so the behavior may be the backend\'s (spec 8.2, rule 3).';

/** A requirement the suite did not run in this release or this run, with the reason. */
export interface NotRun {
  requirement: RequirementId;
  verdict: 'not tested' | 'not applicable';
  reason: string;
}
