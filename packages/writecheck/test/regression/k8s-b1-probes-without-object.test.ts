/**
 * kubernetes/CLI-BUGS.md B1: schema probes on a resource with no object under test go out with
 * `name: null`, so every probe is refused for the missing name and nothing is learned about the probe.
 * The rows built on those refusals are false in both directions.
 *
 * Validation rows (kubernetes, both commits; resource `namespace`, and the same on
 * `configmap-finalizer`, `vm`, `vm-clone` and `pod`):
 *   in.resources_get.mwsc_undefined_argument.undefined_argument.00014
 *     send: resources_get {"apiVersion":"v1","kind":"Namespace","name":null,"mwsc_undefined_argument":"mwsc"}
 *     recv: isError=true "failed to get resource, missing argument name"
 *   MWS-IN-2 | namespace:resources_get | held      "resources_get refused all 1 invalid value(s)."        (false held)
 *   MWS-IN-7 | namespace:resources_get | held                                                             (false held, 66e40e2)
 *   MWS-IN-4 | namespace:resources_get | violated  "… mwsc_undefined_argument (undefined_argument): the error does not name the argument …"  (false violated)
 * With an existing object the same tool accepts the undefined argument (hand check H5, and
 * `MWS-IN-2 | configmap:resources_get | violated` in the same report).
 *
 * Deciding text. Spec MWS-IN-2, test method: "Make two calls that are otherwise valid: one with an extra
 * argument whose name is a misspelling of a real one, and one with an extra argument whose name is
 * unrelated." Verdicts: "`held` (for every probe that is judged here, the call was rejected, or the
 * content of the result names the argument and says that it was not used)". A call that names no object
 * is not otherwise valid, so its refusal is not a rejection of the extra argument. Spec 8.2, rule 4:
 * "`held` requires a forced condition. A test that could not force the condition MUST NOT report `held`."
 * Spec MWS-IN-4, test method: "check that each rejection has `isError: true` and that its content
 * contains the name of the argument that was probed": a refusal for the missing name is not a rejection
 * of the argument probed.
 *
 * Correct records for this fixture: with a valid base call (an object created for the probes) the server
 * accepts both extra arguments without a word, so MWS-IN-2 is `violated` and MWS-IN-7 is `violated`, and
 * every real refusal names its argument, so MWS-IN-4 is `held`. Where the tester sends no probe because
 * it has no valid base call, each is `not tested`. `held` for MWS-IN-2 or MWS-IN-7 and `violated` for
 * MWS-IN-4 are the false rows.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 9d7234d. Kept, skipped, as the regression test for that fix. On d3b536f no probe is sent without an object and the three records are `not tested`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, verdicts } from './harness.js';
import { K8S_GUARD, seedNamespace } from './k8s-fixture.js';

const MANIFEST = `${head({ guard: K8S_GUARD })}
resources:
  - name: namespace
    create: { tool: resources_create_or_update, args: { resource: '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"{{marker}}"}}' }, id: "[0].metadata.name", name_path: metadata.name }
    read: { tool: resources_get, args: { apiVersion: v1, kind: Namespace, name: "{{id}}" }, ignore: [metadata.resourceVersion] }
    delete: { tool: resources_delete, args: { apiVersion: v1, kind: Namespace, name: "{{id}}" } }
    cleanup: delete
`;

test('kubernetes/CLI-BUGS B1: probes on a resource with no object under test are not judged from a base call with name: null', { skip: fixed('9d7234d', 'kubernetes/CLI-BUGS.md B1') }, async () => {
  const f = await startFixture({ profile: 'k8s', manifest: MANIFEST, seed: seedNamespace });
  try {
    const r = await runFixture(f);
    const path = 'namespace:resources_get';
    const problems: string[] = [];
    // No extra-argument probe goes out on a call that is not otherwise valid.
    const known = new Set(['apiVersion', 'kind', 'name', 'namespace']);
    const invalidBase = f.calls().filter((c) => c.tool === 'resources_get' && Object.keys(c.args).some((k) => !known.has(k)) && (typeof c.args['name'] !== 'string' || !c.args['name']));
    for (const c of invalidBase) problems.push(`an extra-argument probe was sent on a call that names no object: resources_get ${JSON.stringify(c.args)}`);
    const expect = (req: string, allowed: string[], why: string) => {
      const got = verdicts(r.doc.results, req, path);
      if (got.length !== 1 || !allowed.includes(got[0]!)) problems.push(`${req} must be ${allowed.join(' or ')} (${why}):\n${show(rows(r.doc.results, req, path).filter((x) => !/review-only/.test(x.reason)))}`);
    };
    expect('MWS-IN-2', ['violated', 'not tested'], 'violated from a valid base call, not tested without one; never held');
    expect('MWS-IN-7', ['violated', 'not tested'], 'violated from a valid base call, not tested without one; never held');
    expect('MWS-IN-4', ['held', 'not tested'], 'every real refusal names its argument; never violated');
    assert.deepEqual(problems, []);
    assert.equal(f.backend.all('k8s').filter((d) => String(d['title']).startsWith('mwsc-')).length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
