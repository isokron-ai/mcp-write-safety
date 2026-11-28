/**
 * Min mode, the correct-server mock-limit set: a correct server (test/fixtures/min/correct-server.mjs, our own code) that uses its
 * backend in ways a mock made from the description cannot model fully must come out with no violated record (a false violation on
 * a correct server is the worst bug min mode can have). Each limit also has a mutation check: the protection turned off, and the
 * same server shows the false violation it guards against.
 *
 *   POST /items/search, an action endpoint                  ANN-1 (and every write-judged check) not tested, never violated
 *   a body idempotency key the description declares         honoured by the mock, RETRY-2 judged
 *   a key in a header the description does not declare     RETRY-2 not tested (key_carrier_unmodelled)
 *   read-modify-write of a tag list, keys re-ordered        ANN-2/ANN-5 additive (identity, not serialization)
 *   a request member the resource does not have             not stored, not a changed field (RES-4)
 *   an argument sent under another name, limit left to the  IN-3 not tested where the backend's description refuses it
 *   backend
 *   a handle-style path (/notes/{noteIdOrKey})              RES-3 not tested (identifier_uncertain)
 *   a create the backend deduplicates (409 on a name)       RETRY-1 not judged
 *   a declared permitting value (FIX_READ_ONLY=enabled)     not probed as unrecognized (CFG-1)
 *   background writes                                      every write-judged record not tested
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readDeclaration } from '../../src/min/declaration.js';
import { capViolations, observedMin, runMin, type MinDoc, type MinOptions } from '../../src/min/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', '..', '..', 'test', 'fixtures', 'min');

function run(env: Record<string, string> = {}, mutate: MinOptions['mutate'] = {}): Promise<MinDoc> {
  return runMin({
    spec: join(FIX, 'correct-api.yaml'),
    server: { command: process.execPath, args: [join(FIX, 'correct-server.mjs')], env },
    baseUrlEnv: ['FIX_API_URL'],
    envNames: ['FIX_API_TOKEN'],
    declaration: readDeclaration(join(FIX, 'correct-server.yaml')),
    timeoutMs: 8000,
    mutate,
  });
}

const violations = (d: MinDoc) => d.results.filter((r) => r.verdict === 'violated' || r.answer === false).map((r) => `${r.requirement} ${r.tool} ${r.case ?? ''}: ${r.reason}`);
const has = (d: MinDoc, req: string, tool: string) => d.results.some((r) => r.requirement === req && r.tool === tool && (r.verdict === 'violated' || r.answer === false));

test('R-MIN-15: a correct server that uses its backend in ways the mock cannot model fully gets no violated record', { timeout: 300_000 }, async () => {
  const d = await run();
  assert.equal(d.run.status, 'complete', d.server.start_problem ?? '');
  assert.deepEqual(capViolations(d), []);
  assert.deepEqual(violations(d), [], 'a false violation on a correct server');
  assert.deepEqual(observedMin(d), []);
  assert.ok(d.results.some((r) => r.verdict === 'held'), 'some checks ran and held');
  // The limits are reported as limits: the action endpoint, the unmodelled key carrier, the uncertain identifier.
  const ann1 = d.results.find((r) => r.requirement === 'MWS-ANN-1' && r.tool === 'search_items')!;
  assert.equal(ann1.verdict, 'not tested');
  assert.equal(ann1.reason_code, 'unmodelled_request');
  const res3 = d.results.find((r) => r.requirement === 'MWS-RES-3' && r.tool === 'create_note');
  assert.equal(res3?.reason_code, 'identifier_uncertain');
  assert.ok(d.results.find((r) => r.requirement === 'MWS-RETRY-2')!.notes.some((n) => /create_note.*not tested.*carrier/.test(n)), 'RETRY-2 on create_note: not tested, the key carrier is not modelled');
  assert.ok(!d.results.some((r) => r.requirement === 'MWS-RETRY-1' && r.tool === 'create_label'), 'a create the backend deduplicates is not judged under RETRY-1');
  assert.ok(d.results.some((r) => r.requirement === 'MWS-RES-3' && r.tool === 'create_item' && r.verdict === 'held'), 'a handle the path names (item_number -> number) is certain');
  assert.ok(d.results.some((r) => r.requirement === 'MWS-CONC-4' && r.tool === 'add_tag' && r.verdict === 'held'), 'a conflict on a write that carried If-Match is judged');
  assert.ok(!d.results.some((r) => r.requirement === 'MWS-CONC-4' && r.tool === 'create_item'), 'no conflict is injected on a write without a precondition');
  assert.ok(!d.faults_injected.some((f) => f.kind === 'conflict' && f.template === '/items'), 'no conflict on POST /items');
});

test('R-MIN-16: a correct server that also writes in the background gets no violated record: write-judged records are not tested', { timeout: 300_000 }, async () => {
  const d = await run({ FIX_HEARTBEAT: '1' });
  assert.equal(d.run.status, 'complete', d.server.start_problem ?? '');
  assert.deepEqual(violations(d), []);
  assert.ok(d.notes.some((n) => /while no call was open/.test(n)));
  assert.ok(d.results.some((r) => r.reason_code === 'background_writes'));
});

// Mutation checks: each protection off, and the false violation it guards against appears on the same correct server.
const MUTATIONS: [string, string, Record<string, string>, (d: MinDoc) => boolean][] = [
  ['unmodelledAsWrites', 'an unmodelled POST /items/search counted as a write: ANN-1 on search_items', {}, (d) => has(d, 'MWS-ANN-1', 'search_items')],
  ['judgeUnmodelledCarrier', 'a key in an undeclared header judged: RETRY-2 on create_note', {}, (d) => has(d, 'MWS-RETRY-2', 'create_note')],
  ['positionalCompare', 'lists compared by serialization: ANN-5 on add_tag', {}, (d) => has(d, 'MWS-ANN-5', 'add_tag')],
  ['storeUnknown', 'a member the resource lacks stored: RES-4 on rename_item', {}, (d) => has(d, 'MWS-RES-4', 'rename_item')],
  ['ignoreBackendSchema', 'the backend\'s own limit ignored: IN-3 on rename_item', {}, (d) => has(d, 'MWS-IN-3', 'rename_item')],
  ['assumeNoDedupe', 'a deduplicating create assumed plain: RETRY-1 on create_label', {}, (d) => has(d, 'MWS-RETRY-1', 'create_label')],
  ['probeDeclaredValues', 'a declared permitting value probed as unrecognized: CFG-1', {}, (d) => has(d, 'MWS-CFG-1', '(server)')],
  ['ignoreBackground', 'background writes ignored: ANN-1 on a read tool', { FIX_HEARTBEAT: '1' }, (d) => has(d, 'MWS-ANN-1', 'get_item') || has(d, 'MWS-ANN-1', 'search_items')],
];
for (const [flag, what, env, shows] of MUTATIONS) {
  test(`R-MIN-17: mutation check ${flag}: with the protection off, ${what} appears (so R-MIN-15 and R-MIN-16 can fail)`, { timeout: 300_000 }, async () => {
    const d = await run(env, { [flag]: true });
    assert.ok(shows(d), `${flag}: expected the false violation; got ${JSON.stringify(violations(d))}`);
  });
}
