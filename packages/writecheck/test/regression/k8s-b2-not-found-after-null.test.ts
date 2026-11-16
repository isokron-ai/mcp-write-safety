/**
 * kubernetes/CLI-BUGS.md B2: a not-found answer that follows a `null` read as "not sent" is judged as
 * a validation refusal that fails to name the argument: a false `violated` under MWS-IN-4.
 *
 * Validation rows (kubernetes, both commits; `configmap:resources_get` and `configmap-norv:resources_get`):
 *   in.resources_get.namespace.null.00819
 *     send: resources_get {"apiVersion":"v1","kind":"ConfigMap","name":"mwsc-85054e26c5-main9","namespace":null}
 *     recv: isError=true "failed to get resource: configmaps \"mwsc-85054e26c5-main9\" not found"
 *   MWS-IN-4 | configmap:resources_get | violated | refusals=23, short_of_requirement=1 |
 *     "1 of 23 refusal(s) by resources_get fall short: namespace (null): the error does not name the argument namespace."
 * The server read `null` as "not sent", looked in its default namespace and did not find the object.
 *
 * Deciding text. Spec MWS-IN-4: "A tool MUST report an input validation failure as a tool execution
 * error (`isError: true`) that names the argument at fault and the reason it was refused." Spec MWS-IN-1,
 * test method: "A conversion keeps the meaning in these cases only: […] `null` sent for an argument that
 * the schema does not require and treated as if the argument had not been sent." The call was not
 * refused for its `namespace` value: the value was accepted under a conversion the spec names, and the
 * call then failed as the same call without the argument fails. That answer is not an input validation
 * failure, and it is not one of "the rejected probes of MWS-IN-1 to MWS-IN-3".
 *
 * Correct record for this fixture: every other refusal by resources_get is a tool execution error that
 * names its argument, so MWS-IN-4 is `held`.
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 9d7234d. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture, verdicts } from './harness.js';
import { configmap, K8S_GUARD, seedNamespace } from './k8s-fixture.js';

const MANIFEST = `${head({ guard: K8S_GUARD })}
resources:
${configmap('configmap', '{ tool: resources_get, args: { apiVersion: v1, kind: ConfigMap, name: "{{id}}", namespace: "{{ns}}" }, ignore: [metadata.resourceVersion] }')}`;

test('kubernetes/CLI-BUGS B2: a not-found after null was read as "not sent" is not an MWS-IN-4 violation', { skip: fixed('9d7234d', 'kubernetes/CLI-BUGS.md B2') }, async () => {
  const f = await startFixture({ profile: 'k8s', manifest: MANIFEST, seed: seedNamespace });
  try {
    const r = await runFixture(f);
    const path = 'configmap:resources_get';
    // The probe was sent and answered as in the validation run.
    assert.ok(f.calls().some((c) => c.tool === 'resources_get' && c.args['namespace'] === null && typeof c.args['name'] === 'string'), 'the null probe for namespace was sent on an otherwise valid call');
    const in4 = rows(r.doc.results, 'MWS-IN-4', path).filter((x) => !/review-only/.test(x.reason));
    assert.ok(!in4.some((x) => /namespace \(null\)/.test(x.reason)), `the not-found answer is counted as a refusal that does not name the argument:\n${show(in4)}`);
    assert.deepEqual(verdicts(r.doc.results, 'MWS-IN-4', path), ['held'], show(in4));
    assert.equal(f.backend.all('k8s').filter((d) => String(d['title']).startsWith('mwsc-')).length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
