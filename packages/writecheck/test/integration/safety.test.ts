/**
 * The seat belts on a live (fake) target: refusals before any write, the tenant guard, the write
 * budget, the open-ledger refusal, cleanup after a kill and after SIGINT, and an HTTP target.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupCommand, planCommand, rerunCommand, reviewCommand } from '../../src/cli/commands.js';
import { runCommand } from '../../src/cli/run.js';
import { NO_CAPTURE } from '../../src/core/capture.js';
import { egressFor } from '../../src/core/egress.js';
import { Ledger, openRuns } from '../../src/core/ledger.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { Redactor } from '../../src/core/redact.js';
import { Session } from '../../src/core/session.js';
import { WritecheckError } from '../../src/core/util.js';
import { fakeManifest, startFake, type Fake } from '../fake/harness.js';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'main.js');
const quiet = () => {};
const refused = (e: unknown) => e instanceof WritecheckError && e.code === 3;

async function hashOf(f: Fake): Promise<string> {
  return (await planCommand({ manifest: f.manifest, env: f.env, log: quiet })).hash;
}
const base = (f: Fake) => ({ manifest: f.manifest, outRoot: join(f.dir, 'out'), stateDir: join(f.dir, 'state'), interactive: false, env: f.env, log: quiet, noSignals: true });

test('a wrong target, a wrong plan hash, or no confirmation at all: refused before any write', async () => {
  const f = await startFake();
  try {
    const hash = await hashOf(f);
    await assert.rejects(runCommand({ ...base(f), confirmTarget: 'other', planHash: hash }), refused);
    await assert.rejects(runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: '0000000000000000' }), refused);
    await assert.rejects(runCommand({ ...base(f) }), /there is no --yes/);
    assert.equal(f.backend.tickets.size, 0);
    assert.ok(!existsSync(join(f.dir, 'state')) || readdirSync(join(f.dir, 'state')).filter((d) => d !== 'throttle').length === 0, 'no ledger: nothing was attempted');
  } finally {
    await f.close();
  }
});

test('the tenant guard must match before the first write', async () => {
  const f = await startFake({ tenant: 'production-tenant' });
  try {
    await assert.rejects(runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) }), /does not match/);
    assert.equal(f.backend.tickets.size, 0);
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
  } finally {
    await f.close();
  }
});

test('the write budget stops the run, what was not run is not tested, and cleanup still runs', async () => {
  const f = await startFake({ extra: '' });
  try {
    writeFileSync(f.manifest, fakeManifest().replace('write_budget: 20000', 'write_budget: 40'));
    const r = await runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) });
    assert.equal(r.doc.run.status, 'stopped');
    assert.match(r.doc.run.stopped_reason ?? '', /write budget of 40/);
    assert.equal(r.exit, 4);
    assert.ok(r.doc.run.writes <= 40);
    assert.ok(r.doc.results.some((x) => x.verdict === 'not tested' && /stopped/.test(x.reason)));
    assert.equal(f.backend.tickets.size, 0);
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
  } finally {
    await f.close();
  }
});

async function untilCreated(stateDir: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(stateDir))
      for (const d of readdirSync(stateDir)) {
        const l = join(stateDir, d, 'ledger.jsonl');
        if (existsSync(l) && readFileSync(l, 'utf8').split('\n').filter((x) => x.includes('"created"')).length >= 2) return;
      }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the run did not create its objects in time');
}

function spawnRun(f: Fake, hash: string, stdout: 'ignore' | 'pipe' = 'ignore') {
  return spawn(process.execPath, [MAIN, 'run', '-m', f.manifest, '--confirm-target', 'fake-tracker', '--plan-hash', hash, '--out', join(f.dir, 'out'), '--state', join(f.dir, 'state')], { env: f.env, stdio: ['ignore', stdout, 'pipe'] });
}

test('killed mid-run (SIGKILL): the ledger says what exists, the next run refuses, cleanup removes it', async () => {
  const f = await startFake({ pairs: 30 });
  try {
    const child = spawnRun(f, await hashOf(f));
    const exited = new Promise((r) => child.once('exit', r));
    await untilCreated(join(f.dir, 'state'));
    child.kill('SIGKILL');
    await exited;
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(f.backend.tickets.size >= 1, 'the kill left objects behind');
    assert.equal(openRuns(join(f.dir, 'state')).length, 1);
    await assert.rejects(runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) }), /open ledger entries/);
    const c = await cleanupCommand({ manifest: f.manifest, stateDir: join(f.dir, 'state'), confirmTarget: 'fake-tracker', env: f.env, log: quiet });
    assert.equal(c.exit, 0);
    assert.equal(f.backend.tickets.size, 0, 'cleanup by ledger (and the prefix sweep) removed everything');
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
  } finally {
    await f.close();
  }
});

test('interrupted (SIGINT): the run cleans up its objects before it exits', async () => {
  const f = await startFake({ pairs: 30 });
  try {
    const child = spawnRun(f, await hashOf(f));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    await untilCreated(join(f.dir, 'state'));
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    assert.equal(f.backend.tickets.size, 0);
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
  } finally {
    await f.close();
  }
});

test('GitHub Action review B1: a CI cancel (SIGINT, then SIGTERM, with stdout closed) still cleans up before exit', async () => {
  const f = await startFake({ pairs: 30 });
  try {
    const child = spawnRun(f, await hashOf(f), 'pipe');
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    await untilCreated(join(f.dir, 'state'));
    child.stdout!.destroy();
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 150));
    child.kill('SIGTERM');
    assert.equal(await exited, 130);
    assert.equal(f.backend.tickets.size, 0, 'the clean-up ran although SIGTERM followed');
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
  } finally {
    await f.close();
  }
});

test('review S4: a second SIGTERM after the first signal still forces the exit at once', async () => {
  const f = await startFake({ pairs: 30 });
  try {
    const child = spawnRun(f, await hashOf(f));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    await untilCreated(join(f.dir, 'state'));
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    child.kill('SIGTERM');
    assert.equal(await exited, 130);
    assert.ok(Date.now() - t0 < 4000, 'the second SIGTERM exits without waiting for the forced clean-up');
    await cleanupCommand({ manifest: f.manifest, stateDir: join(f.dir, 'state'), confirmTarget: 'fake-tracker', env: f.env, log: quiet });
  } finally {
    await f.close();
  }
});

test('cleanup --abandon records leftovers without touching the server', async () => {
  const f = await startFake({ pairs: 30 });
  try {
    const child = spawnRun(f, await hashOf(f));
    const exited = new Promise((r) => child.once('exit', r));
    await untilCreated(join(f.dir, 'state'));
    child.kill('SIGKILL');
    await exited;
    const before = f.backend.tickets.size;
    const c = await cleanupCommand({ manifest: f.manifest, stateDir: join(f.dir, 'state'), abandon: true, env: f.env, log: quiet });
    assert.ok(c.reports[0]!.report.left.length >= 1);
    // review S5: --abandon leaves objects that may exist; when a create's outcome was unknown the exit says so (4), as `run` would.
    if (c.reports[0]!.report.unknown.length) assert.equal(c.exit, 4);
    assert.equal(f.backend.tickets.size, before);
    assert.deepEqual(openRuns(join(f.dir, 'state')), []);
    for (const t of [...f.backend.tickets.keys()]) f.backend.tickets.delete(t);
  } finally {
    await f.close();
  }
});

test('an HTTP target: initialize, tools/list and a call over streamable HTTP; other hosts are off the egress list', async () => {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST') return res.writeHead(200).end();
      const m = JSON.parse(body) as { id?: number; method: string };
      if (m.id === undefined) return res.writeHead(202).end();
      const result = m.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'h', version: '0' } } : m.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } : { content: [{ type: 'text', text: '{"tenant":"mwsc-test-x"}' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  try {
    const m = parseManifestText(`mws: "0.9"\nserver: { url: "${url}" }\ntarget: { environment: test, confirm: t }\nresources:\n  - name: r\n    fixture: { id: x, name: mwsc-x }\n    read: { tool: whoami, args: {} }\n    update: { tool: whoami, mode: field_patch, args: {} }\n    fields: [ { path: a, values: [x, y] }, { path: b, values: [x, y] } ]\n`, 'm.yaml');
    const s = new Session({ manifest: m, capture: NO_CAPTURE, redactor: new Redactor([]), egress: egressFor([url]), env: {}, write_budget: 10, min_interval_ms: 0 });
    const tools = await s.listTools('H');
    assert.deepEqual(tools.map((t) => t['name']), ['whoami']);
    const r = await s.call('H', 'whoami', {}, { write: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { tenant: 'mwsc-test-x' });
    await s.close();
    const other = new Session({ manifest: m, capture: NO_CAPTURE, redactor: new Redactor([]), egress: egressFor(['http://127.0.0.1:1/']), env: {}, write_budget: 10, min_interval_ms: 0 });
    await assert.rejects(other.listTools('H'), /egress|did not initialize/);
    await other.close();
  } finally {
    srv.close();
  }
});

test('a fixture that does not read back as the named object is never written to', async () => {
  const f = await startFake();
  try {
    f.backend.tickets.set('T900', { id: 'T900', title: 'customer-prod-ticket', status: 'open', assignee: 'carol', priority: 2, labels: [], version: 1, updated_at: 'x' });
    writeFileSync(f.manifest, fakeManifest({ idempotency: false }).replace('create: { tool: ticket_create, args: { title: "{{prefix}}ticket" }, id: id, name_path: title }', 'fixture: { id: T900, name: mwsc-fixture-1, name_path: title }'));
    const r = await runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) });
    const t900 = f.backend.tickets.get('T900')!;
    assert.equal(t900.version, 1, 'not written');
    assert.equal(t900.assignee, 'carol');
    assert.ok(r.doc.results.some((x) => x.write_path.resource === 'ticket' && x.verdict === 'not tested' && /does not read back as "mwsc-fixture-1"/.test(x.reason)));
  } finally {
    await f.close();
  }
});

test('cleanup deletes only objects that still read back with the run prefix, and refuses a changed target', async () => {
  const f = await startFake();
  try {
    f.backend.tickets.set('T1', { id: 'T1', title: 'someone-else', status: 'open', assignee: '', priority: 3, labels: [], version: 1, updated_at: 'x' });
    const l = new Ledger(join(f.dir, 'state', 'r1'), 'r1');
    l.append({ kind: 'run_start', run_id: 'r1', prefix: 'mwsc-r1-', manifest_sha256: 'x', hosts: [new URL(f.env['TRACKER_URL']!).host] });
    const i = l.intent('ticket', 'ticket_create', 'test');
    l.append({ kind: 'created', intent: i, resource: 'ticket', id: 'T1', name: 'mwsc-r1-ticket', via: 'result' });
    const c = await cleanupCommand({ manifest: f.manifest, stateDir: join(f.dir, 'state'), confirmTarget: 'fake-tracker', env: f.env, log: quiet });
    assert.ok(f.backend.tickets.has('T1'), 'the foreign object is still there');
    assert.match(c.reports[0]!.report.left[0]!.reason, /without this run's prefix/);
    const l2 = new Ledger(join(f.dir, 'state', 'r2'), 'r2');
    l2.append({ kind: 'run_start', run_id: 'r2', prefix: 'mwsc-r2-', manifest_sha256: 'x', hosts: ['127.0.0.1:1'] });
    l2.append({ kind: 'created', intent: l2.intent('ticket', 'ticket_create', 't'), resource: 'ticket', id: 'T2', name: null, via: 'result' });
    await assert.rejects(cleanupCommand({ manifest: f.manifest, stateDir: join(f.dir, 'state'), confirmTarget: 'fake-tracker', env: f.env, log: quiet }), /different target/);
    await assert.rejects(cleanupCommand({ manifest: f.manifest, stateDir: join(f.dir, 'state'), run: 'r2', env: f.env, log: quiet }), refused);
  } finally {
    await f.close();
  }
});

test('answers that arrive after the client timeout are never counted as refusals or errors', async () => {
  const f = await startFake({ slowErrorsMs: 700, timeoutMs: 300, pairs: 4, staleReps: 2 });
  try {
    const r = await runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) });
    const v = r.doc.results.filter((x) => x.verdict === 'violated');
    assert.deepEqual(v.map((x) => `${x.requirement} ${x.write_path.tool}: ${x.reason}`), []);
    assert.notEqual(r.exit, 1);
    const conc2 = r.doc.results.find((x) => x.requirement === 'MWS-CONC-2' && x.write_path.tool === 'ticket_replace');
    assert.notEqual(conc2?.verdict, 'held', 'a refusal the client never saw is not a held conflict');
    assert.equal(f.backend.tickets.size, 0);
  } finally {
    await f.close();
  }
});

test('a fixture is put back to its original field values after the run', async () => {
  const f = await startFake({ pairs: 2, staleReps: 1 });
  try {
    f.backend.tickets.set('T901', { id: 'T901', title: 'mwsc-fixture-2', status: 'open', assignee: 'carol', priority: 2, labels: [], version: 1, updated_at: 'x' });
    writeFileSync(f.manifest, fakeManifest({ idempotency: false, pairs: 2, staleReps: 1 }).replace('create: { tool: ticket_create, args: { title: "{{prefix}}ticket" }, id: id, name_path: title }', 'fixture: { id: T901, name: mwsc-fixture-2, name_path: title }'));
    const r = await runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) });
    const t = f.backend.tickets.get('T901')!;
    assert.ok(t.version > 1, 'the fixture was written to');
    assert.equal(t.assignee, 'carol');
    assert.equal(t.status, 'open');
    assert.deepEqual(r.doc.safety.fixtures_restored, [{ resource: 'ticket', restored: true }]);
  } finally {
    await f.close();
  }
});

test('rerun refuses a different manifest, repeats the recorded one, and says which run it repeats; review lists open questions', async () => {
  const f = await startFake({ pairs: 2, staleReps: 1 });
  try {
    const first = await runCommand({ ...base(f), confirmTarget: 'fake-tracker', planHash: await hashOf(f) });
    const notes: string[] = [];
    const second = await rerunCommand({ ...base(f), dir: first.outDir, confirmTarget: 'fake-tracker', planHash: first.doc.plan.hash, log: (s) => notes.push(s) });
    assert.equal(second.doc.safety.rerun_of, first.doc.run.id);
    assert.ok(notes.some((n) => n.includes(`is the one run ${first.doc.run.id} used`)));
    writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8') + '\n# changed\n');
    await assert.rejects(rerunCommand({ ...base(f), dir: first.outDir, confirmTarget: 'fake-tracker', planHash: first.doc.plan.hash }), /is not the manifest run/);
    const lines: string[] = [];
    const rv = reviewCommand({ dir: first.outDir, log: (s) => lines.push(s) });
    assert.ok(rv.open >= 1, 'the fake declares no review block, so its review-only clauses are open');
    assert.ok(lines.some((l) => /^- MWS-[A-Z0-9-]+:/.test(l)), 'each question is listed by id');
  } finally {
    await f.close();
  }
});
