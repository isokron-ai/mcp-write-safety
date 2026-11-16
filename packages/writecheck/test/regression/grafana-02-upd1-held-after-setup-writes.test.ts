/**
 * grafana/CLI-BUGS.md 2: a false `held` under MWS-UPD-1 on a tool that resets the fields it is not
 * given. The tester's own setup updates had already reset those fields before the first compared read.
 *
 * Validation rows (grafana, resource `alert-rule-alt`: the same tool, second field `is_paused` with first
 * value `false`, its default, which is what a manifest author tries after grafana/CLI-BUGS.md 1):
 *   e94270a, run 9343e7ac11:
 *     MWS-UPD-1 | MUST | alert-rule-alt:alerting_rules_write | held | Updating labels (the first declared field; the others
 *     were not updated in turn): in 2 successful write(s) only labels changed (ignored: state, health, …).
 *   66e40e2, run a3f0665ec7: `violated`, from the new empty-string and empty-list probes on scratch objects.
 * By hand: an update that names only `labels` removes `annotations`, sets `is_paused` true to false and
 * `keep_firing_for` 10m to 0s. The entry ends: "The `set_field` and `same_value` cases on the main object
 * still see nothing, so a tool whose schema allows no empty string or empty list would still get `held`."
 *
 * Deciding text. Spec MWS-UPD-1, test method: "Create an object with every optional field but one set to
 * a value that is not its default, and that one left unset. Read the object through the server's read
 * tool. Call the update tool naming one field. Read the object again through the same read tool, and
 * compare every other field with its value in the first read, including the field that was unset. […]
 * Repeat for each declared field." The compared read is the read of the object as created, before any
 * other update. Spec 8.1, `held`: "The condition the requirement is about was forced, and the server did
 * what the requirement says in every trial."
 *
 * Two tests on the same defect (option `rebuild`: each field the call does not name goes back to its
 * default), with the second field's first value at its default, as in `alert-rule-alt`:
 *   - as observed: the schema allows an empty string, so the scratch-object probes of 66e75ce see the
 *     reset. Fails on e94270a (`held`, in the words of run 9343e7ac11); passes on 7562919 and d3b536f.
 *   - the case the entry's last sentence predicts (not observed on a real server): every string field
 *     declares minLength 1 and no field is nullable or a list, so none of those probes is allowed by the
 *     schema, and only the compared reads on the main object are left. Fails on 7562919 (`held`); passes
 *     on d3b536f, fixed by the owners in 9d7234d ("each declared field set alone").
 * Both are kept, skipped, as the regression tests for those fixes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { PATCH_UPDATE, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({
  create: 'assignee: ann, paused: false, note: "keep me", priority: 4',
  update: PATCH_UPDATE,
  fields: `      - { path: assignee, values: [ann, bob] }
      - { path: paused, values: [false, true] }`,
})}`;

async function upd1(opts: string[]) {
  const f = await startFixture({ profile: 'tracker', opts, manifest: MANIFEST });
  try {
    const r = await runFixture(f);
    return { rows: rows(r.doc.results, 'MWS-UPD-1', 'ticket:ticket_update'), left: f.backend.all('tickets').length };
  } finally {
    await f.close();
  }
}

test('grafana/CLI-BUGS 2 (as observed): a tool that resets unnamed fields is MWS-UPD-1 violated, never held', { skip: fixed('66e75ce', 'grafana/CLI-BUGS.md 2, as observed', 'e94270a') }, async () => {
  const got = await upd1(['rebuild']);
  assert.deepEqual(got.rows.map((x) => x.verdict), ['violated'], show(got.rows));
  assert.equal(got.left, 0, 'nothing of the run is left behind');
});

test('grafana/CLI-BUGS 2 (schema allows no empty value): the same tool is still MWS-UPD-1 violated, never held', { skip: fixed('9d7234d', 'grafana/CLI-BUGS.md 2, last sentence') }, async () => {
  const got = await upd1(['rebuild', 'strict-empty']);
  assert.deepEqual(got.rows.map((x) => x.verdict), ['violated'], show(got.rows));
  assert.equal(got.left, 0, 'nothing of the run is left behind');
});
