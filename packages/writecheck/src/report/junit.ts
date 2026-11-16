/**
 * JUnit XML for CI: one test case per requirement per write path per scenario. `violated` is a
 * failure; `held` passes; every other verdict is skipped with the verdict as its message, so a green
 * tick never stands for `not observed`. A violation listed in the baseline is skipped as a known
 * violation, and a baseline entry that no longer fails is reported as a failure of its own (so the
 * file cannot rot). The suite element carries no counts: CI tools count for themselves.
 */

import { requirement } from '../requirements.js';
import type { BaselineOutcome } from './baseline.js';
import type { ResultsDoc } from './results.js';
import { writePathKey } from './verdicts.js';

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderJunit(d: ResultsDoc, b: BaselineOutcome | null): string {
  const L: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="mcp-writecheck ${x(d.suite.version)} MWS ${x(d.spec.version)}">`];
  const areas = [...new Set(d.results.map((r) => requirement(r.requirement).area))];
  for (const area of areas) {
    L.push(`  <testsuite name="MWS-${x(area)}">`);
    for (const r of d.results.filter((y) => requirement(y.requirement).area === area)) {
      const key = `${r.requirement} ${writePathKey(r.write_path)}`;
      L.push(`    <testcase classname="${x(`${r.requirement}.${r.scenario.id}`)}" name="${x(key)}">`);
      if (r.verdict === 'violated') {
        if (b?.known.includes(key)) L.push(`      <skipped message="${x(`violated (known, in the baseline): ${r.reason}`)}"/>`);
        else L.push(`      <failure message="${x(`violated (${r.level}): ${r.reason}`)}">${x([r.reason, ...r.notes, r.steps.length ? `trace: ${r.steps.join(', ')}` : ''].filter(Boolean).join('\n'))}</failure>`);
      } else if (r.verdict !== 'held') L.push(`      <skipped message="${x(`${r.verdict}: ${r.reason}`)}"/>`);
      L.push('    </testcase>');
    }
    L.push('  </testsuite>');
  }
  if (b?.stale.length) {
    L.push('  <testsuite name="baseline">');
    for (const s of b.stale) L.push(`    <testcase classname="baseline" name="${x(s)}"><failure message="${x('a baseline entry that no longer fails: remove it from the baseline file')}"/></testcase>`);
    L.push('  </testsuite>');
  }
  L.push('</testsuites>');
  return L.join('\n') + '\n';
}
