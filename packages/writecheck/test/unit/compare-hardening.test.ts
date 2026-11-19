/**
 * Review of the before/after machinery (lane F10): owner rule A in compare, case ids, schema-probe subjects, signatures, tester
 * identity, the test-hash inputs a run used to leave out, and the schema narrowing. Each test names the review finding and the
 * probe (review/compare-probes) it was converted from.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { firstWriteOf, postEvaluate } from '../../src/checks/coverage.js';
import { createsVerdicts } from '../../src/checks/creates.js';
import { recheckCommand } from '../../src/cli/commands.js';
import { compareCommand, finishRecheck } from '../../src/cli/compare.js';
import { TEST_HASH_FORMAT } from '../../src/core/identity.js';
import { parseManifestText, type Manifest } from '../../src/core/manifest.js';
import { Redactor } from '../../src/core/redact.js';
import { canonical, WritecheckError } from '../../src/core/util.js';
import { compareDocs, RELAXED_REQUIRED_IS_SAME_TEST, summarize, type CompareDoc } from '../../src/report/compare.js';
import { signResults, verifyResults } from '../../src/report/sign.js';
import { narrowSchema, stampTestHashes, testHash, testInputs, type TesterId } from '../../src/report/testhash.js';
import { result, type Result } from '../../src/report/verdicts.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..', '..');
const ttManifest = readFileSync(join(pkg, '..', '..', 'examples', 'tiny-tracker', 'writecheck.yaml'), 'utf8');
const load = (text = ttManifest): Manifest => parseManifestText(text, '/work/a/writecheck.yaml');
const tester = { name: 'mcp-writecheck', version: '0.1.0', commit: 'a'.repeat(40), dirty: false };

type Tool = { name: string; [k: string]: unknown };
const props = { id: { type: 'string' }, title: { type: 'string', description: 'The title.' }, status: { type: 'string', enum: ['open', 'closed'] }, assignee: { type: 'string' }, priority: { type: 'integer' }, expected_version: { type: 'integer' }, labels: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } };
/** A tools/list entry for every tool the manifest names (one schema for all), patched by `patch`. */
function toolsFor(m: Manifest, patch: (name: string, schema: Record<string, unknown>) => Record<string, unknown> = (_n, s) => s): Tool[] {
  const names = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'tool' && typeof x === 'string' ? names.add(x) : walk(x));
  };
  walk(m.resources);
  walk(m.target);
  return [...names].sort().map((n) => ({ name: n, description: `${n} does its job`, inputSchema: patch(n, { type: 'object', properties: JSON.parse(JSON.stringify(props)), required: ['id'] }) }));
}
const onTool = (tool: string, f: (s: Record<string, unknown>) => Record<string, unknown>) => (n: string, s: Record<string, unknown>) => (n === tool ? f(s) : s);
const withProps = (s: Record<string, unknown>, extra: Record<string, unknown>, required?: string[]) => ({ ...s, properties: { ...(s['properties'] as object), ...extra }, ...(required ? { required } : {}) });
const without = (s: Record<string, unknown>, arg: string) => {
  const p = { ...(s['properties'] as Record<string, unknown>) };
  delete p[arg];
  return { ...s, properties: p };
};

const W = { resource: 'ticket', tool: 'update_ticket', arm: 'mcp' as const };
function rec(requirement: string, verdict: Result['verdict'], o: { scenario?: { id: string; version: string }; resource?: string; tool?: string; case?: string } = {}): Result {
  const r = result(requirement as never, { ...W, ...(o.resource ? { resource: o.resource } : {}), ...(o.tool ? { tool: o.tool } : {}) }, o.scenario ?? { id: 'stale-write', version: '1' }, verdict, verdict);
  if (verdict === 'violated') r.validity = { class: 'valid', counts: true, failed: [], synthetic_fault: false, evidence: {} };
  return o.case !== undefined ? { ...r, case: o.case } : r;
}
function doc(results: Result[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'mws-results/1',
    suite: { name: 'mcp-writecheck', version: '0.1.0' },
    spec: { version: '0.9' },
    run: { id: `r${Math.random().toString(16).slice(2, 8)}`, status: 'complete', stopped_reason: null, started: '2026-11-18T10:00:00Z', ended: 'e' },
    manifest: { path: 'manifest.yaml', sha256: 'm1' },
    plan: { hash: 'p1' },
    results,
    evidence: { capture: null, checksums: 'SHA256SUMS', signature: null },
    identity: { test_hash: TEST_HASH_FORMAT, tester: { name: 'mcp-writecheck', version: '0.1.0', commit: 'a'.repeat(40), dirty: false }, tools_fingerprint: 't1', server: { repo: 'r', commit: null }, backend: [], gaps: [] },
    ...over,
  };
}
const stamped = (rs: Result[], m: Manifest, tools: Tool[], t: TesterId = tester) => {
  const out = JSON.parse(JSON.stringify(rs)) as Result[];
  stampTestHashes(out, { manifest: m, tools, tester: t });
  return out;
};
function cmp(b: Record<string, unknown>, a: Record<string, unknown>): CompareDoc {
  const s = (d: Record<string, unknown>, f: string) => summarize(d, f, JSON.stringify(d), verifyResults(d, null));
  return compareDocs(b, a, s(b, 'b'), s(a, 'a'));
}
const cellOf = (c: CompareDoc, key: string) => c.cells.find((x) => x.key === key)!;

test('M1 rule A (p06, p10 S): an optional argument the manifest already sends, added by the fix, keeps the test: violated → held is fixed, and says why', () => {
  const m = load();
  const before = toolsFor(m, onTool('update_ticket', (s) => without(s, 'expected_version')));
  const after = toolsFor(m);
  const c = cmp(doc(stamped([rec('MWS-CONC-1', 'violated')], m, before)), doc(stamped([rec('MWS-CONC-1', 'held')], m, after)));
  const x = cellOf(c, 'MWS-CONC-1@update_ticket');
  assert.equal(x.label, 'fixed', x.why);
  assert.ok(x.same_test_because?.some((t) => /update_ticket\.expected_version: an optional argument added \(the test sends it\)/.test(t)), JSON.stringify(x.same_test_because));
});

test('M1 rule A (p10 D, N, O): description-only changes, an optional nested property (also in array items), and another tool relaxing required keep the test', () => {
  const m = load();
  const base = toolsFor(m);
  const r0 = rec('MWS-RES-1', 'held', { scenario: { id: 'read-after-write', version: '1' } });
  const h0 = testHash(r0, { manifest: m, tools: base, tester });
  assert.equal(testHash(r0, { manifest: m, tools: toolsFor(m, onTool('update_ticket', (s) => withProps(s, { title: { type: 'string', description: 'New words.', title: 'T', examples: ['x'], $comment: 'c', deprecated: false } }))), tester }), h0, 'annotation keywords only');
  const variants: [string, Tool[], RegExp][] = [
    ['nested optional in array items', toolsFor(m, onTool('set_labels', (s) => withProps(s, { labels: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' } }, required: ['name'] } } }))), /labels\[\]\.color: an optional nested property added/],
    ['the read tool relaxes required id', toolsFor(m, onTool('get_ticket', (s) => ({ ...s, required: [] }))), /get_ticket\.id: relaxed from required to optional/],
  ];
  for (const [what, after, why] of variants) {
    const c = cmp(doc(stamped([{ ...r0, verdict: 'violated', validity: { class: 'valid', counts: true, failed: [], synthetic_fault: false, evidence: {} } }], m, base)), doc(stamped([r0], m, after)));
    const x = cellOf(c, 'MWS-RES-1@update_ticket');
    assert.equal(x.label, 'fixed', `${what}: ${x.why}`);
    assert.ok(x.same_test_because?.some((t) => why.test(t)), `${what}: ${JSON.stringify(x.same_test_because)}`);
  }
  assert.equal(RELAXED_REQUIRED_IS_SAME_TEST, true, 'owner decision 18 Nov');
});

test('M1 rule A: a tightening is always a changed test (optional → required, a new required argument, a changed type or enum of a sent argument)', () => {
  const m = load();
  const base = toolsFor(m);
  const r0 = rec('MWS-RES-1', 'held', { scenario: { id: 'read-after-write', version: '1' } });
  const tight: [string, Tool[]][] = [
    ['sent argument becomes required', toolsFor(m, onTool('update_ticket', (s) => ({ ...s, required: ['id', 'expected_version'] })))],
    ['new required argument not sent', toolsFor(m, onTool('update_ticket', (s) => withProps(s, { reason: { type: 'string' } }, ['id', 'reason'])))],
    ['type of a sent argument', toolsFor(m, onTool('update_ticket', (s) => withProps(s, { expected_version: { type: 'string' } })))],
    ['enum of a sent argument', toolsFor(m, onTool('update_ticket', (s) => withProps(s, { status: { type: 'string', enum: ['open'] } })))],
    ['new required nested property', toolsFor(m, onTool('set_labels', (s) => withProps(s, { labels: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, c: { type: 'string' } }, required: ['name', 'c'] } } })))],
  ];
  for (const [what, after] of tight) {
    const c = cmp(doc(stamped([{ ...r0, verdict: 'violated', validity: { class: 'valid', counts: true, failed: [], synthetic_fault: false, evidence: {} } }], m, base)), doc(stamped([r0], m, after)));
    const x = cellOf(c, 'MWS-RES-1@update_ticket');
    assert.equal(x.transition, 'test-changed', `${what}: ${x.label} ${x.why} ${JSON.stringify(x.same_test_because)}`);
  }
});

test('M2 (p12): records join per case; without case ids no fix where counts differ or an after record is not tested; a case held → violated beside a violated sibling is a slot regression', () => {
  const m = load();
  const tools = toolsFor(m);
  const sc = { id: 'creates', version: '1' };
  const R = (v: Result['verdict'], c?: string) => rec('MWS-RES-2', v, { scenario: sc, ...(c !== undefined ? { case: c } : {}) });
  const key = 'MWS-RES-2@update_ticket';
  // a) no case ids: [violated ×3] → [held, held, not tested]
  let c = cmp(doc(stamped([R('violated'), R('violated'), R('violated')], m, tools)), doc(stamped([R('held'), R('held'), R('not tested')], m, tools)));
  assert.notEqual(cellOf(c, key).label, 'fixed', cellOf(c, key).why);
  // b) no case ids: three before, two after
  c = cmp(doc(stamped([R('violated'), R('violated'), R('violated')], m, tools)), doc(stamped([R('held'), R('held')], m, tools)));
  assert.notEqual(cellOf(c, key).label, 'fixed');
  // d) no case ids: [held, violated] → [held, not tested]
  c = cmp(doc(stamped([R('held'), R('violated')], m, tools)), doc(stamped([R('held'), R('not tested')], m, tools)));
  assert.notEqual(cellOf(c, key).label, 'fixed');
  // with case ids: one case not tested after is a coverage change; all held is fixed
  c = cmp(doc(stamped([R('violated', 'failure:a'), R('violated', 'failure:b')], m, tools)), doc(stamped([R('held', 'failure:a'), R('not tested', 'failure:b')], m, tools)));
  assert.notEqual(cellOf(c, key).label, 'fixed');
  c = cmp(doc(stamped([R('violated', 'failure:a'), R('violated', 'failure:b')], m, tools)), doc(stamped([R('held', 'failure:a'), R('held', 'failure:b')], m, tools)));
  assert.equal(cellOf(c, key).label, 'fixed');
  // c) [held a, violated b, violated c] → [violated a, held b, violated c]
  c = cmp(doc(stamped([R('held', 'failure:a'), R('violated', 'failure:b'), R('violated', 'failure:c')], m, tools)), doc(stamped([R('violated', 'failure:a'), R('held', 'failure:b'), R('violated', 'failure:c')], m, tools)));
  assert.deepEqual(cellOf(c, key).slot_regressions, ['ticket/creates[failure:a] held → violated']);
  // the creates check stamps its cases
  const res = m.resources.find((r) => r.name === 'ticket')!;
  const call = { step: 's1', ok: false, isError: true, rpc_error: null, text: 'refused', data: null, indeterminate: false };
  const out = createsVerdicts({ creates: [], update_receipt: null, failures: [{ name: 'a', tool: 'update_ticket', call, changed: [] }, { name: 'b', tool: 'update_ticket', call, changed: [] }], delete_case: null, jobs: [] } as never, res, { manifest: m, tools, review: null, gated: false } as never);
  assert.deepEqual(out.filter((r) => r.requirement === 'MWS-RES-2').map((r) => r.case), ['failure:a', 'failure:b']);
});

test('M3: the first-write rule is one shared step, and is read back from a recorded run', () => {
  const m = load();
  const upd = rec('MWS-UPD-1', 'held', { scenario: { id: 'read-after-write', version: '1' } });
  const moved = new Map([['ticket', ['labels', 'priority']]]);
  const once = postEvaluate(m, [upd], moved);
  assert.equal(once[0]!.verdict, 'not tested');
  assert.deepEqual(postEvaluate(m, once, moved), once, 'idempotent');
  assert.deepEqual([...firstWriteOf([], once)], [['ticket', ['labels', 'priority']]], 'from the record of a file written before first_write was kept');
  assert.deepEqual([...firstWriteOf([{ resource: 'ticket', first_write: ['x'] }], [])], [['ticket', ['x']]]);
});

test('M4 (p01, p05): schema probes are about every probed argument: a dropped or retyped probed argument is never fixed; an added optional argument is the same test, and held → violated is regressed', () => {
  const m = load();
  const base = toolsFor(m, onTool('update_ticket', (s) => withProps(s, { legacy_priority: { type: 'integer', minimum: 1 } })));
  const sc = { id: 'schema-probes', version: '1' };
  const key = (q: string) => `${q}@update_ticket`;
  const dropped = toolsFor(m);
  for (const q of ['MWS-IN-1', 'MWS-IN-6']) {
    const c = cmp(doc(stamped([rec(q, 'violated', { scenario: sc })], m, base)), doc(stamped([rec(q, 'held', { scenario: sc })], m, dropped)));
    assert.equal(cellOf(c, key(q)).transition, 'test-changed', `${q}: ${cellOf(c, key(q)).why}`);
    assert.match(cellOf(c, key(q)).why, /legacy_priority: a probed argument was removed/);
  }
  const retyped = toolsFor(m, onTool('update_ticket', (s) => withProps(s, { legacy_priority: { type: 'string' } })));
  let c = cmp(doc(stamped([rec('MWS-IN-1', 'violated', { scenario: sc })], m, base)), doc(stamped([rec('MWS-IN-1', 'held', { scenario: sc })], m, retyped)));
  assert.equal(cellOf(c, key('MWS-IN-1')).transition, 'test-changed', 'IN-1 does not judge the schema');
  c = cmp(doc(stamped([rec('MWS-IN-6', 'violated', { scenario: sc })], m, base)), doc(stamped([rec('MWS-IN-6', 'held', { scenario: sc })], m, retyped)));
  assert.equal(cellOf(c, key('MWS-IN-6')).label, 'schema-fixed', 'IN-6 judges the schema: never plain fixed');
  const plusOpt = toolsFor(m, onTool('update_ticket', (s) => withProps(s, { legacy_priority: { type: 'integer', minimum: 1 }, dry_run: { type: 'boolean' } })));
  for (const q of ['MWS-IN-2', 'MWS-IN-3', 'MWS-IN-6', 'MWS-IN-7']) {
    c = cmp(doc(stamped([rec(q, 'held', { scenario: sc })], m, base)), doc(stamped([rec(q, 'violated', { scenario: sc })], m, plusOpt)));
    assert.equal(cellOf(c, key(q)).label, 'regressed', `${q}: ${cellOf(c, key(q)).transition} ${cellOf(c, key(q)).why}`);
  }
  // held → violated across a real change of the judged schema is a regression too (slot regression in a not-comparable cell, or the label)
  c = cmp(doc(stamped([rec('MWS-IN-6', 'held', { scenario: sc })], m, base)), doc(stamped([rec('MWS-IN-6', 'violated', { scenario: sc })], m, retyped)));
  assert.equal(cellOf(c, key('MWS-IN-6')).label, 'regressed');
});

test('M5 (p04): compare refuses a file whose signature does not verify, pinned or not; unsigned input needs --allow-unsigned and is labelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-f10-'));
  try {
    const m = load();
    const tools = toolsFor(m);
    const { privateKey } = generateKeyPairSync('ed25519');
    const put = (name: string, d: Record<string, unknown>, sign: boolean) => {
      if (sign) (d['evidence'] as Record<string, unknown>)['signature'] = signResults(d, privateKey);
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'results.json'), JSON.stringify(d, null, 2));
      return join(dir, name);
    };
    const b = put('b', doc(stamped([rec('MWS-CONC-1', 'violated')], m, tools)), true);
    const a = put('a', doc(stamped([rec('MWS-CONC-1', 'violated')], m, tools)), true);
    const t = JSON.parse(readFileSync(join(a, 'results.json'), 'utf8')) as { results: Result[] };
    t.results[0]!.verdict = 'held';
    delete t.results[0]!.validity;
    writeFileSync(join(a, 'results.json'), JSON.stringify(t));
    const log = () => {};
    for (const allowUnsigned of [false, true]) assert.throws(() => compareCommand({ before: b, after: a, out: join(dir, 'o'), allowUnsigned, log }), (e: unknown) => e instanceof WritecheckError && e.code === 3);
    const u1 = put('u1', doc(stamped([rec('MWS-CONC-1', 'violated')], m, tools)), false);
    const u2 = put('u2', doc(stamped([rec('MWS-CONC-1', 'held')], m, tools)), false);
    assert.throws(() => compareCommand({ before: u1, after: u2, out: join(dir, 'o'), log }), (e: unknown) => e instanceof WritecheckError && e.code === 2 && /--allow-unsigned/.test(e.message));
    const r = compareCommand({ before: u1, after: u2, out: join(dir, 'o'), allowUnsigned: true, log });
    assert.equal(r.doc.before.signature.accepted, 'allow-unsigned');
    assert.match(readFileSync(join(dir, 'o', 'compare.md'), 'utf8'), /NOT PINNED: accepted with --allow-unsigned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M6 (p03 a-d): restart.stop, processes, decode and protocol enter the hash', () => {
  const m = load();
  const tools = toolsFor(m);
  const r0 = rec('MWS-RETRY-2', 'held', { scenario: { id: 'idempotency-replay.restart', version: '1' } });
  const h0 = testHash(r0, { manifest: m, tools, tester });
  for (const [what, text] of [
    ['restart.stop', ttManifest.replace('restart: { stop: graceful }', 'restart: { stop: kill }')],
    ['processes', ttManifest.replace('processes: separate', 'processes: same')],
    ['decode', ttManifest.replace('restart: { stop: graceful }', 'restart: { stop: graceful }\n  decode: { update_ticket: none }')],
    ['protocol', ttManifest.replace('processes: separate', 'processes: separate\n  protocol: "2025-11-25"')],
  ] as const) {
    assert.notEqual(text, ttManifest, what);
    assert.notEqual(testHash(r0, { manifest: load(text), tools, tester }), h0, what);
  }
});

test('S1 (p13): the manifest copy stays YAML; a catalog argument named password keeps its schema', () => {
  const red = new Redactor(['s3cr3t-value-1']);
  const yaml = 'server:\n  headers_env:\n    authorization: { env: API_TOKEN, prefix: "Bearer " }\n  env: { K: s3cr3t-value-1 }\n';
  const out = red.manifestText(yaml);
  assert.match(out, /authorization: \{ env: API_TOKEN, prefix: "Bearer " \}/);
  assert.ok(!out.includes('s3cr3t-value-1'));
  assert.match(red.text('Authorization: Bearer abcdefgh12345'), /\[REDACTED\]/, 'free text is still masked');
  const cat = red.catalogValue({ tools: [{ name: 't', inputSchema: { properties: { password: { type: 'integer', minimum: 100000 } } }, default: { password: 'hunter2hunter2' } }] });
  assert.deepEqual(cat.tools[0]!.inputSchema.properties.password, { type: 'integer', minimum: 100000 });
  assert.equal((cat.tools[0]!.default as { password: string }).password, '[REDACTED]');
});

test('S2 (p14): MWS-IN-5 hashes the tool description, descriptions inside the schema, and the documents it read', () => {
  const m = load();
  const tools = toolsFor(m);
  const r0 = rec('MWS-IN-5', 'not observed', { scenario: { id: 'in5-search', version: '1' } });
  const h = (ts: Tool[], extras = {}) => testHash(r0, { manifest: m, tools: ts, tester, extras });
  const h0 = h(tools);
  assert.notEqual(h(tools.map((t) => (t.name === 'update_ticket' ? { ...t, description: 'title up to 120 characters' } : t))), h0, 'tool description');
  assert.notEqual(h(toolsFor(m, onTool('update_ticket', (s) => withProps(s, { title: { type: 'string', description: 'up to 120 characters' } })))), h0, 'argument description');
  assert.notEqual(h(tools, { in5_docs: { './limits.md': 'a' } }), h(tools, { in5_docs: { './limits.md': 'b' } }), 'document content');
  const r1 = rec('MWS-RES-1', 'held', { scenario: { id: 'read-after-write', version: '1' } });
  assert.equal(testHash(r1, { manifest: m, tools, tester, extras: { in5_docs: { x: 'a' } } }), testHash(r1, { manifest: m, tools, tester, extras: { in5_docs: { x: 'b' } } }), 'only for MWS-IN-5');
});

test('S3 (p15, p03e): no tester commit on either side (null === null) and a dirty build are not the same build: no fix is claimed', () => {
  const m = load();
  const tools = toolsFor(m);
  for (const t of [{ ...tester, commit: null }, { ...tester, dirty: true }]) {
    const c = cmp(doc(stamped([rec('MWS-CONC-1', 'violated')], m, tools, t)), doc(stamped([rec('MWS-CONC-1', 'held')], m, tools, t)));
    const x = cellOf(c, 'MWS-CONC-1@update_ticket');
    assert.equal(x.transition, 'tester-unpinned', x.why);
    assert.ok(c.warnings.some((w) => /not claimed as fixed/.test(w)));
  }
  const bare = doc(stamped([rec('MWS-CONC-1', 'held')], m, tools), { identity: undefined });
  const c = cmp(bare, JSON.parse(JSON.stringify(bare)) as Record<string, unknown>);
  assert.equal(c.same.tester, false);
  // another tester build is another test
  const c2 = cmp(doc(stamped([rec('MWS-CONC-1', 'violated')], m, tools)), doc(stamped([rec('MWS-CONC-1', 'held')], m, tools, { ...tester, commit: 'b'.repeat(40) })));
  assert.match(cellOf(c2, 'MWS-CONC-1@update_ticket').why, /another tester build judged it/);
});

test('S4 (p17b): recheck refuses a run folder whose results signature no longer verifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-f10-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const d = doc([rec('MWS-ANN-4', 'violated')]);
    (d['evidence'] as Record<string, unknown>)['signature'] = signResults(d, privateKey);
    (d['results'] as Result[])[0]!.verdict = 'held';
    writeFileSync(join(dir, 'results.json'), JSON.stringify(d));
    assert.throws(() => recheckCommand({ dir, log: () => {} }), (e: unknown) => e instanceof WritecheckError && e.code === 3 && /signature does not verify/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S5 (p18): swapped files, one file twice, one server commit twice and newly found violations are said', () => {
  const m = load();
  const tools = toolsFor(m);
  const b = doc(stamped([rec('MWS-CONC-1', 'held'), rec('MWS-CONC-3', 'not tested', { scenario: { id: 'barrier-pairs', version: '1' } })], m, tools), { run: { id: 'r1', status: 'complete', started: '2026-11-18T12:00:00Z' }, identity: { ...(doc([])['identity'] as object), server: { commit: 'c'.repeat(40) } } });
  const a = doc(stamped([rec('MWS-CONC-1', 'held'), rec('MWS-CONC-3', 'violated', { scenario: { id: 'barrier-pairs', version: '1' } })], m, tools), { run: { id: 'r2', status: 'complete', started: '2026-11-18T09:00:00Z' }, identity: { ...(doc([])['identity'] as object), server: { commit: 'c'.repeat(40) } } });
  const c = cmp(b, a);
  assert.ok(c.warnings.some((w) => /started .* before the before run/.test(w)));
  assert.ok(c.warnings.some((w) => /same build of the server/.test(w)));
  assert.equal(cellOf(c, 'MWS-CONC-3@update_ticket').newly_found, true);
  const same = cmp(b, b);
  assert.ok(same.warnings.some((w) => /same file|same run/.test(w)));
});

test('S7 (p09c, p03f): writes_per_second enters MWS-RETRY-2 hashes; the review answers in force (a --review file) enter the hash', () => {
  const m = load();
  const tools = toolsFor(m);
  const r0 = rec('MWS-RETRY-2', 'held', { scenario: { id: 'idempotency-replay.concurrent', version: '1' } });
  assert.notEqual(testHash(r0, { manifest: load(ttManifest.replace('writes_per_second: 1000', 'writes_per_second: 5')), tools, tester }), testHash(r0, { manifest: m, tools, tester }));
  const r1 = rec('MWS-CONC-4', 'self-attested', { scenario: { id: 'review', version: '1' } });
  assert.notEqual(testHash(r1, { manifest: m, tools, tester, review: { by: 'x', answers: { q: { answer: true } } } }), testHash(r1, { manifest: m, tools, tester }));
});

test('S8 (p02, p16): narrowing follows a top-level $ref, $anchor and draft-07 dependencies, and does not crash on % or constructor', () => {
  const used = new Set(['id', 'expected_version']);
  const same = (a: unknown, b: unknown) => canonical(narrowSchema(a, used)) === canonical(narrowSchema(b, used));
  const args = (ev: unknown, required = ['id']) => ({ type: 'object', properties: { id: { type: 'string' }, expected_version: ev }, required });
  const wrap = (x: unknown) => ({ $ref: '#/$defs/Args', $defs: { Args: x } });
  assert.ok(!same(wrap(args({ type: 'integer' })), wrap(args({ type: 'string' }))), 'top-level $ref: type');
  assert.ok(!same(wrap(args({ type: 'integer' })), wrap(args({ type: 'integer' }, ['id', 'expected_version']))), 'top-level $ref: required');
  const anch = (t: string) => ({ type: 'object', properties: { id: { type: 'string' }, expected_version: { $ref: '#Version' } }, $defs: { V: { $anchor: 'Version', type: t } } });
  assert.ok(!same(anch('integer'), anch('string')), '$anchor');
  const base = args({ type: 'integer' });
  assert.ok(!same(base, { ...base, dependencies: { expected_version: ['force'] } }), 'dependencies');
  assert.doesNotThrow(() => narrowSchema({ type: 'object', properties: { id: { $ref: '#/$defs/100%' } }, $defs: { '100%': { type: 'integer' } } }, used));
  assert.doesNotThrow(() => narrowSchema({ type: 'object', properties: { id: { type: 'string' } } }, new Set(['id', 'constructor', '__proto__'])));
  assert.ok(!same(args({ type: 'string', description: 'a' }), args({ type: 'integer', description: 'a' })));
  assert.ok(same(args({ type: 'string', description: 'a' }), args({ type: 'string', description: 'b' })), 'annotation keywords are left out');
  // an argument named like an annotation keyword is still an argument
  const named = (t: string) => ({ type: 'object', properties: { description: { type: t } } });
  assert.ok(canonical(narrowSchema(named('string'), new Set(['description']))) !== canonical(narrowSchema(named('integer'), new Set(['description']))));
});

test('p16 F: a launch check (MWS-CFG-3, read-only mode calls every declared write tool) hashes every resource block and its tools: dropping a resource is never fixed', () => {
  const m = load();
  const tools = toolsFor(m);
  const cfg3 = rec('MWS-CFG-3', 'violated', { resource: '(server)', tool: 'TRACKER_READ_ONLY', scenario: { id: 'read-only', version: '1' } });
  const fewer = load();
  fewer.resources = fewer.resources.filter((r) => r.name !== 'ticket-replace');
  assert.notEqual(testHash(cfg3, { manifest: fewer, tools, tester }), testHash(cfg3, { manifest: m, tools, tester }), 'a dropped resource changes the test');
  const i = testInputs(cfg3, { manifest: m, tools, tester });
  assert.ok(Object.keys(i.tools).includes('replace_ticket'), 'the write tool of every resource is in the tool shapes');
  const retyped = toolsFor(m, onTool('replace_ticket', (s) => withProps(s, { title: { type: 'integer' } })));
  assert.notEqual(testHash(cfg3, { manifest: m, tools: retyped, tester }), testHash(cfg3, { manifest: m, tools, tester }), 'a retyped argument another resource sends changes the test');
  const b = doc(stamped([cfg3], m, tools));
  const a = doc(stamped([rec('MWS-CFG-3', 'held', { resource: '(server)', tool: 'TRACKER_READ_ONLY', scenario: { id: 'read-only', version: '1' } })], fewer, tools));
  assert.notEqual(cellOf(cmp(b, a), 'MWS-CFG-3@TRACKER_READ_ONLY').label, 'fixed');
  // a record of one resource is untouched by another resource's block
  const res1 = rec('MWS-RES-1', 'held', { scenario: { id: 'read-after-write', version: '1' } });
  assert.equal(testHash(res1, { manifest: fewer, tools, tester }), testHash(res1, { manifest: m, tools, tester }));
});

test('p16 E: a tool called with the manifest\'s calls args (annotation effects) hashes the arguments that call sends', () => {
  const m = load();
  const tools: Tool[] = [...toolsFor(m).filter((t) => t.name !== 'add_label'), { name: 'add_label', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } }];
  const ann = rec('MWS-ANN-1', 'held', { tool: 'add_label', scenario: { id: 'annotation-effects', version: '1' } });
  const retyped = tools.map((t) => (t.name === 'add_label' ? { ...t, inputSchema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } } : t));
  assert.notEqual(testHash(ann, { manifest: m, tools: retyped, tester }), testHash(ann, { manifest: m, tools, tester }));
  assert.deepEqual(Object.keys(testInputs(ann, { manifest: m, tools, tester }).tools['add_label']!.p).sort(), ['id', 'name']);
});

test('scheme: records hashed under mws-test-hash/1 and /2 are never joined, and compare says so', () => {
  const m = load();
  const tools = toolsFor(m);
  const old = rec('MWS-CONC-1', 'violated');
  (old as Result).test_hash = `sha256:${'0'.repeat(64)}`;
  const b = doc([old], { identity: { ...(doc([])['identity'] as object), test_hash: 'mws-test-hash/1' } });
  const c = cmp(b, doc(stamped([rec('MWS-CONC-1', 'held')], m, tools)));
  const x = cellOf(c, 'MWS-CONC-1@update_ticket');
  assert.equal(x.transition, 'scheme-changed');
  assert.match(x.why, /hashed under different schemes \(mws-test-hash\/1 before, mws-test-hash\/2 after\)/);
  // the inputs are stored and the hash follows from them
  const s = stamped([rec('MWS-CONC-1', 'held')], m, tools)[0]!;
  assert.equal(s.test_inputs?.scheme, 'mws-test-hash/2');
  assert.equal(canonical(s.test_inputs), canonical(JSON.parse(JSON.stringify(testInputs(rec('MWS-CONC-1', 'held'), { manifest: m, tools, tester })))));
});

test('S7 (p09b), S1 (p13c): recheck hashes with the run\'s --pair-budget, and from recorded test inputs naming the rechecking build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-f10-'));
  try {
    const mf = join(dir, 'manifest.yaml');
    writeFileSync(mf, ttManifest);
    const budget = { repeats: 2, pairs: 1500 };
    const withBudget = parseManifestText(ttManifest, mf, { pairBudget: budget });
    const plain = parseManifestText(ttManifest, mf);
    const tools = toolsFor(plain);
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ tools, prompts: [], resourceTemplates: [] }));
    const pairs = rec('MWS-CONC-3', 'not observed', { scenario: { id: 'barrier-pairs', version: '1' } });
    const kept = stamped([rec('MWS-RES-1', 'held', { scenario: { id: 'read-after-write', version: '1' } })], withBudget, tools)[0]!;
    const original = doc([...stamped([pairs], withBudget, tools), kept], { scope: 's', target: { confirm: 'x', environment: 'test', server: 's', catalog_fingerprint: 'sha256:c', guard: null }, cells: [], not_built: [], measurements: null, leftovers: [], cleanup: null, observations: [], safety: { canaries: [], fixtures_restored: [], gate: null, protocol: null, rerun_of: null }, identity: { ...(doc([])['identity'] as object), spec: { version: '0.9' }, manifest_sha256: 'm1', plan_hash: 'p1', started: 's', finished: 'f', provenance: { sources: [], overridden: [] }, runner: { os: 'x', arch: 'x', node: 'x', ci: null }, server: { repo: null, commit: null, tag: null, image: null, recipe: null, launch: 'x', transport: null }, hash_inputs: { pair_budget: budget } } });
    writeFileSync(join(dir, 'results.json'), JSON.stringify(original));
    mkdirSync(join(dir, 'recheck'));
    const fresh = JSON.parse(JSON.stringify(original)) as { results: Result[] };
    for (const r of fresh.results) {
      delete r.test_hash;
      delete r.test_inputs;
    }
    // the first record has no recorded inputs to reuse: hashed from the copies, with the budget
    (original['results'] as Result[])[0]!.test_inputs = undefined as never;
    writeFileSync(join(dir, 'results.json'), JSON.stringify(original));
    writeFileSync(join(dir, 'recheck', 'results.json'), JSON.stringify(fresh));
    const out = await finishRecheck(dir, { key: null, log: () => {} });
    const me = out.results[0]!.test_inputs!.tester;
    assert.equal(out.results[0]!.test_hash, testHash(pairs, { manifest: withBudget, tools, tester: me }), 'hashed with the budget the run was given');
    assert.notEqual(out.results[0]!.test_hash, testHash(pairs, { manifest: plain, tools, tester: me }));
    assert.equal(out.results[1]!.test_inputs!.rest, kept.test_inputs!.rest, 'recorded inputs reused');
    assert.equal(out.results[1]!.test_hash, testHash(kept, { manifest: withBudget, tools, tester: me }), 'the same hash a run by this build would stamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
