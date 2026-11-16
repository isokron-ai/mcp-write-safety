/**
 * Coverage after SH-6 (spec R15-4 at 15f71e5; Annex E): an argument the declaration lists as restorable
 * gets its counterpart control; the tester puts the field back and confirms it by reading the object again. A field declared
 * restorable that cannot be put back is never held:
 *   one-way    paused-locks: paused: true locks the ticket, so the put-back is refused
 *   ratchet    priority-ratchet: a lower priority is dropped while the call answers success, so only the read-back shows it
 * In both the probe is not judged, no further probe of the tool is sent, and no MWS-IN-1, IN-4 or IN-6 record of it is held.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

type Rec = { requirement: string; verdict: string; reason: string; write_path: { tool: string } };
const manifest = (restorable: string) => `${head({ guard: TRACKER_GUARD })}resources:
${PROJECT}${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, extra: `    restorable: ${restorable}\n` })}`;
const inRecs = (rs: Rec[]) => rs.filter((x) => ['MWS-IN-1', 'MWS-IN-4', 'MWS-IN-6'].includes(x.requirement) && x.write_path.tool === 'ticket_update');

for (const [name, opts, restorable, field] of [['one-way', ['paused-locks'], '[paused]', 'paused'], ['ratchet', ['priority-ratchet'], '[priority]', 'priority']] as const) {
  test(`restorable ${name}: a declared field that cannot be put back is not judged, stops the tool's probes, and is never held`, async () => {
    const f = await startFixture({ profile: 'tracker', opts: [...opts], manifest: manifest(restorable) });
    try {
      const r = await runFixture(f);
      const rs = inRecs(r.doc.results as Rec[]);
      assert.ok(rs.length >= 3, JSON.stringify(rs));
      assert.ok(rs.every((x) => x.verdict !== 'held'), JSON.stringify(rs.map((x) => [x.requirement, x.verdict])));
      assert.ok(rs.some((x) => new RegExp(`sent to ${field}, which the declaration lists .* for clean-up: object "T\\d+", argument ${field}`).test(x.reason)), JSON.stringify(rs.map((x) => x.reason.slice(0, 600))));
      // spec R15-4: the object is used in no later test.
      assert.ok((r.doc.results as Rec[]).some((x) => /used in no later test/.test(x.reason) && x.requirement !== 'MWS-IN-1'), 'later checks of the resource are not run on the object');
      assert.ok(f.calls().some((c: { tool: string; args: Record<string, unknown> }) => c.tool === 'ticket_update' && Object.hasOwn(c.args, field)), 'the counterpart and the put-back were sent');
    } finally {
      await f.close();
    }
  });
}

test('restorable: a listed field that can be put back is judged, the record is held, and the put-back carries the value read before the probe', async () => {
  const { runFake, startFake } = await import('../fake/harness.js');
  const { readFileSync } = await import('node:fs');
  const f = await startFake({ pairs: 2 });
  try {
    const r = await runFake(f);
    const in4 = (r.doc.results as Rec[]).filter((x) => x.requirement === 'MWS-IN-4' && x.write_path.tool === 'ticket_update' && !/review-only/.test(x.reason));
    assert.deepEqual(in4.map((x) => x.verdict), ['held'], JSON.stringify(in4.map((x) => x.reason.slice(0, 300))));
    const dir = `${r.outDir}/capture`;
    const lines = readFileSync(`${dir}/capture.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { step?: string; dir?: string; blob?: { sha256: string } });
    const body = (l: { blob?: { sha256: string } }) => JSON.parse(readFileSync(`${dir}/blobs/sha256/${l.blob!.sha256}`, 'utf8')) as { params?: { arguments?: Record<string, unknown> }; result?: { structuredContent?: { ticket?: Record<string, unknown> } } };
    const use = lines.findIndex((l) => l.dir === 'send' && /^in\.ticket_update\.priority\.[a-z_]+\.use\./.test(l.step ?? ''));
    assert.ok(use >= 0, 'a counterpart of priority was sent');
    const probe = (lines[use]!.step ?? '').replace(/\.use\.\d+$/, '');
    const put = lines.findIndex((l, k) => k > use && l.dir === 'send' && (l.step ?? '').startsWith(`${probe}.restore.`));
    assert.ok(put > use, 'the put-back followed the counterpart');
    const first = lines.findIndex((l) => l.dir === 'send' && (l.step ?? '').startsWith(`${probe}.`) || l.step === probe);
    const reads = lines.slice(0, first).filter((l) => l.dir === 'recv' && /rebase|base2|reset|before/.test(l.step ?? ''));
    const before = reads.map((l) => body(l).result?.structuredContent?.ticket?.['priority']).filter((v) => v !== undefined).pop();
    assert.notEqual(before, undefined, 'the object was read before the probe');
    assert.deepEqual(body(lines[put]!).params?.arguments?.['priority'], before, 'the put-back carried the value read before the probe');
  } finally {
    await f.close();
  }
});
