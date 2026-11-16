/**
 * From the writesafe self-test on 378f32f (its report, section 4): T3 (the control
 * patch body key), T5 (every requirement has a record), T6 (CONC-6 counts current_version and current), T7 (a success that
 * left nothing applied in the stale-write test's validity arm is MWS-RES-1 violated). T1 and T2 are pinned by the fake runs.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { everyRequirement } from '../../src/checks/coverage.js';
import { staleVerdicts, versionIn } from '../../src/checks/stale.js';
import { wp } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { REQUIREMENTS } from '../../src/requirements.js';
import { result } from '../../src/report/verdicts.js';

const man = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: page
    create: { tool: ws_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: ws_get, args: { id: "{{id}}" } }
    update: { tool: ws_patch, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: data.summary, arg: summary, values: [a, b], control_key: summary }
      - { path: data.note, arg: note, values: [x, y] }
    version: { read: version, arg: if_match }
    delete: { tool: ws_delete, args: { id: "{{id}}", if_match: "{{version}}" } }
    cleanup: delete
`,
  'm.yaml',
);

test('T3: a field can name the key the control patch body uses', () => {
  assert.equal(man.resources[0]!.fields![0].control_key, 'summary');
  assert.equal(man.resources[0]!.fields![1].control_key, null);
});

test('T5: a requirement no check made a record for gets one not tested record with what to declare', () => {
  const some = [result('MWS-UPD-1', wp('page', 'ws_patch'), { id: 'x', version: '1' }, 'held', 'ok')];
  const filled = everyRequirement(some, [{ requirement: 'MWS-CONC-5' }]);
  const ids = new Set([...some, ...filled].map((r) => r.requirement));
  for (const r of REQUIREMENTS) if (r.id !== 'MWS-CONC-5') assert.ok(ids.has(r.id), r.id);
  assert.ok(filled.every((r) => r.verdict === 'not tested'));
  assert.match(filled.find((r) => r.requirement === 'MWS-UPD-2')!.reason, /list_edit/);
});

test('T6: CONC-6 finds the current version under current_version, currentVersion or inside current', () => {
  assert.equal(versionIn({ current_version: 'v7' }, 'version', 'v7'), true);
  assert.equal(versionIn({ currentVersion: 7 }, 'version', 7), true);
  assert.equal(versionIn({ current: { version: 'v7', note: 'x' } }, 'version', 'v7'), true);
  assert.equal(versionIn({ current: { version: 'v6' } }, 'version', 'v7'), false);
});

test('T7: a write answered as a success that is not in effect in the validity arm is MWS-RES-1 violated', () => {
  const res = man.resources[0]!;
  const out = { experiment: { arms: [], vars: {} }, arms: { validity: { counts: { valid: 1, both_kept: 0, success_unapplied: 1 }, reps: [] } } } as never;
  const v = staleVerdicts(out, res);
  const r1 = v.filter((r) => r.requirement === 'MWS-RES-1');
  assert.equal(r1.length, 1);
  assert.equal(r1[0]!.verdict, 'violated');
  assert.ok(v.some((r) => r.requirement === 'MWS-CONC-2' && r.verdict === 'not tested'));
  const clean = staleVerdicts({ experiment: { arms: [], vars: {} }, arms: { validity: { counts: { valid: 1, both_kept: 0, success_unapplied: 0 }, reps: [] } } } as never, res);
  assert.equal(clean.filter((r) => r.requirement === 'MWS-RES-1').length, 0);
});

test('T2: clean-up sends a delete that takes the version the version just read, and the object goes', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Ledger } = await import('../../src/core/ledger.js');
  const { cleanupLedger } = await import('../../src/core/cleanup.js');
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-t2-'));
  try {
    const ledger = new Ledger(dir, 'r1');
    const i = ledger.intent('page', 'ws_create', 't');
    ledger.append({ kind: 'created', intent: i, resource: 'page', id: 'P1', name: 'mwsc-r1-x', via: 'result' });
    let exists = true;
    const sent: unknown[] = [];
    const ok = (data: unknown) => ({ ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
    const err = (t: string) => ({ ok: false, data: null, text: t, timed_out: false, transport_error: null, rpc_error: null });
    const session = {
      stepId: (s: string) => s,
      listTools: async () => [{ name: 'ws_delete', inputSchema: { type: 'object', properties: { id: {}, if_match: {} } } }],
      async call(_l: string, tool: string, args: Record<string, unknown>) {
        if (tool === 'ws_get') return exists ? ok({ id: 'P1', data: { summary: 'mwsc-r1-x' }, version: 'v3' }) : err('not found');
        if (tool === 'ws_delete') {
          sent.push(args);
          if (args['if_match'] !== 'v3') return err('version required');
          exists = false;
          return ok({ deleted: 'P1' });
        }
        return err('no');
      },
    };
    const rep = await cleanupLedger(ledger, man, session as never, {}, 'mwsc-r1-');
    assert.deepEqual(sent, [{ id: 'P1', if_match: 'v3' }]);
    assert.deepEqual(rep.deleted.map((d) => d.id), ['P1']);
    assert.deepEqual(rep.failed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T1: a tool whose probes could not start is not tested with the real reason, never not applicable', async () => {
  const { schemaCheck } = await import('../../src/checks/schema.js');
  const tools = [{ name: 'ws_get', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }, { name: 'ws_patch', inputSchema: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' } }, additionalProperties: false } }];
  const r = schemaCheck.evaluate({ check: 'schema-probes', version: '1', resource: 'page', data: { probes: [], not_probed: { ws_patch: 'the object under test could not be put back to its baseline before the probes, so none was sent' } } }, { manifest: man, tools } as never);
  const mine = r.filter((x) => x.write_path.tool === 'ws_patch' && /^MWS-IN-[1-467]$/.test(x.requirement));
  assert.ok(mine.length >= 6, JSON.stringify(mine.map((x) => x.requirement)));
  for (const x of mine) {
    assert.equal(x.verdict, 'not tested', `${x.requirement}: ${x.reason}`);
    assert.match(x.reason, /baseline/);
  }
});
