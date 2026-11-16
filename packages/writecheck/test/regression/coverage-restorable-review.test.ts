/**
 * Independent review of 3283a69 (spec R15-4 at 15f71e5): what a counterpart control on a write to an existing object must never do.
 *   unknown counterpart  slow-priority-5: priority 5 is applied and answered after the timeout; the object is still put back
 *   unknown put-back     slow-putback: the put-back is applied and answered after the timeout; the tool and the object are halted
 *   hidden field         hidden-paused: the read does not show paused, so a counterpart for it is not sent (no no-op put-back)
 *   call_only            { arg: paused, call_only: true }: the put-back is the base call without the argument
 *   halt                 priority-ratchet: after the failed put-back no record of the tool is held, IN-5 included, and nothing more
 *                        goes to the tool
 *   unlisted             an argument not listed gets no counterpart, even one equal to the value the object holds (033c298 removed)
 * Every test but the last fails on 3283a69 (the last on 3a68072).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

type Rec = { requirement: string; verdict: string; reason: string; write_path: { tool: string } };
type Call = { tool: string; args: Record<string, unknown> };
const LIMITS = '{ write_budget: 20000, writes_per_second: 1000, pairs: 2, stale_reps: 1, gate_reps: 1, timeout_ms: 1000, max_fuzz_cases: 200 }';
const manifest = (extra: string) => `${head({ guard: TRACKER_GUARD, limits: LIMITS })}resources:
${PROJECT}${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, extra })}`;
const updates = (f: { calls(): Call[] }) => f.calls().filter((c) => c.tool === 'ticket_update');
const inRecs = (rs: Rec[]) => rs.filter((x) => /^MWS-IN-[1-7]$/.test(x.requirement) && x.write_path.tool === 'ticket_update' && !/review-only/.test(x.reason));

test('review 1: a counterpart whose outcome is unknown is still followed by the put-back to the value read before the probe', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['slow-priority-5'], manifest: manifest('    restorable: [priority]\n') });
  try {
    const r = await runFixture(f);
    const u = updates(f);
    const i = u.findIndex((c) => c.args['priority'] === 5);
    assert.ok(i >= 0, 'the counterpart priority 5 was sent');
    // the first later call that carries priority at all is the put-back: an integer other than 5 (a probe would be "abc", 0.5, null …)
    const next = u.slice(i + 1).find((c) => Object.hasOwn(c.args, 'priority'));
    assert.ok(next && Number.isInteger(next.args['priority']) && next.args['priority'] !== 5, `a put-back of priority followed the counterpart: ${JSON.stringify(u.slice(i, i + 4).map((c) => c.args))}`);
    assert.ok(inRecs(r.doc.results as Rec[]).filter((x) => x.requirement === 'MWS-IN-4').every((x) => x.verdict !== 'held'), 'the probe with an unknown counterpart is not judged');
  } finally {
    await f.close();
  }
});

test('review 1: a put-back whose outcome is unknown halts the tool and the object; nothing more goes to the tool', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['slow-putback'], manifest: manifest('    restorable: [priority]\n    try_values:\n      - { arg: note, value: "x" }\n') });
  try {
    const r = await runFixture(f);
    const u = updates(f);
    const i = u.findIndex((c) => c.args['priority'] === 5);
    const put = u.findIndex((c, k) => k > i && typeof c.args['priority'] === 'number');
    assert.ok(i >= 0 && put > i, 'the counterpart and its put-back were sent');
    assert.deepEqual(u.slice(put + 1).map((c) => c.args), [], 'no further call to ticket_update after the put-back with an unknown outcome');
    const rs = r.doc.results as Rec[];
    assert.ok(inRecs(rs).every((x) => x.verdict !== 'held' && x.verdict !== 'not observed'), JSON.stringify(inRecs(rs).map((x) => [x.requirement, x.verdict])));
    assert.ok(rs.some((x) => /for clean-up: object "T\d+", argument priority/.test(x.reason)));
    assert.ok(rs.some((x) => /used in no later test/.test(x.reason)));
  } finally {
    await f.close();
  }
});

test('review 3: an argument the read does not show gets no counterpart; call_only puts it back by the base call without it', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['hidden-paused'], manifest: manifest('    restorable: [paused]\n') });
  try {
    const r = await runFixture(f);
    assert.deepEqual(updates(f).filter((c) => c.args['paused'] === true), [], 'no counterpart for a field the read does not show');
    assert.ok((r.doc.results as Rec[]).some((x) => /does not show paused/.test(x.reason)));
  } finally {
    await f.close();
  }
  const g = await startFixture({ profile: 'tracker', opts: ['hidden-paused'], manifest: manifest('    restorable: [{ arg: paused, call_only: true }]\n') });
  try {
    await runFixture(g);
    const u = updates(g);
    const i = u.findIndex((c) => c.args['paused'] === true);
    assert.ok(i >= 0, 'the counterpart was sent for a call_only argument');
    const next = u[i + 1];
    assert.ok(next && !Object.hasOwn(next.args, 'paused'), `the put-back is the base call without paused: ${JSON.stringify(next?.args)}`);
  } finally {
    await g.close();
  }
});

test('review 2: after a halt no record of the tool is held or not observed (IN-2, IN-3, IN-5, IN-6, IN-7), and no further call goes to it', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['priority-ratchet'], manifest: manifest('    restorable: [priority]\n    try_values:\n      - { arg: note, value: "x" }\n') });
  try {
    const r = await runFixture(f);
    const rs = inRecs(r.doc.results as Rec[]);
    for (const id of ['MWS-IN-2', 'MWS-IN-3', 'MWS-IN-5', 'MWS-IN-6', 'MWS-IN-7']) {
      const xs = rs.filter((x) => x.requirement === id);
      assert.ok(xs.length && xs.every((x) => x.verdict !== 'held' && x.verdict !== 'not observed'), `${id}: ${JSON.stringify(xs.map((x) => [x.verdict, x.reason.slice(0, 160)]))}`);
    }
    assert.match(rs.find((x) => x.requirement === 'MWS-IN-5')!.reason, /not probed further after a failed put-back/);
    const u = updates(f);
    const i = u.findIndex((c) => c.args['priority'] === 5);
    const put = u.findIndex((c, k) => k > i && typeof c.args['priority'] === 'number');
    assert.deepEqual(u.slice(put + 1).map((c) => c.args), [], 'no further call to ticket_update after the failed put-back');
  } finally {
    await f.close();
  }
});

test('R15-4: an argument not listed gets no counterpart, even one equal to the value the object holds (033c298 removed)', async () => {
  const f = await startFixture({ profile: 'tracker', opts: [], manifest: manifest('') });
  try {
    await runFixture(f);
    assert.deepEqual(updates(f).filter((c) => c.args['paused'] === false), [], 'paused: false (the value the ticket holds) is not sent: paused is not listed');
  } finally {
    await f.close();
  }
});

test('re-review A: a tool halted in one resource gets no MWS-IN call at all from a later resource (not even the base call), and its records give the halt reason', async () => {
  const { readFileSync } = await import('node:fs');
  const extra = '    restorable: [priority]\n';
  const m = `${head({ guard: TRACKER_GUARD, limits: LIMITS })}resources:
${PROJECT}${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, extra })}${ticket({ name: 'ticket2', update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, extra })}`;
  const f = await startFixture({ profile: 'tracker', opts: ['priority-ratchet'], manifest: m });
  try {
    const r = await runFixture(f);
    const dir = `${(r as unknown as { outDir: string }).outDir}/capture`;
    const lines = readFileSync(`${dir}/capture.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { label?: string; step?: string; dir?: string });
    const second = lines.filter((l) => l.dir === 'send' && /^IN\.ticket2\b/.test(l.label ?? '') && (l.step ?? '').startsWith('in.ticket_update.'));
    assert.deepEqual(second.map((l) => l.step), [], 'no MWS-IN call to the halted tool from the second resource');
    const rs = (r.doc.results as (Rec & { write_path: { resource: string; tool: string } })[]).filter((x) => x.write_path.resource === 'ticket2' && x.write_path.tool === 'ticket_update' && ['MWS-IN-1', 'MWS-IN-3', 'MWS-IN-4'].includes(x.requirement) && !/review-only/.test(x.reason));
    assert.ok(rs.every((x) => !/was not probed: \S+ was not probed/.test(x.reason)), 'the reason says it once');
    assert.ok(rs.length >= 3 && rs.every((x) => x.verdict === 'not tested' && /put-back on it failed earlier in this run/.test(x.reason)), JSON.stringify(rs.map((x) => [x.requirement, x.verdict, x.reason.slice(0, 160)])));
  } finally {
    await f.close();
  }
});
