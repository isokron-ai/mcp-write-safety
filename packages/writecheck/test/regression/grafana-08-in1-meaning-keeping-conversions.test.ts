/**
 * grafana/CLI-BUGS.md 8: MWS-IN-1 was `violated` for conversions the spec says keep the meaning.
 *
 * Validation rows (grafana, e94270a only, run 9343e7ac11, 10 MUST rows; `fixed` on 66e40e2), for example:
 *   MWS-IN-1 | MUST | dashboard:get_dashboard_by_uid | violated | get_dashboard_by_uid accepted 2 of 5 value(s) its schema
 *     does not allow: version=3 (numeric_string); version=null (null).
 * All 77 accepted probes were of three kinds: `null` for an argument the schema does not require (56), a
 * numeric string for an integer (14), a string for a list argument (7; the probe list of spec 0.9 has no
 * probe for a list argument, so that kind is no longer sent). Checked by hand for update_annotation:
 * `tags: null` left the tags as they were; `time: "3"` was used as 3.
 *
 * Deciding text. Spec MWS-IN-1, test method: "A conversion keeps the meaning in these cases only: a string
 * that is exactly a JSON number used as that number; the strings `"true"` and `"false"` used as true and
 * false; a number or a boolean used as its JSON text for a string argument; `null` sent for an argument
 * that the schema does not require and treated as if the argument had not been sent." Verdicts: "`held` (no
 * accepted probe changed the meaning by those cases […])". Spec NF-21: "Not a violation of MWS-IN-1. The
 * conversion is judged only by MWS-IN-6."
 *
 * The fixture: ticket_update makes exactly those conversions (option `lenient`) and refuses every other
 * wrongly typed value by name. Correct records: MWS-IN-1 `held`; MWS-IN-6 `violated (SHOULD)`.
 *
 * Status: fails on e94270a; passes on 7562919 and on d3b536f, fixed by the owners in 66e75ce. Kept, skipped, as
 * the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({ create: 'assignee: ann, status: blocked, note: "keep me", priority: 4', update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('grafana/CLI-BUGS 8: conversions that keep the meaning are MWS-IN-1 held and MWS-IN-6 violated (SHOULD)', { skip: fixed('66e75ce', 'grafana/CLI-BUGS.md 8', 'e94270a') }, async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['lenient'], manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    const path = 'ticket:ticket_update';
    // The conversions happened: a numeric string for the integer, null for an optional argument.
    assert.ok(f.calls().some((c) => c.tool === 'ticket_update' && typeof c.args['priority'] === 'string' && /^\d+$/.test(c.args['priority'])), 'a numeric-string probe was sent for the integer argument');
    assert.ok(f.calls().some((c) => c.tool === 'ticket_update' && c.args['priority'] === null), 'the null probe was sent');
    const in1 = rows(r.doc.results, 'MWS-IN-1', path);
    // why: action dogfood SH-6 (spec R14-6): a probe whose counterpart would write a value the base call does not send (paused:
    // true) is not judged, so the record is not held; it is never violated by the conversions that keep the meaning.
    assert.deepEqual(in1.map((x) => x.verdict), ['not tested'], show(in1));
    assert.match(in1[0]!.reason, /counterpart of the same meaning .* was not sent/, show(in1));
    const in6 = rows(r.doc.results, 'MWS-IN-6', path);
    assert.deepEqual(in6.map((x) => x.verdict), ['violated'], show(in6));
    assert.equal(in6[0]!.level, 'SHOULD');
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
