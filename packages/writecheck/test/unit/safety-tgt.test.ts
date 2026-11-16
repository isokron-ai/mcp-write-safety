/**
 * The tester-safety fix of note 6: MWS-TGT-1 is run for the selector tool itself before any MWS-TGT-2
 * selector form is sent (spec 7.3, rule 1), and a one-line not-found sentence is never read as an object.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { targetingVerdicts } from '../../src/checks/targeting.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { parseStructured } from '../../src/core/util.js';

const man = (narrow: string) => parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: project
    create: { tool: p_create, args: { key: "{{key}}", name: "{{marker}}" }, id: key }
    read: { tool: p_list, args: {}, items: projects, match: key }
    key: { arg: key, vary: { arg: name, path: name } }
    delete: { tool: p_delete, args: { key: "{{id}}" } }
    cleanup: delete
  - name: ticket
    scope: { resource: project, arg: project, default: inbox, list: { tool: t_list, args: { project: "{{scope}}" }, items: tickets, name: title } }
    create: { tool: t_create, args: { project: "{{?scope}}", title: "{{marker}}" }, id: id }
    read: { tool: t_get, args: { id: "{{id}}" } }
    delete: { tool: t_delete, args: { id: "{{id}}" } }
    cleanup: delete
    selector:
      tool: t_delete_many
      args: { project: "{{scope}}" }
${narrow}      forms: [ { name: omitted, args: {} } ]
`, 'm.yaml');

const call = (ok: boolean) => ({ ok, isError: !ok, text: ok ? 'deleted' : 'refused', step: 's1', indeterminate: false } as never);

test('selector.narrow must name the run marker', () => {
  assert.throws(() => man('      narrow: { title_prefix: "x" }\n'), /marker/);
  assert.ok(man('      narrow: { title_prefix: "{{marker}}" }\n').resources[1]!.selector!.narrow);
  assert.equal(man('').resources[1]!.selector!.narrow, null);
});

test('MWS-TGT-1 on the selector tool: an object of the same name removed outside the named scope is violated', () => {
  const res = man('      narrow: { title_prefix: "{{marker}}" }\n').resources[1]!;
  const scopes = { named: 'a', other: 'b', default: 'inbox' };
  const v = targetingVerdicts({ tgt1: null, tgt1sel: { scopes, call: call(true), before: { named: 1, other: 1, default: 1 }, after: { named: 0, other: 1, default: 0 } }, tgt2: null, tgt3: null } as never, res);
  assert.deepEqual(v.map((r) => [r.requirement, r.verdict]), [['MWS-TGT-1', 'violated']]);
  assert.match(JSON.stringify(v[0]!.write_path), /t_delete_many/);
  assert.match(v[0]!.reason, /default/);
  const h = targetingVerdicts({ tgt1: null, tgt1sel: { scopes, call: call(true), before: { named: 1, other: 1, default: 1 }, after: { named: 0, other: 1, default: 1 } }, tgt2: null, tgt3: null } as never, res);
  assert.equal(h[0]!.verdict, 'held');
  const n = targetingVerdicts({ tgt1: null, tgt1sel: { scopes, call: call(true), before: { named: 1, other: 1, default: 1 }, after: { named: 1, other: 1, default: 1 } }, tgt2: null, tgt3: null } as never, res);
  assert.equal(n[0]!.verdict, 'not tested');
});

test('a one-line "Error: … not found" sentence is not an object; a YAML document still is', () => {
  assert.equal(parseStructured('Error: Document with ID "4" not found in collection "tasks"'), null);
  assert.deepEqual(parseStructured('id: 4\ntitle: x\n'), { id: 4, title: 'x' });
});
