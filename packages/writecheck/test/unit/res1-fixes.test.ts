/**
 * MWS-RES-1 review fixes: a multi-item tool with neither invalid_id nor backend.gate still gets its call on good items only
 * (and the ATOM records say what they need), and the wait for a deleted object ends on the first read that shows it gone.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { multiCheck, multiVerdicts, type MultiObs } from '../../src/checks/multi.js';
import type { RunContext, Tool } from '../../src/checks/types.js';
import { Driver, type ReadResult } from '../../src/core/driver.js';
import { parseManifestText } from '../../src/core/manifest.js';

const MAN = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: t_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" } }
    list: { tool: t_list, args: {}, items: tickets, id: id, name: title }
    cleanup: delete
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    multi:
      - { tool: t_bulk, args: { ids: "{{ids}}", status: closed }, effect: { path: status, value: closed } }
`,
  'm.yaml',
);
const RES = MAN.resources[0]!;
const TOOLS = ['t_create', 't_get', 't_list', 't_delete', 't_bulk'].map((name) => ({ name, inputSchema: { type: 'object' } })) as unknown as Tool[];

test('multi-item without invalid_id and without backend.gate: MWS-RES-1 is planned and run, ATOM says what it needs', async () => {
  assert.equal(MAN.backend?.gate, undefined);
  const p = multiCheck.plan({ manifest: MAN, tools: TOOLS }, RES);
  assert.equal(p.runs, true);
  assert.ok(p.calls.some((c) => /t_bulk: 2 good items only.*MWS-RES-1/.test(c)));
  assert.equal(p.writes, 3);
  assert.equal(p.creates, 2);
  assert.ok(!p.notRun.some((r) => r.requirement === 'MWS-RES-1'), 'RES-1 is not reported as not tested');
  assert.ok(!p.notRun.some((r) => r.requirement === 'MWS-ATOM-1'), 'the ATOM records come from evaluate, with the right reason');
  // collect reaches the tool (the sentinel is thrown by the first thing runMulti does).
  const ctx = { gate: null, label: () => { throw new Error('reached runMulti'); } } as unknown as RunContext;
  await assert.rejects(multiCheck.collect(ctx, RES), /reached runMulti/);
  // evaluate: ATOM is not tested because it has no trial, with the reason that matches the declaration.
  const o: MultiObs = { tool: 't_bulk', routing: null, mutating_in_learning: null, trials: [] };
  const v = multiVerdicts(o, RES, RES.multi[0]!);
  assert.deepEqual(v.map((r) => `${r.requirement} ${r.verdict}`), ['MWS-ATOM-1 not tested', 'MWS-ATOM-2 not tested']);
  assert.ok(v.every((r) => /declare invalid_id.*backend\.gate/.test(r.reason)));
});

test('readSettled: a wait with a done predicate ends on the first read that shows the object gone, not at the end of the window', async () => {
  const reads: boolean[] = [false, false, true];
  let n = 0;
  const d = Object.create(Driver.prototype) as Driver & { res: unknown; session: unknown; readOnce: unknown };
  Object.assign(d, {
    res: { read: { settle_ms: 60000 } },
    session: { stepId: (s: string) => s },
    readOnce: async (): Promise<ReadResult> => ({ ok: !reads[n++], obj: {}, version: null, call: null, http: null, reads: 1, settled: false }),
  });
  const t0 = Date.now();
  const r = await d.readSettled('L', 'x', () => false, (x) => !x.ok);
  assert.equal(r.reads, 3);
  assert.equal(r.settled, true);
  assert.ok(Date.now() - t0 < 5000, 'it did not wait out the 60 s window');
  // Without done the same reads never settle before the window; with no predicate there is one read (a refusal).
  n = 0;
  const one = await d.readSettled('L', 'x');
  assert.equal(one.reads, 1);
});
