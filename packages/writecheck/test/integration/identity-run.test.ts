/**
 * F8 end to end on the fake tracker: a run writes results.identity and a test_hash on every record, signs results.json with
 * --sign-key, validates against the published schema, and two runs of the same manifest on two builds compare cell by cell.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planCommand, recheckCommand } from '../../src/cli/commands.js';
import { compareCommand, finishRecheck, verifyResultsCommand } from '../../src/cli/compare.js';
import { runCommand } from '../../src/cli/run.js';
import { validates } from '../../src/core/jsonschema.js';
import { startFake, type Fake } from '../fake/harness.js';
import { assertMatchesSchema, assertNoBannedText, assertPublishable } from '../publish-lint.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schema', 'mws-results-1.schema.json'), 'utf8')) as Record<string, unknown>;

async function run(f: Fake, identity: Parameters<typeof runCommand>[0]['identity'], out: string) {
  const quiet = () => {};
  const { hash } = await planCommand({ manifest: f.manifest, env: f.env, log: quiet });
  return runCommand({ manifest: f.manifest, outRoot: out, stateDir: join(f.dir, 'state'), confirmTarget: 'fake-tracker', planHash: hash, interactive: false, env: f.env, log: quiet, noSignals: true, ...(identity ? { identity } : {}) });
}

test('a run states its identity, hashes every record\'s test, signs results.json; two builds compare on the hashes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mwsc-f8-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(tmp, 'key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(join(tmp, 'pub.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
  const good = await startFake({ pairs: 10 });
  const bad = await startFake({ pairs: 10, defects: ['MWS-UPD-1'] });
  try {
    const before = await run(good, { signKey: join(tmp, 'key.pem'), provenance: { serverRepo: 'https://example.invalid/fake', serverCommit: 'a'.repeat(40), serverImage: `example.invalid/fake@sha256:${'b'.repeat(64)}`, backendImages: [`fake-backend=example.invalid/backend@sha256:${'c'.repeat(64)}`] } }, join(tmp, 'before'));
    const after = await run(bad, { signKey: join(tmp, 'key.pem'), provenance: { serverCommit: 'd'.repeat(40) } }, join(tmp, 'after'));
    const doc = JSON.parse(readFileSync(join(before.outDir, 'results.json'), 'utf8')) as Record<string, unknown> & { results: { test_hash?: string }[]; identity: Record<string, unknown> & { gaps: string[]; server: Record<string, unknown> } };
    assert.equal(validates(schema, doc), true, 'results.json validates against mws-results-1');
    // Signed, with a stated identity, a test_hash (and test_hash_core) per record and the MWS-IN-5 numbers: no member the schema does not name.
    assertPublishable(before.outDir);
    assertPublishable(after.outDir);
    assert.ok(doc.results.some((r) => 'test_hash_core' in r) && doc.results.some((r) => (r as { requirement?: string }).requirement === 'MWS-IN-5'));
    assert.ok(doc.results.length > 0 && doc.results.every((r) => /^sha256:[0-9a-f]{64}$/.test(r.test_hash ?? '')), 'every record has a test_hash');
    assert.equal(doc.identity['format'], 'mws-identity/1');
    assert.equal(doc.identity.server['commit'], 'a'.repeat(40));
    assert.equal(doc.identity['plan_hash'], (doc['plan'] as { hash: string }).hash);
    assert.ok(!doc.identity.gaps.some((g) => /^server\.|^backend/.test(g)), doc.identity.gaps.join('; '));
    assert.match(readFileSync(join(before.outDir, 'report.md'), 'utf8'), /signed with the Ed25519 key `ed25519-[0-9a-f]{16}`[\s\S]*Run identity/);
    const log = () => {};
    assert.equal(verifyResultsCommand({ file: before.outDir, pubkey: join(tmp, 'pub.pem'), log }).exit, 0);
    const aid = (JSON.parse(readFileSync(join(after.outDir, 'results.json'), 'utf8')) as { identity: { gaps: string[] } }).identity;
    assert.ok(aid.gaps.some((g) => g.startsWith('server.repo')) && aid.gaps.some((g) => g.startsWith('server.image')), 'what the after run did not state is a gap');
    // The same manifest on two builds: every cell present on both is joined on an equal hash; UPD-1 regressed.
    const c = compareCommand({ before: before.outDir, after: after.outDir, out: join(tmp, 'cmp'), pubkey: join(tmp, 'pub.pem'), log }).doc;
    assert.equal(c.same.manifest, true);
    assert.deepEqual(c.cells.filter((x) => x.transition === 'test-changed' || x.transition === 'no-test-hash').map((x) => x.key), []);
    const upd = c.cells.filter((x) => x.requirement === 'MWS-UPD-1' && x.label === 'regressed');
    assert.ok(upd.length >= 1, JSON.stringify(c.cells.filter((x) => x.requirement === 'MWS-UPD-1').map((x) => [x.key, x.transition])));
    assert.ok(!c.cells.some((x) => x.label === 'fixed'), 'nothing is fixed by a defect');
    // Review: recheck's copy is not covered by the original signature; it is unsigned, every record hashed, the recheck named.
    recheckCommand({ dir: before.outDir, log });
    const rc = await finishRecheck(before.outDir, { key: null, log });
    assert.equal(rc.evidence.signature, null);
    assert.ok(rc.identity?.rechecked_by && rc.results.every((r) => typeof r.test_hash === 'string'));
    assert.equal(validates(schema, JSON.parse(readFileSync(join(before.outDir, 'recheck', 'results.json'), 'utf8'))), true);
    assertPublishable(join(before.outDir, 'recheck'));
    const rs = await finishRecheck(before.outDir, { key: privateKey, log });
    assert.equal(typeof rs.evidence.signature, 'object');
    assert.equal(verifyResultsCommand({ file: join(before.outDir, 'recheck'), pubkey: join(tmp, 'pub.pem'), log }).exit, 0);
    const cmp = JSON.parse(readFileSync(join(tmp, 'cmp', 'compare.json'), 'utf8')) as unknown;
    assertMatchesSchema('mws-compare-1', cmp, 'compare.json');
    assertNoBannedText(cmp, { 'compare.md': readFileSync(join(tmp, 'cmp', 'compare.md'), 'utf8') });
  } finally {
    await good.close();
    await bad.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
