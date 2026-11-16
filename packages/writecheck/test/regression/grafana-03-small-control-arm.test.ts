/**
 * grafana/CLI-BUGS.md 3 and CLI-BUGS-d3b536f.md 3: a control arm of fewer than 30 overlapped pairs decided the
 * attribution of a MWS-CONC-3 record. On d3b536f the attribution became `unresolved`, but the record still carried
 * the general rule-3 note "No control arm ran", which is untrue (a control arm of 10 pairs ran).
 *
 * Validation row (grafana, d3b536f, variant manifest with limits.pairs: 10, run 0a89b0a8d6):
 *   MWS-CONC-3 | MUST | annotation:update_annotation | violated | "… one change was lost in 2 of 10 pairs (10 overlapped).
 *     The platform's API lost none of 10 accepted pairs."
 *     note: The control arm lost none in 10 overlapped pairs; "none lost" needs 30 (spec 8.2, rule 6) …
 *     note: Attribution: unresolved. No control arm ran, so the behavior may be the backend's (spec 8.2, rule 3).
 *
 * Deciding text. Spec 8.2, rule 6: "A `not observed` verdict from a simultaneous-pairs test needs at least 30
 * overlapped pairs with no loss seen." Rule 3: `server` is "a control arm ran and the platform API refused the write
 * or did not show the behavior"; a control arm too small to show that the platform keeps both changes shows neither,
 * so the attribution is `unresolved`, and the record says why. Rule 1: "One trial that reproduces the forbidden
 * behavior is enough for `violated` or `platform`", so the tool arm's loss is still a `violated` record.
 *
 * The fixture: ticket_replace writes the whole ticket with no version (option no-precondition); the platform's
 * whole-object write checks the version it is sent, so the control arm loses nothing. limits.pairs is 4.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD, limits: '{ write_budget: 20000, writes_per_second: 1000, pairs: 4, stale_reps: 1, gate_reps: 1, timeout_ms: 10000, max_fuzz_cases: 200 }' })}
resources:
${ticket({ name: 'ticket-doc', update: '{ tool: ticket_replace, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}" } }', fields: ASSIGNEE_STATUS })}`;

test('grafana/CLI-BUGS 3: below 30 overlapped control pairs the attribution is unresolved, and the record says a control arm ran', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['no-precondition'], manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const pairs = rows(r.doc.results, 'MWS-CONC-3', 'ticket-doc:ticket_replace').filter((x) => x.scenario.id.startsWith('barrier-pairs'));
    assert.deepEqual(pairs.map((x) => x.verdict), ['violated'], show(pairs));
    const p = pairs[0]!;
    assert.equal(p.attribution, 'unresolved', show(pairs));
    assert.ok(p.notes.some((n) => /needs 30/.test(n)), p.notes.join('\n'));
    assert.ok(!p.notes.some((n) => /No control arm ran/.test(n)), `a control arm ran; the record must not say otherwise:\n${p.notes.join('\n')}`);
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
