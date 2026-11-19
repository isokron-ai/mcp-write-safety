/**
 * Review M3 (before/after): `recheck` by the build that made a run must not change a verdict or a hash. The run applies whole-run
 * adjustments after the checks' evaluate() (a declared explicit override takes MWS-CONC-1 away, NF-7; the first write after a
 * create keeps MWS-UPD-1 from held); recheck used to skip them, so the rechecked copy said held where the run said not tested,
 * under an equal test hash. Converted from review probe p11 (a) and the real-pair rows of p11 (b).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { recheckCommand } from '../../src/cli/commands.js';
import { finishRecheck } from '../../src/cli/compare.js';
import type { ResultsDoc } from '../../src/report/results.js';
import { head, runFixture, startFixture, TRACKER_GUARD } from '../regression/harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from '../regression/tracker-fixture.js';

const key = (r: ResultsDoc['results'][number]) => `${r.requirement}|${r.write_path.resource}|${r.write_path.tool}|${r.scenario.id}|${r.case ?? ''}`;

async function runAndRecheck(f: Awaited<ReturnType<typeof startFixture>>): Promise<{ run: ResultsDoc; re: ResultsDoc }> {
  const r = await runFixture(f);
  const log = () => {};
  recheckCommand({ dir: r.outDir, log });
  await finishRecheck(r.outDir, { key: null, log });
  return { run: JSON.parse(readFileSync(join(r.outDir, 'results.json'), 'utf8')) as ResultsDoc, re: JSON.parse(readFileSync(join(r.outDir, 'recheck', 'results.json'), 'utf8')) as ResultsDoc };
}

function sameVerdictsAndHashes(run: ResultsDoc, re: ResultsDoc): void {
  const group = (d: ResultsDoc) => {
    const m = new Map<string, string[]>();
    for (const r of d.results) m.set(key(r), [...(m.get(key(r)) ?? []), `${r.verdict} ${r.test_hash}`].sort());
    return m;
  };
  const a = group(run);
  const b = group(re);
  const moved = [...a].filter(([k, v]) => JSON.stringify(b.get(k)) !== JSON.stringify(v)).map(([k, v]) => `${k}: ${v.join(', ')} → ${(b.get(k) ?? ['(none)']).join(', ')}`);
  assert.deepEqual(moved, [], 'every record keeps its verdict and its test_hash');
  assert.deepEqual(re.cells?.map((c) => `${c.key} ${c.verdict}`), run.cells?.map((c) => `${c.key} ${c.verdict}`), 'every cell keeps its verdict');
}

test('M3: recheck of a fresh run with a declared explicit override changes no verdict and no hash', async () => {
  const MANIFEST = `${head({ guard: TRACKER_GUARD, gate: true })}
resources:
${ticket({ name: 'ticket-save', update: '{ tool: ticket_save, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}", overwrite: true }, override: overwrite }', fields: ASSIGNEE_STATUS })}`;
  const f = await startFixture({ profile: 'tracker', manifest: MANIFEST });
  try {
    const { run, re } = await runAndRecheck(f);
    const conc1 = run.results.filter((r) => r.requirement === 'MWS-CONC-1' && r.write_path.tool === 'ticket_save' && /explicit override/.test(r.reason));
    assert.ok(conc1.length >= 1, 'the run took MWS-CONC-1 away for the override (the case under test)');
    sameVerdictsAndHashes(run, re);
  } finally {
    await f.close();
  }
});

test('M3: recheck of a fresh run whose first write after the create changed other fields changes no verdict and no hash', async () => {
  const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({ create: 'assignee: ann, status: blocked, note: "keep me", priority: 4, meta: { source: null, panels: 2 }', update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;
  const f = await startFixture({ profile: 'tracker', opts: ['strict-empty'], backend: { normalizeOnWrite: true }, manifest: MANIFEST });
  try {
    const { run, re } = await runAndRecheck(f);
    assert.ok(run.results.some((r) => r.requirement === 'MWS-UPD-1' && r.reason.startsWith('the first write after the create')), 'the first-write rule applied in the run (the case under test)');
    sameVerdictsAndHashes(run, re);
  } finally {
    await f.close();
  }
});
