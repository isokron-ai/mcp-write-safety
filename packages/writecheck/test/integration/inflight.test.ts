/**
 * The in-flight scenarios (src/checks/inflight.ts): the lost answer with the request held on its way (MWS-RES-1) and the
 * same-key call while the first is still being applied (MWS-RES-2), the two conditions tiny-tracker 0.4.0's
 * settle-miss-reported-not-applied and in-progress-reported-not-applied need (review B9 and B1). Each R-WC row of REGRESSIONS.md
 * is pinned here, with a mutation run beside each detection: with the forced schedule changed, the defect build reads clean,
 * so the schedule is what finds it.
 *
 * The judge and the gate's cut-and-hold are tested on their own; the rest runs against tiny-tracker when it is built
 * (examples/tiny-tracker/dist, or TINY_TRACKER_DIR), and is skipped otherwise, with the reason.
 *
 * The same-key scenario needs the first write held inside the backend: tiny-tracker's backend/before-commit/delay (armable since
 * R-TT-10), on the control listener of `tiny-tracker all --fixture-control`. Without the faults feature the listener answers the
 * arming 501 not_enabled, which is shown to give `not tested` with the target's own answer.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { INFLIGHT_SCENARIOS, INFLIGHT_SCHEDULE, inflightCheck, lostHeldVerdict, sameKeyVerdict, type LostHeldObs, type SameKeyObs } from '../../src/checks/inflight.js';
import { usePatterns } from '../../src/checks/says.js';
import { useShapes, type ShapeCapture } from '../../src/checks/shape.js';
import { wp, type CallBrief, type Tool } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { Forwarder } from '../../src/gate/forwarder.js';
import type { Result } from '../../src/report/verdicts.js';
import { manifestFor, runTT, startTinyTracker, tinyTrackerDir, TT_MANIFEST, type TT } from '../tiny-tracker/harness.js';

const dir = tinyTrackerDir();
const skip = dir ? false : 'tiny-tracker is not built here (examples/tiny-tracker/dist or TINY_TRACKER_DIR)';
const SHIPPED = parseManifestText(readFileSync(TT_MANIFEST, 'utf8'), 'writecheck.yaml');
const TOOLS = ['create_ticket', 'get_ticket', 'list_tickets', 'create_project', 'list_projects', 'delete_project', 'delete_ticket'].map((name) => ({ name, inputSchema: { type: 'object' }, annotations: {} })) as unknown as Tool[];
const W = wp('ticket', 'create_ticket');

const violatedIds = (rs: Result[]) => [...new Set(rs.filter((r) => r.verdict === 'violated').map((r) => r.requirement))].sort();
const rec = (rs: Result[], scenario: string, tool = 'create_ticket') => rs.find((r) => r.scenario.id === scenario && r.write_path.tool === tool);

afterEach(() => {
  usePatterns(null);
  INFLIGHT_SCHEDULE.mutation = null;
});

// ---------------------------------------------------------------- the judge, on its own

const S = (o: Record<string, unknown>): ShapeCapture => ({ sc: { shape: 'write-result/0.1', ...o }, texts: [{ shape: 'write-result/0.1', ...o }] });
const call = (o: Partial<CallBrief> = {}): CallBrief => ({ step: 'c1', ok: false, isError: true, rpc_error: null, text: '', data: null, indeterminate: false, tool: 'create_ticket', carried: { key: true }, ...o });
const trace = (ids: unknown[]) => ({ step: 't1', ok: true, count: ids.length, ids });
const lost = (o: Partial<LostHeldObs>): LostHeldObs => ({ routing: 'gate', learned: { method: 'POST', path: '/tickets', nth: 1, requests: [{ seq: 1, method: 'POST', path: '/tickets', status: 201 }] }, key: 'k1', before: trace([]), call: null, held: { seq: 2, method: 'POST', path: '/tickets', status: null }, landed: 201, requests: [], after: trace([]), ...o });
const same = (o: Partial<SameKeyObs>): SameKeyObs => ({ hold: 'fixture-api/1', key: 'k2', before: trace([]), armed: { status: 201, id: 'F-1' }, first: { ...call({ ok: true, isError: false, step: 'c0' }), t_end_ms: 2 }, second: null, overlapped: true, after: trace(['T-1']), ...o });
const NOT_APPLIED = S({ outcome: 'not_applied', repeat: 'no', code: 'not_found' });
const UNKNOWN = S({ outcome: 'unknown', repeat: 'same_key', code: 'no_answer' });

function useTT(): void {
  usePatterns(SHIPPED);
  useShapes(SHIPPED, TOOLS);
}

test('R-WC-01: the lost-held judge: an answer that says not applied, then the held request creates the object, is MWS-RES-1 violated', () => {
  useTT();
  const r = lostHeldVerdict(lost({ call: call({ text: 'The answer was lost and the backend has no write with this key; nothing was written.', shape: NOT_APPLIED }), after: trace(['T-9']) }), W);
  assert.equal(r.requirement, 'MWS-RES-1');
  assert.equal(r.scenario.id, INFLIGHT_SCENARIOS.lostHeld);
  assert.equal(r.verdict, 'violated', r.reason);
  assert.match(r.reason, /T-9/);
  assert.deepEqual(r.steps, ['c1', 't1'], 'a violated record names its steps');
});

test('R-WC-01: mutation of the judge: the same answer where the held request created nothing (a fence closed the key) is held', () => {
  useTT();
  const r = lostHeldVerdict(lost({ call: call({ text: 'nothing was written, and the key is now closed', shape: S({ outcome: 'not_applied', repeat: 'no', code: 'key_fenced' }) }), landed: 409, after: trace([]) }), W);
  assert.equal(r.verdict, 'held', r.reason);
});

test('R-WC-03: the lost-held judge: an answer that says the outcome is not known holds whatever the held request did', () => {
  useTT();
  const r = lostHeldVerdict(lost({ call: call({ text: 'The connection to the backend broke; it is not known whether the ticket was created.', shape: UNKNOWN }), after: trace(['T-3']) }), W);
  assert.equal(r.verdict, 'held', r.reason);
});

test('R-WC-04: the lost-held judge never blames the target for the tester\'s own limitation', () => {
  useTT();
  const said = call({ text: 'nothing was written', shape: NOT_APPLIED });
  const cases: [string, Partial<LostHeldObs>][] = [
    ['no gate route that can cut and hold', { skipped: 'the gate route node_import cannot close the server\'s connection and keep its request back' }],
    ['the hold did not apply', { skipped: 'the hold was not applied', held: null }],
    ['the backend gave no answer to the released request', { call: said, landed: null, after: trace(['T-1']) }],
    ['the trace failed', { call: said, after: { step: 't1', ok: false, count: null, ids: [], reason: 'list failed' } }],
    ['the call itself was lost', { call: call({ indeterminate: true }), after: trace(['T-1']) }],
  ];
  for (const [what, o] of cases) assert.equal(lostHeldVerdict(lost(o), W).verdict, 'not tested', what);
});

test('R-WC-02: the same-key judge: a second answer that says not applied while the keyed write is in effect is MWS-RES-2 violated', () => {
  useTT();
  const r = sameKeyVerdict(same({ second: { ...call({ step: 'c2', text: 'Another call with this idempotency_key is running; nothing was written.', shape: NOT_APPLIED }), t_end_ms: 1 } }), W);
  assert.equal(r.requirement, 'MWS-RES-2');
  assert.equal(r.scenario.id, INFLIGHT_SCENARIOS.sameKey);
  assert.equal(r.verdict, 'violated', r.reason);
  assert.deepEqual(r.steps, ['c0', 'c2', 't1']);
});

test('R-WC-03: the same-key judge: "still in progress, repeat with the same key" (outcome unknown) holds', () => {
  useTT();
  const r = sameKeyVerdict(same({ second: { ...call({ step: 'c2', text: 'An earlier call with this idempotency_key is still being applied; this call wrote nothing. Repeat it later with the same idempotency_key to get its result.', shape: S({ outcome: 'unknown', repeat: 'same_key', code: 'in_progress' }) }), t_end_ms: 1 } }), W);
  assert.equal(r.verdict, 'held', r.reason);
});

/**
 * The B-9 reading on a concrete example, for the owner to check the rule against. A server whose intent is right (the second
 * call itself wrote nothing) answers the same-key call while the first is in flight with "conflict, nothing written" and
 * `outcome: "not_applied"`, `code: "conflict"`; the first write lands afterwards. Annex B-9 ("A repeat with a key"): on a call that
 * carried an idempotency key, `outcome` and `code` are statements about the write the key identifies, not about this call. That
 * write is in effect afterwards, so `not_applied` misstates it: MWS-RES-2 `violated` (second clause), although the server's own
 * meaning was true of the second call. The form B-9 gives for this case is `outcome: "unknown"`, `code: "in_progress"`,
 * `repeat: "same_key"` (held, the test above). Where the first write never lands, nothing contradicts the answer: not tested.
 */
test('R-WC-03: B-9 reading, a concrete example: "conflict, nothing written" (not_applied) for a same-key call while the first is in flight is violated once the first lands, not tested if it never does', () => {
  useTT();
  const conflict = { ...call({ step: 'c2', text: 'Conflict: another request with this idempotency_key is being processed. Nothing was written by this call.', shape: S({ outcome: 'not_applied', repeat: 'no', code: 'conflict' }) }), t_end_ms: 1 };
  const landed = sameKeyVerdict(same({ second: conflict, after: trace(['T-7']) }), W);
  assert.equal(landed.verdict, 'violated', landed.reason);
  assert.match(landed.reason, /not_applied/);
  const never = sameKeyVerdict(same({ second: conflict, first: { ...call({ step: 'c0' }), t_end_ms: 2 }, after: trace([]) }), W);
  assert.equal(never.verdict, 'not tested', never.reason);
});

test('R-WC-04: the same-key judge: no hold, a refused or unfired hold, or no keyed write is not tested, never a verdict', () => {
  useTT();
  const said = { ...call({ step: 'c2', text: 'nothing was written', shape: NOT_APPLIED }), t_end_ms: 1 };
  const cases: [string, Partial<SameKeyObs>][] = [
    ['the control is not reachable', { skipped: 'TRACKER_CONTROL_URL is not set', armed: null, first: null }],
    ['the control refused the arming', { skipped: 'the target answered 501', armed: { status: 501, id: null }, first: null }],
    ['the hold did not fire', { skipped: 'the hold did not fire' }],
    ['no keyed write in effect afterwards', { second: said, after: trace([]) }],
  ];
  for (const [what, o] of cases) assert.equal(sameKeyVerdict(same(o), W).verdict, 'not tested', what);
});

test('R-WC-04: plan: without a gate, with the in-process hook route, and without a declared in-flight hold, each scenario is not tested with the reason', () => {
  const ticket = (m: typeof SHIPPED) => inflightCheck.plan({ manifest: m, tools: TOOLS }, m.resources.find((r) => r.name === 'ticket')!);
  const shipped = ticket(SHIPPED);
  assert.equal(shipped.runs, true);
  assert.equal(shipped.notRun.length, 0, 'the shipped manifest declares both');
  const bare = ticket({ ...SHIPPED, backend: null });
  assert.equal(bare.runs, false);
  assert.deepEqual(bare.notRun.map((r) => `${r.requirement} ${r.scenario.id} ${r.verdict}`), ['MWS-RES-1 inflight.lost-held not tested', 'MWS-RES-2 inflight.same-key not tested']);
  assert.match(bare.notRun[0]!.reason, /backend\.gate.*not a finding about the server/);
  assert.match(bare.notRun[1]!.reason, /backend\.inflight_hold.*not a finding about the server/);
  const hook = ticket({ ...SHIPPED, backend: { gate: { rewrite_env: null, node_import: true, hold_timeout_ms: 5000 } } });
  assert.match(hook.notRun.find((r) => r.requirement === 'MWS-RES-1')!.reason, /in-process hook route.*limitation of the tester/);
});

test('R-WC-04: backend.inflight_hold names fixture-api/1 only, and its token is a secret of the run', async () => {
  const m = (h: string) => parseManifestText(readFileSync(TT_MANIFEST, 'utf8').replace(/  inflight_hold: .*$/m, `  inflight_hold: ${h}`), 'm.yaml');
  assert.deepEqual(SHIPPED.backend?.inflight_hold, { fixture: 'fixture-api/1', control_env: 'TRACKER_CONTROL_URL', token_env: 'TRACKER_CONTROL_TOKEN', hold_ms: 3000 });
  assert.throws(() => m('{ fixture: other/1, control_env: A, token_env: B }'), /fixture-api\/1/);
  assert.throws(() => m('{ fixture: fixture-api/1, control_env: A, token_env: B, extra: 1 }'), /extra/);
  const { secretsOf, egressOf } = await import('../../src/cli/run.js');
  const token = 'control-token-0123456789';
  assert.ok(secretsOf(SHIPPED, { TRACKER_CONTROL_TOKEN: token }).includes(token));
  assert.ok(egressOf(SHIPPED, { TRACKER_CONTROL_URL: 'http://127.0.0.1:4664' }).allow.includes('127.0.0.1:4664'));
});

// ---------------------------------------------------------------- the gate's cut-and-hold

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

function post(port: number, path: string): Promise<{ status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? null, error: null }));
    });
    r.on('error', (e) => resolve({ status: null, error: (e as NodeJS.ErrnoException).code ?? e.message }));
    r.end('{"title":"x"}');
  });
}

test('R-WC-05: the forwarder cuts the server\'s connection at once, keeps the request back, and sends it on only when released', async () => {
  const seen: string[] = [];
  const backend = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => res.writeHead(201, { 'content-type': 'application/json' }).end('{}'));
  });
  const bport = await listen(backend);
  const gate = new Forwarder('X', `http://127.0.0.1:${bport}`, { allow: [] }, 5000);
  await gate.start();
  try {
    const gport = Number(new URL(gate.serverEnv()['X']!).port);
    const h = gate.dropAndHold({ method: 'POST', path: '/tickets', nth: 1 });
    const r = await post(gport, '/tickets');
    assert.equal(r.status, null, 'the server heard no answer');
    assert.ok(r.error, 'its connection was closed');
    assert.ok(await h.waitHeld(1000), 'the request is held');
    assert.deepEqual(seen, [], 'the backend has not seen it');
    await h.release();
    assert.equal(await h.landed(2000), 201, 'released, it lands');
    assert.deepEqual(seen, ['POST /tickets']);
    // A second request is not held (the hold took the first match only).
    assert.equal((await post(gport, '/tickets')).status, 201);
  } finally {
    await gate.stop();
    backend.close();
  }
});

test('R-WC-05: mutation: a request taken off the wire is never dropped silently: clearing the gate sends it on', async () => {
  let landed = 0;
  const backend = createHttpServer((req, res) => {
    landed++;
    req.resume();
    req.on('end', () => res.writeHead(201).end());
  });
  const bport = await listen(backend);
  const gate = new Forwarder('X', `http://127.0.0.1:${bport}`, { allow: [] }, 5000);
  await gate.start();
  try {
    const h = gate.dropAndHold({ method: 'POST', path: '/tickets', nth: 1 });
    await post(Number(new URL(gate.serverEnv()['X']!).port), '/tickets');
    assert.ok(await h.waitHeld(1000));
    gate.clear();
    assert.equal(await h.landed(2000), 201);
    assert.equal(landed, 1);
  } finally {
    await gate.stop();
    backend.close();
  }
});

// ---------------------------------------------------------------- against tiny-tracker, the matrix layout (backend and server apart, through the gate)

async function run(o: Parameters<typeof startTinyTracker>[1]): Promise<Result[]> {
  const t = await startTinyTracker(dir!, { pairs: 4, gateReps: 1, ...o });
  try {
    const r = await runTT(t);
    assert.deepEqual(r.doc.leftovers, [], 'nothing left behind (the late ticket the held request made is cleaned up)');
    return r.doc.results;
  } finally {
    await t.close();
  }
}

test('R-WC-01: --defect settle-miss-reported-not-applied: the lost answer with the request held is MWS-RES-1 violated, and nothing else is', { skip }, async () => {
  const rs = await run({ defects: ['settle-miss-reported-not-applied'] });
  const r = rec(rs, INFLIGHT_SCENARIOS.lostHeld)!;
  assert.equal(r.verdict, 'violated', r.reason);
  assert.equal(r.requirement, 'MWS-RES-1');
  assert.match(r.reason, /nothing was written/);
  assert.ok(r.steps.length >= 2);
  assert.deepEqual(violatedIds(rs), ['MWS-RES-1']);
  assert.equal(rec(rs, INFLIGHT_SCENARIOS.lostHeld, 'create_project')?.verdict, 'held', 'the defect is in create_ticket only');
});

test('R-WC-01: mutation: the same build with the held request released before the server answers reads held (the hold is what finds it)', { skip }, async () => {
  INFLIGHT_SCHEDULE.mutation = 'release-before-answer';
  const rs = await run({ defects: ['settle-miss-reported-not-applied'] });
  const r = rec(rs, INFLIGHT_SCENARIOS.lostHeld)!;
  // why: released first, the request lands before the server's lookup, which then finds the write: a success, in effect.
  assert.equal(r.verdict, 'held', r.reason);
  assert.ok(!rs.some((x) => x.scenario.id.startsWith('inflight.') && x.verdict === 'violated'));
});

test('R-WC-03: correct build (the release default profile, as the defect matrix runs it): lost-held held, same-key not tested with the reason, nothing violated', { skip }, async () => {
  const rs = await run({});
  assert.deepEqual(violatedIds(rs), []);
  for (const tool of ['create_ticket', 'create_project']) {
    const l = rec(rs, INFLIGHT_SCENARIOS.lostHeld, tool)!;
    assert.equal(l.verdict, 'held', `${tool}: ${l.reason}`);
    const s = rec(rs, INFLIGHT_SCENARIOS.sameKey, tool)!;
    assert.equal(s.verdict, 'not tested', `${tool}: ${s.reason}`);
    assert.match(s.reason, /TRACKER_CONTROL_URL is not set/);
  }
});

test('R-WC-03: correct variant settle-by-lookup (a lookup behind a fence): the held request is refused when it lands; lost-held held, nothing violated', { skip }, async () => {
  const rs = await run({ variants: ['settle-by-lookup'] });
  assert.deepEqual(violatedIds(rs), []);
  const l = rec(rs, INFLIGHT_SCENARIOS.lostHeld)!;
  assert.equal(l.verdict, 'held', l.reason);
  assert.match(l.notes.join(' '), /answered it 409/, 'the fence refused the late request');
});

test('R-WC-03: correct variant key-store-honest (keys kept by the server, no backend key): lost-held held, nothing violated', { skip }, async () => {
  const noBackendKey = (text: string) => {
    const out = text.replace(/(title: "\{\{marker\}\}" \}, key: \{ arg: idempotency_key \}, replay_marker: replayed), backend_key: true/, '$1');
    assert.notEqual(out, text, 'the edit removed backend_key: true from the ticket idempotency block (the shipped manifest did not drift)');
    return out;
  };
  const rs = await run({ variants: ['key-store-honest'], edit: noBackendKey });
  assert.deepEqual(violatedIds(rs), []);
  assert.equal(rec(rs, INFLIGHT_SCENARIOS.lostHeld)!.verdict, 'held', rec(rs, INFLIGHT_SCENARIOS.lostHeld)!.reason);
});

test('R-WC-06: --defect in-progress-reported-not-applied in the matrix layout: same-key not tested with the reason (no hold inside the backend), never held', { skip }, async () => {
  const rs = await run({ defects: ['in-progress-reported-not-applied'] });
  const s = rec(rs, INFLIGHT_SCENARIOS.sameKey)!;
  assert.equal(s.verdict, 'not tested');
  assert.match(s.reason, /TRACKER_CONTROL_URL is not set/);
  assert.deepEqual(violatedIds(rs), []);
});

test('R-WC-04: the in-process hook route cannot cut and hold: lost-held is not tested, naming the tester\'s limitation', { skip }, async () => {
  const rs = await run({ defects: ['settle-miss-reported-not-applied'], gate: 'node_import' });
  const r = rec(rs, INFLIGHT_SCENARIOS.lostHeld)!;
  assert.equal(r.verdict, 'not tested');
  assert.match(r.reason, /in-process hook route.*limitation of the tester/);
});

// ---------------------------------------------------------------- against tiny-tracker all --fixture-control (the in-flight hold)

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/**
 * `tiny-tracker all --fixture-control`, its backend and control listener on fixed loopback ports the tester knows (no gate: the
 * hold is the target's own). `faults`: whether the faults feature is on (without it the control listener refuses the arming).
 * The manifest keeps one server process: no restart step and no launch settings, whose second process would want the same ports.
 */
async function startAll(o: { defects?: string[]; faults: boolean }): Promise<TT> {
  const [bport, cport] = [await freePort(), await freePort()];
  const work = mkdtempSync(join(tmpdir(), 'mwsc-ttall-'));
  const features = o.faults ? 'evidence,strict-input,ledger,faults' : 'evidence,strict-input,ledger';
  const edit = (text: string) => {
    const x = text
      .replace(/command: \[node, dist\/src\/cli\.js, server, --port, "0"\]/, `command: [node, dist/src/cli.js, all, --port, "0", --backend-port, "${bport}", --fixture-control, --control-port, "${cport}", --features, "${features}"]`)
      .replace('env_passthrough: [TRACKER_BACKEND_TOKEN]', 'env_passthrough: [TRACKER_BACKEND_TOKEN, TRACKER_CONTROL_TOKEN, TRACKER_EVIDENCE_TOKEN]')
      .replace('env_public: [TRACKER_BACKEND_URL, TRACKER_DEFECTS, TRACKER_VARIANTS, TRACKER_KEY_JOURNAL]', 'env_public: [TRACKER_DEFECTS]')
      .replace(/^  restart: .*$/m, '')
      .replace(/^  gate: \{ rewrite_env: TRACKER_BACKEND_URL \}$/m, '')
      .replace(/\nsettings:\n(  .*\n)+?(  tool_filters:\n(    - .*\n)+)/, '\n');
    assert.ok(x.includes('--fixture-control') && !/^settings:/m.test(x) && !/rewrite_env/.test(x), 'the manifest was edited for the all layout');
    return x;
  };
  const manifest = join(work, 'writecheck.yaml');
  writeFileSync(manifest, manifestFor(dir!, { pairs: 4, gateReps: 1, extra: edit }));
  const tok = () => randomBytes(12).toString('hex');
  return {
    backend: null as never,
    url: `http://127.0.0.1:${bport}`,
    dir: work,
    manifest,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TRACKER_BACKEND_URL: `http://127.0.0.1:${bport}`, TRACKER_BACKEND_TOKEN: `tt-b-${tok()}`, TRACKER_CONTROL_TOKEN: `tt-c-${tok()}`, TRACKER_EVIDENCE_TOKEN: `tt-e-${tok()}`, TRACKER_CONTROL_URL: `http://127.0.0.1:${cport}`, ...(o.defects?.length ? { TRACKER_DEFECTS: o.defects.join(',') } : {}) },
    async close() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}

async function runAll(o: { defects?: string[]; faults: boolean }): Promise<Result[]> {
  const t = await startAll(o);
  try {
    const r = await runTT(t);
    assert.deepEqual(r.doc.leftovers, []);
    return r.doc.results;
  } finally {
    await t.close();
  }
}

test('R-WC-02: with the in-flight hold (all --fixture-control, faults), --defect in-progress-reported-not-applied: the same-key call is MWS-RES-2 violated', { skip }, async () => {
  const rs = await runAll({ defects: ['in-progress-reported-not-applied'], faults: true });
  const s = rec(rs, INFLIGHT_SCENARIOS.sameKey)!;
  assert.equal(s.verdict, 'violated', s.reason);
  assert.match(s.reason, /nothing was written/);
  assert.ok(s.steps.length >= 3);
  assert.equal(rec(rs, INFLIGHT_SCENARIOS.sameKey, 'create_project')?.verdict, 'held', 'the defect is in create_ticket only');
  assert.equal(rec(rs, INFLIGHT_SCENARIOS.lostHeld)?.verdict, 'not tested', 'no gate in this layout');
});

test('R-WC-02: mutation: the same build with the second call sent after the first has answered reads held (the overlap is what finds it)', { skip }, async () => {
  INFLIGHT_SCHEDULE.mutation = 'second-after-first';
  const rs = await runAll({ defects: ['in-progress-reported-not-applied'], faults: true });
  const s = rec(rs, INFLIGHT_SCENARIOS.sameKey)!;
  assert.equal(s.verdict, 'held', s.reason);
});

test('R-WC-03: with the in-flight hold (all --fixture-control, faults), the correct build: the same-key call answers in progress, held; no in-flight record violated', { skip }, async () => {
  const rs = await runAll({ faults: true });
  for (const tool of ['create_ticket', 'create_project']) {
    const s = rec(rs, INFLIGHT_SCENARIOS.sameKey, tool)!;
    assert.equal(s.verdict, 'held', `${tool}: ${s.reason}`);
    assert.match(s.notes.join(' '), /answered before the first/, `${tool}: the second call met the first in flight`);
  }
  assert.ok(!rs.some((x) => x.scenario.id.startsWith('inflight.') && x.verdict === 'violated'));
});

test('R-WC-04: a control listener without the faults feature answers the arming 501 not_enabled: same-key is not tested, quoting the target, never violated', { skip }, async () => {
  const rs = await runAll({ defects: ['in-progress-reported-not-applied'], faults: false });
  const s = rec(rs, INFLIGHT_SCENARIOS.sameKey)!;
  assert.equal(s.verdict, 'not tested');
  assert.match(s.reason, /501 .*not_enabled/);
});
