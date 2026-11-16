/**
 * kubernetes/CLI-BUGS.md B3: the control arm of the held-request test for MWS-CONC-3 is two partial
 * patches whatever the tool's mode. For a tool that writes the whole object, the platform is then asked
 * a different question from the one the tool was asked, and the record contradicts the simultaneous-pairs
 * record beside it: a false `violated`.
 *
 * Validation rows (kubernetes, both commits; resource `configmap-norv`, declared full_replace):
 *   MWS-CONC-3 | configmap-norv:resources_create_or_update | barrier-pairs | platform
 *     "Both calls reported success and one change was lost in 30 of 30 pairs; the platform's API lost 30 of 30 of the same pairs."
 *   MWS-CONC-3 | configmap-norv:resources_create_or_update | held-request  | violated | trials=4, lost=4, serialized=0, refused=0, control_pairs=4, control_lost=0
 *     "… a change was lost in 4 of 4 forced trials. The platform's API lost none of 4 simultaneous partial updates."
 * Hand check H3: two whole-object applies from one read, sent to the API by one field manager, both
 * answer 200 and one change is lost.
 *
 * Deciding text. Spec 7.4, held request: "The control arm for a held request is the same forced schedule
 * sent to the platform API: A's write, carrying what A read, sent after B's write has been applied."
 * Spec MWS-CONC-3, test method: "The control arm for a held request is the same forced schedule sent to
 * the platform API (section 7.4), so a `platform` record from a held request never describes a schedule
 * that the platform API refuses." Spec 8.1, `platform`: "The behavior was reproduced through the server
 * and, in the control arm, through the platform API as well."
 *
 * The fixture: ticket_replace writes the whole ticket with no version (as the apply did for
 * `configmap-norv`), and the platform's whole-object write (control.write) takes any write, while its
 * per-field patch is atomic. A's whole-object write carrying what A read, sent after B's, is applied by
 * the platform and B's change is gone: the correct held-request record is `platform`.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 9d7234d. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD, gate: true, limits: '{ write_budget: 20000, writes_per_second: 1000, pairs: 4, stale_reps: 1, gate_reps: 2, timeout_ms: 10000, max_fuzz_cases: 200 }' })}
resources:
${ticket({ name: 'ticket-doc', update: '{ tool: ticket_replace, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}" } }', fields: ASSIGNEE_STATUS })}`;

test('kubernetes/CLI-BUGS B3: the held-request control of a whole-object tool is the same whole-object schedule; the record is platform', { skip: fixed('9d7234d', 'kubernetes/CLI-BUGS.md B3') }, async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['no-precondition'], backend: { putUnchecked: true }, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const conc3 = rows(r.doc.results, 'MWS-CONC-3', 'ticket-doc:ticket_replace');
    const pairs = conc3.filter((x) => x.scenario.id.startsWith('barrier-pairs'));
    const held = conc3.filter((x) => x.scenario.id.startsWith('held-request'));
    // The simultaneous-pairs record is right today: the platform loses the same pairs.
    assert.deepEqual(pairs.map((x) => x.verdict), ['platform'], show(pairs));
    // The held-request record must agree with it.
    assert.deepEqual(held.map((x) => x.verdict), ['platform'], show(held));
    assert.equal(held[0]!.attribution, 'platform');
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});

/*
 * kubernetes/CLI-BUGS-d3b536f.md B3 (not fixed in effect on d3b536f and 169b0cb): the control arm sent A's whole-object
 * write after B's, but B's write was still the control's partial patch, sent as another identity. Where the platform's
 * concurrency control is field ownership (a server-side apply), who B is decides the outcome: the API refuses A's apply
 * (409, field owned by another manager) and the record said `violated`, attribution `server`. By hand (hand check HA),
 * with B as the same manager the API applies A's later write and B's change is lost: `platform`.
 *
 * Deciding text. Spec 7.4: "The control arm for a held request is the same forced schedule sent to the platform API:
 * A's write, carrying what A read, sent after B's write has been applied." In the tool arm both writers are calls
 * through the same server, so in the control arm both are the declared whole-object write (control.write), each from
 * the read before either wrote, with its own change.
 *
 * The fixture: ticket_replace sends a forced apply as the field manager `tracker-server` (option apply-force); the
 * backend keeps field owners (fieldManagers). control.write is a non-forced apply by the same manager; control.patch is
 * a merge patch by another (the validation manifest's `configmap-norv`).
 */
const OWNERS_CONTROL = `    control:
      base_env: SHAPE_URL
      read: { http: [GET, "/c/tickets/{{id}}"] }
      patch: { http: [PATCH, "/c/tickets/{{id}}"], body: { "{{field}}": "{{value}}" } }
      write: { http: [PUT, "/c/tickets/{{id}}"], body: "{{object}}", headers: { x-field-manager: tracker-server } }
      delete: { http: [DELETE, "/c/tickets/{{id}}"] }
`;
const OWNERS_MANIFEST = `${head({ guard: TRACKER_GUARD, gate: true, limits: '{ write_budget: 20000, writes_per_second: 1000, pairs: 4, stale_reps: 1, gate_reps: 2, timeout_ms: 10000, max_fuzz_cases: 200 }' })}
resources:
${ticket({ name: 'ticket-apply', update: '{ tool: ticket_replace, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}" } }', fields: ASSIGNEE_STATUS, control: false })}${OWNERS_CONTROL}`;

test('kubernetes/CLI-BUGS-d3b536f B3: both writers of the held-request control are the declared whole-object write; with field owners the record is platform, never server', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['no-precondition', 'apply-force'], backend: { fieldManagers: true }, manifest: OWNERS_MANIFEST });
  try {
    const r = await runFixture(f);
    const held = rows(r.doc.results, 'MWS-CONC-3', 'ticket-apply:ticket_replace').filter((x) => x.scenario.id.startsWith('held-request'));
    assert.deepEqual(held.map((x) => x.verdict), ['platform'], show(held));
    assert.equal(held[0]!.attribution, 'platform');
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
