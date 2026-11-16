/**
 * SPEC-RECHECK.md S-08 (spec-recheck E-7, file E's unsafe-probe item; "unsafe to run as written"): the
 * misspelled-argument probe of MWS-IN-2, on a tool that selects many objects, is a dropped selector.
 *
 * Source of the finding: a hand run on tiny-tracker's defect build `drop-unknown-args`:
 *   delete_tickets({"project":"e5","status":"closed","title_prefx":"dt15"})
 * deleted both closed tickets in the project; the same prefix, spelled correctly, matched neither.
 *
 * Deciding text. Spec MWS-IN-2, test method: "On a tool that deletes or bulk-updates, both probes are
 * subject to the rules of section 7.3." Spec 7.3, first rule: "On a tool that deletes or bulk-updates, a
 * probe of MWS-IN-1, MWS-IN-2 or MWS-IN-3 that replaces, removes or misspells an identifier, a scope
 * argument or a selector is subject to the same two rules, because a value that the server drops leaves
 * the call matching more than it names. […] Where the rules cannot be met, the test is not run or the
 * probe is not sent, and the record says so".
 *
 * The fixture: arguments the schema does not define are dropped without a word (option
 * `drop-unknown-args`, the defect of the hand run), tickets_delete ignores its project
 * (`delete-ignores-scope`), has no guard on an empty selector (`empty-selector-matches-all`) and defaults
 * a missing project (`default-missing-scope`). The default project holds two tickets that are not the
 * tester's. A call such as `tickets_delete {"project":"<p>","title_prefx":"<prefix>"}` deletes them.
 * On this server the rules of 7.3 cannot be met for tickets_delete, so no call may go out that carries a
 * misspelled or undefined argument in place of its selector, scope or identifier.
 *
 * Status on 7562919 and on d3b536f: passes, because the two extra-argument probes are sent only to a resource's read and
 * update tools, and always on top of the tool's complete base call. This is the guard for the change that
 * extends them to delete and bulk tools (kubernetes/CLI-BUGS.md B10): it must stay green then. It is not
 * skipped.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, dangerousWithExtra, seedBystanders, showDanger } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  extra: `    multi:
      - tool: tickets_delete
        args: { project: "{{scope}}", title_prefix: "{{batch}}" }
        effect: deleted
`,
})}`;

test('the predicate flags the call of the hand run (a misspelled selector in place of the selector)', () => {
  const own = { tool: 'project_create', args: { key: 'e5' } };
  assert.equal(dangerousWithExtra([own, { tool: 'tickets_delete', args: { project: 'e5', title_prefx: 'dt15' } }]).length, 1);
  assert.equal(dangerousWithExtra([own, { tool: 'tickets_delete', args: { project: 'e5', title_prefix: 'dt15', title_prefx: 'dt15' } }]).length, 0, 'an extra argument beside the complete base call leaves the call matching what it names');
});

test('SPEC-RECHECK S-08 (E-7): no misspelled or undefined argument is sent to a delete or bulk tool in place of its selector, scope or identifier', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['drop-unknown-args', 'default-missing-scope', 'delete-ignores-scope', 'empty-selector-matches-all'], manifest: MANIFEST, seed: seedBystanders });
  try {
    await runFixture(f);
    assert.deepEqual(showDanger(dangerousWithExtra(f.calls())), [], 'a call to a delete or bulk tool went out with a misspelled or undefined argument and without its selector, scope or identifier');
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS, 'the tickets the tester did not create are untouched');
    // The probes themselves were sent where they are safe: the read and the update tool got both extra arguments.
    assert.ok(f.calls().some((c) => c.tool === 'ticket_update' && Object.hasOwn(c.args, 'mwsc_undefined_argument')), 'the undefined-argument probe ran on the update tool');
  } finally {
    await f.close();
  }
});
