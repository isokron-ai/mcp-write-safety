/**
 * kubernetes/CLI-BUGS.md B4: `null` for an argument the schema does not require, read as "not sent",
 * was judged `violated` under MWS-IN-1.
 *
 * Validation rows (kubernetes, e94270a only; `fixed` on 66e40e2):
 *   MWS-IN-1 | pod-scoped:pods_list | violated  "pods_list accepted 1 of 9 value(s) its schema does not allow: limit=null (null)."
 *   MWS-IN-1 | helm-release:resources_list | violated  "… fieldSelector=null (null); labelSelector=null (null); limit=null (null); namespace=null (null)."
 *
 * Deciding text. Spec MWS-IN-1, test method: "A conversion keeps the meaning in these cases only: […]
 * `null` sent for an argument that the schema does not require and treated as if the argument had not
 * been sent." Verdicts: "`held` (no accepted probe changed the meaning by those cases […])". Known
 * limitations: "A conversion that keeps the meaning is judged by MWS-IN-6." Spec NF-21: "Not a violation
 * of MWS-IN-1. The conversion is judged only by MWS-IN-6."
 *
 * Correct records for this fixture: MWS-IN-1 `held`; MWS-IN-6 `violated (SHOULD)`, naming the nulls.
 *
 * Departure from the real server: it uses `limit: 0.5` as 0 (kubernetes/CLI-BUGS.md B19, a different
 * entry); the fixture refuses a fraction, so that the only accepted probes are the nulls.
 *
 * Status: fails on e94270a; passes on 7562919 and on d3b536f, fixed by the owners in 66e75ce. Kept, skipped, as
 * the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixed, head, rows, runFixture, show, startFixture } from './harness.js';
import { configmap, K8S_GUARD, seedNamespace } from './k8s-fixture.js';

const MANIFEST = `${head({ guard: K8S_GUARD })}
resources:
${configmap('configmap-list', '{ tool: resources_list, args: { apiVersion: v1, kind: ConfigMap, namespace: "{{ns}}" }, items: items, match: metadata.name, ignore: [metadata.resourceVersion] }')}`;

test('kubernetes/CLI-BUGS B4: null for an optional argument, read as "not sent", is MWS-IN-1 held and MWS-IN-6 violated', { skip: fixed('66e75ce', 'kubernetes/CLI-BUGS.md B4', 'e94270a') }, async () => {
  const f = await startFixture({ profile: 'k8s', manifest: MANIFEST, seed: seedNamespace });
  try {
    const r = await runFixture(f);
    const path = 'configmap-list:resources_list';
    for (const arg of ['namespace', 'labelSelector', 'limit']) assert.ok(f.calls().some((c) => c.tool === 'resources_list' && c.args[arg] === null), `the null probe for ${arg} was sent`);
    const in1 = rows(r.doc.results, 'MWS-IN-1', path);
    assert.deepEqual(in1.map((x) => x.verdict), ['held'], show(in1));
    const in6 = rows(r.doc.results, 'MWS-IN-6', path);
    assert.deepEqual(in6.map((x) => x.verdict), ['violated'], show(in6));
    assert.equal(in6[0]!.level, 'SHOULD');
    for (const arg of ['namespace', 'labelSelector', 'limit']) assert.match(in6[0]!.reason, new RegExp(`${arg}=null`), show(in6));
  } finally {
    await f.close();
  }
});
