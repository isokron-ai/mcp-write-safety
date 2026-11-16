/**
 * Tester safety, the three items flagged "for the owners" in review v8 and the port report, checked on this head.
 *   1  A bulk update bounded by its container alone ({ project: "{{scope}}" }, no {{ids}}) acts on every object in the container it
 *      is given, as a delete does; it was sent with neither the MWS-TGT-1 gate nor the own-container rule. A server that ignores the
 *      container closes the bystanders.
 *   2  A scope named inside a nested object ({ meta: { project: "inbox" } }) beside {{scope}} at the top level was sent.
 *   3  The launch check (CFG-3) called a delete bounded by its container in the run's container, which is not confirmed to hold
 *      nothing but the tester's objects and is the server's default where it could not be created. It now gets a container of
 *      its own, confirmed to hold only the one object made in it.
 * Each must never be sent, and the record says why.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, seedBystanders } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

type Call = { tool: string; args: Record<string, unknown> };
type Rec = { requirement: string; verdict: string; reason: string; notes: string[]; write_path?: { tool?: string } };

const SELECTOR = `    selector:
      tool: tickets_delete
      args: { project: "{{scope}}" }
      narrow: { title_prefix: "{{marker}}" }
      send_empty_forms: true
      forms:
        - { name: omitted, args: {} }
        - { name: empty, args: { title_prefix: "" } }
`;
const manifest = (multi: string, selector = true) => `${head({ guard: TRACKER_GUARD }).replace('SHAPE_CALL_LOG]', 'SHAPE_CALL_LOG, SHAPE_READ_ONLY]')}settings:
  read_only: { env: SHAPE_READ_ONLY, on: "true", valid: { "true": restrict, "false": permit } }
resources:
${PROJECT}${ticket({ scope: true, update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, extra: `${selector ? SELECTOR : ''}    multi:
${multi}` })}`;

test('owners\' item 1: a bulk update bounded by its container alone is gated as a delete is; the bystanders keep their state', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['bulk-close', 'close-ignores-scope'], manifest: manifest(`      - tool: tickets_close
        args: { project: "{{scope}}" }
        effect: { path: status, value: closed }
        invalid_id: T-0
`, false), seed: seedBystanders });
  try {
    const r = await runFixture(f);
    const sent = f.calls().filter((c: Call) => c.tool === 'tickets_close');
    assert.deepEqual(sent, [], 'a bulk update the container alone bounds is not sent without MWS-TGT-1 held for it');
    assert.deepEqual(f.backend.all('tickets').filter((t) => BYSTANDERS.includes(String(t['id'])) && t['status'] !== 'open').map((t) => t['id']), [], 'no bystander was closed');
    const atom = (r.doc.results as Rec[]).filter((x) => x.requirement === 'MWS-ATOM-1' && x.write_path?.tool === 'tickets_close');
    assert.ok(atom.length && atom.every((x) => x.verdict === 'not tested' && /MWS-TGT-1/.test(x.reason)), JSON.stringify(atom.map((x) => [x.verdict, x.reason])));
  } finally {
    await f.close();
  }
});

test('owners\' item 2: a container named inside a nested object is never sent', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-prefix'], manifest: manifest(`      - tool: tickets_delete
        args: { project: "{{scope}}", title_prefix: "{{batch}}", meta: { project: "inbox" } }
        effect: deleted
        invalid_id: T-0
`), seed: seedBystanders });
  try {
    const r = await runFixture(f);
    const nested = f.calls().filter((c: Call) => c.tool === 'tickets_delete' && c.args['meta'] !== undefined);
    assert.deepEqual(nested, [], 'a call that names a container inside a nested object is not sent');
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
    const atom = (r.doc.results as Rec[]).filter((x) => x.requirement === 'MWS-ATOM-1' && x.write_path?.tool === 'tickets_delete');
    assert.ok(atom.length && atom.every((x) => /nested object/.test(x.reason)), JSON.stringify(atom.map((x) => [x.verdict, x.reason])));
  } finally {
    await f.close();
  }
});

test('owners\' item 3: the launch check calls a tool bounded by its container only in a container made and confirmed for it', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-prefix'], manifest: manifest(`      - tool: tickets_delete
        args: { project: "{{scope}}", title_prefix: "{{batch}}" }
        effect: deleted
        invalid_id: T-0
`), seed: seedBystanders });
  try {
    const r = await runFixture(f);
    const t1 = (r.doc.results as Rec[]).filter((x) => x.requirement === 'MWS-TGT-1' && x.write_path?.tool === 'tickets_delete').map((x) => x.verdict);
    assert.ok(t1.includes('held'), `precondition: MWS-TGT-1 held for tickets_delete (${t1.join(', ')})`);
    const own = new Set(f.calls().filter((c: Call) => c.tool === 'project_create').map((c: Call) => c.args['key']));
    const launch = f.calls().filter((c: Call) => c.tool === 'tickets_delete' && /-c3m\d+$/.test(String(c.args['title_prefix'] ?? '')));
    assert.ok(launch.length > 0, 'the CFG-3 call of the bulk delete is made');
    assert.ok(launch.every((c: Call) => /-c3c\d+$/.test(String(c.args['project']))), `the CFG-3 call names a container made for it, never the run's: ${JSON.stringify(launch.map((c: Call) => c.args))}`);
    assert.ok(f.calls().filter((c: Call) => c.tool === 'tickets_delete').every((c: Call) => own.has(c.args['project'])), 'every bulk delete names a container the run created');
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
    void r;
  } finally {
    await f.close();
  }
});
