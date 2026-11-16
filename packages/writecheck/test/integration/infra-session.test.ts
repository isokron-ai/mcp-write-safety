/**
 * The session's new connection paths: a stdio launch variant that refuses its settings, the raw
 * result hook, and (with TINY_TRACKER_DIR) a launched streamable HTTP server spoken to in both
 * protocol revisions, launch variants with other settings, and the base-URL gate between the
 * launched server and its backend forcing one interleaving.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { NO_CAPTURE } from '../../src/core/capture.js';
import { egressFor } from '../../src/core/egress.js';
import { parseManifestText, type Manifest } from '../../src/core/manifest.js';
import { Redactor } from '../../src/core/redact.js';
import { Session } from '../../src/core/session.js';
import { createGate, lastMutating, nthOf } from '../../src/gate/gate.js';

const TAIL = `target: { environment: test, confirm: x }
limits: { timeout_ms: 5000, writes_per_second: 1000 }
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`;

/** A tiny stdio MCP server: refuses to start on an unknown MODE, answers initialize, tools/list and one tool. */
const STDIO_SERVER = `
if (!['', 'on', 'off'].includes(process.env.MODE ?? '')) { console.error('MODE=' + process.env.MODE + ' is not recognized'); process.exit(2); }
const rl = (await import('node:readline')).createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 's', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'mode=' + (process.env.MODE ?? '') + ' secret=' + (process.env.SECRET ?? '') }] } });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
`;

test('stdio: a launch variant that refuses its settings has not started; the raw result hook sees unredacted answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-sess-'));
  try {
    writeFileSync(join(dir, 'srv.mjs'), STDIO_SERVER);
    const m = parseManifestText(`mws: "0.9"\nserver:\n  stdio: [${JSON.stringify(process.execPath)}, srv.mjs]\n  cwd: .\n  env_passthrough: [SECRET]\n${TAIL}`, join(dir, 'manifest.yaml'));
    const seen: { raw: string; isError: boolean; tool: string }[] = [];
    const s = new Session({ manifest: m, capture: NO_CAPTURE, redactor: new Redactor(['s3cret-value-123']), egress: egressFor([]), env: { PATH: process.env['PATH'], SECRET: 's3cret-value-123' }, write_budget: 10, min_interval_ms: 0, onResult: (e) => seen.push(e) });
    try {
      const bad = await s.launch({ label: 'BAD', env: { MODE: 'yes' } });
      assert.equal(bad.started, false);
      if (!bad.started) {
        assert.equal(bad.exit_code, 2);
        assert.match(bad.stderr_tail, /not recognized/);
      }
      const ok = await s.launch({ label: 'ON', env: { MODE: 'on' } });
      assert.deepEqual(ok, { started: true, protocol: '2025-11-25' });
      const r = await s.call('ON', 'echo', {}, { write: false });
      assert.match(r.text ?? '', /mode=on secret=s3cret-value-123/);
      assert.equal(seen.length, 1);
      assert.ok(seen[0]!.raw.includes('s3cret-value-123'), 'the hook gets the raw answer');
      assert.equal(seen[0]!.isError, false);
      // A restart (MWS-RETRY-2 step (e)): the same label, the same settings, a new process; the stop kind actually used.
      const g = await s.restart('ON', 'graceful');
      assert.equal(g.started, true);
      assert.equal(g.stop_used, 'graceful', 'a stdio server that exits when its stdin closes stopped gracefully');
      assert.ok(g.t_ready_ms !== null && g.t_ready_ms >= g.t_stopped_ms);
      assert.match((await s.call('ON', 'echo', {}, { write: false })).text ?? '', /mode=on/);
      const k = await s.restart('ON', 'kill');
      assert.deepEqual([k.started, k.stop_used, k.ended_by], [true, 'kill', 'SIGKILL']);
      await assert.rejects(s.restart('MAIN', 'kill'), /was not started with launch/);
      await s.release(['ON']);
      // The normal path still works, and auto mode fell back to initialize after server/discover was refused.
      await s.listTools('MAIN');
      assert.equal(s.protocolOf('MAIN'), '2025-11-25');
    } finally {
      await s.close();
    }
    const urlManifest = parseManifestText(`mws: "0.9"\nserver: { url: "http://127.0.0.1:9/mcp" }\n${TAIL}`, join(dir, 'm2.yaml'));
    const s2 = new Session({ manifest: urlManifest, capture: NO_CAPTURE, redactor: new Redactor([]), egress: egressFor([]), env: {}, write_budget: 1, min_interval_ms: 0 });
    await assert.rejects(s2.launch({ label: 'X', env: {} }), /launch checks need server\.stdio or server\.launch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TT = process.env['TINY_TRACKER_DIR'];
const ttSkip = TT && existsSync(join(TT, 'dist', 'src', 'cli.js')) ? false : 'TINY_TRACKER_DIR is not set to a built tiny-tracker';
const TOKEN = 'local-test-token-0123456789';

async function startBackend(): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn(process.execPath, [join(TT!, 'dist', 'src', 'cli.js'), 'backend', '--port', '0'], { env: { PATH: process.env['PATH'], TRACKER_BACKEND_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((r, j) => {
    createInterface({ input: proc.stdout! }).once('line', r);
    proc.once('exit', (c) => j(new Error(`backend exited ${c}`)));
  });
  return { proc, url: (JSON.parse(line) as { backend: string }).backend };
}

function ttManifest(dir: string, protocol: string, gate: false | 'rewrite' | 'hook'): Manifest {
  return parseManifestText(`mws: "0.9"
server:
  launch: { command: [${JSON.stringify(process.execPath)}, dist/src/cli.js, server, --port, "0"], url_from: mcp }
  cwd: ${JSON.stringify(TT)}
  protocol: "${protocol}"
  env_passthrough: [TRACKER_BACKEND_TOKEN]
  env_public: [TRACKER_BACKEND_URL]
${gate === 'rewrite' ? 'backend: { gate: { rewrite_env: TRACKER_BACKEND_URL, hold_timeout_ms: 3000 } }\n' : gate === 'hook' ? 'backend: { gate: { node_import: true, hold_timeout_ms: 3000 } }\n' : ''}${TAIL}`, join(dir, 'manifest.yaml'));
}

for (const protocol of ['2026-07-28', '2025-11-25', 'auto']) {
  test(`tiny-tracker launched over HTTP, protocol ${protocol}: tools/list, a create and a read; launch variants with other settings`, { skip: ttSkip }, async () => {
    const be = await startBackend();
    const dir = mkdtempSync(join(tmpdir(), 'mwsc-tt-'));
    const env = { PATH: process.env['PATH'], TRACKER_BACKEND_TOKEN: TOKEN, TRACKER_BACKEND_URL: be.url };
    const s = new Session({ manifest: ttManifest(dir, protocol, false), capture: NO_CAPTURE, redactor: new Redactor([TOKEN]), egress: egressFor([]), env, write_budget: 100, min_interval_ms: 0 });
    try {
      const cat = await s.catalog('A');
      assert.ok(cat.tools.some((t) => t['name'] === 'create_ticket'));
      assert.deepEqual([cat.prompts, cat.resourceTemplates], [[], []]);
      assert.equal(s.protocolOf('A'), protocol === '2025-11-25' ? '2025-11-25' : '2026-07-28');
      const c = await s.call('A', 'create_ticket', { title: 'mwsc-x-ticket', idempotency_key: 'mwsc-key-0001' }, { meta: { 'example.com/trace': 'on' } });
      assert.equal(c.ok, true, c.text ?? '');
      const id = (c.data as { id: string }).id;
      const g = await s.call('B', 'get_ticket', { id }, { write: false });
      assert.equal((g.data as { title: string }).title, 'mwsc-x-ticket');
      const bad = await s.launch({ label: 'RO-BAD', env: { TRACKER_READ_ONLY: 'enabled' } });
      assert.equal(bad.started, false);
      if (!bad.started) assert.match(bad.stderr_tail + bad.reason, /not recognized|exited \(2\)/);
      const ro = await s.launch({ label: 'RO', env: { TRACKER_READ_ONLY: 'true' } });
      assert.equal(ro.started, true);
      const roTools = (await s.listTools('RO')).map((t) => t['name']);
      // tiny-tracker keeps write tools listed in read-only mode, and each refuses with a tool error that says why.
      assert.ok(roTools.includes('get_ticket'));
      const roWrite = await s.call('RO', 'create_ticket', { title: 'mwsc-x-ro' });
      assert.equal(roWrite.ok, false);
      assert.match(roWrite.text ?? roWrite.rpc_error?.message ?? '', /read-only/);
      await s.release(['RO']);
    } finally {
      await s.close();
      be.proc.kill('SIGINT');
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const route of ['rewrite', 'hook'] as const)
test(`tiny-tracker through the ${route === 'rewrite' ? 'base-URL' : 'node --import'} gate: the learning pass sees one PATCH; holding it lets writer B finish first; both changes survive`, { skip: ttSkip }, async () => {
  const be = await startBackend();
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-tt-'));
  const env = { PATH: process.env['PATH'], TRACKER_BACKEND_TOKEN: TOKEN, TRACKER_BACKEND_URL: be.url };
  const manifest = ttManifest(dir, 'auto', route);
  const egress = egressFor([]);
  const gate = createGate(manifest, env, { stateDir: dir, egress })!;
  await gate.start();
  const s = new Session({ manifest, capture: NO_CAPTURE, redactor: new Redactor([TOKEN]), egress, env, write_budget: 100, min_interval_ms: 0, gate });
  try {
    const c = await s.call('A', 'create_ticket', { title: 'mwsc-g-ticket' });
    const id = (c.data as { id: string }).id;
    await s.connect('B');
    const m = gate.mark();
    assert.ok((await s.call('A', 'update_ticket', { id, title: 'mwsc-g-learn', force: true })).ok);
    const learned = await gate.since(m);
    const last = lastMutating(learned)!;
    assert.deepEqual([last.method, last.path], ['PATCH', `/tickets/${id}`]);
    const h = gate.hold({ method: last.method, path: last.path, nth: nthOf(learned, last) });
    const a = s.call('A', 'update_ticket', { id, title: 'mwsc-g-A', force: true });
    const held = await h.waitHeld(gate.holdTimeoutMs);
    assert.ok(held, 'writer A is held at the gate');
    assert.ok((await s.call('B', 'update_ticket', { id, assignee: 'bea', force: true })).ok);
    await h.release();
    assert.ok((await a).ok);
    const t = (await s.call('B', 'get_ticket', { id }, { write: false })).data as { title: string; assignee: string };
    assert.deepEqual([t.title, t.assignee], ['mwsc-g-A', 'bea']);
  } finally {
    await s.close();
    await gate.stop();
    be.proc.kill('SIGINT');
    rmSync(dir, { recursive: true, force: true });
  }
});
