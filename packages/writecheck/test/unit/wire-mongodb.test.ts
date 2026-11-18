/**
 * The MongoDB side of the wire gate without a socket: BSON against specification vectors, command
 * classification ($out/$merge, mapReduce, unknown commands), OP_MSG framing at every split,
 * replies matched by responseTo, and the transaction state per session (lsid).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decode, encode, firstKey } from '../../src/gate/wire/bson.js';
import { classifyMongo, MongoSession, opMsg, sharedMongo } from '../../src/gate/wire/mongodb.js';
import { lsid, MongoClient } from '../wire/mongo.js';

test('bson: specification vectors decode; the writer round-trips what the gate writes', () => {
  // {"hello": "world"} and {"BSON": ["awesome", 5.05, 1986]} from bsonspec.org.
  const hello = Buffer.from('16000000026865 6c6c6f0006000000776f726c640000'.replace(/ /g, ''), 'hex');
  assert.deepEqual(decode(hello)[0], { hello: 'world' });
  const arr = Buffer.from('310000000442534f4e002600000002300008000000617765736f6d65000131003333333333331440103200c20700000000', 'hex');
  assert.deepEqual(decode(arr)[0], { BSON: ['awesome', 5.05, 1986] });
  assert.equal(firstKey(arr), 'BSON');
  const doc = { ok: 0, errmsg: 'x', code: 1, big: 2 ** 40, t: true, n: null, a: [1, 'two'], d: { e: 1.5 }, l: { _bson: 'long' as const, value: '7' }, b: { _bson: 'binary' as const, sub: 4, hex: '00ff' } };
  const [back] = decode(encode(doc));
  assert.deepEqual(back, { ...doc, l: 7 });
  assert.throws(() => decode(Buffer.from('0500000001', 'hex')), /past its message|not terminated/);
});

test('mongodb: commands are named with their namespace; $out/$merge and unknown commands count as writes', () => {
  const c = (body: Record<string, unknown>) => {
    const k = Object.keys(body)[0]!;
    const r = classifyMongo({ $db: 'mwsc', ...body } as never, k);
    return [r.verb, r.path, r.mutating, r.uncertain ? 'uncertain' : 'certain'];
  };
  assert.deepEqual(c({ update: 'mwsc_items', updates: [] }), ['update', 'mwsc.mwsc_items', true, 'certain']);
  assert.deepEqual(c({ findAndModify: 'mwsc_items' }), ['findAndModify', 'mwsc.mwsc_items', true, 'certain']);
  assert.deepEqual(c({ find: 'mwsc_items', filter: {} }), ['find', 'mwsc.mwsc_items', false, 'certain']);
  assert.deepEqual(c({ aggregate: 'mwsc_items', pipeline: [{ $match: {} }] }), ['aggregate', 'mwsc.mwsc_items', false, 'certain']);
  assert.deepEqual(c({ aggregate: 'mwsc_items', pipeline: [{ $match: {} }, { $merge: { into: 'x' } }] }), ['aggregate', 'mwsc.mwsc_items', true, 'certain']);
  assert.deepEqual(c({ aggregate: 1, pipeline: [{ $out: 'x' }] }), ['aggregate', 'mwsc', true, 'certain']);
  assert.deepEqual(c({ mapReduce: 'c', out: { inline: 1 } }), ['mapReduce', 'mwsc.c', false, 'certain']);
  assert.deepEqual(c({ mapReduce: 'c', out: 'dst' }), ['mapReduce', 'mwsc.c', true, 'certain']);
  assert.deepEqual(c({ getMore: 5, collection: 'mwsc_items' }), ['getMore', 'mwsc.mwsc_items', false, 'certain']);
  assert.deepEqual(c({ hello: 1 }), ['hello', 'mwsc', false, 'certain']);
  assert.deepEqual(c({ commitTransaction: 1 }), ['commitTransaction', 'mwsc', false, 'certain']);
  assert.deepEqual(c({ fooBar: 'x' }), ['fooBar', 'mwsc.x', true, 'uncertain']);
  assert.equal(classifyMongo({ $db: 'd', aggregate: 'c', pipeline: [{ $match: { secret: 'v' } }, { $merge: 'x' }] }, 'aggregate').statement, 'aggregate d.c [$match,$merge]', 'stage names, never values');
});

test('mongodb codec: OP_MSG framed alike at every split; replies matched by responseTo; moreToCome expects nothing', () => {
  const m1 = opMsg(1, 0, { update: 'c', updates: [{ q: { _id: 'a' }, u: { $set: { t: 'x' } } }], $db: 'd' });
  const m2 = opMsg(2, 0, { find: 'c', filter: { _id: 'a' }, $db: 'd' });
  const m3 = opMsg(3, 0, { insert: 'c', documents: [{ _id: 'b' }], $db: 'd' }, 2);
  const stream = Buffer.concat([m1, m2, m3]);
  const shape = (us: ReturnType<MongoSession['client']>) => us.map((u) => `${u.req?.verb} ${u.req?.path} ${u.req?.mutating} ${u.noReply ? 'noreply' : ''}`);
  const want = shape(new MongoSession('k').client(stream));
  assert.deepEqual(want, ['update d.c true ', 'find d.c false ', 'insert d.c true noreply']);
  for (let i = 1; i < stream.length; i++) {
    const s = new MongoSession('k');
    assert.deepEqual(shape([...s.client(stream.subarray(0, i)), ...s.client(stream.subarray(i))]), want, `split at ${i}`);
  }
  const s = new MongoSession('k');
  const us = s.client(stream);
  us.forEach((u, i) => s.sent(i + 1, u));
  const ps = s.server(Buffer.concat([opMsg(901, 2, { cursor: { firstBatch: [], id: 0 }, ok: 1 }), opMsg(900, 1, { n: 1, nModified: 1, ok: 1 }), opMsg(902, 900, { ok: 1 })]));
  assert.deepEqual(ps.map((p) => [p.unit, p.end?.reply ?? null]), [[2, 'ok:1'], [1, 'ok:1 n:1 nModified:1'], [null, null]]);
  const e = new MongoSession('k');
  const [w] = e.client(opMsg(5, 0, { insert: 'c', documents: [], $db: 'd' }));
  e.sent(1, w!);
  assert.deepEqual(e.server(opMsg(9, 5, { n: 0, writeErrors: [{ index: 0, code: 11000 }], ok: 1 }))[0]!.end, { status: 400, reply: 'ok:1 writeErrors 11000 n:0', txn: 'idle' });
  const [w2] = e.client(opMsg(6, 0, { insert: 'c', documents: [], $db: 'd' }));
  e.sent(2, w2!);
  assert.equal(e.server(opMsg(10, 6, { ok: 0, code: 10107, codeName: 'NotWritablePrimary' }))[0]!.end!.status, 503);
  const inj = e.injectError(w2!, 'boom', 'idle');
  assert.equal(inj.bytes.readInt32LE(8), 6, 'the injected reply answers the request');
  assert.deepEqual(decode(inj.bytes, 21)[0], { ok: 0, errmsg: 'boom', code: 1, codeName: 'InternalError' });
});

test('mongodb codec: transaction state is per session and shared across connections of one gate', () => {
  const shared = sharedMongo();
  const a = new MongoSession('c1', shared);
  const b = new MongoSession('c2', shared);
  const L = lsid('aa'.repeat(16));
  const step = (s: MongoSession, id: number, body: Record<string, unknown>, reply: Record<string, unknown> = { ok: 1 }) => {
    const [u] = s.client(opMsg(id, 0, { ...body, $db: 'd' } as never));
    s.sent(id, u!);
    return [u!.txnKey, s.server(opMsg(id + 100, id, reply as never))[0]!.end!];
  };
  const [k1, o1] = step(a, 1, { update: 'c', updates: [], lsid: L, txnNumber: 1, startTransaction: true, autocommit: false }) as [string, { txn: string }];
  assert.equal(k1, `lsid:${'aa'.repeat(16)}`);
  assert.equal(o1.txn, 'in');
  assert.equal(b.txn(k1), 'in', 'the other connection sees the session in a transaction');
  const [, o2] = step(b, 2, { commitTransaction: 1, lsid: L, txnNumber: 1, autocommit: false }) as [string, object];
  assert.deepEqual(o2, { status: 200, reply: 'ok:1', txn: 'idle', ended: true, committed: true });
  step(a, 3, { update: 'c', updates: [], lsid: L, txnNumber: 2, startTransaction: true, autocommit: false });
  const [, o4] = step(a, 4, { update: 'c', updates: [], lsid: L, txnNumber: 2, autocommit: false }, { ok: 0, code: 112, errorLabels: ['TransientTransactionError'] }) as [string, object];
  assert.deepEqual(o4, { status: 400, reply: 'ok:0 code:112', txn: 'idle', ended: true });
});

test('mongodb codec: the legacy OP_QUERY handshake is a read; OP_COMPRESSED is an uncertain write', () => {
  const s = new MongoSession('k');
  const [h] = s.client(MongoClient.opQuery(7, { isMaster: 1, client: { driver: { name: 'x' } } }));
  assert.deepEqual([h!.req!.verb, h!.req!.path, h!.req!.mutating], ['isMaster', 'admin', false]);
  const comp = Buffer.alloc(25);
  comp.writeInt32LE(25, 0);
  comp.writeInt32LE(8, 4);
  comp.writeInt32LE(2012, 12);
  const [c] = s.client(comp);
  assert.equal(c!.req!.mutating, true);
  assert.match(c!.req!.uncertain!, /compressed/);
});
