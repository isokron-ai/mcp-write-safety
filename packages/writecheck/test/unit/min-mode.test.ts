/**
 * Min mode (src/min): the requirement list, the caps (the false-pass guard), the mock, the plan rule, the declaration
 * reader. Each behaviour has a mutation check: the protection turned off, and the test's own assertion goes red.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REQUIREMENTS } from '../../src/requirements.js';
import { parseDeclaration } from '../../src/min/declaration.js';
import { Mock } from '../../src/min/mock.js';
import { buildModel } from '../../src/min/openapi.js';
import { applyCaps, capViolations, combine, MIN_REQUIREMENTS, minStatus, runMin, serverEnv, type MinRecord } from '../../src/min/run.js';
import { fromPattern } from '../../src/min/values.js';

const BACKEND_SEMANTIC = ['MWS-UPD-1', 'MWS-UPD-2', 'MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-3', 'MWS-TGT-1', 'MWS-TGT-3', 'MWS-RES-1', 'MWS-ATOM-2'];

test('R-MIN-03: the min-mode list names every MWS requirement once, each with a reason, and the nine backend-semantic ones are not_testable_mock', () => {
  const ids = Object.keys(MIN_REQUIREMENTS);
  assert.deepEqual([...ids].sort(), REQUIREMENTS.map((r) => r.id).sort());
  for (const [id, e] of Object.entries(MIN_REQUIREMENTS)) {
    assert.ok(['run', 'partial', 'not_testable_mock'].includes(e.min), id);
    assert.ok(e.why.length > 40, `${id}: give the reason in one line`);
  }
  assert.deepEqual(ids.filter((id) => minStatus(id) === 'not_testable_mock').sort(), [...BACKEND_SEMANTIC].sort());
  // RES-2 has an in-flight and settle form that needs a real key store: never held in min mode.
  assert.equal(minStatus('MWS-RES-2'), 'partial');
});

const rec = (requirement: string, verdict: MinRecord['verdict'], tool = 't'): MinRecord => ({ requirement, level: 'MUST', tool, case: null, verdict, reason: 'x', basis: 'stateful-mock', method: 'black-box', steps: [], numbers: {}, notes: [] });

test('R-MIN-04: the cap turns any verdict on a backend-semantic requirement into not tested (not_testable_mock), and a partial one keeps only violated', () => {
  const raw = [rec('MWS-CONC-3', 'held'), rec('MWS-UPD-1', 'violated'), rec('MWS-RES-1', 'held'), rec('MWS-RETRY-2', 'held'), rec('MWS-ANN-2', 'violated'), rec('MWS-IN-3', 'held')];
  const out = applyCaps(raw);
  for (const id of BACKEND_SEMANTIC) {
    const r = out.filter((x) => x.requirement === id);
    assert.equal(r.length, 1, id);
    assert.equal(r[0]!.verdict, 'not tested');
    assert.equal(r[0]!.status, 'not_testable_mock');
    assert.equal(r[0]!.reason_code, 'backend_semantics_not_exercised');
  }
  assert.equal(out.find((x) => x.requirement === 'MWS-RETRY-2')!.status, 'not_testable_mock', 'a partial requirement is never held');
  assert.equal(out.find((x) => x.requirement === 'MWS-ANN-2')!.verdict, 'violated');
  assert.equal(out.find((x) => x.requirement === 'MWS-IN-3')!.verdict, 'held');
  assert.equal(out.filter((x) => x.requirement === 'MWS-SEC-1').length, 1, 'a requirement with no record still gets one');
  assert.deepEqual(capViolations({ results: out }), []);
});

test('R-MIN-04: mutation check: without the cap, the guard refuses the document (a held CONC-3, a violated UPD-1, a held RETRY-2, missing records)', () => {
  const raw = [rec('MWS-CONC-3', 'held'), rec('MWS-UPD-1', 'violated'), rec('MWS-RETRY-2', 'held')];
  const bad = capViolations({ results: applyCaps(raw, { off: true }) });
  assert.ok(bad.some((b) => b.startsWith('MWS-CONC-3')));
  assert.ok(bad.some((b) => b.startsWith('MWS-UPD-1')));
  assert.ok(bad.some((b) => b.startsWith('MWS-RETRY-2')));
  assert.ok(bad.some((b) => b.startsWith('MWS-ATOM-2') && /no record/.test(b)));
});

test('R-MIN-11: combining trials: violated wins, held needs no not-observed beside it (spec 8.2 rule 13)', () => {
  const t = (verdict: MinRecord['verdict']) => ({ requirement: 'MWS-IN-3', tool: 'x', case: 'c', verdict, reason: verdict, method: 'black-box' as const, steps: [] });
  assert.equal(combine([t('held'), t('violated'), t('held')])[0]!.verdict, 'violated');
  assert.equal(combine([t('held'), t('not tested')])[0]!.verdict, 'held');
  assert.equal(combine([t('not tested')])[0]!.verdict, 'not tested');
});

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'things', version: '1' },
  paths: {
    '/things': {
      get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } } } } } } } } },
      post: { parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'same key, other body: 422 `key_reused`' }], responses: { '201': { description: 'created', content: { 'application/json': { schema: { type: 'object', properties: { thing: { $ref: '#/components/schemas/Thing' } } } } } }, '422': { description: 'no' } } },
    },
    '/things/{id}': {
      get: { responses: { '200': { description: 'ok', headers: { ETag: {} }, content: { 'application/json': { schema: { type: 'object', properties: { thing: { $ref: '#/components/schemas/Thing' } } } } } } } },
      patch: { parameters: [{ name: 'If-Match', in: 'header', schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { thing: { $ref: '#/components/schemas/Thing' }, changed: { type: 'array', items: { type: 'string' } } } } } } }, '412': { description: 'conflict', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, current: { $ref: '#/components/schemas/Thing' } } } } } } } },
    },
  },
  components: { schemas: { Thing: { type: 'object', required: ['id', 'name', 'version'], properties: { id: { type: 'string', pattern: '^TH-[0-9]+$' }, name: { type: 'string' }, version: { type: 'integer', minimum: 1 } } } } },
};

const http = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number | null; body: unknown; headers: Record<string, unknown> }> =>
  new Promise((resolve) => {
    const u = new URL(url);
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode ?? null, body: t ? JSON.parse(t) : undefined, headers: res.headers }));
    });
    r.on('error', () => resolve({ status: null, body: undefined, headers: {} }));
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });

test('R-MIN-06: the mock is stateful (a create is read back), honours a declared Idempotency-Key, and records every request with its step', async () => {
  const m = new Mock(buildModel(SPEC, JSON.stringify(SPEC)));
  const url = await m.listen();
  try {
    m.step = 's1';
    const c = await http(`${url}/things`, 'POST', { name: 'a' }, { 'idempotency-key': 'k1' });
    assert.equal(c.status, 201);
    const id = (c.body as { thing: { id: string } }).thing.id;
    assert.match(id, /^TH-[0-9]+$/);
    const g = await http(`${url}/things/${id}`, 'GET');
    assert.equal((g.body as { thing: { name: string } }).thing.name, 'a');
    assert.equal(g.headers['etag'], '"1"');
    const again = await http(`${url}/things`, 'POST', { name: 'a' }, { 'idempotency-key': 'k1' });
    assert.equal((again.body as { thing: { id: string } }).thing.id, id, 'the same key and body replays');
    assert.equal(m.objects('/things').length, 1);
    const other = await http(`${url}/things`, 'POST', { name: 'b' }, { 'idempotency-key': 'k1' });
    assert.equal(other.status, 422);
    assert.equal((other.body as { error: string }).error, 'key_reused', 'the code is read from the parameter description');
    const p = await http(`${url}/things/${id}`, 'PATCH', { name: 'z' }, { 'if-match': '"1"' });
    assert.equal((p.body as { thing: { version: number } }).thing.version, 2);
    assert.deepEqual((p.body as { changed: string[] }).changed, ['name']);
    assert.equal(m.records.length, 5);
    assert.ok(m.records.every((r) => r.step === 's1'));
    assert.equal(m.records.filter((r) => r.applied).length, 2, 'a replay and a refusal applied nothing');
  } finally {
    await m.close();
  }
});

test('R-MIN-07: the mock injects a fault on the named request only (the second mutating one), deterministically, and records it', async () => {
  const m = new Mock(buildModel(SPEC, JSON.stringify(SPEC)));
  const url = await m.listen();
  try {
    m.arm({ id: 'F-test', mutating: true, nth: 2, fault: { kind: 'status', status: 503, code: 'unavailable' } });
    await http(`${url}/things`, 'GET');
    const a = await http(`${url}/things`, 'POST', { name: 'a' });
    const b = await http(`${url}/things`, 'POST', { name: 'b' });
    const c = await http(`${url}/things`, 'POST', { name: 'c' });
    assert.deepEqual([a.status, b.status, c.status], [201, 503, 201]);
    assert.deepEqual(m.injected.map((f) => [f.id, f.seq, f.status]), [['F-test', 3, 503]]);
    m.arm({ id: 'F-lost', mutating: true, nth: 1, fault: { kind: 'apply_then_drop' } });
    const d = await http(`${url}/things`, 'POST', { name: 'd' });
    assert.equal(d.status, null, 'the answer was cut');
    assert.equal(m.objects('/things').filter((o) => o['name'] === 'd').length, 1, 'and the write was applied');
    const id = String(m.objects('/things')[0]!['id']);
    m.arm({ id: 'F-conflict', mutating: true, nth: 1, fault: { kind: 'conflict' } });
    const e = await http(`${url}/things/${id}`, 'PATCH', { name: 'q' }, { 'if-match': '"1"' });
    assert.equal(e.status, 412);
    assert.equal((e.body as { current: { id: string } }).current.id, id, 'the conflict body carries the current object');
  } finally {
    await m.close();
  }
});

test('R-MIN-07: the schedule is deterministic: the same fault on the same named request gives the same answers on a second run', async () => {
  const run = async () => {
    const m = new Mock(buildModel(SPEC, JSON.stringify(SPEC)));
    const url = await m.listen();
    m.arm({ id: 'F', mutating: true, nth: 3, fault: { kind: 'status', status: 422, code: 'validation' } });
    const st: (number | null)[] = [];
    for (let i = 0; i < 5; i++) st.push((await http(`${url}/things`, 'POST', { name: `n${i}` })).status);
    await m.close();
    return st;
  };
  assert.deepEqual(await run(), await run());
  assert.deepEqual(await run(), [201, 201, 422, 201, 201]);
});

test('R-MIN-08: the plan is accepted by rule only when every target is the mock; any other URL refuses it and every requirement is not tested (target_not_standin)', async () => {
  const ok = serverEnv({ mockUrl: 'http://127.0.0.1:5', baseUrlEnv: ['API_URL'], envNames: ['API_TOKEN', 'API_HOST', 'REGION'], set: {}, base: {} });
  assert.equal(ok.env['API_URL'], 'http://127.0.0.1:5');
  assert.equal(ok.env['API_HOST'], 'http://127.0.0.1:5');
  assert.match(ok.env['API_TOKEN']!, /^mwsmin-canary-[0-9a-f]{24}$/);
  assert.deepEqual(ok.canaries, [ok.env['API_TOKEN']]);
  assert.equal(ok.env['REGION'], 'mwsmin-dummy');
  assert.deepEqual(ok.refused, []);
  const bad = serverEnv({ mockUrl: 'http://127.0.0.1:5', baseUrlEnv: ['API_URL'], envNames: [], set: { OTHER_URL: 'https://api.example.com/v1' }, base: {} });
  assert.equal(bad.refused.length, 1);
  const dir = mkdtempSync(join(tmpdir(), 'min-plan-'));
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, JSON.stringify(SPEC));
  const doc = await runMin({ spec, server: { command: process.execPath, args: ['-e', 'process.exit(9)'], env: {} }, baseUrlEnv: ['API_URL'], set: { OTHER_URL: 'https://api.example.com/v1' } });
  assert.equal(doc.run.status, 'refused');
  assert.equal(doc.plan.accepted, false);
  assert.ok(doc.results.filter((r) => !['not_testable_mock'].includes(r.status ?? '')).every((r) => r.verdict === 'not tested' && r.reason_code === 'target_not_standin'));
  const none = await runMin({ spec, server: { command: process.execPath, args: ['-e', 'process.exit(9)'], env: {} }, baseUrlEnv: [] });
  assert.equal(none.run.status, 'refused', 'with no base URL pointed at the mock the backend is not known to be the mock');
});

test('R-MIN-09: a server that does not start against the mock (a token checked at start) is not tested, never the server\'s violation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'min-start-'));
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, JSON.stringify(SPEC));
  const doc = await runMin({ spec, server: { command: process.execPath, args: ['-e', 'console.error("invalid API token"); process.exit(1)'], env: {} }, baseUrlEnv: ['API_URL'], envNames: ['API_TOKEN'] });
  assert.equal(doc.run.status, 'server_did_not_start');
  assert.ok(doc.results.every((r) => r.verdict === 'not tested'));
  assert.ok(doc.results.some((r) => r.reason_code === 'start_requires_credentials'));
});

const CRASHY = `
const rl = require('readline').createInterface({ input: process.stdin });
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') say({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'crashy', version: '1' } } });
  else if (m.method === 'tools/list') say({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'create_thing', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, annotations: { readOnlyHint: false, destructiveHint: false } }] } });
  else if (m.method === 'tools/call') process.exit(3);
  else if (m.id !== undefined) say({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});`;

test('R-MIN-10: a server that exits on the mock\'s reply is not tested (our limit), and no violation is recorded against it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'min-crash-'));
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, JSON.stringify(SPEC));
  writeFileSync(join(dir, 'crashy.cjs'), CRASHY);
  const doc = await runMin({ spec, server: { command: process.execPath, args: [join(dir, 'crashy.cjs')], env: {} }, baseUrlEnv: ['API_URL'], timeoutMs: 3000 });
  assert.equal(doc.run.status, 'complete');
  assert.deepEqual(doc.results.filter((r) => r.verdict === 'violated' && r.requirement !== 'MWS-ANN-4'), []);
  assert.ok(doc.notes.some((n) => /exited during the call/.test(n)));
});

test('R-MIN-12: a declaration member marked "# guessed" is ignored (min mode never judges on a guessed field)', () => {
  const d = parseDeclaration(['patterns:', '  write_failed: "failed" # guessed', '  not_used: "not used"', 'settings:', '  read_only: { env: RO, on: "true" } # guessed', 'results: { shape: write-result/0.1 }'].join('\n'));
  assert.equal(d.patterns['write_failed'], undefined);
  assert.ok(d.patterns['not_used']);
  assert.equal(d.readOnly, null);
  assert.equal(d.shape, 'write-result/0.1');
  assert.deepEqual(d.dropped.sort(), ['patterns.write_failed', 'settings.read_only']);
  // Mutation check: the same text without the marker gives both members.
  const m = parseDeclaration(['patterns:', '  write_failed: "failed"', 'settings:', '  read_only: { env: RO, on: "true" }'].join('\n'));
  assert.ok(m.patterns['write_failed'] && m.readOnly);
});

test('R-MIN-13: identifiers are made from the description\'s pattern (T-1234 for ^T-[0-9]+$), differ by seed, and match', () => {
  const a = fromPattern('^T-[0-9]+$', 7)!;
  const b = fromPattern('^T-[0-9]+$', 8)!;
  assert.match(a, /^T-[0-9]+$/);
  assert.notEqual(a, b);
  assert.match(fromPattern('^[a-z0-9][a-z0-9-]{0,62}$', 3)!, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.equal(fromPattern('^(a|b)$', 1), null, 'an alternation is not guessed at');
});
