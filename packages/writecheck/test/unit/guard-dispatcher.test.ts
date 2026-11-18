/**
 * t12 (mcp-server-mysql 2.0.9): with writes on, the server's only tool, `mysql_query`, declares destructiveHint: true. A guard
 * declared read_only_call through it (a SELECT) is now accepted only where it is the server's only read route (no tool declares
 * readOnlyHint: true and the manifest reads only through it) and there is state to compare; the run then also reads every
 * pre-made fixture whole before the first guard call and after the third, and every read must succeed and match.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseManifestText } from '../../src/core/manifest.js';
import { guardProblem, tenantGuard, type GuardCall } from '../../src/core/safety.js';
import { WritecheckError } from '../../src/core/util.js';

const ok = (data: unknown) => ({ ok: true, isError: false, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
const err = (t: string) => ({ ok: false, isError: true, data: null, text: t, timed_out: false, transport_error: null, rpc_error: null });

const SQL = { name: 'mysql_query', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };

/** A one-tool SQL server over one table: the fixture row mwsc-fx-1 and a scratch row. */
function sqlServer(o: { guard?: (rows: Map<string, Record<string, unknown>>) => unknown; extraTools?: Record<string, unknown>[]; fixtureFails?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>([
    ['mwsc-fx-1', { id: 'mwsc-fx-1', name: 'mwsc-fx-1', title: 'alpha', version: 1 }],
    ['mwsc-s-1', { id: 'mwsc-s-1', name: 'mwsc-s-1', title: 'seed', version: 1 }],
  ]);
  const sent: string[] = [];
  let seq = 0;
  let writes = 0;
  let guardCalls = 0;
  const session = {
    stepId: (x: string) => `${x}#${++seq}`,
    listTools: async () => [SQL, ...(o.extraTools ?? [])],
    reserveWrites(n: number) {
      writes += n;
    },
    async call(_label: string, tool: string, args: { sql?: string }) {
      assert.equal(tool, 'mysql_query');
      const sql = args.sql ?? '';
      sent.push(sql);
      if (sql.startsWith('SELECT name FROM mwsc_items WHERE id')) {
        guardCalls++;
        return ok(o.guard ? o.guard(rows) : [{ name: rows.get('mwsc-fx-1')!['name'] }]);
      }
      if (sql.startsWith('SELECT * FROM mwsc_items WHERE id =')) {
        if (o.fixtureFails) return err('Error: boom');
        const id = /'([^']+)'/.exec(sql)![1]!;
        return ok(rows.has(id) ? [rows.get(id)] : []);
      }
      if (sql.startsWith('SELECT * FROM mwsc_items WHERE id <>')) return ok([...rows.values()].filter((r) => r['id'] !== 'mwsc-fx-1'));
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { rows, sent, session, writes: () => writes, guardCalls: () => guardCalls };
}

const man = (o: { guard?: string; list?: boolean; fixture?: boolean; otherRead?: boolean } = {}) =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: ${o.guard ?? `{ tool: mysql_query, args: { sql: "SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'" }, path: "$[0].name", pattern: "^mwsc-fx-1$", read_only_call: true }`} }
resources:
  - name: item
${o.fixture === false ? '    create: { tool: mysql_query, args: { sql: "INSERT {{marker}}" }, id_regex: "id: (\\\\d+)" }\n    cleanup: delete\n    delete: { tool: mysql_query, args: { sql: "DELETE {{id}}" } }\n' : '    fixture: { id: mwsc-fx-1, name: mwsc-fx-1, name_path: name }\n    cleanup: leave\n'}    read: { tool: ${o.otherRead ? 'get_item' : 'mysql_query'}, args: { sql: "SELECT * FROM mwsc_items WHERE id = '{{id}}'" }, items: "$", match: id, ignore: [version] }
${o.list ? '    list: { tool: mysql_query, args: { sql: "SELECT * FROM mwsc_items WHERE id <> \'mwsc-fx-1\'" }, items: "$", id: id, name: name }\n' : ''}`,
    'm.yaml',
  );

const refused = (re: RegExp[]) => (e: unknown) => {
  assert.ok(e instanceof WritecheckError, String(e));
  assert.equal(e.code, 3);
  for (const r of re) assert.match(e.message, r);
  return true;
};

test('t12: guardProblem accepts read_only_call through a destructive dispatcher that is the only read route', () => {
  const m = man({ list: true });
  assert.equal(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m }), null);
});

test('t12: guardProblem refuses the destructive dispatcher when a read-only tool exists', () => {
  const m = man({ list: true });
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: ['list_tables'], manifest: m })!, /offers read-only tools \(list_tables\)/);
});

test('t12: guardProblem refuses the destructive dispatcher when the manifest reads through another tool', () => {
  const m = man({ otherRead: true });
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m })!, /destructiveHint: true; .*only read route, and this manifest reads through get_item/);
});

test('t12: guardProblem refuses the destructive dispatcher without the manifest to judge it by, or with nothing to compare', () => {
  const m = man();
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [] })!, /destructiveHint: true/);
  const bare = man({ fixture: false });
  assert.match(guardProblem(bare.target.guard!, SQL, { readOnlyTools: [], manifest: bare })!, /declares none/);
});

test('t12: a guard not declared read_only_call is still refused on a destructive tool (annotation or read_only: true)', () => {
  const plain = man({ guard: `{ tool: mysql_query, args: { sql: "SELECT 1" }, path: x, pattern: "^a$" }` });
  assert.match(guardProblem(plain.target.guard!, SQL, { readOnlyTools: [], manifest: plain, anyAnnotated: true })!, /readOnlyHint: false or destructiveHint: true/);
  const ro = man({ guard: `{ tool: mysql_query, args: { sql: "SELECT 1" }, path: x, pattern: "^a$", read_only: true }` });
  assert.match(guardProblem(ro.target.guard!, SQL, { readOnlyTools: [], manifest: ro, anyAnnotated: true })!, /declare the exact call instead: target.guard.read_only_call: true/);
});

test('t12: a SELECT guard through the destructive dispatcher passes; the fixture and the list are read around the three calls', async () => {
  const d = sqlServer();
  const calls: GuardCall[] = [];
  const g = await tenantGuard(man({ list: true }), d.session as never, 'G', { onCall: (c) => calls.push(c) });
  assert.equal(g.basis, 'operator');
  assert.equal(g.destructive, true);
  assert.equal(g.matched, 'mwsc-fx-1');
  assert.equal(calls.length, 3);
  assert.equal(d.writes(), 3, 'each declared call still counts as a write');
  assert.match(g.state ?? '', /fixture item "mwsc-fx-1", list mysql_query .* read the same before and after the three calls/);
  const fx = "SELECT * FROM mwsc_items WHERE id = 'mwsc-fx-1'";
  const ls = "SELECT * FROM mwsc_items WHERE id <> 'mwsc-fx-1'";
  const gd = "SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'";
  assert.deepEqual(d.sent, [fx, ls, gd, gd, gd, fx, ls]);
});

test('t12: a guard call that changes the fixture (an ignored field included) and answers the same each time is refused', async () => {
  // The answer never changes, the list excludes the fixture, and version is in read.ignore: only the whole fixture read catches it.
  const d = sqlServer({ guard: (rows) => ((rows.get('mwsc-fx-1')!['version'] as number)++, [{ name: 'mwsc-fx-1' }]) });
  await assert.rejects(tenantGuard(man({ list: true }), d.session as never, 'G'), refused([/fixture item "mwsc-fx-1" changed across its three calls/, /was sent 3 time\(s\)/, /may have changed state/]));
  assert.equal(d.guardCalls(), 3);
});

test('t12: a fixture that cannot be read refuses the destructive dispatcher guard', async () => {
  const d = sqlServer({ fixtureFails: true });
  await assert.rejects(tenantGuard(man({ list: true }), d.session as never, 'G'), refused([/destructiveHint: true .*compared in full; fixture item "mwsc-fx-1" could not be read/]));
});

test('t12: a read-only tool in tools/list refuses the destructive dispatcher guard before any call', async () => {
  const d = sqlServer({ extraTools: [{ name: 'list_tables', annotations: { readOnlyHint: true } }] });
  await assert.rejects(tenantGuard(man({ list: true }), d.session as never, 'G'), refused([/offers read-only tools/]));
  assert.deepEqual(d.sent, []);
});
