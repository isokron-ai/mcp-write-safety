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

/** A tiny stdio MCP server whose writes answer "enqueued" and apply DELAY ms later. patch_row checks the version when it applies. */
const ASYNC_SERVER = `
const DELAY = 150;
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
const later = (f) => setTimeout(f, DELAY);
let replaces = 0;
const answer = (name, args) => {
  if (name === 'whoami') return { tenant: 'mwsc-test-async', replaces };
  const row = rows[args.id];
  if (!row) return { error: 'not found' };
  if (name === 'get_row') return { ...row };
  if (name === 'set_row') {
    replaces++;
    const body = { ...args.row };
    later(() => { rows[args.id] = { ...body, id: row.id, version: rows[args.id].version + 1 }; });
    return { status: 'enqueued' };
  }
  const { id, version, ...fields } = args;
  later(() => {
    const now = rows[id];
    if (now.version !== version) return; // stale at apply time: dropped
    rows[id] = { ...now, ...fields, version: now.version + 1 };
  });
  return { status: 'enqueued' };
};
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'async', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const data = answer(m.params.name, m.params.arguments ?? {});
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
`;

const MANIFEST = `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, srv.mjs]
  cwd: .
target: { environment: test, confirm: async, guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" } }
limits: { timeout_ms: 5000, writes_per_second: 1000 }
resources:
  - name: full
    fixture: { id: F1, name: mwsc-full, name_path: name }
    read: { tool: get_row, args: { id: "{{id}}" }, settle_ms: 1500 }
    update: { tool: set_row, mode: full_replace, args: { id: "{{id}}", row: "{{object}}" } }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
  - name: patch
    fixture: { id: F2, name: mwsc-patch, name_path: name }
    read: { tool: get_row, args: { id: "{{id}}" }, settle_ms: 1500 }
    update: { tool: patch_row, mode: field_patch, args: { id: "{{id}}", version: "{{version}}", "{{field}}": "{{value}}" } }
    version: { read: version, arg: version }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`;

async function withServer(body: (s: Session, m: ReturnType<typeof parseManifestText>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-async-'));
  try {
    writeFileSync(join(dir, 'srv.mjs'), ASYNC_SERVER);
    const m = parseManifestText(MANIFEST, join(dir, 'manifest.yaml'));
    const s = new Session({ manifest: m, capture: NO_CAPTURE, redactor: new Redactor([]), egress: egressFor([]), env: { PATH: process.env['PATH'] }, write_budget: 50, min_interval_ms: 0 });
    try {
      await s.catalog('MAIN');
      await body(s, m);
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [i, mode] of [[0, 'full_replace'], [1, 'field_patch with a required version']] as const) {
  test(`reset on a server whose updates apply asynchronously (${mode}): both differing fields go back to the baseline`, async () => {
    await withServer(async (s, m) => {
      const d = new Driver(s, m, m.resources[i]!, 'mwsc-x-', {});
      d.id = i === 0 ? 'F1' : 'F2';
      d.baseline = [1, 1];
      const ok = await d.reset('MAIN');
      const back = await d.readSettled('MAIN', 'test.final', (o) => (o as { a: number; b: number }).a === 1 && (o as { a: number; b: number }).b === 1);
      assert.deepEqual({ ok, a: (back.obj as { a: number }).a, b: (back.obj as { b: number }).b }, { ok: true, a: 1, b: 1 });
      if (i === 0) {
        const who = await s.call('MAIN', 'whoami', {}, { step: s.stepId('test.count'), write: false });
        assert.equal((who.data as { replaces: number }).replaces, 1, 'one full_replace write puts every differing field back');
      }
    });
  });
}
