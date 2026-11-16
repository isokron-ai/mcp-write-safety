/**
 * grafana/CLI-BUGS-d3b536f.md N3: two field-patch write paths lost their MWS-CONC-1 record with no reason. On 66e40e2
 * every field-patch resource had a MWS-CONC-1 row; on d3b536f `annotation:update_annotation` (a control block with
 * read and patch, no write) and `alert-rule-alt:alerting_rules_write` (two fields that are not independent, GF-03)
 * have none. The README promises a `not tested` row, with the reason, for what is not exercised.
 *
 * Deciding text. Spec MWS-CONC-1, test method: "A control arm is required … Without a control arm the verdict is
 * `not tested`." Spec 8.1: "`not tested`: The test was not run, or its result cannot be used. The record states the
 * reason and what would be needed to run it."
 *
 * The fixture: ticket_update, a field patch with no version argument, behind the gate, with a control block that has
 * no whole-object write. The second case (fields not independent, as alert-rule-alt) is a unit test of gatedVerdicts
 * in test/unit/r6r7.test.ts.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const LIMITS = '{ write_budget: 20000, writes_per_second: 1000, pairs: 2, stale_reps: 1, gate_reps: 1, timeout_ms: 10000, max_fuzz_cases: 200 }';
const NO_WRITE_CONTROL = `    control:
      base_env: SHAPE_URL
      read: { http: [GET, "/c/tickets/{{id}}"] }
      patch: { http: [PATCH, "/c/tickets/{{id}}"], body: { "{{field}}": "{{value}}" } }
      delete: { http: [DELETE, "/c/tickets/{{id}}"] }
`;

test('grafana/CLI-BUGS-d3b536f N3: a field patch behind the gate with no control.write still gets a MWS-CONC-1 record that says what is missing', async () => {
  const manifest = `${head({ guard: TRACKER_GUARD, gate: true, limits: LIMITS })}
resources:
${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS, control: false })}${NO_WRITE_CONTROL}`;
  const f = await startFixture({ profile: 'tracker', manifest });
  try {
    const r = await runFixture(f);
    const c1 = rows(r.doc.results, 'MWS-CONC-1', 'ticket:ticket_update');
    assert.deepEqual(c1.map((x) => x.verdict), ['not tested'], show(c1));
    assert.match(c1[0]!.reason, /control.*write/, c1[0]!.reason);
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});

