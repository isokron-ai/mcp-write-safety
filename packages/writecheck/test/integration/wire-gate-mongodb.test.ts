/**
 * The wire gate in front of a minimal in-process MongoDB (test/wire/mongo.ts): the URL rewrite
 * with directConnection, pass-through and the log, streaming hello replies, the hold, the faults,
 * the deferred fault at commitTransaction across two connections of one session, and createGate.
 * A real mongod (standalone and single-node replica set) and the official driver are verified on
 * the Mac (docs/WIRE-GATE.md §7).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { egressFor } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { createGate, lastMutating } from '../../src/gate/gate.js';
import { MongoSession, sharedMongo } from '../../src/gate/wire/mongodb.js';
import { WireGate } from '../../src/gate/wire/proxy.js';
import { rewriteUrl } from '../../src/gate/wire/url.js';
import { fakeMongo, lsid, MongoClient, type FakeMongo } from '../wire/mongo.js';

async function setup(): Promise<{ db: FakeMongo; g: WireGate; port: number; done: () => Promise<void> }> {
  const db = await fakeMongo();
  db.coll('mwsc.mwsc_items').set('mwsc-fx-1', { _id: 'mwsc-fx-1', title: 'alpha', status: 'open' });
  const shared = sharedMongo();
  const g = new WireGate('mongodb', 'MDB_URL', db.url, egressFor([]), 1_000, (k) => new MongoSession(k, shared));
  await g.start();
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(g.serverEnv()['MDB_URL']!)![1]);
  return { db, g, port, done: async () => (await g.stop(), await db.close()) };
}

const upd = (title: string, extra: Record<string, unknown> = {}) => ({ update: 'mwsc_items', updates: [{ q: { _id: 'mwsc-fx-1' }, u: { $set: { title } } }], $db: 'mwsc', ...extra });
const find = { find: 'mwsc_items', filter: { _id: 'mwsc-fx-1' }, $db: 'mwsc' };

test('mongodb gate: URL rewrite adds directConnection; commands forwarded and logged by namespace', async () => {
  assert.equal(rewriteUrl('mongodb://u:p@db:27017/mwsc?authSource=admin', '127.0.0.1', 9), 'mongodb://u:p@127.0.0.1:9/mwsc?authSource=admin&directConnection=true');
  assert.equal(rewriteUrl('mongodb://db', '127.0.0.1', 9), 'mongodb://127.0.0.1:9/?directConnection=true');
  assert.equal(rewriteUrl('mongodb://db/x?directConnection=false&w=1', '127.0.0.1', 9), 'mongodb://127.0.0.1:9/x?directConnection=true&w=1');
  const { db, g, port, done } = await setup();
  try {
    assert.match(g.serverEnv()['MDB_URL']!, /^mongodb:\/\/mws:pw@127\.0\.0\.1:\d+\/mwsc\?authSource=admin&directConnection=true$/);
    const c = await MongoClient.connect(port);
    const m0 = g.mark();
    assert.equal((await c.cmd({}, { raw: (id) => MongoClient.opQuery(id, { isMaster: 1 }) }))?.['ismaster'], true);
    assert.deepEqual(await c.cmd(upd('bravo')), { n: 1, nModified: 1, ok: 1 });
    assert.equal(((await c.cmd(find))?.['cursor'] as { firstBatch: { title: string }[] }).firstBatch[0]!.title, 'bravo');
    assert.deepEqual((await c.cmd({ insert: 'mwsc_items', documents: [{ _id: 'mwsc-fx-1' }], $db: 'mwsc' }))?.['writeErrors'], [{ index: 0, code: 11000, errmsg: 'E11000 duplicate key' }]);
    const log = await g.since(m0);
    assert.deepEqual(
      log.map((r) => [r.method, r.path, r.mutating, r.status, r.wire?.reply]),
      [
        ['isMaster', 'admin', false, 200, 'ok:1'],
        ['update', 'mwsc.mwsc_items', true, 200, 'ok:1 n:1 nModified:1'],
        ['find', 'mwsc.mwsc_items', false, 200, 'ok:1'],
        ['insert', 'mwsc.mwsc_items', true, 400, 'ok:1 writeErrors 11000 n:0'],
      ],
    );
    assert.equal(lastMutating(log)?.method, 'insert');
    // Streaming hello: the continuation reply belongs to no request and still reaches the client.
    const before = c.replies.length;
    await c.cmd({ hello: 1, $db: 'admin' }, { flags: 1 << 16 });
    assert.ok(await c.until(() => c.replies.length >= before + 2, 1000), 'both streamed replies arrive');
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'bravo');
    c.close();
  } finally {
    await done();
  }
});

test('mongodb gate: hold an update while another connection writes; release', async () => {
  const { db, g, port, done } = await setup();
  try {
    const A = await MongoClient.connect(port);
    const B = await MongoClient.connect(port);
    const h = g.hold({ method: 'update', path: 'mwsc.mwsc_items', nth: 1 });
    const pa = A.cmd(upd('A'), { ms: 5000 });
    assert.ok(await h.waitHeld(2000));
    assert.deepEqual(await B.cmd(upd('B')), { n: 1, nModified: 1, ok: 1 });
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'B');
    await h.release();
    assert.ok(await pa);
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'A');
    A.close();
    B.close();
  } finally {
    await done();
  }
});

test('mongodb gate: status is answered by the gate; commit_then_reset applies then cuts', async () => {
  const { db, g, port, done } = await setup();
  try {
    const c = await MongoClient.connect(port);
    const f = g.fault({ method: '*', path: '*', nth: 1, kind: 'status', status: 500 });
    await c.cmd(find);
    assert.deepEqual(await c.cmd(upd('no')), { ok: 0, errmsg: 'injected by the mcp-writecheck gate', code: 1, codeName: 'InternalError' });
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'alpha');
    assert.equal((await f.waitHit(200))?.wire?.synthetic, true);
    const f2 = g.fault({ method: 'update', path: 'mwsc.mwsc_items', nth: 1, kind: 'commit_then_reset' });
    assert.equal(await c.cmd(upd('ctr'), { ms: 500 }), null);
    assert.ok(c.closed);
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'ctr');
    assert.equal((await f2.waitHit(200))?.status, null);
  } finally {
    await done();
  }
});

test('mongodb gate: a lost-answer fault on an update in a transaction lands on commitTransaction, on whichever connection carries it', async () => {
  const { db, g, port, done } = await setup();
  try {
    const A = await MongoClient.connect(port);
    const B = await MongoClient.connect(port);
    const L = lsid('ab'.repeat(16));
    const f = g.fault({ method: 'update', path: 'mwsc.mwsc_items', nth: 1, kind: 'commit_then_reset' });
    const m0 = g.mark();
    assert.deepEqual(await A.cmd(upd('tx', { lsid: L, txnNumber: 1, startTransaction: true, autocommit: false })), { n: 1, nModified: 1, ok: 1 }, 'the statement is answered');
    assert.equal(await f.waitHit(50), null);
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'alpha', 'not committed yet');
    assert.equal(await B.cmd({ commitTransaction: 1, lsid: L, txnNumber: 1, autocommit: false, $db: 'admin' }, { ms: 500 }), null, 'the commit answer is cut');
    assert.equal(db.coll('mwsc.mwsc_items').get('mwsc-fx-1')!['title'], 'tx');
    const commit = (await g.since(m0)).find((r) => r.method === 'commitTransaction')!;
    assert.deepEqual((await f.waitHit(200))?.wire?.deferred, { to: commit.seq, outcome: 'committed' });
    assert.equal(A.closed, false, 'only the connection that carried the commit is cut');
    A.close();
  } finally {
    await done();
  }
});

test('mongodb gate: createGate picks Mongo; SRV, several hosts and TLS are refused', async () => {
  const db = await fakeMongo();
  try {
    const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: x }
backend: { gate: { rewrite_env: MDB_MCP_CONNECTION_STRING } }
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`, '/tmp/b1-m.yaml');
    const mk = (url: string) => createGate(m, { MDB_MCP_CONNECTION_STRING: url }, { stateDir: '/tmp/b1-unused', egress: egressFor([]) });
    const g = mk(db.url)!;
    assert.equal(g.route, 'wire');
    assert.match(g.describe(), /directConnection=true.*reads OP_MSG/);
    assert.throws(() => mk('mongodb+srv://cluster.example.com/x'), /SRV discovery/);
    assert.throws(() => mk('mongodb://a:27017,b:27017/x?replicaSet=rs0'), /several hosts/);
    assert.throws(() => mk('mongodb://a/x?tls=true'), /tls=true: TLS to the backend is not built/);
    assert.throws(() => mk('mongodb://a/x?compressors=zstd'), /compressors=/);
    assert.throws(() => mk('mongodb://a/x?loadBalanced=true'), /loadBalanced=true/);
  } finally {
    await db.close();
  }
});
