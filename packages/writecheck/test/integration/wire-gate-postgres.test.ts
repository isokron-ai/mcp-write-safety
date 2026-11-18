/**
 * The wire gate in front of a minimal in-process Postgres (test/wire/pg.ts): pass-through and the
 * request log, SSLRequest answered by the gate, pipelining and one-byte writes, the hold with a
 * second connection finishing first, the nth match, the four faults, the deferred fault at COMMIT,
 * and the emulation after an error injected inside a transaction. Real drivers and a real Postgres
 * are verified on the Mac (docs/WIRE-GATE.md §7).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { egressFor } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { createGate, lastMutating, nthOf } from '../../src/gate/gate.js';
import { PostgresSession } from '../../src/gate/wire/postgres.js';
import { WireGate } from '../../src/gate/wire/proxy.js';
import { fakePostgres, PgClient, type FakePg } from '../wire/pg.js';

async function setup(initial: Record<string, string> = { a: '1', b: '1' }): Promise<{ db: FakePg; g: WireGate; port: number; done: () => Promise<void> }> {
  const db = await fakePostgres(initial);
  const g = new WireGate('postgres', 'DATABASE_URL', db.url, egressFor([]), 1_000, (k) => new PostgresSession(k));
  await g.start();
  const port = Number(/:(\d+)\//.exec(g.serverEnv()['DATABASE_URL']!)![1]);
  return { db, g, port, done: async () => (await g.stop(), await db.close()) };
}

test('postgres gate: forwards faithfully, rewrites only host and port, logs each unit with its class and answer', async () => {
  const { db, g, port, done } = await setup();
  try {
    assert.match(g.serverEnv()['DATABASE_URL']!, /^postgres:\/\/mws:secret@127\.0\.0\.1:\d+\/mwsc$/);
    assert.match(g.describe(), /DATABASE_URL .*loopback wire gate 127\.0\.0\.1:\d+.*forwards every connection to 127\.0\.0\.1:\d+ and reads the Postgres v3 protocol/);
    const c = await PgClient.connect(port, { ssl: true });
    assert.equal(c.sslAnswer, 'N', 'the gate answers the SSLRequest itself');
    const m0 = g.mark();
    assert.deepEqual((await c.query("UPDATE kv SET v = 'x' WHERE k = 'a'")).tags, ['UPDATE 1']);
    assert.deepEqual((await c.send(PgClient.ext('SELECT v FROM kv WHERE k = $1', ['a']))).rows, ['x']);
    const bad = await c.query("INSERT INTO kv (k, v) VALUES ('a', 'dup')");
    assert.deepEqual([bad.error, bad.state], ['23505', 'I']);
    const log = await g.since(m0);
    assert.deepEqual(
      log.map((r) => [r.method, r.path, r.mutating, r.status, r.wire?.reply]),
      [
        ['UPDATE', 'kv', true, 200, 'CommandComplete UPDATE 1'],
        ['SELECT', 'kv', false, 200, 'CommandComplete SELECT 1'],
        ['INSERT', 'kv', true, 400, 'ErrorResponse 23505'],
      ],
    );
    assert.equal(log[0]!.wire!.statement, 'UPDATE kv SET v = ? WHERE k = ?', 'values are not logged');
    assert.equal(db.table.get('a'), 'x');
    assert.equal(db.startups, 1);
    c.close();
  } finally {
    await done();
  }
});

test('postgres gate: pipelined units and one-byte writes are framed and answered in order', async () => {
  const { db, g, port, done } = await setup();
  try {
    const c = await PgClient.connect(port, { chunked: true });
    const m0 = g.mark();
    const three = Buffer.concat([PgClient.q("UPDATE kv SET v = 'p1' WHERE k = 'a'"), PgClient.ext('UPDATE kv SET v = $1 WHERE k = $2', ['p2', 'b']), PgClient.q("SELECT v FROM kv WHERE k = 'a'")]);
    const a = await c.send(three, { readies: 3, chunked: true });
    assert.deepEqual(a.tags, ['UPDATE 1', 'UPDATE 1', 'SELECT 1']);
    assert.deepEqual(a.rows, ['p1']);
    assert.deepEqual((await g.since(m0)).map((r) => `${r.method} ${r.path}`), ['UPDATE kv', 'UPDATE kv', 'SELECT kv']);
    assert.deepEqual([db.table.get('a'), db.table.get('b')], ['p1', 'p2']);
    c.close();
  } finally {
    await done();
  }
});

test('postgres gate: the learning pass names the last write, and a hold keeps it back while another connection finishes', async () => {
  const { db, g, port, done } = await setup();
  try {
    const A = await PgClient.connect(port);
    const B = await PgClient.connect(port);
    // Learning pass: a read-modify-write the way a server would do it.
    const m0 = g.mark();
    await A.query('BEGIN');
    await A.query("SELECT v FROM kv WHERE k = 'a'");
    await A.query("UPDATE kv SET v = 'learn' WHERE k = 'a'");
    await A.query('COMMIT');
    const learned = await g.since(m0);
    const last = lastMutating(learned)!;
    assert.deepEqual([last.method, last.path, nthOf(learned, last)], ['UPDATE', 'kv', 1], 'the write, not the COMMIT');
    // The held schedule.
    const h = g.hold({ method: 'UPDATE', path: 'kv', nth: 1 });
    const pa = A.query("UPDATE kv SET v = 'A' WHERE k = 'a'", 5000);
    const held = await h.waitHeld(2000);
    assert.ok(held, 'held');
    assert.equal(held.method, 'UPDATE');
    assert.ok(!db.seen.includes("UPDATE kv SET v = 'A' WHERE k = 'a'"), 'the held unit has not reached the database');
    const rb = await B.query("UPDATE kv SET v = 'B' WHERE k = 'a'");
    assert.deepEqual(rb.tags, ['UPDATE 1'], 'the other connection finishes while A is held');
    assert.equal(db.table.get('a'), 'B');
    await h.release();
    assert.deepEqual((await pa).tags, ['UPDATE 1']);
    assert.equal(db.table.get('a'), 'A', 'the held write lands after release');
    assert.ok(h.releasedAt);
    // nth: the 2nd matching unit from when the hold was armed.
    const h2 = g.hold({ method: 'UPDATE', path: 'kv', nth: 2 });
    await A.query("UPDATE kv SET v = '1st' WHERE k = 'b'");
    const p2 = A.query("UPDATE kv SET v = '2nd' WHERE k = 'b'", 5000);
    assert.ok(await h2.waitHeld(1000));
    assert.equal(db.table.get('b'), '1st');
    await h2.release();
    await p2;
    assert.equal(db.table.get('b'), '2nd');
    A.close();
    B.close();
  } finally {
    await done();
  }
});

test('postgres gate: status, commit_then_status, commit_then_reset and commit_then_hang', async () => {
  const { db, g, port, done } = await setup();
  try {
    // status: not forwarded; the client gets an ErrorResponse and ReadyForQuery I; the connection stays usable.
    const c = await PgClient.connect(port);
    const f1 = g.fault({ method: '*', path: '*', nth: 1, kind: 'status', status: 500 });
    await c.query("SELECT v FROM kv WHERE k = 'a'"); // a read does not count for '*'
    const r1 = await c.query("UPDATE kv SET v = 'no' WHERE k = 'a'");
    assert.deepEqual([r1.error, r1.state], ['XX000', 'I']);
    const hit1 = await f1.waitHit(500);
    assert.deepEqual([hit1?.method, hit1?.status, hit1?.wire?.synthetic], ['UPDATE', 500, true]);
    assert.equal(db.table.get('a'), '1', 'never reached the database');
    assert.ok(!db.seen.some((s) => s.includes("'no'")));
    assert.deepEqual((await c.query("UPDATE kv SET v = 'ok' WHERE k = 'a'")).tags, ['UPDATE 1'], 'still usable');
    // commit_then_status: forwarded and applied; the answer replaced.
    g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_status', status: 503 });
    const r2 = await c.send(PgClient.ext('UPDATE kv SET v = $1 WHERE k = $2', ['cts', 'a']));
    assert.deepEqual([r2.error, r2.state, r2.tags], ['XX000', 'I', []]);
    assert.equal(db.table.get('a'), 'cts');
    // commit_then_reset: applied, then the connection is cut before any answer.
    const f3 = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    const r3 = await c.query("UPDATE kv SET v = 'ctr' WHERE k = 'a'");
    assert.equal(r3.state, null);
    assert.ok(c.closed);
    assert.equal(db.table.get('a'), 'ctr');
    const hit3 = await f3.waitHit(500);
    assert.deepEqual([hit3?.status, hit3?.wire?.reply], [null, 'CommandComplete UPDATE 1 (answer cut by the gate)']);
    // commit_then_hang: applied, no answer, the connection stays open.
    const d = await PgClient.connect(port);
    const f4 = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_hang' });
    const r4 = await d.query("UPDATE kv SET v = 'cth' WHERE k = 'a'", 400);
    assert.equal(r4.state, null);
    assert.equal(d.closed, false);
    assert.equal(db.table.get('a'), 'cth');
    assert.ok(await f4.waitHit(200));
    d.close();
  } finally {
    await done();
  }
});

test('postgres gate: a lost-answer fault on a write inside a transaction is applied at its COMMIT', async () => {
  const { db, g, port, done } = await setup();
  try {
    const c = await PgClient.connect(port);
    const f = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    const m0 = g.mark();
    await c.query('BEGIN');
    const u = await c.query("UPDATE kv SET v = 'tx' WHERE k = 'a'");
    assert.deepEqual([u.tags, u.state], [['UPDATE 1'], 'T'], 'the write is answered: it is not committed yet');
    assert.equal(await f.waitHit(100), null, 'not hit until the commit');
    const cm = await c.query('COMMIT');
    assert.equal(cm.state, null, 'the COMMIT answer is cut');
    assert.equal(db.table.get('a'), 'tx', 'and the write is committed');
    const hit = (await f.waitHit(500))!;
    const log = await g.since(m0);
    const commit = log.find((r) => r.method === 'COMMIT')!;
    assert.deepEqual([hit.method, hit.status, hit.wire?.deferred], ['UPDATE', null, { to: commit.seq, outcome: 'committed' }]);
    assert.equal(commit.status, null);
    // Rolled back: the answer is delivered and the fault reports that nothing was committed.
    const c2 = await PgClient.connect(port);
    const f2 = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    await c2.query('BEGIN');
    await c2.query("UPDATE kv SET v = 'rb' WHERE k = 'a'");
    const rb = await c2.query('ROLLBACK');
    assert.deepEqual([rb.tags, rb.state], [['ROLLBACK'], 'I']);
    assert.deepEqual((await f2.waitHit(500))?.wire?.deferred?.outcome, 'rolled back');
    assert.equal(db.table.get('a'), 'tx');
    // BEGIN … COMMIT in one Query: the unit itself commits, so the fault applies to it directly.
    const c3 = await PgClient.connect(port);
    const f3 = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    const one = await c3.query("BEGIN; UPDATE kv SET v = 'one' WHERE k = 'b'; COMMIT");
    assert.equal(one.state, null);
    assert.equal(db.table.get('b'), 'one');
    assert.equal((await f3.waitHit(500))?.wire?.deferred, undefined);
    c2.close();
  } finally {
    await done();
  }
});

test('postgres gate: an error injected inside a transaction keeps client and database in step', async () => {
  const { db, g, port, done } = await setup();
  try {
    const c = await PgClient.connect(port);
    g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'status' });
    await c.query('BEGIN');
    await c.query("INSERT INTO kv (k, v) VALUES ('n', 'new')");
    const u = await c.query("UPDATE kv SET v = 'x' WHERE k = 'a'");
    assert.deepEqual([u.error, u.state], ['XX000', 'E'], 'the client is told its transaction failed');
    const before = db.seen.length;
    const s = await c.query("SELECT v FROM kv WHERE k = 'a'");
    assert.deepEqual([s.error, s.state], ['25P02', 'E']);
    assert.equal(db.seen.length, before, 'answered by the gate, as Postgres would');
    const cm = await c.send(PgClient.ext('COMMIT', []));
    assert.deepEqual([cm.tags, cm.state, cm.types], [['ROLLBACK'], 'I', '12nCZ']);
    assert.equal(db.seen[db.seen.length - 1], 'ROLLBACK', 'the database rolled back');
    assert.equal(db.table.has('n'), false, 'nothing from the failed transaction was committed');
    assert.deepEqual((await c.query("SELECT v FROM kv WHERE k = 'a'")).rows, ['1'], 'in step again');
    c.close();
  } finally {
    await done();
  }
});

test('postgres gate: createGate picks the wire gate by scheme and refuses URLs it cannot stand in for', async () => {
  const db = await fakePostgres();
  try {
    const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: x }
backend: { gate: { rewrite_env: DATABASE_URL } }
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`, '/tmp/b1-m.yaml');
    const egress = egressFor([]);
    const g = createGate(m, { DATABASE_URL: db.url }, { stateDir: '/tmp/b1-unused', egress })!;
    assert.equal(g.route, 'wire');
    assert.ok(egress.allow.includes(`127.0.0.1:${db.port}`));
    await g.start();
    assert.match(g.serverEnv()['DATABASE_URL']!, /^postgres:\/\/mws:secret@127\.0\.0\.1:\d+\/mwsc$/);
    await g.stop();
    const refuse = (url: string, re: RegExp) => assert.throws(() => createGate(m, { DATABASE_URL: url }, { stateDir: '/tmp/b1-unused', egress: egressFor([]) }), re);
    refuse('postgres://u@db:5432/x?sslmode=require', /sslmode=require: TLS to the backend is not built/);
    refuse('postgres://u@h1,h2/x', /several hosts/);
    refuse('postgres://u@%2Fvar%2Frun%2Fpostgresql/x', /Unix-socket/);
    refuse('postgres://169.254.169.254/x', /metadata/);
  } finally {
    await db.close();
  }
});
