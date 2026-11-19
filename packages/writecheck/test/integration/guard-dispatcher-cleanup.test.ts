/**
 * Review F6 on 1b7e1e1: the cleanup path (commands.ts, cleanupCommand) with a tenant guard declared read_only_call through a
 * one-tool SQL dispatcher that declares destructiveHint: true (the t12 shape). A tiny stdio MCP server stands in for
 * mcp-server-mysql. Cleanup runs the same guard as a run: the state reads around the declared calls are recorded in the ledger
 * (guard_state_read) before they go out, and a guard whose arguments hold a write word is refused before any call.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cleanupCommand } from '../../src/cli/commands.js';
import { Ledger, readLedger } from '../../src/core/ledger.js';
import { WritecheckError } from '../../src/core/util.js';

// A one-tool MCP server over one in-memory table; state is kept in a JSON file so the test can read it afterwards.
const SERVER = `
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const DB = process.argv[2];
const load = () => JSON.parse(readFileSync(DB, 'utf8'));
const save = (rows) => writeFileSync(DB, JSON.stringify(rows));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const TOOL = { name: 'mysql_query', description: 'Run SQL', inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
function run(sql) {
  const rows = load();
  let m;
  if ((m = /^SELECT name FROM mwsc_items WHERE id = '([^']*)'$/.exec(sql))) return text(JSON.stringify(rows.filter((r) => r.id === m[1]).map((r) => ({ name: r.name }))));
  if ((m = /^SELECT seq, id, name, version FROM mwsc_items WHERE id = '([^']*)'$/.exec(sql))) return text(JSON.stringify(rows.filter((r) => r.id === m[1])));
  if ((m = /^SELECT seq, id, name, version FROM mwsc_items WHERE seq = (\\d+)$/.exec(sql))) return text(JSON.stringify(rows.filter((r) => r.seq === Number(m[1]))));
  if (/^SELECT seq, id, name, version FROM mwsc_items WHERE id <> 'mwsc-fx-1' ORDER BY seq$/.test(sql)) return text(JSON.stringify(rows.filter((r) => r.id !== 'mwsc-fx-1')));
  if ((m = /^DELETE FROM mwsc_items WHERE seq = (\\d+)$/.exec(sql))) {
    const left = rows.filter((r) => r.seq !== Number(m[1]));
    save(left);
    return text("Delete successful on schema 'mwsv'. Affected rows: " + (rows.length - left.length));
  }
  return text('Error: unsupported SQL ' + sql, true);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'sql-fake', version: '0.0.0' } } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: run(String(msg.params.arguments.sql)) });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

const manifest = (server: string, db: string, guardSql: string) => `mws: "0.9"
server: { stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(server)}, ${JSON.stringify(db)}] }
target:
  environment: test
  confirm: t12-fake
  guard: { tool: mysql_query, args: { sql: "${guardSql}" }, path: "$[0].name", pattern: "^mwsc-fx-1$", read_only_call: true }
patterns:
  applied: '\\b(?:Update|Insert|Delete) successful on schema\\b.*\\bAffected rows: [1-9]'
resources:
  - name: item
    fixture: { id: mwsc-fx-1, name: mwsc-fx-1, name_path: name }
    read: { tool: mysql_query, args: { sql: "SELECT seq, id, name, version FROM mwsc_items WHERE id = '{{id}}'" }, items: "$", match: id, ignore: [version] }
    cleanup: leave
  - name: scratch
    create: { tool: mysql_query, args: { sql: "INSERT INTO mwsc_items (id, name) VALUES ('{{marker}}', '{{marker}}')" }, id_regex: 'Last insert ID: (\\d+)', name_path: name }
    read: { tool: mysql_query, args: { sql: "SELECT seq, id, name, version FROM mwsc_items WHERE seq = {{id}}" }, items: "$", match: seq }
    list: { tool: mysql_query, args: { sql: "SELECT seq, id, name, version FROM mwsc_items WHERE id <> 'mwsc-fx-1' ORDER BY seq" }, items: "$", id: seq, name: name }
    delete: { tool: mysql_query, args: { sql: "DELETE FROM mwsc_items WHERE seq = {{id}}" } }
    missing_id: 999999999
    cleanup: delete
`;

function setup(guardSql: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-t12-cleanup-'));
  const server = join(dir, 'server.mjs');
  const db = join(dir, 'db.json');
  writeFileSync(server, SERVER);
  writeFileSync(db, JSON.stringify([{ seq: 1, id: 'mwsc-fx-1', name: 'mwsc-fx-1', version: 1 }, { seq: 2, id: 'mwsc-r1-a', name: 'mwsc-r1-a', version: 1 }]));
  writeFileSync(join(dir, 'm.yaml'), manifest(server, db, guardSql));
  const stateDir = join(dir, 'state');
  const ledger = new Ledger(join(stateDir, 'r1'), 'r1', (x) => x);
  ledger.append({ kind: 'run_start', run_id: 'r1', prefix: 'mwsc-r1-', manifest_sha256: 'x', hosts: [] });
  ledger.append({ kind: 'intent', seq: 1, resource: 'scratch', tool: 'mysql_query', purpose: 'setup' });
  ledger.append({ kind: 'created', intent: 1, resource: 'scratch', id: 2, name: 'mwsc-r1-a', via: 'result' });
  return { dir, db, stateDir, manifest: join(dir, 'm.yaml'), ledgerFile: join(stateDir, 'r1', 'ledger.jsonl') };
}

test('F6: cleanup through a destructive-marked SQL dispatcher guard records the state reads and the declared calls, then deletes', async () => {
  const f = setup("SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'");
  try {
    const log: string[] = [];
    const c = await cleanupCommand({ manifest: f.manifest, stateDir: f.stateDir, confirmTarget: 't12-fake', env: {}, log: (s) => log.push(s) });
    assert.equal(c.exit, 0, log.join('\n'));
    const l = readLedger(f.ledgerFile);
    const kinds = l.filter((e) => e.kind === 'guard_call' || e.kind === 'guard_state_read').map((e) => (e.kind === 'guard_call' ? `call ${e.phase}` : `state ${e.phase} ${e.what.split(' ')[0]}`));
    assert.deepEqual(kinds, ['state before fixture', 'state before list', 'call check', 'call dry', 'call after', 'state after fixture', 'state after list']);
    assert.ok(log.some((s) => /reading fixture item "mwsc-fx-1" through mysql_query \(before the declared calls; the tenant check has not matched yet\)/.test(s)), log.join('\n'));
    const rows = JSON.parse((await import('node:fs')).readFileSync(f.db, 'utf8')) as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id), ['mwsc-fx-1'], 'the scratch row was deleted, the fixture kept');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('F6: cleanup refuses a destructive-marked dispatcher guard whose arguments hold a write word, before any call', async () => {
  const f = setup("SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1' FOR UPDATE");
  try {
    await assert.rejects(cleanupCommand({ manifest: f.manifest, stateDir: f.stateDir, confirmTarget: 't12-fake', env: {}, log: () => {} }), (e) => {
      assert.ok(e instanceof WritecheckError, String(e));
      assert.equal(e.code, 3);
      assert.match(e.message, /contains "FOR UPDATE", a word that can write, lock or have a side effect/);
      return true;
    });
    assert.equal(readLedger(f.ledgerFile).filter((e) => e.kind === 'guard_call' || e.kind === 'guard_state_read').length, 0);
    const rows = JSON.parse((await import('node:fs')).readFileSync(f.db, 'utf8')) as unknown[];
    assert.equal(rows.length, 2, 'nothing deleted');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
