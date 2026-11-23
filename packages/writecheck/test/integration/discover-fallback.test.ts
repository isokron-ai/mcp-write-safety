/**
 * Corpus run 3 (t05): the session's server/discover fallback, against a tiny stdio server in four shapes:
 *   (a) it answers server/discover with -32601 Method not found: initialize only, a note, no restart;
 *   (b) it crashes on server/discover (an older MCP Python SDK: a validation error, exit 1): started again once, initialize only;
 *   (c) it negotiates an older revision (2024-11-05): server/discover is never sent;
 *   (d) it hangs on server/discover: the discover timeout, the server still answers ping, initialize only.
 * Each case is recorded as a note in the session (for the results) and in the capture. No ports are bound.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CaptureEvent, CaptureSink } from '../../src/core/capture.js';
import { egressFor } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { Redactor } from '../../src/core/redact.js';
import { predatesOffered, Session } from '../../src/core/session.js';

const TAIL = `target: { environment: test, confirm: x }
limits: { timeout_ms: 5000, writes_per_second: 1000 }
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`;

/** DISCOVER=notfound|crash|crashall|hang; REV: the revision initialize answers. Every method it receives is appended to LOG. */
const SERVER = `
import { appendFileSync } from 'node:fs';
const rl = (await import('node:readline')).createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
appendFileSync(process.env.LOG, 'start\\n');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  appendFileSync(process.env.LOG, m.method + '\\n');
  if (process.env.DISCOVER === 'crashall' && m.id !== undefined && m.method !== 'initialize') { process.stderr.write('boom\\n'); process.exit(1); }
  if (m.method === 'server/discover') {
    if (process.env.DISCOVER === 'crash') { process.stderr.write('pydantic_core._pydantic_core.ValidationError: 1 validation error for ClientRequest\\n'); process.exit(1); }
    if (process.env.DISCOVER === 'hang') return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: process.env.REV || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 's', version: '0' } } });
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
`;

class Sink implements CaptureSink {
  readonly events: CaptureEvent[] = [];
  write(e: CaptureEvent): void {
    this.events.push(e);
  }
}

async function withServer(env: Record<string, string>, body: (s: Session, log: () => string[], sink: Sink) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-disc-'));
  const logFile = join(dir, 'log');
  writeFileSync(logFile, '');
  writeFileSync(join(dir, 'srv.mjs'), SERVER);
  const m = parseManifestText(`mws: "0.9"\nserver:\n  stdio: [${JSON.stringify(process.execPath)}, srv.mjs]\n  cwd: .\n  env_public: [LOG, DISCOVER, REV]\n${TAIL}`, join(dir, 'manifest.yaml'));
  const sink = new Sink();
  const s = new Session({ manifest: m, capture: sink, redactor: new Redactor([]), egress: egressFor([]), env: { PATH: process.env['PATH'], LOG: logFile, ...env }, write_budget: 10, min_interval_ms: 0 });
  const { readFileSync } = await import('node:fs');
  try {
    await body(s, () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean), sink);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const noteEvents = (k: Sink) => k.events.filter((e) => e.channel === 'process' && e['event'] === 'note');

test('predatesOffered: only a dated revision older than 2025-11-25', () => {
  assert.equal(predatesOffered('2024-11-05'), true);
  assert.equal(predatesOffered('2025-06-18'), true);
  assert.equal(predatesOffered('2025-11-25'), false);
  assert.equal(predatesOffered('2026-07-28'), false);
  assert.equal(predatesOffered(null), false);
  assert.equal(predatesOffered('draft'), false);
});

test('(a) server/discover answered -32601: initialize only, one note, no restart', async () => {
  await withServer({ DISCOVER: 'notfound' }, async (s, log, sink) => {
    await s.listTools('MAIN');
    assert.equal(s.protocolOf('MAIN'), '2025-11-25');
    assert.equal(log().filter((l) => l === 'start').length, 1);
    assert.equal(log().filter((l) => l === 'server/discover').length, 1);
    assert.equal(s.notes.length, 1);
    assert.match(s.notes[0]!, /server\/discover was answered with JSON-RPC error -32601 \(method not found\)/);
    assert.equal(noteEvents(sink).length, 1);
    // A second connection is not asked again.
    await s.listTools('B');
    assert.equal(log().filter((l) => l === 'server/discover').length, 1);
  });
});

test('(b) a server that crashes on server/discover is started again once and used with initialize only', async () => {
  await withServer({ DISCOVER: 'crash' }, async (s, log, sink) => {
    const tools = await s.listTools('MAIN');
    assert.equal(tools[0]!['name'], 'echo');
    assert.equal(s.protocolOf('MAIN'), '2025-11-25');
    assert.equal((await s.call('MAIN', 'echo', {}, { write: false })).ok, true);
    const l = log();
    assert.equal(l.filter((x) => x === 'start').length, 2, l.join(','));
    assert.equal(l.filter((x) => x === 'server/discover').length, 1, 'server/discover is sent once, never again after the crash');
    assert.equal(s.notes.length, 1);
    assert.match(s.notes[0]!, /MAIN: the server failed on server\/discover .*exit code 1.*ValidationError.*started again once/);
    const ev = noteEvents(sink);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.label, 'MAIN');
    // Later connections (separate processes) go straight to initialize.
    await s.listTools('B');
    assert.equal(log().filter((x) => x === 'server/discover').length, 1);
    assert.equal(log().filter((x) => x === 'start').length, 3);
  });
});

test('(b) launch(): a launch variant that crashes on server/discover has started (after its one restart)', async () => {
  await withServer({ DISCOVER: 'crash' }, async (s, log) => {
    const r = await s.launch({ label: 'V', env: {} });
    assert.deepEqual(r, { started: true, protocol: '2025-11-25' });
    assert.equal((await s.call('V', 'echo', {}, { write: false })).ok, true);
    assert.equal(log().filter((x) => x === 'server/discover').length, 1);
    const g = await s.restart('V', 'graceful');
    assert.equal(g.started, true, g.reason ?? '');
    assert.equal(log().filter((x) => x === 'server/discover').length, 1);
  });
});

test('(c) a server that negotiates an older revision is never sent server/discover', async () => {
  await withServer({ DISCOVER: 'crash', REV: '2024-11-05' }, async (s, log, sink) => {
    await s.listTools('MAIN');
    assert.equal(s.protocolOf('MAIN'), '2024-11-05');
    assert.ok(!log().includes('server/discover'));
    assert.equal(log().filter((x) => x === 'start').length, 1);
    assert.equal(s.notes.length, 1);
    assert.match(s.notes[0]!, /server\/discover was not sent: the server negotiated protocol revision 2024-11-05/);
    assert.equal(noteEvents(sink).length, 1);
  });
});

test('(d) a server that hangs on server/discover but still answers ping: initialize only, no restart', async () => {
  await withServer({ DISCOVER: 'hang' }, async (s, log) => {
    await s.listTools('MAIN');
    assert.equal(s.protocolOf('MAIN'), '2025-11-25');
    assert.equal(log().filter((x) => x === 'start').length, 1);
    assert.ok(log().includes('ping'));
    assert.equal(s.notes.length, 1);
    assert.match(s.notes[0]!, /server\/discover failed \(no answer within the discover timeout\), but the server still answers/);
  });
});

test('(e) a server that crashes on every request after initialize: one restart, then a code 4 failure, no loop', async () => {
  await withServer({ DISCOVER: 'crashall' }, async (s, log) => {
    await assert.rejects(s.listTools('MAIN'), (e: unknown) => (e as { code?: number }).code === 4);
    const l = log();
    assert.equal(l.filter((x) => x === 'start').length, 2, l.join(','));
    assert.equal(l.filter((x) => x === 'server/discover').length, 1);
  });
});
