/**
 * t17 on a live stdio server: a server built like Python FastMCP with a wrap-result output schema answers every tool
 * with structuredContent `{"result": "<a JSON document as a string>"}`. The tenant guard (a path), the fixture lookup (a
 * list read with items and match) and a plain read work when the tool's outputSchema marks the wrapped result, or when the
 * manifest declares `decode: json`; with neither, the result is read as it is and the paths find nothing.
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
import { tenantGuard } from '../../src/core/safety.js';
import { Session } from '../../src/core/session.js';
import { getPath } from '../../src/core/util.js';

/**
 * A tiny stdio MCP server that wraps every result as FastMCP does. MARK=fastmcp: each outputSchema carries
 * `x-fastmcp-wrap-result`; MARK=single: the only property is `result` (type string); MARK=none: no outputSchema at all.
 */
const WRAP_SERVER = `
const mark = process.env.MARK ?? 'fastmcp';
const rl = (await import('node:readline')).createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const schema = mark === 'none' ? undefined : { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], ...(mark === 'fastmcp' ? { 'x-fastmcp-wrap-result': true } : {}) };
const ro = { readOnlyHint: true };
const tools = [
  { name: 'whoami', inputSchema: { type: 'object' }, annotations: ro },
  { name: 'get_rows', inputSchema: { type: 'object' }, annotations: ro },
  { name: 'get_row', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: ro },
  { name: 'set_row', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
].map((t) => (schema ? { ...t, outputSchema: schema } : t));
const rows = [{ id: 'F1', name: 'mwsc-fixture', a: 1, b: 1 }, { id: 'F2', name: 'mwsc-second', a: 2, b: 2 }];
const answer = (name, args) => {
  if (name === 'whoami') return { tenant: 'mwsc-test-wrap' };
  if (name === 'get_rows') return { rows };
  if (name === 'get_row') return rows.find((r) => r.id === args.id) ?? { error: 'not found' };
  return { ok: true };
};
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'wrap', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const text = JSON.stringify(answer(m.params.name, m.params.arguments ?? {}));
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
`;

const manifestText = (decode: boolean | 'none', serverDecode = '') => {
  const d = decode === 'none' ? ', decode: none' : decode ? ', decode: json' : '';
  return `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, srv.mjs]
  cwd: .
  env_public: [MARK]${serverDecode ? `\n  decode: ${serverDecode}` : ''}
target: { environment: test, confirm: wrap, guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-"${d} } }
limits: { timeout_ms: 5000, writes_per_second: 1000 }
resources:
  - name: row
    fixture: { id: F1, name: mwsc-fixture, name_path: name }
    read: { tool: get_rows, args: {}, items: rows, match: id${d} }
    update: { tool: set_row, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
  - name: one
    fixture: { id: F2, name: mwsc-second, name_path: name }
    read: { tool: get_row, args: { id: "{{id}}" }${d} }
    update: { tool: set_row, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`;
};

async function withServer(mark: string, decode: boolean | 'none', body: (s: Session, m: ReturnType<typeof parseManifestText>) => Promise<void>, serverDecode = ''): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-wrap-'));
  try {
    writeFileSync(join(dir, 'srv.mjs'), WRAP_SERVER);
    const m = parseManifestText(manifestText(decode, serverDecode), join(dir, 'manifest.yaml'));
    const s = new Session({ manifest: m, capture: NO_CAPTURE, redactor: new Redactor([]), egress: egressFor([]), env: { PATH: process.env['PATH'], MARK: mark }, write_budget: 10, min_interval_ms: 0 });
    try {
      await body(s, m);
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [mark, decode, basis] of [['fastmcp', false, 'outputSchema'], ['single', false, 'outputSchema'], ['none', true, 'manifest']] as const) {
  test(`wrapped results (${mark === 'none' ? 'no outputSchema, manifest decode: json' : `outputSchema ${mark}`}): the guard, the fixture lookup and a read find their paths`, async () => {
    await withServer(mark, decode, async (s, m) => {
      await s.catalog('MAIN');
      // each of the three is tried before any is asserted, so a failure shows which of them found nothing
      const guard = await tenantGuard(m, s, 'MAIN').then((g) => g.matched, (e: Error) => e.message);
      // the fixture lookup: a list read, the item whose id is the fixture's
      const list = new Driver(s, m, m.resources[0]!, 'mwsc-x-', {});
      list.id = 'F1';
      const r = await list.readOnce('MAIN', s.stepId('setup.row.fixture'));
      // a plain read by id
      const one = new Driver(s, m, m.resources[1]!, 'mwsc-x-', {});
      one.id = 'F2';
      const r2 = await one.readOnce('MAIN', s.stepId('setup.one.fixture'));
      assert.deepEqual({ guard, fixture: getPath(r.obj, 'name') ?? null, read: getPath(r2.obj, 'name') ?? null }, { guard: 'mwsc-test-wrap', fixture: 'mwsc-fixture', read: 'mwsc-second' });
      assert.equal(r.ok && r2.ok, true);
      assert.deepEqual(r.call?.decoded, { from: 'structuredContent.result', basis });
      assert.deepEqual(r2.call?.decoded, { from: 'structuredContent.result', basis });
      assert.equal(typeof (r.call?.raw_structured as { result?: unknown }).result, 'string', 'structuredContent as received is kept beside the decoded data');
      // the evidence: one note per decoded tool, saying why
      const notes = s.notes.filter((n) => /wrapped result/.test(n));
      assert.deepEqual(notes.map((n) => /: (\w+) answers a wrapped result/.exec(n)?.[1]).sort(), ['get_row', 'get_rows', 'whoami']);
      assert.ok(notes.every((n) => (basis === 'manifest' ? /the manifest declares decode: json/ : /outputSchema marks a wrapped result/).test(n)), notes.join('\n'));
    });
  });
}

test('wrapped results with no outputSchema marker and no decode: json are read as they are: the guard and the fixture find nothing', async () => {
  await withServer('none', false, async (s, m) => {
    await s.catalog('MAIN');
    await assert.rejects(tenantGuard(m, s, 'MAIN'), /target\.guard: whoami at tenant returned null, which does not match/);
    const list = new Driver(s, m, m.resources[0]!, 'mwsc-x-', {});
    list.id = 'F1';
    const r = await list.readOnce('MAIN', s.stepId('setup.row.fixture'));
    assert.equal(r.ok, false, 'the fixture is not found');
    assert.equal(r.call?.decoded, undefined);
    assert.equal(typeof (r.call?.data as { result?: unknown }).result, 'string', 'data is structuredContent as received');
    assert.equal(s.notes.filter((n) => /wrapped result/.test(n)).length, 0);
  });
});

for (const [mark, how] of [['single', 'read, list and guard'], ['fastmcp', 'server.decode']] as const) {
  test(`decode: none (${how}) keeps a marked tool's wrapped results as received (outputSchema ${mark}); the notes say so`, async () => {
    await withServer(
      mark,
      how === 'server.decode' ? false : 'none',
      async (s, m) => {
        await s.catalog('MAIN');
        await assert.rejects(tenantGuard(m, s, 'MAIN'), /target\.guard: whoami at tenant returned null/);
        const list = new Driver(s, m, m.resources[0]!, 'mwsc-x-', {});
        list.id = 'F1';
        const r = await list.readOnce('MAIN', s.stepId('setup.row.fixture'));
        assert.equal(r.ok, false);
        assert.equal(r.call?.decoded, undefined);
        assert.equal(r.call?.raw_structured, undefined);
        assert.equal(typeof (r.call?.data as { result?: unknown }).result, 'string');
        const notes = s.notes.filter((n) => /decode: none/.test(n));
        assert.deepEqual(notes.map((n) => /: (\w+)'s outputSchema marks a wrapped result/.exec(n)?.[1]).sort(), ['get_rows', 'whoami']);
        assert.equal(s.notes.filter((n) => /answers a wrapped result/.test(n)).length, 0);
      },
      how === 'server.decode' ? '{ whoami: none, get_rows: none, get_row: none }' : '',
    );
  });
}
