/**
 * F8: run identity, the per-record test_hash, the results signature, and compare.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compareCommand, verifyResultsCommand } from '../../src/cli/compare.js';
import { main } from '../../src/cli/main.js';
import { buildIdentity, buildStamp, emptyProvenance, parseProvenance, resolveProvenance, TEST_HASH_FORMAT } from '../../src/core/identity.js';
import { parseManifestText, type Manifest } from '../../src/core/manifest.js';
import { validates } from '../../src/core/jsonschema.js';
import { canonical, WritecheckError } from '../../src/core/util.js';
import { classify, compareDocs, joinCell, rollUp, summarize, type Side } from '../../src/report/compare.js';
import { keyId, loadSigningKey, privateKeyFrom, publicKeyFrom, RESULTS_SIGNATURE_DOMAIN, signedBody, signResults, verifyResults } from '../../src/report/sign.js';
import { testHash, testHashInput } from '../../src/report/testhash.js';
import { result, type Result } from '../../src/report/verdicts.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..', '..');
const ttManifest = readFileSync(join(pkg, '..', '..', 'examples', 'tiny-tracker', 'writecheck.yaml'), 'utf8');

const load = (text = ttManifest, dir = '/work/a'): Manifest => parseManifestText(text, join(dir, 'writecheck.yaml'));

/** A tools/list entry for every tool tiny-tracker's manifest names, plus what a test adds. */
function toolsFor(m: Manifest, extra: { name: string; [k: string]: unknown }[] = []): { name: string; [k: string]: unknown }[] {
  const names = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'tool' && typeof x === 'string' ? names.add(x) : walk(x));
  };
  walk(m.resources);
  walk(m.target);
  return [...[...names].sort().map((n) => ({ name: n, description: `${n} does its job`, inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } }, annotations: { readOnlyHint: n.startsWith('get') || n.startsWith('list') } })), ...extra];
}

const w = { resource: 'ticket', tool: 'update_ticket', arm: 'mcp' as const };
const rec = (o: Partial<{ requirement: string; scenario: { id: string; version: string }; write_path: typeof w }> = {}) => result((o.requirement ?? 'MWS-CONC-1') as never, o.write_path ?? w, o.scenario ?? { id: 'stale', version: '3' }, 'held', 'x');
const tester = { name: 'mcp-writecheck', version: '0.1.0', commit: 'a'.repeat(40) };

test('test_hash: equal across tool-list changes that do not touch the test (added tools, order, other tools changed)', () => {
  const m = load();
  const tools = toolsFor(m);
  const h0 = testHash(rec(), { manifest: m, tools, tester });
  assert.match(h0, /^sha256:[0-9a-f]{64}$/);
  // A patched build that adds tools, offers them in another order, and changes a tool this test does not name.
  const more = [...toolsFor(m, [{ name: 'update_ticket_v2', description: 'new', inputSchema: { type: 'object' } }, { name: 'zz_admin', inputSchema: {} }])].reverse();
  assert.equal(testHash(rec(), { manifest: m, tools: more, tester }), h0);
  const otherChanged = tools.map((t) => (t.name === 'create_project' ? { ...t, description: 'rewritten' } : t));
  assert.equal(testHash(rec(), { manifest: m, tools: otherChanged, tester }), h0, 'a tool outside the record\'s resource block');
  // title, icons and _meta are display data.
  assert.equal(testHash(rec(), { manifest: m, tools: tools.map((t) => (t.name === 'update_ticket' ? { ...t, title: 'Update', icons: [{ src: 'x' }], _meta: { a: 1 } } : t)), tester }), h0);
});

test('test_hash: equal across what names the build, not the test (server block, target, provenance, write budget, folder)', () => {
  const m = load();
  const tools = toolsFor(m);
  const h0 = testHash(rec(), { manifest: m, tools, tester });
  const variants = [
    ttManifest.replace('command: [node, dist/src/cli.js, server, --port, "0"]', 'command: [node, build/patched.js, server, --port, "0"]'),
    ttManifest.replace('confirm: tiny-tracker', 'confirm: tiny-tracker-patched'),
    ttManifest.replace('confirm: tiny-tracker', `confirm: tiny-tracker\n  provenance: { repo: https://github.com/x/y, commit: ${'b'.repeat(40)} }`),
    ttManifest.replace('write_budget: 20000, writes_per_second: 1000', 'write_budget: 90000, writes_per_second: 50'),
    ttManifest.replace(/^# .*\n/gm, ''),
  ];
  for (const [i, v] of variants.entries()) assert.equal(testHash(rec(), { manifest: load(v), tools, tester }), h0, `variant ${i}`);
  // The same manifest checked out in another folder.
  assert.equal(testHash(rec(), { manifest: load(ttManifest, '/elsewhere/b'), tools, tester }), h0);
});

test('test_hash: differs when the test\'s own inputs change', () => {
  const m = load();
  const tools = toolsFor(m);
  const ctx = { manifest: m, tools, tester };
  const h0 = testHash(rec(), ctx);
  const differs = (h: string, why: string) => assert.notEqual(h, h0, why);
  // The write path tool's schema (a patch adds a version argument), its description, its annotations.
  const patch = (f: (t: { name: string; [k: string]: unknown }) => object) => tools.map((t) => (t.name === 'update_ticket' ? { ...t, ...f(t) } : t));
  differs(testHash(rec(), { ...ctx, tools: patch(() => ({ inputSchema: { type: 'object', properties: { id: { type: 'string' }, resourceVersion: { type: 'string' } } } })) }), 'input schema');
  differs(testHash(rec(), { ...ctx, tools: patch(() => ({ description: 'Stale writes are not detected.' })) }), 'description');
  differs(testHash(rec(), { ...ctx, tools: patch(() => ({ annotations: { destructiveHint: true } })) }), 'annotations');
  // A tool the resource block names (the read tool), and the write path tool missing from the catalog.
  differs(testHash(rec(), { ...ctx, tools: tools.map((t) => (t.name === 'get_ticket' ? { ...t, inputSchema: { type: 'object' } } : t)) }), 'read tool');
  differs(testHash(rec(), { ...ctx, tools: tools.filter((t) => t.name !== 'update_ticket') }), 'tool removed');
  // The record: requirement, scenario id and version, write path.
  differs(testHash(rec({ requirement: 'MWS-CONC-2' }), ctx), 'requirement');
  differs(testHash(rec({ scenario: { id: 'stale', version: '4' } }), ctx), 'scenario version');
  differs(testHash(rec({ scenario: { id: 'pairs', version: '3' } }), ctx), 'scenario id');
  differs(testHash(rec({ write_path: { ...w, resource: 'ticket-replace' } }), ctx), 'resource');
  // The resource block (an args template), the declaration (review rules), a limit that bears on a verdict, the tester.
  differs(testHash(rec(), { ...ctx, manifest: load(ttManifest.replace('expected_version: "{{?version}}" }\n      cases:', 'expected_version: "{{version}}" }\n      cases:')) }), 'args template');
  differs(testHash(rec(), { ...ctx, manifest: load(ttManifest.replace('max_fuzz_cases: 200', 'max_fuzz_cases: 40')) }), 'limit');
  differs(testHash(rec(), { ...ctx, manifest: load(ttManifest.replace('"not detected|best-effort"', '"not detected"')) }), 'review rules');
  differs(testHash(rec(), { ...ctx, tester: { ...tester, commit: 'c'.repeat(40) } }), 'tester commit');
  differs(testHash(rec(), { ...ctx, tester: { ...tester, version: '0.2.0' } }), 'tester version');
  // What entered the hash is inspectable, and the tool list is not in it.
  const input = testHashInput(rec(), ctx);
  assert.equal(input['format'], TEST_HASH_FORMAT);
  assert.deepEqual(Object.keys(input['tools'] as object).includes('create_project'), false);
  assert.ok(Object.keys(input['tools'] as object).includes('get_ticket'));
});

test('provenance: validated, flags win over the manifest and say so, gaps list what is not pinned', () => {
  assert.throws(() => parseProvenance({ commit: 'abc1234' }, 'p'), /not a full git commit/);
  assert.throws(() => parseProvenance({ comit: 'x' }, 'p'), /unknown key "comit"/);
  assert.throws(() => parseProvenance({ backend: [{ image: 'x' }] }, 'p'), /name.*required/);
  assert.throws(() => load(ttManifest.replace('confirm: tiny-tracker', 'confirm: tiny-tracker\n  provenance: { commit: deadbeef }')), /not a full git commit/);
  const m = parseProvenance({ repo: 'https://github.com/o/r', commit: 'a'.repeat(40), backend: [{ name: 'postgres', image: 'postgres:16' }] }, 'p');
  const r = resolveProvenance(m, { serverCommit: 'b'.repeat(40), serverImage: `ghcr.io/o/r@sha256:${'c'.repeat(64)}`, backendImages: [`postgres=postgres@sha256:${'d'.repeat(64)}`, `kind-node=kindest/node:v1.31`] });
  assert.equal(r.provenance.commit, 'b'.repeat(40));
  assert.equal(r.provenance.repo, 'https://github.com/o/r');
  assert.equal(r.provenance.backend.length, 2);
  assert.ok(r.overridden.some((x) => x.startsWith('commit:')));
  assert.deepEqual(r.sources, ['manifest target.provenance', 'flags']);
  assert.throws(() => resolveProvenance(null, { serverCommit: 'HEAD' }), /--server-commit/);
  assert.throws(() => resolveProvenance(null, { backendImages: ['noequals'] }), /name=image/);
  const id = buildIdentity({ manifestSha256: 'm', planHash: 'p', toolsFingerprint: 't', launch: 'node x', transport: 'stdio', provenance: r.provenance, sources: r.sources, overridden: r.overridden, started: 's', finished: 'f', env: {}, stamp: { commit: 'e'.repeat(40), dirty: false } });
  assert.ok(id.gaps.some((g) => g.startsWith('backend kind-node')), 'a backend image without a digest');
  assert.ok(id.gaps.some((g) => g.startsWith('provenance:')), 'an overridden value');
  assert.ok(!id.gaps.some((g) => g.startsWith('server.')), 'the server is pinned');
  const bare = buildIdentity({ manifestSha256: 'm', planHash: 'p', toolsFingerprint: 't', launch: 'node x', transport: null, provenance: emptyProvenance(), sources: [], overridden: [], started: 's', finished: 'f', env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r' }, stamp: { commit: null, dirty: null } });
  for (const g of ['tester.commit', 'server.repo', 'server.commit', 'server.image', 'backend']) assert.ok(bare.gaps.some((x) => x.startsWith(g)), g);
  assert.equal(bare.runner.ci?.url, 'https://github.com/o/r/actions/runs/42');
  // The schema accepts both.
  const schema = JSON.parse(readFileSync(join(pkg, 'schema', 'mws-results-1.schema.json'), 'utf8')) as { properties: Record<string, unknown> };
  assert.equal(validates(schema.properties['identity'], JSON.parse(JSON.stringify(id)), schema), true);
  assert.equal(validates(schema.properties['identity'], JSON.parse(JSON.stringify(bare)), schema), true);
  assert.equal(validates(schema.properties['identity'], { ...JSON.parse(JSON.stringify(bare)), score: 1 }, schema), false);
});

test('build stamp: npm run build wrote the commit this checkout is at', () => {
  const s = buildStamp();
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: pkg, encoding: 'utf8' });
  if (git.status !== 0) return;
  assert.equal(s.commit, git.stdout.trim());
  const missing = buildStamp(join(tmpdir(), 'no-such-build-info.json'));
  assert.equal(missing.commit, null);
  assert.match(missing.note ?? '', /no build stamp/);
});

/** An unencrypted openssh-key-v1 file for an Ed25519 key (what ssh-keygen writes with no passphrase). */
function opensshPem(k: KeyObject, cipher = 'none'): string {
  const jwk = k.export({ format: 'jwk' }) as { d: string; x: string };
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  const str = (b: Buffer | string) => {
    const x = Buffer.isBuffer(b) ? b : Buffer.from(b);
    const n = Buffer.alloc(4);
    n.writeUInt32BE(x.length);
    return Buffer.concat([n, x]);
  };
  const u32 = (v: number) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(v);
    return n;
  };
  const pubBlob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  let priv = Buffer.concat([u32(7), u32(7), str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str('test')]);
  let pad = 1;
  while (priv.length % 8) priv = Buffer.concat([priv, Buffer.from([pad++])]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), str(cipher), str(cipher === 'none' ? 'none' : 'bcrypt'), str(''), u32(1), str(pubBlob), str(priv)]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').replace(/(.{70})/g, '$1\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const sshPub = (k: KeyObject) => {
  const x = Buffer.from((createPublicKey(k).export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const s = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return `ssh-ed25519 ${Buffer.concat([s(Buffer.from('ssh-ed25519')), s(x)]).toString('base64')} test@host`;
};

const miniDoc = (results: Result[], over: Record<string, unknown> = {}) => ({
  format: 'mws-results/1',
  suite: { name: 'mcp-writecheck', version: '0.1.0' },
  spec: { version: '0.9' },
  run: { id: 'r1', status: 'complete', stopped_reason: null, started: 's', ended: 'e' },
  manifest: { path: 'manifest.yaml', sha256: 'm1' },
  plan: { hash: 'p1' },
  results,
  evidence: { capture: null, checksums: 'SHA256SUMS', signature: null },
  identity: { test_hash: TEST_HASH_FORMAT, tester: { commit: 'a'.repeat(40) }, tools_fingerprint: 't1', server: { repo: 'r', commit: null }, backend: [], gaps: [] },
  ...over,
});

test('results signature: signs the canonical document, verifies against a pinned key, refuses changes and other keys', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519').privateKey;
  const doc = miniDoc([rec()]) as Record<string, unknown> & { evidence: { signature: unknown } };
  const sig = signResults(doc, privateKey);
  assert.equal(sig.key_id, keyId(privateKey));
  assert.match(sig.key_id, /^ed25519-[0-9a-f]{16}$/);
  doc.evidence.signature = sig;
  // Through a file and back (pretty-printed): the canonical body is the same.
  const round = JSON.parse(JSON.stringify(doc, null, 2)) as typeof doc;
  assert.equal(verifyResults(round, createPublicKey(privateKey)).status, 'valid');
  assert.equal(verifyResults(round, null).status, 'valid-unpinned');
  assert.equal(verifyResults(round, createPublicKey(other)).status, 'invalid');
  const tampered = JSON.parse(JSON.stringify(round)) as { results: { verdict: string }[] };
  tampered.results[0]!.verdict = 'violated';
  assert.match(verifyResults(tampered, createPublicKey(privateKey)).detail, /content changed/);
  // A forged digest with the old value: the signature itself fails.
  const forged = JSON.parse(JSON.stringify(tampered)) as { evidence: { signature: { digest: string } } };
  forged.evidence.signature.digest = `sha256:${(verifyResults(tampered, null).digest ?? '').slice(7)}`;
  assert.equal(verifyResults(forged, createPublicKey(privateKey)).status, 'invalid');
  // A swapped embedded key does not help an unpinned check either.
  const swapped = JSON.parse(JSON.stringify(round)) as { evidence: { signature: { public_key_pem: string } } };
  swapped.evidence.signature.public_key_pem = createPublicKey(other).export({ format: 'pem', type: 'spki' }).toString();
  assert.equal(verifyResults(swapped, null).status, 'invalid');
  // Unsigned and ssh-only are flagged, not passed.
  assert.equal(verifyResults(miniDoc([rec()]), null).status, 'unsigned');
  assert.equal(verifyResults(miniDoc([rec()], { evidence: { capture: null, checksums: 'SHA256SUMS', signature: 'SHA256SUMS.sig' } }), null).status, 'ssh-only');
  // The message is the domain line and the RFC 8785 body: openssl can check it with nothing of ours.
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-sig-'));
  try {
    writeFileSync(join(dir, 'msg'), RESULTS_SIGNATURE_DOMAIN + signedBody(round));
    writeFileSync(join(dir, 'sig'), Buffer.from(sig.value, 'base64'));
    writeFileSync(join(dir, 'pub.pem'), sig.public_key_pem);
    const o = spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', join(dir, 'pub.pem'), '-rawin', '-in', join(dir, 'msg'), '-sigfile', join(dir, 'sig')], { encoding: 'utf8' });
    if (o.status !== null && !/unknown option|rawin/i.test(o.stderr)) assert.match(o.stdout + o.stderr, /Signature Verified Successfully/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(signedBody(round), canonical({ ...round, evidence: { ...round.evidence, signature: null } }));
  // The schema accepts the signature object and the legacy string.
  const schema = JSON.parse(readFileSync(join(pkg, 'schema', 'mws-results-1.schema.json'), 'utf8')) as { properties: { evidence: unknown } };
  for (const s of [sig, 'SHA256SUMS.sig', null]) assert.equal(validates(schema.properties.evidence, { capture: null, checksums: 'SHA256SUMS', signature: JSON.parse(JSON.stringify(s)) }, schema), true);
});

test('signing keys: PKCS#8 PEM and unencrypted OpenSSH; public keys as PEM or ssh-ed25519; others refused', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.equal(keyId(privateKeyFrom(pem)), keyId(privateKey));
  assert.equal(keyId(privateKeyFrom(opensshPem(privateKey))), keyId(privateKey));
  assert.equal(keyId(publicKeyFrom(sshPub(privateKey))), keyId(privateKey));
  assert.equal(keyId(publicKeyFrom(createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString())), keyId(privateKey));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => privateKeyFrom(rsa), /Ed25519 only/);
  assert.throws(() => privateKeyFrom(opensshPem(privateKey, 'aes256-ctr')), /encrypted/);
  // MWSC_SIGN_KEY may hold the PEM itself (a CI secret); a missing path is refused before the run writes anything.
  assert.equal(keyId(loadSigningKey(undefined, { MWSC_SIGN_KEY: pem })!), keyId(privateKey));
  assert.equal(loadSigningKey(undefined, {}), null);
  assert.throws(() => loadSigningKey('/no/such/key', {}), /does not exist/);
});

const side = (verdict: Side['verdict'], h = 'sha256:x', o: Partial<Side> = {}): Side => ({ verdict, test_hash: h, level: 'MUST', run_cell: null, reason: 'r', records: [], scenarios: ['s v1'], ...o });

test('compare: rule 13 roll-up, and only violated → held on an equal test hash is fixed', () => {
  const r = (verdict: string, counts?: boolean) => ({ requirement: 'MWS-CONC-3', write_path: { resource: 'a', tool: 't' }, scenario: { id: 's', version: '1' }, verdict, ...(counts === undefined ? {} : { validity: { counts } }) });
  assert.equal(rollUp([r('held'), r('platform'), r('not observed')]).verdict, 'platform', 'B4: platform beats held');
  assert.equal(rollUp([r('held'), r('violated')]).verdict, 'violated');
  assert.equal(rollUp([r('held'), r('violated', false)]).verdict, 'held', 'a violated record that does not count ranks below held');
  assert.equal(rollUp([r('not observed'), r('violated', false)]).verdict, 'violated?');
  assert.equal(rollUp([r('not tested'), r('not applicable')]).verdict, 'not tested');
  assert.equal(classify(side('violated'), side('held')).label, 'fixed');
  assert.equal(classify(side('held'), side('violated')).label, 'regressed');
  assert.equal(classify(side('not observed'), side('violated')).label, 'regressed');
  assert.equal(classify(side('violated'), side('violated')).transition, 'still-violated');
  assert.equal(classify(side('platform'), side('platform')).label, 'unchanged');
  for (const [b, a, t] of [['violated', 'not observed', 'not-seen-after'], ['held', 'platform', '→platform'], ['platform', 'held', 'platform→'], ['held', 'not observed', 'changed']] as const) {
    const c = classify(side(b), side(a));
    assert.equal(c.label, 'changed', `${b} → ${a}`);
    assert.equal(c.transition, t);
  }
  // B5: a coverage change is never a fix.
  assert.deepEqual([classify(side('violated'), side('not tested')).label, classify(side('violated'), side('not tested')).transition], ['not comparable', 'coverage-change']);
  assert.equal(classify(side('not applicable'), side('violated')).label, 'not comparable');
  // A different test is never compared, whatever the verdicts.
  assert.equal(classify(side('violated', 'sha256:a'), side('held', 'sha256:b')).transition, 'test-changed');
  assert.equal(classify(side('violated', null as never), side('held')).transition, 'no-test-hash');
  assert.equal(classify(side('violated?'), side('held')).transition, 'unstable');
  // The join is per slot (requirement, resource, tool, procedure): a slot the other build did not reach joins when it says
  // not tested, and is a coverage change when it carries evidence; the same slot with another hash is a changed test.
  const R = (verdict: string, scenario: { id: string; version: string }, hash: string, resource = 'a') => ({ requirement: 'MWS-RES-1', write_path: { resource, tool: 't' }, scenario, verdict, test_hash: hash });
  const s1 = { id: 'rw', version: '1' };
  assert.equal(joinCell([R('held', s1, 'h1')], [R('held', s1, 'h1'), R('not tested', { id: 'creates', version: '1' }, 'h2')]), null);
  assert.equal(joinCell([R('held', s1, 'h1'), R('not observed', s1, 'h3', 'b')], [R('held', s1, 'h1')])?.transition, 'coverage-change');
  assert.match(joinCell([R('held', s1, 'h1')], [R('held', { id: 'rw', version: '2' }, 'h9')])?.why ?? '', /procedure v1 → v2/);
  assert.equal(joinCell([R('held', s1, 'h1')], [R('held', s1, 'h8')])?.transition, 'test-changed');
  assert.equal(joinCell([{ ...R('held', s1, 'h1'), test_hash: undefined as never }], [R('held', s1, 'h1')])?.transition, 'no-test-hash');
  const withRecs = (v: Side['verdict'], recs: ReturnType<typeof R>[]) => side(v, 'sha256:x', { recs: recs as never });
  assert.equal(classify(withRecs('violated', [R('violated', s1, 'h1')]), withRecs('held', [R('held', s1, 'h1')])).label, 'fixed');
  assert.equal(classify(withRecs('violated', [R('violated', s1, 'h1')]), withRecs('held', [R('held', s1, 'h1'), R('held', s1, 'h1', 'b')])).transition, 'coverage-change', 'held where before had no evidence is not a fix');
  // The run's own cell disagrees with the records: not compared.
  assert.equal(classify(side('held', 'sha256:x', { run_cell: 'platform' }), side('held')).transition, 'rollup-mismatch');
  assert.equal(classify(side('not tested', 'sha256:x', { run_cell: 'not applicable' }), side('not tested')).label, 'unchanged');
});

test('compare: joins cells on test_hash across a patched build with more tools; refuses what cannot be compared', () => {
  const m = load();
  const tools = toolsFor(m);
  const patched = toolsFor(m, [{ name: 'admin_reset', inputSchema: { type: 'object' } }]);
  const stamp = (rs: Result[], ts: typeof tools) => rs.map((x) => ({ ...x, test_hash: testHash(x, { manifest: m, tools: ts, tester }) }));
  const del = { resource: 'ticket', tool: 'delete_ticket', arm: 'mcp' as const };
  const before = stamp([result('MWS-CONC-1', w, { id: 'stale', version: '3' }, 'violated', 'lost'), result('MWS-CONC-3', w, { id: 'pairs', version: '2' }, 'held', 'ok'), result('MWS-CONC-3', w, { id: 'gated', version: '1' }, 'platform', 'both'), result('MWS-CONC-2', del, { id: 'stale', version: '3' }, 'violated', 'v')], tools);
  const after = stamp([result('MWS-CONC-1', w, { id: 'stale', version: '3' }, 'held', 'refused'), result('MWS-CONC-3', w, { id: 'pairs', version: '2' }, 'held', 'ok'), result('MWS-CONC-3', w, { id: 'gated', version: '1' }, 'platform', 'both'), result('MWS-ANN-4', { resource: '(catalog)', tool: 'admin_reset', arm: 'mcp' }, { id: 'catalog', version: '1' }, 'held', 'h')], patched);
  // delete_ticket's schema changed on the patched build: the same requirement is a different test.
  const afterDel = { ...result('MWS-CONC-2', del, { id: 'stale', version: '3' }, 'held', 'h'), test_hash: testHash(result('MWS-CONC-2', del, { id: 'stale', version: '3' }, 'held', 'h'), { manifest: m, tools: patched.map((t) => (t.name === 'delete_ticket' ? { ...t, inputSchema: { type: 'object', properties: { id: {}, if_match: {} } } } : t)), tester }) };
  const b = miniDoc(before as Result[]);
  const a = miniDoc([...(after as Result[]), afterDel as Result], { identity: { ...miniDoc([]).identity, tools_fingerprint: 't2' } });
  const sum = (d: Record<string, unknown>, f: string) => summarize(d, f, JSON.stringify(d), verifyResults(d, null));
  const c = compareDocs(b, a, sum(b, 'b'), sum(a, 'a'));
  const by = new Map(c.cells.map((x) => [x.key, x]));
  assert.equal(by.get('MWS-CONC-1@update_ticket')!.label, 'fixed');
  assert.equal(by.get('MWS-CONC-3@update_ticket')!.before!.verdict, 'platform', 'B4: the cell is platform, not held');
  assert.equal(by.get('MWS-CONC-3@update_ticket')!.label, 'unchanged');
  assert.equal(by.get('MWS-CONC-2@delete_ticket')!.transition, 'test-changed');
  assert.equal(by.get('MWS-ANN-4@admin_reset')!.transition, 'new-cell');
  assert.equal(c.same.tools, false);
  assert.equal(c.rating, null);
  assert.ok(c.warnings.some((x) => /signature unsigned/.test(x)));
  assert.equal(c.cells[0]!.label, 'fixed', 'regressed first, then fixed');
  assert.ok(!/"(total|score|percent|passed)"/.test(JSON.stringify(c)), 'no aggregate');
  // Refusals.
  assert.throws(() => compareDocs(b, { ...a, spec: { version: '0.10' } }, sum(b, 'b'), sum({ ...a, spec: { version: '0.10' } }, 'a')), /different MWS versions/);
  const noHash = miniDoc([rec()]);
  assert.throws(() => compareDocs(noHash, a, sum(noHash, 'b'), sum(a, 'a')), /no test_hash/);
  assert.throws(() => compareDocs(b, { ...a, identity: { test_hash: 'mws-test-hash/0' } }, sum(b, 'b'), sum(a, 'a')), /mws-test-hash\/0/);
});

test('compare and verify-results commands: files, exit codes, pinned keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-cmp-'));
  try {
    const m = load();
    const tools = toolsFor(m);
    const h = (x: Result) => ({ ...x, test_hash: testHash(x, { manifest: m, tools, tester }) });
    const { privateKey } = generateKeyPairSync('ed25519');
    const write = (name: string, rs: Result[], sign: boolean) => {
      const d = miniDoc(rs.map(h) as Result[]) as Record<string, unknown> & { evidence: { signature: unknown } };
      if (sign) d.evidence.signature = signResults(d, privateKey);
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'results.json'), JSON.stringify(d, null, 2) + '\n');
      return join(dir, name);
    };
    const before = write('before', [result('MWS-CONC-1', w, { id: 'stale', version: '3' }, 'held', 'ok')], true);
    const after = write('after', [result('MWS-CONC-1', w, { id: 'stale', version: '3' }, 'violated', 'lost')], true);
    const unsigned = write('unsigned', [result('MWS-CONC-1', w, { id: 'stale', version: '3' }, 'held', 'ok')], false);
    writeFileSync(join(dir, 'pub'), sshPub(privateKey));
    const lines: string[] = [];
    const log = (s: string) => lines.push(s);
    const r = compareCommand({ before, after, out: join(dir, 'out'), pubkey: join(dir, 'pub'), log });
    assert.equal(r.exit, 1, 'a regression exits 1');
    assert.ok(existsSync(join(dir, 'out', 'compare.json')) && existsSync(join(dir, 'out', 'compare.md')));
    assert.match(readFileSync(join(dir, 'out', 'compare.md'), 'utf8'), /## Regressed[\s\S]*MWS-CONC-1@update_ticket/);
    assert.throws(() => compareCommand({ before: unsigned, after, out: join(dir, 'out2'), pubkey: join(dir, 'pub'), log }), (e: unknown) => e instanceof WritecheckError && e.code === 3);
    assert.equal(verifyResultsCommand({ file: before, pubkey: join(dir, 'pub'), log }).exit, 0);
    assert.equal(verifyResultsCommand({ file: before, log }).exit, 1, 'not pinned');
    assert.equal(verifyResultsCommand({ file: unsigned, pubkey: join(dir, 'pub'), log }).exit, 1, 'unsigned');
    const t = JSON.parse(readFileSync(join(before, 'results.json'), 'utf8')) as { run: { id: string } };
    t.run.id = 'other';
    writeFileSync(join(before, 'results.json'), JSON.stringify(t));
    assert.equal(verifyResultsCommand({ file: before, pubkey: join(dir, 'pub'), log }).exit, 3);
    // Through main: the commands and the run identity flags are known.
    assert.equal(await main(['verify-results', unsigned]), 1);
    await assert.rejects(() => main(['run', '-m', join(dir, 'none.yaml'), '--server-commit']), /needs a value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
