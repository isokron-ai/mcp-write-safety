/**
 * The baseline (expected-failures) file: known violations, one per line as
 * "<requirement> <resource>:<tool>". Known violations do not fail the run; a new `violated` MUST
 * does; and a baseline entry that is no longer violated fails too, so the file cannot rot. Teams
 * get a ratchet: no new violations, remove old ones as they are fixed.
 *
 *   format: mws-baseline/1
 *   expected_violations:
 *     - MWS-CONC-3 ticket:ticket_update
 */

import { readFileSync } from 'node:fs';

import { isRequirementId } from '../requirements.js';
import { isObj, parseConfigText, WritecheckError } from '../core/util.js';
import { writePathKey, type Result } from './verdicts.js';

export interface BaselineOutcome {
  /** Violations in the baseline (they do not fail the run). */
  known: string[];
  /** Violated MUSTs not in the baseline: these fail the run. */
  new_must: string[];
  /** Baseline entries that got a definite verdict other than violated: these fail the run too. */
  stale: string[];
  /** Baseline entries whose check did not run to a verdict this time (not tested, stopped): they neither pass nor fail. */
  not_rechecked: string[];
}

export function loadBaseline(file: string): string[] {
  const raw = parseConfigText(readFileSync(file, 'utf8'), file);
  if (!isObj(raw) || raw['format'] !== 'mws-baseline/1' || !Array.isArray(raw['expected_violations'])) throw new WritecheckError(`${file}: format mws-baseline/1 with an expected_violations list`, 2);
  return (raw['expected_violations'] as unknown[]).map((e, i) => {
    const s = String(e).trim().replace(/\s+/g, ' ');
    const [req, wp] = s.split(' ');
    if (!req || !wp || !isRequirementId(req) || !wp.includes(':')) throw new WritecheckError(`${file}: expected_violations[${i}]: "<MWS-ID> <resource>:<tool>"`, 2);
    return s;
  });
}

export function applyBaseline(results: Result[], baseline: string[]): BaselineOutcome {
  const violated = results.filter((r) => r.verdict === 'violated');
  const keys = new Set(violated.map((r) => `${r.requirement} ${writePathKey(r.write_path)}`));
  const known = [...keys].filter((k) => baseline.includes(k));
  const new_must = [...new Set(violated.filter((r) => r.level === 'MUST').map((r) => `${r.requirement} ${writePathKey(r.write_path)}`))].filter((k) => !baseline.includes(k));
  // why: an entry is stale only when the same requirement and write path came out definitely not violated; a check that did not run says nothing.
  const definite = new Set(results.filter((r) => ['held', 'not observed', 'platform', 'not applicable'].includes(r.verdict)).map((r) => `${r.requirement} ${writePathKey(r.write_path)}`));
  const stale = baseline.filter((b) => !keys.has(b) && definite.has(b));
  const not_rechecked = baseline.filter((b) => !keys.has(b) && !definite.has(b));
  return { known, new_must, stale, not_rechecked };
}

/** Exit status: 1 for a new violated MUST or a stale baseline entry, else 0. */
export const exitCodeFor = (b: BaselineOutcome): 0 | 1 => (b.new_must.length || b.stale.length ? 1 : 0);
