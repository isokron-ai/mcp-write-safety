/**
 * Driver.reset on a server whose updates apply asynchronously: the update answers "enqueued" and the change lands
 * later. Two fields differ from the baseline (as at the final fixture put-back).
 *
 * full_replace: a reset that wrote one field at a time built the second write from a read taken before the first had
 * landed, so the second write sent the first field's old value back and undid it; the reset (and the fixture put-back)
 * failed. The reset now sends one write with every differing field, and confirms it within the settle window.
 *
 * field_patch with a required version: the second field's write carried the version read before the first had
 * landed, and the server dropped it as stale when it applied it. The reset now waits for each field to show its
 * baseline before reading the base of the next write.
 *
 * The server is deterministic: a write is applied right after the answer to the next call, so the first read after a
 * write still shows the old object.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { NO_CAPTURE } from '../../src/core/capture.js';
import { Driver } from '../../src/core/driver.js';
import { egressFor } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { Redactor } from '../../src/core/redact.js';
import { Session } from '../../src/core/session.js';

/**
 * MODE=lag: a write answers "enqueued" and is applied after the answer to the next call; patch_row checks the version
 * when it applies and drops a stale write. MODE=refuse2: set_row refuses a write that changes both fields, and applies
 * any other at once. MODE=hang: the first write is never answered, and is applied after the answer to the next call. MODE=never: writes answer "enqueued"
 * and are never applied. whoami reports the number of writes received.
 */
const SERVER = `
const MODE = process.env.MODE ?? 'lag';
const rl = (await import('node:readline')).createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const ro = { readOnlyHint: true };
const rw = { readOnlyHint: false, destructiveHint: false };
const tools = [
  { name: 'whoami', inputSchema: { type: 'object' }, annotations: ro },
  { name: 'get_row', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: ro },
  { name: 'set_row', inputSchema: { type: 'object', properties: { id: { type: 'string' }, row: { type: 'object' } } }, annotations: rw },
  { name: 'patch_row', inputSchema: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' }, a: { type: 'integer' }, b: { type: 'integer' } } }, annotations: rw },
];
const rows = { F1: { id: 'F1', name: 'mwsc-full', a: 2, b: 2, version: 0 }, F2: { id: 'F2', name: 'mwsc-patch', a: 2, b: 2, version: 0 } };
let writes = 0;
let pending = [];
const apply = (id, args, replace) => {
  const now = rows[id];
  if (replace) rows[id] = { ...args.row, id, version: now.version + 1 };
  else {
    const { id: _id, version, ...fields } = args;
    if (now.version !== version) return; // stale when applied: dropped
    rows[id] = { ...now, ...fields, version: now.version + 1 };
  }
};
const answer = (name, args) => {
  if (name === 'whoami') return { data: { tenant: 'mwsc-test-async', writes } };
  const row = rows[args.id];
  if (!row) return { data: { error: 'not found' }, isError: true };
  if (name === 'get_row') return { data: { ...row } };
  writes++;
  const replace = name === 'set_row';
  if (MODE === 'never') return { data: { status: 'enqueued' } };
  if (MODE === 'hang' && writes === 1) {
    pending.push(() => apply(args.id, args, replace));
    return null;
  }
  if (MODE === 'refuse2' && replace && args.row.a !== row.a && args.row.b !== row.b) return { data: { error: 'one field at a time' }, isError: true };
  if (MODE === 'lag') {
    pending.push(() => apply(args.id, args, replace));
    return { data: { status: 'enqueued' } };
  }
  apply(args.id, args, replace);
  return { data: { ok: true } };
};
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'async', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const due = pending;
    pending = [];
    const a = answer(m.params.name, m.params.arguments ?? {});
    if (a) send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(a.data) }], structuredContent: a.data, isError: !!a.isError } });
    for (const f of due) f();
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
`;

const MANIFEST = `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, srv.mjs]
  cwd: .
  env_public: [MODE]
target: { environment: test, confirm: async, guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" } }
limits: { timeout_ms: 800, writes_per_second: 1000 }
resources:
  - name: full
    fixture: { id: F1, name: mwsc-full, name_path: name }
    read: { tool: get_row, args: { id: "{{id}}" }, settle_ms: 400 }
    update: { tool: set_row, mode: full_replace, args: { id: "{{id}}", row: "{{object}}" } }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
  - name: patch
    fixture: { id: F2, name: mwsc-patch, name_path: name }
    read: { tool: get_row, args: { id: "{{id}}" }, settle_ms: 400 }
    update: { tool: patch_row, mode: field_patch, args: { id: "{{id}}", version: "{{version}}", "{{field}}": "{{value}}" } }
    version: { read: version, arg: version }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`;

interface Outcome {
  ok: boolean;
  a: unknown;
  b: unknown;
  writes: number;
}

/** Reset one resource (0: full_replace, 1: field_patch) from a = b = 2 to the baseline [1, 1] on a server in MODE. */
async function reset(mode: string, resource: 0 | 1): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-async-'));
  try {
    writeFileSync(join(dir, 'srv.mjs'), SERVER);
    const m = parseManifestText(MANIFEST, join(dir, 'manifest.yaml'));
    const s = new Session({ manifest: m, capture: NO_CAPTURE, redactor: new Redactor([]), egress: egressFor([]), env: { PATH: process.env['PATH'], MODE: mode }, write_budget: 50, min_interval_ms: 0 });
    try {
      await s.catalog('MAIN');
      const d = new Driver(s, m, m.resources[resource]!, 'mwsc-x-', {});
      d.id = resource === 0 ? 'F1' : 'F2';
      d.baseline = [1, 1];
      const ok = await d.reset('MAIN');
      const row = (await d.readOnce('MAIN', s.stepId('test.final'))).obj as { a: unknown; b: unknown };
      const who = await s.call('MAIN', 'whoami', {}, { step: s.stepId('test.count'), write: false });
      return { ok, a: row.a, b: row.b, writes: (who.data as { writes: number }).writes };
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reset on a server whose updates apply asynchronously (full_replace): both fields go back in one write', async () => {
  assert.deepEqual(await reset('lag', 0), { ok: true, a: 1, b: 1, writes: 1 });
});

test('reset on a server whose updates apply asynchronously (field_patch with a required version): each field waits for the one before', async () => {
  assert.deepEqual(await reset('lag', 1), { ok: true, a: 1, b: 1, writes: 2 });
});

test('reset (full_replace): a refused write of both fields falls back to one field at a time', async () => {
  assert.deepEqual(await reset('refuse2', 0), { ok: true, a: 1, b: 1, writes: 3 });
});

test('reset (full_replace): a write with an unknown outcome (timed out) is judged by the settled read, with no further write', async () => {
  assert.deepEqual(await reset('hang', 0), { ok: true, a: 1, b: 1, writes: 1 });
});

test('reset: a server that never applies the writes is reported as not reset', async () => {
  assert.deepEqual(await reset('never', 0), { ok: false, a: 2, b: 2, writes: 1 });
  assert.deepEqual(await reset('never', 1), { ok: false, a: 2, b: 2, writes: 1 });
});
