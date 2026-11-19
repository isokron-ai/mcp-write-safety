/**
 * Regressions from the independent review of the wire gate (lane B1): answers the gate writes are
 * ordered after earlier pipelined answers and judged by the backend's state after them; a lost-answer
 * fault counts only for a write that was carried out and kept; barriers have a ceiling and let COPY
 * data through; an error inside the gate closes the connection, never the CLI.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { egressFor } from '../../src/core/egress.js';
import { MongoSession, sharedMongo } from '../../src/gate/wire/mongodb.js';
import { pg, PostgresSession } from '../../src/gate/wire/postgres.js';
import { WireGate } from '../../src/gate/wire/proxy.js';
import { RedisSession } from '../../src/gate/wire/redis.js';
import { fakeMongo, lsid, MongoClient } from '../wire/mongo.js';
import { fakePostgres, PgClient } from '../wire/pg.js';
import { fakeRedis, RedisClient } from '../wire/redis.js';

async function pgGate(initial: Record<string, string> = { a: '1', b: '1' }, barrierMs?: number) {
  const db = await fakePostgres(initial);
  const g = new WireGate('postgres', 'DATABASE_URL', db.url, egressFor([]), 1_000, (k) => new PostgresSession(k), barrierMs ? { barrierMs } : {});
  await g.start();
  const port = Number(/:(\d+)\//.exec(g.serverEnv()['DATABASE_URL']!)![1]);
  return { db, g, port, done: async () => (await g.stop(), await db.close()) };
}

async function redisGate() {
  const db = await fakeRedis({ k: 'v', n: '1' });
  const g = new WireGate('redis', 'REDIS_URL', db.url, egressFor([]), 1_000, (k) => new RedisSession(k));
  await g.start();
  const port = Number(/:(\d+)\/0$/.exec(g.serverEnv()['REDIS_URL']!)![1]);
  return { db, g, port, done: async () => (await g.stop(), await db.close()) };
}

test('review 1: postgres, pipelined BEGIN; SELECT; UPDATE (injected error); COMMIT: answers in order and the transaction is not committed', async () => {
  const { db, g, port, done } = await pgGate();
  try {
    const c = await PgClient.connect(port);
    g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'status' });
    const four = Buffer.concat([PgClient.q('BEGIN'), PgClient.q("INSERT INTO kv (k, v) VALUES ('new', 'x')"), PgClient.q("UPDATE kv SET v = 'x' WHERE k = 'a'"), PgClient.q('COMMIT')]);
    const a = await c.send(four, { readies: 4 });
    const z = c.msgs.filter((m) => m.t === 'Z').map((m) => m.body.toString('latin1'));
    assert.deepEqual(z, ['T', 'T', 'E', 'I'], 'BEGIN and INSERT answered first, then the injected error, then the COMMIT');
    assert.deepEqual(a.tags, ['BEGIN', 'INSERT 0 1', 'ROLLBACK']);
    assert.equal(a.error, 'XX000');
    assert.equal(db.seen[db.seen.length - 1], 'ROLLBACK', 'the database rolled back');
    assert.equal(db.table.has('new'), false, 'nothing from the failed transaction was committed');
    assert.equal(db.table.get('a'), '1');
    c.close();
  } finally {
    await done();
  }
});

test('review 1: redis, pipelined GET, SET (injected error) and MULTI, SET (injected error), EXEC', async () => {
  const { db, g, port, done } = await redisGate();
  try {
    const c = await RedisClient.connect(port);
    g.fault({ method: 'SET', path: 'k', nth: 1, kind: 'status' });
    const got = await c.call(RedisClient.cmd('GET', 'k') + RedisClient.cmd('SET', 'k', 'w'), /-ERR[^\r]*\r\n$/);
    assert.equal(got, '$1\r\nv\r\n-ERR injected by the mcp-writecheck gate\r\n', 'the GET answer comes first');
    g.fault({ method: 'SET', path: 'k', nth: 1, kind: 'status' });
    const t = await c.call(RedisClient.cmd('MULTI') + RedisClient.cmd('SET', 'n', '2') + RedisClient.cmd('SET', 'k', 'w') + RedisClient.cmd('EXEC'), /EXECABORT[^\r]*\r\n$/);
    assert.equal(t, '+OK\r\n+QUEUED\r\n-ERR injected by the mcp-writecheck gate\r\n-EXECABORT Transaction discarded because of previous errors.\r\n');
    assert.deepEqual(db.seen.slice(-3), ['MULTI', 'SET n 2', 'DISCARD'], 'the backend saw MULTI, the queued SET, DISCARD');
    assert.ok(db.seen.includes('DISCARD') && !db.seen.includes('EXEC'));
    assert.equal(db.data.get('n'), '1', 'nothing from the aborted transaction applied');
    c.close();
  } finally {
    await done();
  }
});

test('review 2: a lost-answer fault is not a trial when the write failed, was rolled back, or its fate after a savepoint is unknown', async () => {
  const { db, g, port, done } = await pgGate();
  try {
    const c = await PgClient.connect(port);
    // The write itself is refused.
    const f1 = g.fault({ method: 'INSERT', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    const r1 = await c.query("INSERT INTO kv (k, v) VALUES ('a', 'dup')");
    assert.deepEqual([r1.error, r1.state], ['23505', 'I'], 'the real answer is delivered');
    assert.equal(await f1.waitHit(200), null);
    assert.match(f1.why!, /the write itself was refused \(ErrorResponse 23505\)/);
    // One Query that begins, writes and rolls back.
    const f2 = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    const r2 = await c.query("BEGIN; UPDATE kv SET v = 'rb' WHERE k = 'a'; ROLLBACK");
    assert.equal(r2.state, 'I');
    assert.equal(await f2.waitHit(200), null);
    assert.match(f2.why!, /undid what it changed/);
    // A ROLLBACK TO SAVEPOINT after the write, then COMMIT.
    const f3 = g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    await c.query('BEGIN');
    await c.query('SAVEPOINT s');
    await c.query("UPDATE kv SET v = 'sp' WHERE k = 'a'");
    await c.query('ROLLBACK TO s');
    const r3 = await c.query('COMMIT');
    assert.deepEqual([r3.tags, r3.state], [['COMMIT'], 'I'], 'the COMMIT answer is delivered');
    assert.equal(await f3.waitHit(200), null);
    assert.match(f3.why!, /ROLLBACK TO SAVEPOINT/);
    assert.equal(db.table.get('a'), '1');
    c.close();
  } finally {
    await done();
  }
});

test('review 2: redis, a SET that fails inside EXEC is not a trial; one that succeeds is', async () => {
  const { db, g, port, done } = await redisGate();
  try {
    const c = await RedisClient.connect(port);
    const f = g.fault({ method: 'INCR', path: 'k', nth: 1, kind: 'commit_then_reset' });
    const t = await c.call(RedisClient.cmd('MULTI') + RedisClient.cmd('SET', 'n', '5') + RedisClient.cmd('INCR', 'k') + RedisClient.cmd('EXEC'), /\*2\r\n[\s\S]*\r\n-ERR[^\r]*\r\n$/);
    assert.match(t, /^\+OK\r\n\+QUEUED\r\n\+QUEUED\r\n\*2\r\n\+OK\r\n-ERR/, 'the EXEC answer is delivered');
    assert.equal(await f.waitHit(200), null);
    assert.equal(f.why, 'the write failed inside EXEC');
    const f2 = g.fault({ method: 'SET', path: 'n', nth: 1, kind: 'commit_then_reset' });
    await c.call(RedisClient.cmd('MULTI') + RedisClient.cmd('INCR', 'k') + RedisClient.cmd('SET', 'n', '6') + RedisClient.cmd('EXEC'), /QUEUED\r\n\+QUEUED\r\n$/);
    assert.ok(await f2.waitHit(1000), 'the SET was carried out and kept: a trial');
    assert.equal(db.data.get('n'), '6');
  } finally {
    await done();
  }
});

test('review 2: mongodb, an error is not injected inside a transaction (the gate cannot keep the session in step)', async () => {
  const db = await fakeMongo();
  db.coll('d.c').set('x', { _id: 'x', t: 'a' });
  const shared = sharedMongo();
  const g = new WireGate('mongodb', 'U', db.url, egressFor([]), 1_000, (k) => new MongoSession(k, shared));
  await g.start();
  try {
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(g.serverEnv()['U']!)![1]);
    const c = await MongoClient.connect(port);
    const f = g.fault({ method: 'update', path: 'd.c', nth: 1, kind: 'status' });
    const r = await c.cmd({ update: 'c', updates: [{ q: { _id: 'x' }, u: { $set: { t: 'b' } } }], $db: 'd', lsid: lsid('cd'.repeat(16)), txnNumber: 1, startTransaction: true, autocommit: false });
    assert.deepEqual(r, { n: 1, nModified: 1, ok: 1 }, 'forwarded as it is');
    assert.equal(await f.waitHit(100), null);
    assert.match(f.why!, /inside a MongoDB transaction/);
    c.close();
  } finally {
    await g.stop();
    await db.close();
  }
});

test('review 4: COPY data passes a barrier; an answer that never comes closes the connection after the ceiling', async () => {
  const { db, g, port, done } = await pgGate({}, 300);
  try {
    const c = await PgClient.connect(port);
    const f = g.fault({ method: 'COPY FROM', path: 'kv', nth: 1, kind: 'commit_then_reset' });
    const data = pg.msg('d', Buffer.from('x\t1\ny\t2\n'));
    const r = await c.send(Buffer.concat([PgClient.q('COPY kv FROM STDIN'), data, pg.msg('c', Buffer.alloc(0))]), { ms: 2000 });
    assert.equal(r.state, null, 'the COPY answer is cut');
    assert.deepEqual([db.table.get('x'), db.table.get('y')], ['1', '2'], 'the data reached the database');
    assert.ok(await f.waitHit(500));
    // A unit behind one whose answer never comes: the gate closes the connection instead of hanging.
    const d = await PgClient.connect(port);
    const m0 = g.mark();
    g.fault({ method: 'UPDATE', path: 'kv', nth: 1, kind: 'status' });
    const r2 = await d.send(Buffer.concat([PgClient.q('SELECT hang()'), PgClient.q("UPDATE kv SET v = '9' WHERE k = 'x'")]), { readies: 2, ms: 2000 });
    assert.equal(r2.state, null);
    assert.ok(d.closed, 'closed');
    const log = await g.since(m0);
    assert.ok(log.some((x) => x.method === '?' && /did not arrive within 300 ms/.test(x.wire?.uncertain ?? '')), JSON.stringify(log));
  } finally {
    await done();
  }
});

test('review 8: an error inside a codec closes that connection and is logged; the gate and the process go on', async () => {
  const db = await fakePostgres();
  let n = 0;
  const g = new WireGate('postgres', 'DATABASE_URL', db.url, egressFor([]), 1_000, (k) => {
    const s = new PostgresSession(k);
    if (++n === 1)
      s.client = () => {
        throw new TypeError('boom');
      };
    return s;
  });
  await g.start();
  try {
    const port = Number(/:(\d+)\//.exec(g.serverEnv()['DATABASE_URL']!)![1]);
    const bad = await PgClient.connect(port).catch(() => null);
    assert.ok(bad === null || bad.closed, 'the first connection is closed');
    const log = await g.since(0);
    assert.ok(log.some((x) => x.method === '?' && /boom/.test(x.wire?.uncertain ?? '')));
    const good = await PgClient.connect(port);
    assert.deepEqual((await good.query("SELECT v FROM kv WHERE k = 'a'")).rows, []);
    good.close();
  } finally {
    await g.stop();
    await db.close();
  }
});
