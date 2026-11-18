/**
 * t12 (mcp-server-mysql 2.0.9): with writes on, the server's only tool, `mysql_query`, declares destructiveHint: true. A guard
 * declared read_only_call through it (a SELECT) is now accepted only where it is the server's only read route (no tool declares
 * readOnlyHint: true and the manifest reads only through it) and there is state to compare; the run then also reads every
 * pre-made fixture whole before the first guard call and after the third, and every read must succeed and match.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseManifestText } from '../../src/core/manifest.js';
import { guardArgsProblem, guardProblem, tenantGuard, type GuardCall, type GuardStateRead } from '../../src/core/safety.js';
import { WritecheckError } from '../../src/core/util.js';

const ok = (data: unknown) => ({ ok: true, isError: false, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
const err = (t: string) => ({ ok: false, isError: true, data: null, text: t, timed_out: false, transport_error: null, rpc_error: null });

const SQL = { name: 'mysql_query', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };

/** A one-tool SQL server over one table: the fixture row mwsc-fx-1 and a scratch row. */
function sqlServer(o: { guard?: (rows: Map<string, Record<string, unknown>>) => unknown; extraTools?: Record<string, unknown>[]; fixtureFails?: boolean | 'after'; listMore?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>([
    ['mwsc-fx-1', { id: 'mwsc-fx-1', name: 'mwsc-fx-1', title: 'alpha', version: 1 }],
    ['mwsc-s-1', { id: 'mwsc-s-1', name: 'mwsc-s-1', title: 'seed', version: 1 }],
  ]);
  const sent: string[] = [];
  let seq = 0;
  let writes = 0;
  let guardCalls = 0;
  let fixtureReads = 0;
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
        fixtureReads++;
        if (o.fixtureFails === true || (o.fixtureFails === 'after' && fixtureReads > 1)) return err('Error: boom');
        const id = /'([^']+)'/.exec(sql)![1]!;
        return ok(rows.has(id) ? [rows.get(id)] : []);
      }
      if (sql.startsWith('SELECT * FROM mwsc_items WHERE id <>')) {
        const items = [...rows.values()].filter((r) => r['id'] !== 'mwsc-fx-1');
        return ok(o.listMore ? { items, has_more: true } : items);
      }
      if (sql.startsWith('SELECT COUNT')) return ok({ n: rows.size, v: [...rows.values()].reduce((a, r) => a + (r['version'] as number), 0) });
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { rows, sent, session, writes: () => writes, guardCalls: () => guardCalls };
}

const man = (o: { guard?: string; list?: boolean; fixture?: boolean; otherRead?: boolean; canary?: boolean; listItems?: string } = {}) =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: ${o.guard ?? `{ tool: mysql_query, args: { sql: "SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'" }, path: "$[0].name", pattern: "^mwsc-fx-1$", read_only_call: true }`} }
${o.canary ? 'canaries:\n  - { name: count, tool: mysql_query, args: { sql: "SELECT COUNT(*) FROM mwsc_items" }, ignore: [v] }\n' : ''}resources:
  - name: item
${o.fixture === false ? '    create: { tool: mysql_query, args: { sql: "INSERT {{marker}}" }, id_regex: "id: (\\\\d+)" }\n    cleanup: delete\n    delete: { tool: mysql_query, args: { sql: "DELETE {{id}}" } }\n' : '    fixture: { id: mwsc-fx-1, name: mwsc-fx-1, name_path: name }\n    cleanup: leave\n'}    read: { tool: ${o.otherRead ? 'get_item' : 'mysql_query'}, args: { sql: "SELECT * FROM mwsc_items WHERE id = '{{id}}'" }, items: "$", match: id, ignore: [version] }
${o.list ? '    list: { tool: mysql_query, args: { sql: "SELECT * FROM mwsc_items WHERE id <> \'mwsc-fx-1\'" }, items: "' + (o.listItems ?? '$') + '", id: id, name: name, ignore: [title] }\n' : ''}`,
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
  assert.equal(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m, tools: [SQL] }), null);
});

test('t12: guardProblem refuses the destructive dispatcher when a read-only tool exists', () => {
  const m = man({ list: true });
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: ['list_tables'], manifest: m, tools: [SQL] })!, /offers read-only tools \(list_tables\)/);
});

test('t12: guardProblem refuses the destructive dispatcher when the manifest reads through another tool', () => {
  const m = man({ otherRead: true });
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m, tools: [SQL] })!, /destructiveHint: true; .*only read route, and this manifest reads through get_item/);
});

test('t12: guardProblem refuses the destructive dispatcher without the manifest to judge it by, or with nothing to compare', () => {
  const m = man();
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [] })!, /destructiveHint: true/);
  const bare = man({ fixture: false });
  assert.match(guardProblem(bare.target.guard!, SQL, { readOnlyTools: [], manifest: bare, tools: [SQL] })!, /declares none/);
});

test('t12: a guard not declared read_only_call is still refused on a destructive tool (annotation or read_only: true)', () => {
  const plain = man({ guard: `{ tool: mysql_query, args: { sql: "SELECT 1" }, path: x, pattern: "^a$" }` });
  assert.match(guardProblem(plain.target.guard!, SQL, { readOnlyTools: [], manifest: plain, anyAnnotated: true, tools: [SQL] })!, /readOnlyHint: false or destructiveHint: true/);
  const ro = man({ guard: `{ tool: mysql_query, args: { sql: "SELECT 1" }, path: x, pattern: "^a$", read_only: true }` });
  assert.match(guardProblem(ro.target.guard!, SQL, { readOnlyTools: [], manifest: ro, anyAnnotated: true, tools: [SQL] })!, /declare the exact call instead: target.guard.read_only_call: true/);
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

// ---- review on 1b7e1e1: F1-F6 ----

test('F1: a guard call that changes an ignored field on a listed row (not the fixture) is refused; lists are read with no ignored field left out', async () => {
  const d = sqlServer({ guard: (rows) => ((rows.get('mwsc-s-1')!['version'] as number)++, [{ name: 'mwsc-fx-1' }]) });
  await assert.rejects(tenantGuard(man({ list: true }), d.session as never, 'G'), refused([/list mysql_query .* changed across its three calls/]));
  const t = sqlServer({ guard: (rows) => ((rows.get('mwsc-s-1')!['title'] = 'x'), [{ name: 'mwsc-fx-1' }]) });
  await assert.rejects(tenantGuard(man({ list: true }), t.session as never, 'G'), refused([/list mysql_query .* changed/]), 'list.ignore is not applied either');
});

test('F1: a canary-only manifest (no fixture) is accepted, and a change to a field the canary ignores is refused', async () => {
  const m = man({ fixture: false, canary: true });
  assert.equal(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m, tools: [SQL] }), null);
  const okd = sqlServer();
  const g = await tenantGuard(m, okd.session as never, 'G');
  assert.match(g.state ?? '', /^canary count read the same/);
  const d = sqlServer({ guard: (rows) => ((rows.get('mwsc-s-1')!['version'] as number)++, [{ name: 'mwsc-fx-1' }]) });
  await assert.rejects(tenantGuard(m, d.session as never, 'G'), refused([/canary count changed across its three calls/]));
});

test('F6: a fixture read that works before the calls and fails after them refuses the guard', async () => {
  const d = sqlServer({ fixtureFails: 'after' });
  await assert.rejects(tenantGuard(man({ list: true }), d.session as never, 'G'), refused([/fixture item "mwsc-fx-1" answered before the guard's calls and not after them/, /was sent 3 time\(s\)/]));
});

test('F6: a list read only in part counts as unread in dispatcher mode and refuses the guard', async () => {
  const d = sqlServer({ listMore: true });
  await assert.rejects(tenantGuard(man({ list: true, listItems: 'items' }), d.session as never, 'G'), refused([/compared in full; list mysql_query .* could not be read/]));
});

test('F2: guard arguments with a write, lock or side-effect word, a comment or a second statement are refused; a plain SELECT is not', () => {
  assert.equal(guardArgsProblem({ sql: "SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1'" }), null);
  assert.equal(guardArgsProblem({ sql: "SELECT name FROM mwsc_items WHERE id = 'mwsc-fx-1';" }), null, 'one trailing ; is one statement');
  for (const [sql, re] of [
    ['DELETE FROM mwsc_audit', /"DELETE"/],
    ['delete from mwsc_audit', /"delete"/],
    ["SELECT name FROM mwsc_items WHERE id = 'x' FOR UPDATE", /"FOR UPDATE"/],
    ["SELECT name FROM t FOR  share", /"FOR  share"/],
    ["SELECT name FROM t LOCK IN SHARE MODE", /"LOCK"/],
    ["SELECT GET_LOCK('a', 1)", /"GET_LOCK"/],
    ["SELECT pg_advisory_lock(1)", /"pg_advisory_lock"/],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", /"INTO"/],
    ['CALL proc()', /"CALL"/],
    ['SET @a = 1', /"SET"/],
    ['REPLACE INTO t VALUES (1)', /"REPLACE"/],
    ['MERGE INTO t', /"MERGE"/],
    ['TRUNCATE t', /"TRUNCATE"/],
    ['GRANT ALL ON t TO u', /"GRANT"/],
    ['EXEC sp_x', /"EXEC"/],
    ['COPY t TO STDOUT', /"COPY"/],
    ["SELECT nextval('s')", /"nextval"/],
    ['SELECT 1; DROP TABLE x', /more than one statement/],
    ['DELETE FROM mwsc_audit; DROP TABLE x', /more than one statement|"DELETE"/],
    ['SELECT /*!50000 1 */ FROM t', /comment marker/],
    ['SELECT 1 -- x', /comment marker/],
    ['SELECT 1 # x', /comment marker/],
  ] as [string, RegExp][]) assert.match(guardArgsProblem({ sql }) ?? 'accepted', re, sql);
  assert.match(guardArgsProblem({ q: { nested: ['ok', 'UPDATE t SET a = 1'] } }) ?? '', /"UPDATE"/, 'nested strings are checked');
});

test('F2: guardProblem refuses the destructive dispatcher guard with write words (probe E), and the plan text names them', () => {
  const m = man({ list: true, guard: `{ tool: mysql_query, args: { sql: "DELETE FROM mwsc_audit; DROP TABLE x" }, path: x, pattern: "^a$", read_only_call: true }` });
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m, tools: [SQL] })!, /destructiveHint: true, and the declared call's arguments .*must be a plain read/);
});

test('F3: another tool that declares neither readOnlyHint: false nor destructiveHint: true refuses the destructive dispatcher guard', () => {
  const m = man({ list: true });
  for (const other of [{ name: 'get_row' }, { name: 'get_row', annotations: {} }, { name: 'get_row', annotations: { destructiveHint: false } }])
    assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m, tools: [SQL, other] })!, /this server offers get_row, which declare neither readOnlyHint: false nor destructiveHint: true/);
  // a tool that declares itself a write is not a read route
  assert.equal(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m, tools: [SQL, { name: 'drop_db', annotations: { readOnlyHint: false } }, { name: 'w', annotations: { destructiveHint: true } }] }), null);
  assert.match(guardProblem(m.target.guard!, SQL, { readOnlyTools: [], manifest: m })!, /not known here/, 'without tools/list it fails closed');
});

test('F4: every state read is announced before it is sent, with its phase, around the three guard calls', async () => {
  const d = sqlServer();
  const seen: string[] = [];
  const reads: GuardStateRead[] = [];
  await tenantGuard(man({ list: true }), { ...d.session, call: async (...a: Parameters<typeof d.session.call>) => (seen.push(`sent ${a[2].sql}`), d.session.call(...a)) } as never, 'G', {
    onCall: (c) => seen.push(`call ${c.phase}`),
    onStateRead: (r) => (reads.push(r), seen.push(`state ${r.phase} ${r.what.split(' ')[0]}`)),
  });
  assert.deepEqual(reads.map((r) => [r.phase, r.tool, r.what.split(' ')[0]]), [['before', 'mysql_query', 'fixture'], ['before', 'mysql_query', 'list'], ['after', 'mysql_query', 'fixture'], ['after', 'mysql_query', 'list']]);
  // each announcement comes right before its read goes out
  assert.deepEqual(seen.filter((x) => !x.startsWith('sent')).slice(0, 3), ['state before fixture', 'state before list', 'call check']);
  assert.equal(seen.indexOf('state before fixture') + 1, seen.findIndex((x) => x.startsWith("sent SELECT * FROM mwsc_items WHERE id = 'mwsc-fx-1'")));
});
