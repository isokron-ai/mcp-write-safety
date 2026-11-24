/**
 * t12 (@benborla29/mcp-server-mysql 2.0.9 against mysql 8.4): with any ALLOW_*_OPERATION=true the server's only tool,
 * mysql_query, declares readOnlyHint: false, destructiveHint: true. The guard is a SELECT declared read_only_call. Before this
 * change `plan --catalog` warned "run would refuse: target.guard: mysql_query declares destructiveHint: true; even a declared
 * read-only call through it cannot be the guard", and a full run stopped at exit 3 before any write.
 *
 * Now the plan accepts it, and says the guard runs through a destructive-marked dispatcher. The same manifest is still refused
 * where the server also offers a read-only tool, and where the guard is not declared read_only_call.
 * The manifest is the t12 hand manifest (onboard/t12/manifest.yaml) without its comments; the catalog is the write-mode tools/list.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { planCommand } from '../../src/cli/commands.js';

const T12 = `mws: "0.9"
server:
  stdio: ["{{bin}}/mcp-server-mysql"]
  env_passthrough: [MYSQL_PASS]
  env_public: [MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_DB, ALLOW_INSERT_OPERATION, ALLOW_UPDATE_OPERATION, ALLOW_DELETE_OPERATION]
  processes: separate
target:
  environment: test
  confirm: mwsv-corpus-t12
  guard: { tool: mysql_query, args: { sql: "SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'" }, path: "$[0].name", pattern: "^mwsc-fx-1$", read_only_call: true }
limits: { write_budget: 10000, writes_per_second: 50, pairs: 500, stale_reps: 30, timeout_ms: 15000, max_fuzz_cases: 1000 }
patterns:
  applied: '\\b(?:Update|Insert|Delete) successful on schema\\b.*\\bAffected rows: [1-9]'
  conflict: '\\bAffected rows: 0\\b'
resources:
  - name: item
    fixture: { id: mwsc-fx-1, name: mwsc-fx-1, name_path: name }
    read: { tool: mysql_query, args: { sql: "SELECT id, name, title, status, version FROM mwsc_items WHERE id = '{{id}}'" }, items: "$", match: id, ignore: [version] }
    update:
      tool: mysql_query
      mode: field_patch
      args: { sql: "UPDATE mwsc_items SET {{field}} = '{{value}}', version = version + 1 WHERE id = '{{id}}'" }
    fields: [ { path: title, values: [alpha, bravo], skip: [invalid] }, { path: status, values: [in_progress, closed], skip: [invalid] } ]
    missing_id: mwsc-no-such-id
    cleanup: leave
  - name: scratch
    create:
      tool: mysql_query
      args: { sql: "INSERT INTO mwsc_items (id, name, title, status, version) VALUES ('{{marker}}', '{{marker}}', 'seed-title', 'open', 1)" }
      id_regex: 'Last insert ID: (\\d+)'
      name_path: name
    read: { tool: mysql_query, args: { sql: "SELECT seq, id, name, title, status, version FROM mwsc_items WHERE seq = {{id}}" }, items: "$", match: seq }
    list: { tool: mysql_query, args: { sql: "SELECT seq, id, name, title, status, version FROM mwsc_items WHERE id <> 'mwsc-fx-1' ORDER BY seq" }, items: "$", id: seq, name: name }
    delete: { tool: mysql_query, args: { sql: "DELETE FROM mwsc_items WHERE seq = {{id}}" } }
    missing_id: 999999999
    cleanup: delete
calls:
  mysql_query: { resource: scratch, args: { sql: "UPDATE mwsc_items SET title = 'bravo', version = version + 1 WHERE seq = {{id}}" } }
`;

const MYSQL_QUERY = { name: 'mysql_query', description: 'Run SQL queries against MySQL database', inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'The SQL query to execute' } }, required: ['sql'] }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'MySQL Query' } };

async function plan(manifest: string, tools: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-t12-'));
  try {
    writeFileSync(join(dir, 'm.yaml'), manifest);
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ tools }));
    const log: string[] = [];
    const r = await planCommand({ manifest: join(dir, 'm.yaml'), catalog: join(dir, 'tools.json'), env: {}, log: (s) => log.push(s) });
    return { ...r, log: log.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('t12: plan --catalog no longer says the run would refuse the SELECT guard through the destructive-marked mysql_query', async () => {
  const r = await plan(T12, [MYSQL_QUERY]);
  assert.doesNotMatch(r.warning ?? '', /target\.guard/, r.warning ?? '');
  const w = r.plan.warnings.find((x) => /runs through a tool that declares destructiveHint: true \(a dispatcher\)/.test(x)) ?? '';
  assert.ok(w.startsWith(`the tenant guard mysql_query {"sql":"SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'"} runs through`), r.plan.warnings.join(' | '));
  assert.match(w, /these reads go out before the tenant check matches/);
  assert.match(w, /Tables, columns, schemas and counters the manifest does not read, and a write undone within one call, are not compared/);
  assert.match(r.log, /with no ignored field left out/);
  assert.equal(r.plan.writes_at_most >= 3, true);
});

test('t12: the same manifest is refused where the server also offers a read-only tool', async () => {
  const r = await plan(T12, [MYSQL_QUERY, { name: 'list_tables', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
  assert.match(r.warning ?? '', /run would refuse: target\.guard: read_only_call is for a server whose only tool is a dispatcher; this server offers read-only tools \(list_tables\)/);
});

test('t12: the same guard without read_only_call is refused', async () => {
  const m = T12.replace(', read_only_call: true }', ' }');
  assert.notEqual(m, T12);
  const r = await plan(m, [MYSQL_QUERY]);
  assert.match(r.warning ?? '', /run would refuse: target\.guard: mysql_query declares readOnlyHint: false or destructiveHint: true/);
  assert.ok(!r.plan.warnings.some((w) => /destructiveHint: true \(a dispatcher\)/.test(w)));
});

test('t12: a manifest that reads the fixture through another tool keeps the refusal', async () => {
  const m = T12.replace('read: { tool: mysql_query, args: { sql: "SELECT id, name', 'read: { tool: mysql_get, args: { sql: "SELECT id, name');
  assert.notEqual(m, T12);
  const r = await plan(m, [MYSQL_QUERY, { name: 'mysql_get', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }]);
  assert.match(r.warning ?? '', /run would refuse: target\.guard: mysql_query declares destructiveHint: true; .*this manifest reads through mysql_get/);
});

test('t12 review F2/F3: the plan says the run would refuse a write word in the guard, or a second tool that may read', async () => {
  const m = T12.replace("WHERE id = 'mwsc-fx-1'\" }, path", "WHERE id = 'mwsc-fx-1' FOR UPDATE\" }, path");
  assert.notEqual(m, T12);
  const r = await plan(m, [MYSQL_QUERY]);
  assert.match(r.warning ?? '', /run would refuse: target\.guard: mysql_query declares destructiveHint: true, and the declared call's arguments .*"FOR UPDATE"/);
  const r2 = await plan(T12, [MYSQL_QUERY, { name: 'mysql_describe', inputSchema: { type: 'object' } }]);
  assert.match(r2.warning ?? '', /run would refuse: .*this server offers mysql_describe, which declare neither readOnlyHint: false nor destructiveHint: true/);
});
