/**
 * SPEC-RECHECK.md S-07, first half (spec-recheck B-13, item 1; "unsafe to run as written"): the MWS-TGT-2
 * probes run although nothing has shown that the tool under test confines itself to the container it is
 * given. Where the tool ignores its scope argument, the empty-selector probe empties the server's default
 * scope, which the tester did not create.
 *
 * Source of the finding: B-13 is from the text (tiny-tracker's scope defect touches only create_ticket).
 * On 7562919, `targetingCheck.collect` runs MWS-TGT-1 on the create tool only, and then runs MWS-TGT-2 on
 * the selector tool whatever MWS-TGT-1 said (src/checks/targeting.ts, `tgt1` then `tgt2`). On d3b536f
 * (9d7234d, "MWS-TGT-2 runs only after MWS-TGT-1 is held on the scope-named container") MWS-TGT-2 waits
 * for MWS-TGT-1, but for MWS-TGT-1 on the create tool: the tool that deletes is still never shown to
 * confine itself, and that is the tool the rule names ("for that tool").
 *
 * Deciding text. Spec 7.3, first rule: "A test that calls a deleting or bulk-updating tool with an empty,
 * missing or match-all selector or with a container path (MWS-TGT-2) MUST NOT be run outside a container
 * that the tester created for that test and has confirmed holds nothing but objects it created. Where
 * that container is named to the tool by a scope argument, the test MUST NOT be run unless MWS-TGT-1 has
 * been run for that tool with the verdict `held`. […] Where the rules cannot be met, the test is not run
 * or the probe is not sent, and the record says so; if no other probe remains, the verdict is `not
 * tested`."
 *
 * Spec MWS-TGT-1, test method (how "for that tool" is run on a deleting tool): "For a tool that updates or
 * deletes, first create an object with the same name or key in each of the two scopes and in the default
 * scope, so that a misdirected write has something to act on […]. Call the tool naming the first scope.
 * Read back in the named scope, in the second scope and in the default scope, and establish where the
 * write took effect."
 *
 * The fixture: ticket_create honours `project`, so MWS-TGT-1 on the create tool is `held`. tickets_delete
 * does not: it runs in the default project whatever `project` says (option `delete-ignores-scope`), and it
 * has no guard on an empty selector (option `empty-selector-matches-all`). The default project holds two
 * tickets that are not the tester's. MWS-TGT-1 cannot be `held` for tickets_delete on this server (run as
 * the method says, with a selector that names only the tester's own same-named tickets, it is `violated`,
 * and nothing but the tester's own ticket in the default project is lost), so the empty-selector calls
 * must never be sent, and MWS-TGT-2 is `not tested`.
 *
 * Status: fails on 7562919 and on d3b536f, in the same way. The tester sends `tickets_delete {"project":"<its container>"}`, the server
 * deletes both bystanders, and the report says MWS-TGT-2 `held` (the three objects in the tester's
 * container were all still there).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, rows, runFixture, show, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, dangerous, seedBystanders, showDanger } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  extra: `    selector:
      tool: tickets_delete
      args: { project: "{{scope}}" }
      forms:
        - { name: omitted, args: {} }
        - { name: empty, args: { title_prefix: "" } }
`,
})}`;

test('SPEC-RECHECK S-07 (B-13): no empty-selector probe is sent to a bulk delete that MWS-TGT-1 has not shown to stay in its container', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['delete-ignores-scope', 'empty-selector-matches-all'], manifest: MANIFEST, seed: seedBystanders });
  try {
    const r = await runFixture(f);
    const problems: string[] = [];
    const left = bystandersLeft(f.backend);
    if (left.length !== BYSTANDERS.length) problems.push(`the run deleted ${BYSTANDERS.length - left.length} of ${BYSTANDERS.length} tickets it did not create (left: ${left.join(', ') || 'none'})`);
    problems.push(...showDanger(dangerous(f.calls()).filter((d) => d.call.tool === 'tickets_delete')).map((s) => `sent: ${s}`));
    const tgt2 = rows(r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
    if (tgt2.length !== 1 || tgt2[0]!.verdict !== 'not tested') problems.push(`MWS-TGT-2 must be not tested (MWS-TGT-1 is not held for tickets_delete):\n${show(tgt2)}`);
    assert.deepEqual(problems, []);
  } finally {
    await f.close();
  }
});
