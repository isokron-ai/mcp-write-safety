/**
 * SPEC-RECHECK.md S-07, second half (spec-recheck B-13, item 2; "unsafe to run as written"): on delete and
 * bulk tools, the MWS-IN-1 and MWS-IN-3 probes replace or remove the very argument that keeps the call on
 * the tester's objects. A server that drops a wrongly typed value (K8S-09) or defaults a missing scope
 * then acts somewhere else.
 *
 * Deciding text. Spec 7.3, first rule: "On a tool that deletes or bulk-updates, a probe of MWS-IN-1,
 * MWS-IN-2 or MWS-IN-3 that replaces, removes or misspells an identifier, a scope argument or a selector
 * is subject to the same two rules, because a value that the server drops leaves the call matching more
 * than it names. A probe that removes, replaces or misspells the scope argument itself is sent only where
 * the server has a default scope and that scope is also a container that the tester created and has
 * confirmed holds nothing but objects it created. Where the rules cannot be met, the test is not run or
 * the probe is not sent, and the record says so; if no other probe remains, the verdict is `not tested`."
 *
 * The fixture: wrongly typed values are dropped without a word (option `drop-bad-types`), a bulk delete
 * with no project acts on the default project (`default-missing-scope`), tickets_delete ignores its
 * project (`delete-ignores-scope`) and has no guard on an empty selector (`empty-selector-matches-all`).
 * The default project holds two tickets that are not the tester's. On this server neither rule of 7.3 can
 * be met for ticket_delete or tickets_delete, so no such probe may be sent to them. The delete tool and
 * the bulk tool are declared where a tester finds them (`delete`, `multi`).
 *
 * Status on 7562919 and on d3b536f: passes, because the schema probes are sent only to a resource's read and update
 * tools (kubernetes/CLI-BUGS.md B10, grafana/CLI-BUGS.md 9), and on an update tool `protectedProps`
 * keeps the id and the scope as configured. This is the guard for the change that extends the probes to
 * delete and bulk tools: it must stay green then. It is not skipped.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, dangerous, seedBystanders, showDanger } from './safety-fixture.js';
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

test('the predicate of the safety tests flags the calls spec 7.3 forbids here, and no others', () => {
  const own = { tool: 'project_create', args: { key: 'mwsc-x-p1' } };
  const bad = [
    { tool: 'ticket_delete', args: { id: 5 } },
    { tool: 'ticket_delete', args: {} },
    { tool: 'tickets_delete', args: { project: 5, title_prefix: 'mwsc-x-' } },
    { tool: 'tickets_delete', args: { title_prefix: 'mwsc-x-' } },
    { tool: 'tickets_delete', args: { project: 'inbox', title_prefix: 'mwsc-x-' } },
    { tool: 'tickets_delete', args: { project: 'mwsc-x-p1', title_prefix: { a: 1 } } },
    { tool: 'tickets_delete', args: { project: 'mwsc-x-p1' } },
    { tool: 'tickets_delete', args: { project: 'mwsc-x-p1', title_prefx: 'mwsc-x-' } },
  ];
  const good = [
    { tool: 'ticket_delete', args: { id: 'T7' } },
    { tool: 'tickets_delete', args: { project: 'mwsc-x-p1', title_prefix: 'mwsc-x-b1' } },
    { tool: 'tickets_delete', args: { project: 'mwsc-x-p1', title_prefix: 'mwsc-x-b1', mwsc_undefined_argument: 'mwsc' } },
  ];
  assert.equal(dangerous([own, ...bad]).length, bad.length);
  assert.deepEqual(dangerous([own, ...good]), []);
});

test('SPEC-RECHECK S-07 (B-13): no MWS-IN-1 or MWS-IN-3 probe replaces or removes the id, the scope or the selector of a delete or bulk tool', async () => {
  const f = await startFixture({ profile: 'tracker', opts: ['drop-bad-types', 'default-missing-scope', 'delete-ignores-scope', 'empty-selector-matches-all'], manifest: MANIFEST, seed: seedBystanders });
  try {
    await runFixture(f);
    assert.deepEqual(showDanger(dangerous(f.calls())), [], 'a call to a delete or bulk tool went out with its identifier, scope or selector missing or replaced');
    assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS, 'the tickets the tester did not create are untouched');
    assert.ok(f.calls().some((c) => c.tool === 'ticket_delete'), 'the delete tool was exercised (cleanup by id)');
  } finally {
    await f.close();
  }
});
