/**
 * The Postgres side of the wire gate without a socket: the SQL classifier (write or read, verb,
 * table, values removed, unknown counted as a write with the reason), and the codec's framing of
 * synthetic frames (every chunk split, extended groups to Sync or Flush, the answer boundaries,
 * skip-to-Sync after an error, and the emulation after an injected error).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pg, PostgresSession } from '../../src/gate/wire/postgres.js';
import { classifySql, combine } from '../../src/gate/wire/sql.js';
import { PgClient } from '../wire/pg.js';

const one = (sql: string) => {
  const c = combine(classifySql(sql));
  return [c.verb, c.path, c.mutating, c.uncertain ? 'uncertain' : 'certain'];
};

test('sql: writes, reads and control statements are named with their table', () => {
  const cases: [string, unknown[]][] = [
    ["UPDATE mwsc_items SET title = 'x' WHERE id = $1", ['UPDATE', 'mwsc_items', true, 'certain']],
    ['update ONLY public.Items set a=1', ['UPDATE', 'public.items', true, 'certain']],
    ['INSERT INTO "Mixed"."Case" (a) VALUES (1)', ['INSERT', 'Mixed.Case', true, 'certain']],
    ['DELETE FROM t WHERE id = 1', ['DELETE', 't', true, 'certain']],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1', ['MERGE', 't', true, 'certain']],
    ['TRUNCATE TABLE t', ['TRUNCATE', 't', true, 'certain']],
    ['COPY t FROM STDIN', ['COPY FROM', 't', true, 'certain']],
    ['COPY t TO STDOUT', ['COPY TO', 't', false, 'certain']],
    ['COPY (SELECT 1) TO STDOUT', ['COPY TO', '', false, 'certain']],
    ['CREATE TABLE IF NOT EXISTS t (a int)', ['CREATE TABLE', 't', true, 'certain']],
    ['DROP TABLE IF EXISTS t', ['DROP TABLE', 't', true, 'certain']],
    ['SELECT id, title FROM mwsc_items WHERE id = $1', ['SELECT', 'mwsc_items', false, 'certain']],
    ['SELECT count(*), coalesce(max(v), 0) FROM t', ['SELECT', 't', false, 'certain']],
    ['SELECT * FROM t WHERE id = ANY($1) AND EXISTS (SELECT 1 FROM u)', ['SELECT', 't', false, 'certain']],
    ['SELECT a::varchar(10) FROM t', ['SELECT', 't', false, 'certain']],
    ['SELECT * FROM t FOR UPDATE', ['SELECT', 't', false, 'certain']],
    ["SELECT nextval('s')", ['SELECT', '', true, 'uncertain']],
    ['SELECT my_proc(1) FROM t', ['SELECT', 't', true, 'uncertain']],
    ['SELECT * INTO newt FROM t', ['SELECT INTO', 'newt', true, 'certain']],
    ['WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x', ['WITH UPDATE', 't', true, 'certain']],
    ['WITH x AS (SELECT * FROM t) SELECT * FROM x FOR UPDATE', ['WITH SELECT', 'x', false, 'certain']],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x ON CONFLICT (id) DO UPDATE SET a = 1', ['WITH INSERT', 't', true, 'certain']],
    ['EXPLAIN SELECT * FROM t', ['EXPLAIN', 't', false, 'certain']],
    ['EXPLAIN UPDATE t SET a = 1', ['EXPLAIN', 't', false, 'certain']],
    ['EXPLAIN ANALYZE UPDATE t SET a = 1', ['EXPLAIN ANALYZE UPDATE', 't', true, 'certain']],
    ['EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t', ['EXPLAIN ANALYZE DELETE', 't', true, 'certain']],
    ['CALL do_things(1)', ['CALL', 'do_things', true, 'uncertain']],
    ["DO $$ BEGIN UPDATE t SET a = 1; END $$", ['DO', '', true, 'uncertain']],
    ['BEGIN', ['BEGIN', '', false, 'certain']],
    ['START TRANSACTION ISOLATION LEVEL SERIALIZABLE', ['BEGIN', '', false, 'certain']],
    ['END', ['COMMIT', '', false, 'certain']],
    ['ABORT', ['ROLLBACK', '', false, 'certain']],
    ['ROLLBACK TO SAVEPOINT s1', ['ROLLBACK TO', '', false, 'certain']],
    ["SET search_path = 'x'", ['SET', '', false, 'certain']],
    ['LOCK TABLE t IN EXCLUSIVE MODE', ['LOCK', '', false, 'certain']],
    ['VACUUM t', ['VACUUM', '', false, 'certain']],
    ['FROBNICATE t', ['FROBNICATE', '', true, 'uncertain']],
    ['', ['EMPTY', '', false, 'certain']],
  ];
  for (const [sql, want] of cases) assert.deepEqual(one(sql), want, sql);
});

test('sql: literals, comments and dollar quotes never hide or fake a write, and values are removed', () => {
  assert.deepEqual(one("SELECT 'UPDATE t SET a = 1' FROM t"), ['SELECT', 't', false, 'certain'], 'a write inside a string is a value');
  assert.deepEqual(one('SELECT 1 FROM t -- ; DELETE FROM t'), ['SELECT', 't', false, 'certain'], 'a write in a comment');
  assert.deepEqual(one('/* outer /* nested */ still */ DELETE FROM t'), ['DELETE', 't', true, 'certain']);
  assert.deepEqual(one("SELECT $tag$ ; DELETE FROM t $tag$ FROM t"), ['SELECT', 't', false, 'certain']);
  assert.deepEqual(one("SELECT E'it\\'s; DELETE FROM t' FROM t"), ['SELECT', 't', false, 'certain']);
  const c = combine(classifySql("UPDATE t SET name = 'Alice O''Brien', n = 42 WHERE id = 'x-1'"));
  assert.equal(c.statement, 'UPDATE t SET name = ?, n = ? WHERE id = ?');
  assert.ok(!/Alice|42|x-1/.test(c.statement));
});

test('sql: several statements in one Query take the first write and count the statements', () => {
  const c = combine(classifySql("BEGIN; SELECT v FROM kv WHERE k = 'a'; UPDATE kv SET v = 'b' WHERE k = 'a'; COMMIT"));
  assert.deepEqual([c.verb, c.path, c.mutating, c.statements], ['UPDATE', 'kv', true, 4]);
  const r = combine(classifySql('SELECT 1; SELECT 2'));
  assert.deepEqual([r.verb, r.mutating, r.statements], ['SELECT', false, 2]);
  const u = combine(classifySql('SELECT 1; FROB x'));
  assert.equal(u.mutating, true);
  assert.match(u.uncertain!, /unknown statement FROB/);
});

test('sql: PREPARE and EXECUTE on one connection', () => {
  const prepared = new Map();
  assert.deepEqual(combine(classifySql('PREPARE up (text) AS UPDATE t SET a = $1', prepared)).verb, 'PREPARE');
  assert.equal(combine(classifySql('PREPARE up (text) AS UPDATE t SET a = $1', prepared)).mutating, false);
  const e = combine(classifySql("EXECUTE up('x')", prepared));
  assert.deepEqual([e.verb, e.path, e.mutating, e.uncertain], ['UPDATE', 't', true, undefined]);
  const u = combine(classifySql('EXECUTE other', prepared));
  assert.deepEqual([u.verb, u.mutating], ['EXECUTE', true]);
  assert.match(u.uncertain!, /not prepared on this connection/);
});

function startup(): Buffer {
  const params = Buffer.concat([Buffer.from('user\0mws\0\0')]);
  const b = Buffer.alloc(8);
  b.writeInt32BE(params.length + 8, 0);
  b.writeInt32BE(196608, 4);
  return Buffer.concat([b, params]);
}

test('codec: units are the same whatever the chunk boundaries', () => {
  const ssl = Buffer.alloc(8);
  ssl.writeInt32BE(8, 0);
  ssl.writeInt32BE(80877103, 4);
  const stream = Buffer.concat([ssl, startup(), pg.msg('p', Buffer.from('pw\0')), PgClient.q("UPDATE kv SET v = 'b' WHERE k = 'a'"), PgClient.ext('SELECT v FROM kv WHERE k = $1', ['a']), PgClient.ext('DELETE FROM kv WHERE k = $1', ['a'], { end: 'H' }), pg.msg('S', Buffer.alloc(0)), pg.msg('X', Buffer.alloc(0))]);
  const shape = (us: ReturnType<PostgresSession['client']>) => us.map((u) => [u.req ? `${u.req.verb} ${u.req.path} ${u.req.mutating}` : u.localReply ? 'local' : 'pass', u.bytes.length]);
  const whole = new PostgresSession('k');
  const want = shape(whole.client(stream));
  assert.deepEqual(
    want.map((x) => x[0]),
    ['local', 'pass', 'pass', 'UPDATE kv true', 'SELECT kv false', 'DELETE kv true', 'SYNC  false', 'pass'],
  );
  for (let cut = 1; cut < stream.length; cut++) {
    const s = new PostgresSession('k');
    const got = shape([...s.client(stream.subarray(0, cut)), ...s.client(stream.subarray(cut))]);
    assert.deepEqual(got, want, `split at ${cut}`);
  }
  const bytes = new PostgresSession('k');
  const all: ReturnType<PostgresSession['client']> = [];
  for (const b of stream) all.push(...bytes.client(Buffer.from([b])));
  assert.deepEqual(shape(all), want, 'one byte at a time');
});

test('codec: an Execute of a named statement prepared in an earlier unit is classified by that statement', () => {
  const s = new PostgresSession('k');
  s.client(startup());
  const prep = Buffer.concat([pg.msg('P', Buffer.from('s1\0UPDATE t SET a = $1\0\0\0')), pg.msg('S', Buffer.alloc(0))]);
  const [p] = s.client(prep);
  assert.deepEqual([p!.req!.verb, p!.req!.mutating], ['PREPARE', false]);
  const bind = Buffer.concat([Buffer.from('\0s1\0'), Buffer.from([0, 0, 0, 0, 0, 0])]);
  const [e] = s.client(Buffer.concat([pg.msg('B', bind), pg.msg('E', Buffer.from('\0\0\0\0\0')), pg.msg('S', Buffer.alloc(0))]));
  assert.deepEqual([e!.req!.verb, e!.req!.path, e!.req!.mutating], ['UPDATE', 't', true]);
  const [u] = s.client(Buffer.concat([pg.msg('E', Buffer.from('nope\0\0\0\0\0')), pg.msg('S', Buffer.alloc(0))]));
  assert.equal(u!.req!.mutating, true);
  assert.match(u!.req!.uncertain!, /portal nope, whose statement was not seen/);
});

test('codec: answer boundaries (ReadyForQuery, counted Flush units, skip to Sync after an error)', () => {
  const s = new PostgresSession('k');
  s.client(startup());
  const auth = Buffer.concat([pg.msg('R', Buffer.from([0, 0, 0, 0])), pg.ready('idle')]);
  assert.deepEqual(s.server(auth).map((p) => p.unit), [null, null], 'startup answers belong to no unit');
  const [q] = s.client(PgClient.q('UPDATE t SET a = 1'));
  s.sent(1, q!);
  const notice = pg.msg('N', Buffer.from('SNOTICE\0\0'));
  const ps = s.server(Buffer.concat([notice, pg.complete('UPDATE 1'), pg.ready('idle')]));
  assert.deepEqual(ps.map((p) => [p.unit, !!p.end]), [[null, false], [1, false], [1, true]]);
  assert.deepEqual(ps[2]!.end, { status: 200, reply: 'CommandComplete UPDATE 1', txn: 'idle' });
  // Two Flush units and a Sync unit pipelined; the first fails: the second gets nothing, the Sync's ReadyForQuery ends it.
  const [f1] = s.client(PgClient.ext('UPDATE t SET a = $1', ['x'], { end: 'H' }));
  const [f2] = s.client(PgClient.ext('UPDATE t SET b = $1', ['y'], { end: 'H' }));
  const [sy] = s.client(pg.msg('S', Buffer.alloc(0)));
  s.sent(2, f1!);
  s.sent(3, f2!);
  s.sent(4, sy!);
  const err = pg.error('23505', 'dup');
  const ps2 = s.server(Buffer.concat([pg.msg('1', Buffer.alloc(0)), pg.msg('2', Buffer.alloc(0)), err, pg.ready('idle')]));
  assert.deepEqual(ps2.map((p) => [p.unit, p.end?.status ?? null]), [[2, null], [2, null], [2, 400], [3, 400], [4, 200]]);
  assert.equal(ps2[2]!.end!.reply, 'ErrorResponse 23505');
  // A Flush unit answered in full ends on its last answer, without a ReadyForQuery.
  const [f3] = s.client(PgClient.ext('SELECT a FROM t', [], { end: 'H' }));
  s.sent(5, f3!);
  const ps3 = s.server(Buffer.concat([pg.msg('1', Buffer.alloc(0)), pg.msg('2', Buffer.alloc(0)), pg.msg('n', Buffer.alloc(0)), pg.msg('D', Buffer.from([0, 0])), pg.complete('SELECT 1')]));
  assert.equal(ps3[ps3.length - 1]!.end?.reply, 'CommandComplete SELECT 1');
});

test('codec: transaction end and commit are reported from ReadyForQuery', () => {
  const s = new PostgresSession('k');
  s.client(startup());
  s.server(pg.ready('idle'));
  const step = (sql: string, id: number, reply: Buffer[]) => {
    const [u] = s.client(PgClient.q(sql));
    s.sent(id, u!);
    return s.server(Buffer.concat(reply)).find((p) => p.end)!.end!;
  };
  assert.deepEqual(step('BEGIN', 1, [pg.complete('BEGIN'), pg.ready('in')]).txn, 'in');
  assert.deepEqual(step('UPDATE t SET a = 1', 2, [pg.complete('UPDATE 1'), pg.ready('in')]), { status: 200, reply: 'CommandComplete UPDATE 1', txn: 'in' });
  assert.deepEqual(step('COMMIT', 3, [pg.complete('COMMIT'), pg.ready('idle')]), { status: 200, reply: 'CommandComplete COMMIT', txn: 'idle', ended: true, committed: true });
  step('BEGIN', 4, [pg.complete('BEGIN'), pg.ready('in')]);
  assert.deepEqual(step('ROLLBACK', 5, [pg.complete('ROLLBACK'), pg.ready('idle')]), { status: 200, reply: 'CommandComplete ROLLBACK', txn: 'idle', ended: true, rolledBack: true });
  step('BEGIN', 6, [pg.complete('BEGIN'), pg.ready('in')]);
  step('BAD', 7, [pg.error('42601', 'x'), pg.ready('failed')]);
  assert.deepEqual(step('COMMIT', 8, [pg.complete('ROLLBACK'), pg.ready('idle')]), { status: 200, reply: 'CommandComplete ROLLBACK', txn: 'idle', ended: true, rolledBack: true }, 'COMMIT of a failed transaction is not a commit');
  step('BEGIN', 9, [pg.complete('BEGIN'), pg.ready('in')]);
  assert.deepEqual(step("PREPARE TRANSACTION 'x'", 10, [pg.complete('PREPARE TRANSACTION'), pg.ready('idle')]), { status: 200, reply: 'CommandComplete PREPARE TRANSACTION', txn: 'idle', ended: true, rolledBack: true }, 'PREPARE TRANSACTION ends the transaction without committing it');
});

test('codec: after an error injected inside a transaction, the gate answers as a failed transaction until it ends', () => {
  const s = new PostgresSession('k');
  s.client(startup());
  s.server(pg.ready('in'));
  const [u] = s.client(PgClient.q('UPDATE t SET a = 1'));
  const inj = s.injectError(u!, 'boom', 'in');
  assert.match(inj.bytes.toString('latin1'), /CXX000/);
  assert.equal(inj.bytes[inj.bytes.length - 1], 0x45, 'ReadyForQuery E');
  assert.equal(s.txn('k'), 'failed');
  const [sel] = s.client(PgClient.q('SELECT 1'));
  const i1 = s.intercept(sel!);
  assert.ok(i1 && 'synth' in i1);
  assert.match(i1.synth.toString('latin1'), /C25P02/);
  const [commit] = s.client(PgClient.ext('COMMIT', []));
  const i2 = s.intercept(commit!);
  assert.ok(i2 && 'forward' in i2);
  assert.match(i2.forward.bytes.toString('latin1'), /^Q.*ROLLBACK/s);
  assert.equal(i2.answer.toString('latin1').replace(/[^A-Za-z0-9]/g, ''), '12nCROLLBACKZI');
  assert.equal(s.intercept(sel!), null, 'in step again');
});

test('egress: database schemes only for the wire gate, with their default ports', async () => {
  const { assertEgress, egressFor } = await import('../../src/core/egress.js');
  const p = egressFor(['postgres://u:p@db.local/x', 'redis://cache', 'mongodb://m:27018/x', 'https://api.example.com/v1']);
  assert.deepEqual(p.allow.sort(), ['api.example.com:443', 'cache:6379', 'db.local:5432', 'm:27018']);
  assert.throws(() => assertEgress(new URL('postgres://db.local/x'), p), /scheme postgres:/, "the tester's own requests stay HTTP");
  assertEgress(new URL('postgres://db.local/x'), p, { wire: true });
  assert.throws(() => assertEgress(new URL('postgres://other/x'), p, { wire: true }), /not on the egress list/);
  assert.throws(() => assertEgress(new URL('file:///etc/passwd'), p, { wire: true }), /scheme/);
});

test('sql (review 3, 10): COPY (query), schema-qualified and pg_-named functions, cursors, backslash escapes, SET values', () => {
  assert.deepEqual(one('COPY (DELETE FROM t WHERE a = 1 RETURNING *) TO STDOUT'), ['COPY (DELETE)', 't', true, 'certain']);
  assert.deepEqual(one("COPY (SELECT nextval('s')) TO STDOUT"), ['COPY (SELECT)', '', true, 'uncertain']);
  assert.deepEqual(one('COPY (SELECT a FROM t) TO STDOUT'), ['COPY TO', 't', false, 'certain']);
  assert.deepEqual(one('SELECT evil.count(*) FROM t'), ['SELECT', 't', true, 'uncertain'], 'a qualified name outside pg_catalog is not trusted');
  assert.match(combine(classifySql('SELECT evil.count(*) FROM t')).uncertain!, /evil\.count\(\)/);
  assert.deepEqual(one('SELECT pg_catalog.count(*) FROM t'), ['SELECT', 't', false, 'certain']);
  assert.deepEqual(one('SELECT pg_get_evil(1)'), ['SELECT', '', true, 'uncertain'], 'a pg_get_ prefix is not trusted');
  const prepared = new Map();
  assert.equal(combine(classifySql("DECLARE c CURSOR FOR SELECT nextval('s') FROM t", prepared)).mutating, false, 'DECLARE runs nothing');
  const f = combine(classifySql('FETCH 10 FROM c', prepared));
  assert.deepEqual([f.verb, f.mutating], ['FETCH', true]);
  assert.match(f.uncertain!, /cursor c/);
  classifySql('DECLARE r CURSOR WITH HOLD FOR SELECT a FROM t', prepared);
  assert.equal(combine(classifySql('FETCH NEXT IN r', prepared)).mutating, false);
  // standard_conforming_strings = off: a backslash escapes a quote, so the DELETE is code, not string.
  const hidden = "SELECT 'a\\' x 'y; DELETE FROM t; --'";
  assert.equal(combine(classifySql(hidden)).mutating, false, 'read as one string with the default setting');
  assert.equal(combine(classifySql(hidden, new Map(), { backslashEscapes: true })).mutating, true, 'read as code with standard_conforming_strings off');
  assert.equal(combine(classifySql('SET app.token = abc123')).statement, 'SET app.token');
  assert.equal(combine(classifySql('SET SESSION search_path TO private_schema')).statement, 'SET search_path');
});

test('codec: standard_conforming_strings from ParameterStatus changes how later statements are read', () => {
  const s = new PostgresSession('k');
  s.client(startup());
  s.server(Buffer.concat([pg.msg('S', Buffer.from('standard_conforming_strings\0off\0')), pg.ready('idle')]));
  const [u] = s.client(PgClient.q("SELECT 'a\\' x 'y; DELETE FROM t; --'"));
  assert.equal(u!.req!.mutating, true);
});
