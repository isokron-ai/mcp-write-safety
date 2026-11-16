/**
 * Note 31 (review v8, BL-5; reproducers R12a to R12c): a multi-item delete was sent as scope-bound once MWS-TGT-1 was held
 * for it, where it carried a literal under the scope argument, or {{scope}} under another key. MWS-TGT-1 held shows only that the
 * tool keeps to the container it is told, not that the container holds only the tester's objects. Against a server that ignores
 * the narrowing, both bystanders were deleted and MWS-ATOM-2 reported held.
 *   R12a  { project: "inbox", title_prefix: "{{batch}}" }      a literal container: never sent
 *   R12b  { project: "{{scope}}", title_prefix: "{{batch}}" }  control: sent inside the tester's container, bystanders kept
 *   R12c  { title_prefix: "{{scope}}-{{batch}}" }               {{scope}} under another key, the scope argument left out: never sent
 * On this head R12a is refused at manifest load (a literal binds nothing there) and in R12c MWS-TGT-1 is not held, so both were
 * already safe; the same hole shows where {{scope}} stands elsewhere in the call and MWS-TGT-1 is held:
 *   R12d  { project: "inbox", title_prefix: "{{scope}}-{{batch}}" }   a literal container, {{scope}} under another key: never sent
 *   R12e  { title_prefix: "{{scope}}-{{batch}}" }, MWS-TGT-1 held      the scope argument left out: never sent
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { BYSTANDERS, bystandersLeft, seedBystanders } from './safety-fixture.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

const manifest = (args: string) => `${head({ guard: TRACKER_GUARD }).replace('SHAPE_CALL_LOG]', 'SHAPE_CALL_LOG, SHAPE_READ_ONLY]')}settings:
  read_only: { env: SHAPE_READ_ONLY, on: "true", valid: { "true": restrict, "false": permit } }
resources:
${PROJECT}${ticket({
  scope: true,
  update: PATCH_UPDATE,
  fields: ASSIGNEE_STATUS,
  extra: `    selector:
      tool: tickets_delete
      args: { project: "{{scope}}" }
      narrow: { title_prefix: "{{marker}}" }
      send_empty_forms: true
      forms:
        - { name: omitted, args: {} }
        - { name: empty, args: { title_prefix: "" } }
    multi:
      - tool: tickets_delete
        args: ${args}
        effect: deleted
        invalid_id: T-0
`,
})}`;

// [id, args, sent, opts, MWS-TGT-1 held is a precondition, may be refused at load]
const CASES: [string, string, boolean, string[], boolean, boolean][] = [
  ['R12a', '{ project: "inbox", title_prefix: "{{batch}}" }', false, ['delete-ignores-prefix'], false, true],
  ['R12b', '{ project: "{{scope}}", title_prefix: "{{batch}}" }', true, ['delete-ignores-prefix'], true, false],
  ['R12c', '{ title_prefix: "{{scope}}-{{batch}}" }', false, ['delete-ignores-prefix', 'default-missing-scope'], false, false],
  ['R12d', '{ project: "inbox", title_prefix: "{{scope}}-{{batch}}" }', false, ['delete-ignores-prefix'], true, false],
  ['R12e', '{ title_prefix: "{{scope}}-{{batch}}" }', false, ['delete-ignores-prefix'], true, false],
];
for (const [id, args, sent, opts, needT1, mayRefuse] of CASES) {
  test(`BL-5 ${id}: multi-item delete ${args}, MWS-TGT-1 held, narrowing ignored: ${sent ? 'sent in the tester\'s container' : 'never sent'}`, async () => {
    const f = await startFixture({ profile: 'tracker', opts, manifest: manifest(args), seed: seedBystanders });
    try {
      let r: Awaited<ReturnType<typeof runFixture>>;
      try {
        r = await runFixture(f);
      } catch (e) {
        if (!mayRefuse || !/must bind the objects the call acts on/.test(String(e))) throw e;
        assert.deepEqual(f.calls().filter((c: { tool: string }) => c.tool === 'tickets_delete'), [], 'refused at load: nothing sent');
        assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS);
        return;
      }
      const results = r.doc.results as { requirement: string; verdict: string; reason: string; write_path?: { tool?: string } }[];
      const t1 = results.filter((x) => x.requirement === 'MWS-TGT-1' && x.write_path?.tool === 'tickets_delete').map((x) => x.verdict);
      if (needT1) assert.ok(t1.includes('held'), `precondition: MWS-TGT-1 held for tickets_delete (${t1.join(', ')})`);
      assert.deepEqual(bystandersLeft(f.backend), BYSTANDERS, 'objects the tester did not create are untouched (spec 7.3, rule 1)');
      const outside = f.calls().filter((c: { tool: string; args: Record<string, unknown> }) => c.tool === 'tickets_delete' && (c.args['project'] === 'inbox' || c.args['project'] === undefined));
      if (!sent) {
        assert.deepEqual(outside, [], 'a multi-item delete told a container the tester did not create is never sent');
        const a2 = results.filter((x) => x.requirement === 'MWS-ATOM-2' && x.write_path?.tool === 'tickets_delete');
        assert.ok(a2.every((x) => x.verdict !== 'held'), `no held from a call that was not sent: ${JSON.stringify(a2.map((x) => x.verdict))}`);
      }
    } finally {
      await f.close();
    }
  });
}
