/**
 * The wire gate in front of a minimal in-process Redis (test/wire/redis.ts): pass-through and the
 * log, the hold with a second connection finishing first, the faults, the deferred fault at EXEC,
 * EXECABORT after an error injected while queuing, and createGate's choice by scheme. A real Redis
 * and real clients are verified on the Mac (docs/WIRE-GATE.md §7).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { egressFor } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { createGate, lastMutating } from '../../src/gate/gate.js';
import { WireGate } from '../../src/gate/wire/proxy.js';
import { RedisSession } from '../../src/gate/wire/redis.js';
import { fakeRedis, RedisClient, type FakeRedis } from '../wire/redis.js';

async function setup(): Promise<{ db: FakeRedis; g: WireGate; port: number; done: () => Promise<void> }> {
  const db = await fakeRedis({ 'mwsc-fx-1': '{"title":"alpha"}', n: '1' });
  const g = new WireGate('redis', 'REDIS_URL', db.url, egressFor([]), 1_000, (k) => new RedisSession(k));
  await g.start();
  const port = Number(/:(\d+)\/0$/.exec(g.serverEnv()['REDIS_URL']!)![1]);
  return { db, g, port, done: async () => (await g.stop(), await db.close()) };
}

test('redis gate: forwards, logs commands with their key, never their values', async () => {
  const { db, g, port, done } = await setup();
  try {
    assert.match(g.serverEnv()['REDIS_URL']!, /^redis:\/\/:pw@127\.0\.0\.1:\d+\/0$/);
    const c = await RedisClient.connect(port);
    const m0 = g.mark();
    assert.equal(await c.call(['GET', 'mwsc-fx-1']), '$17\r\n{"title":"alpha"}\r\n');
    assert.equal(await c.call(['SET', 'mwsc-fx-1', '{"title":"bravo"}']), '+OK\r\n');
    assert.equal(await c.call('PING\r\n'), '+PONG\r\n');
    assert.equal(await c.call(['INCR', 'mwsc-fx-1']), '-ERR value is not an integer or out of range\r\n');
    const log = await g.since(m0);
    assert.deepEqual(
      log.map((r) => [r.method, r.path, r.mutating, r.status, r.wire?.reply, r.wire?.statement]),
      [
        ['GET', 'mwsc-fx-1', false, 200, '$17', 'GET mwsc-fx-1'],
        ['SET', 'mwsc-fx-1', true, 200, '+OK', 'SET mwsc-fx-1'],
        ['PING', '', false, 200, '+PONG', 'PING'],
        ['INCR', 'mwsc-fx-1', true, 400, '-ERR', 'INCR mwsc-fx-1'],
      ],
    );
    assert.equal(lastMutating(log)?.method, 'INCR');
    assert.equal(db.data.get('mwsc-fx-1'), '{"title":"bravo"}');
    c.close();
  } finally {
    await done();
  }
});

test('redis gate: hold one SET while another connection writes; release; nth', async () => {
  const { db, g, port, done } = await setup();
  try {
    const A = await RedisClient.connect(port);
    const B = await RedisClient.connect(port);
    const h = g.hold({ method: 'SET', path: 'mwsc-fx-1', nth: 1 });
    const pa = A.call(['SET', 'mwsc-fx-1', 'A'], /\r\n$/, 5000);
    assert.ok(await h.waitHeld(2000));
    assert.equal(await B.call(['SET', 'mwsc-fx-1', 'B']), '+OK\r\n');
    assert.equal(db.data.get('mwsc-fx-1'), 'B');
    await h.release();
    assert.equal(await pa, '+OK\r\n');
    assert.equal(db.data.get('mwsc-fx-1'), 'A');
    A.close();
    B.close();
  } finally {
    await done();
  }
});

test('redis gate: status is not forwarded; commit_then_reset applies then cuts; commit_then_status replaces the answer', async () => {
  const { db, g, port, done } = await setup();
  try {
    const c = await RedisClient.connect(port);
    const f = g.fault({ method: '*', path: '*', nth: 1, kind: 'status', status: 500 });
    await c.call(['GET', 'n']);
    assert.equal(await c.call(['SET', 'n', 'no']), '-ERR injected by the mcp-writecheck gate\r\n');
    assert.equal(db.data.get('n'), '1');
    assert.deepEqual([(await f.waitHit(200))?.wire?.synthetic, db.seen.includes('SET n no')], [true, false]);
    g.fault({ method: 'SET', path: 'n', nth: 1, kind: 'commit_then_status', status: 503 });
    assert.equal(await c.call(['SET', 'n', 'cts']), '-ERR injected by the mcp-writecheck gate\r\n');
    assert.equal(db.data.get('n'), 'cts');
    const f3 = g.fault({ method: 'SET', path: 'n', nth: 1, kind: 'commit_then_reset' });
    assert.equal(await c.call(['SET', 'n', 'ctr'], /\r\n$/, 500), '');
    assert.ok(c.closed);
    assert.equal(db.data.get('n'), 'ctr');
    assert.equal((await f3.waitHit(200))?.status, null);
  } finally {
    await done();
  }
});

test('redis gate: a lost-answer fault on a SET inside MULTI is applied at EXEC; an injected queuing error aborts the EXEC', async () => {
  const { db, g, port, done } = await setup();
  try {
    const c = await RedisClient.connect(port);
    const f = g.fault({ method: 'SET', path: 'n', nth: 1, kind: 'commit_then_reset' });
    const m0 = g.mark();
    assert.equal(await c.call(['MULTI']), '+OK\r\n');
    assert.equal(await c.call(['SET', 'n', 'tx']), '+QUEUED\r\n', 'the queued answer is delivered');
    assert.equal(await f.waitHit(50), null);
    assert.equal(await c.call(['EXEC'], /\r\n$/, 500), '', 'the EXEC answer is cut');
    assert.equal(db.data.get('n'), 'tx');
    const exec = (await g.since(m0)).find((r) => r.method === 'EXEC')!;
    assert.deepEqual((await f.waitHit(200))?.wire?.deferred, { to: exec.seq, outcome: 'committed' });
    const d = await RedisClient.connect(port);
    g.fault({ method: 'SET', path: 'n', nth: 1, kind: 'status' });
    await d.call(['MULTI']);
    assert.equal(await d.call(['SET', 'mwsc-fx-1', 'queued']), '+QUEUED\r\n');
    assert.equal(await d.call(['SET', 'n', 'x']), '-ERR injected by the mcp-writecheck gate\r\n');
    assert.equal(await d.call(['EXEC']), '-EXECABORT Transaction discarded because of previous errors.\r\n');
    assert.equal(db.seen[db.seen.length - 1], 'DISCARD');
    assert.equal(db.data.get('mwsc-fx-1'), '{"title":"alpha"}', 'nothing from the aborted transaction applied');
    assert.equal(await d.call(['GET', 'n']), '$2\r\ntx\r\n', 'in step again');
    d.close();
  } finally {
    await done();
  }
});

test('redis gate: SUBSCRIBE passes the connection through; createGate picks Redis; rediss is refused', async () => {
  const { port, done, db } = await setup();
  try {
    const c = await RedisClient.connect(port);
    const got = await c.call(['SUBSCRIBE', 'ch'], /message/, 2000);
    assert.match(got, /subscribe[\s\S]*message[\s\S]*hello/);
    c.close();
    const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: x }
backend: { gate: { rewrite_env: REDIS_URL } }
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`, '/tmp/b1-m.yaml');
    const g2 = createGate(m, { REDIS_URL: db.url }, { stateDir: '/tmp/b1-unused', egress: egressFor([]) })!;
    assert.equal(g2.route, 'wire');
    assert.match(g2.describe(), /reads RESP/);
    assert.throws(() => createGate(m, { REDIS_URL: 'rediss://cache:6380' }, { stateDir: '/tmp/b1-unused', egress: egressFor([]) }), /rediss: TLS to the backend is not built/);
  } finally {
    await done();
  }
});
