/**
 * The Redis side of the wire gate without a socket: command classification (keys, scripts,
 * stores, unknown commands), RESP framing across every chunk split, RESP3 pushes and attributes,
 * inline commands, the MULTI/EXEC commit point and the EXECABORT emulation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyRedis, RedisSession } from '../../src/gate/wire/redis.js';
import { RedisClient } from '../wire/redis.js';

const c = (...a: string[]) => {
  const r = classifyRedis(a);
  return [r.verb, r.path, r.mutating, r.uncertain ? 'uncertain' : 'certain'];
};

test('redis: commands are named with their key; unknown and scripts count as writes', () => {
  assert.deepEqual(c('set', 'mwsc-fx-1', '{"a":1}'), ['SET', 'mwsc-fx-1', true, 'certain']);
  assert.deepEqual(c('GET', 'k'), ['GET', 'k', false, 'certain']);
  assert.deepEqual(c('HSET', 'h', 'f', 'v'), ['HSET', 'h', true, 'certain']);
  assert.deepEqual(c('EXPIRE', 'k', '10'), ['EXPIRE', 'k', true, 'certain']);
  assert.deepEqual(c('DEL', 'a', 'b'), ['DEL', 'a', true, 'certain']);
  assert.deepEqual(c('EVAL', 'return 1', '1', 'k1'), ['EVAL', 'k1', true, 'uncertain']);
  assert.deepEqual(c('EVAL_RO', 'return 1', '1', 'k1'), ['EVAL_RO', 'k1', false, 'certain']);
  assert.deepEqual(c('SORT', 'l', 'STORE', 'dst'), ['SORT', 'l', true, 'certain']);
  assert.deepEqual(c('SORT', 'l', 'LIMIT', '0', '1'), ['SORT', 'l', false, 'certain']);
  assert.deepEqual(c('BITOP', 'AND', 'dest', 'a', 'b'), ['BITOP', 'dest', true, 'certain']);
  assert.deepEqual(c('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 's1', '>'), ['XREADGROUP', 's1', true, 'certain']);
  assert.deepEqual(c('OBJECT', 'ENCODING', 'k'), ['OBJECT', 'k', false, 'certain']);
  assert.deepEqual(c('CONFIG', 'GET', 'maxmemory'), ['CONFIG GET', '', false, 'certain']);
  assert.deepEqual(c('CONFIG', 'SET', 'maxmemory', '1'), ['CONFIG SET', '', true, 'uncertain']);
  assert.deepEqual(c('JSON.SET', 'doc', '$', '{}'), ['JSON.SET', 'doc', true, 'certain']);
  assert.deepEqual(c('FT.CREATE', 'idx'), ['FT.CREATE', '', true, 'uncertain'], 'an unknown command records no argument');
  assert.deepEqual(c('MULTI'), ['MULTI', '', false, 'certain']);
  assert.deepEqual(c('FLUSHDB'), ['FLUSHDB', '', true, 'certain']);
  const auth = classifyRedis(['AUTH', 'user', 'hunter2']);
  assert.equal(auth.statement, 'AUTH', 'credentials are never recorded');
  assert.equal(classifyRedis(['HELLO', '3', 'AUTH', 'u', 'p']).statement, 'HELLO');
  assert.equal(classifyRedis(['SET', 'k', 'secret-value']).statement, 'SET k', 'values are not recorded');
});

test('redis codec: commands framed alike at every split; inline commands; replies attributed in order', () => {
  const stream = Buffer.from(RedisClient.cmd('SET', 'k', 'v\r\nwith crlf') + 'PING\r\n' + RedisClient.cmd('GET', 'k') + RedisClient.cmd('DEL', 'k'));
  const shape = (s: RedisSession, parts: Buffer[]) => parts.flatMap((p) => s.client(p)).map((u) => `${u.req?.verb} ${u.req?.path} ${u.bytes.length}`);
  const want = shape(new RedisSession('k'), [stream]);
  assert.deepEqual(want.map((w) => w.split(' ').slice(0, 2).join(' ')), ['SET k', 'PING ', 'GET k', 'DEL k']);
  for (let i = 1; i < stream.length; i++) assert.deepEqual(shape(new RedisSession('k'), [stream.subarray(0, i), stream.subarray(i)]), want, `split at ${i}`);
  const s = new RedisSession('k');
  const us = s.client(stream);
  us.forEach((u, i) => s.sent(i + 1, u));
  const reply = Buffer.from('+OK\r\n+PONG\r\n$12\r\nv\r\nwith crlf\r\n:1\r\n');
  for (let i = 1; i < reply.length; i++) {
    const t = new RedisSession('k');
    t.client(stream).forEach((u, j) => t.sent(j + 1, u));
    const ps = [...t.server(reply.subarray(0, i)), ...t.server(reply.subarray(i))];
    assert.deepEqual(ps.map((p) => [p.unit, p.end?.reply]), [[1, '+OK'], [2, '+PONG'], [3, '$12'], [4, ':1']], `reply split at ${i}`);
  }
});

test('redis codec: RESP3 pushes are out of band, attributes belong to the next reply, errors map to statuses', () => {
  const s = new RedisSession('k');
  const us = s.client(Buffer.from(RedisClient.cmd('HELLO', '3') + RedisClient.cmd('GET', 'a') + RedisClient.cmd('SET', 'a', '1') + RedisClient.cmd('GET', 'b')));
  us.forEach((u, i) => s.sent(i + 1, u));
  const ps = s.server(Buffer.from('%1\r\n+proto\r\n:3\r\n>3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$1\r\nx\r\n|1\r\n+ttl\r\n:5\r\n$1\r\n1\r\n-LOADING Redis is loading\r\n_\r\n'));
  assert.deepEqual(ps.map((p) => [p.unit, p.end?.reply ?? null, p.end?.status ?? null]), [[1, '%1', 200], [null, null, null], [2, '$1', 200], [3, '-LOADING', 503], [4, 'nil', 200]]);
  const e = new RedisSession('k');
  const [w] = e.client(Buffer.from(RedisClient.cmd('INCR', 'x')));
  e.sent(1, w!);
  assert.deepEqual(e.server(Buffer.from('-WRONGTYPE Operation against a key\r\n'))[0]!.end, { status: 400, reply: '-WRONGTYPE', txn: 'idle' });
});

test('redis codec: EXEC is the commit point; an error injected while queuing makes the gate answer EXECABORT', () => {
  const s = new RedisSession('k');
  const run = (cmd: string[], reply: string, id: number) => {
    const [u] = s.client(Buffer.from(RedisClient.cmd(...cmd)));
    s.sent(id, u!);
    return s.server(Buffer.from(reply))[0]!.end!;
  };
  assert.equal(run(['MULTI'], '+OK\r\n', 1).txn, 'in');
  assert.deepEqual(run(['SET', 'a', '1'], '+QUEUED\r\n', 2), { status: 200, reply: '+QUEUED', txn: 'in', queuedIndex: 0 });
  assert.deepEqual(run(['EXEC'], '*1\r\n+OK\r\n', 3), { status: 200, reply: '*1', txn: 'idle', ended: true, committed: true });
  run(['MULTI'], '+OK\r\n', 4);
  assert.deepEqual(run(['EXEC'], '*-1\r\n', 5), { status: 200, reply: 'nil', txn: 'idle', ended: true }, 'aborted by WATCH: not a commit');
  run(['MULTI'], '+OK\r\n', 6);
  const [set] = s.client(Buffer.from(RedisClient.cmd('SET', 'b', '2')));
  const inj = s.injectError(set!, 'boom', s.txn());
  assert.equal(inj.bytes.toString(), '-ERR boom\r\n');
  const [exec] = s.client(Buffer.from(RedisClient.cmd('EXEC')));
  const ic = s.intercept(exec!);
  assert.ok(ic && 'forward' in ic);
  assert.equal(ic.forward.bytes.toString(), RedisClient.cmd('DISCARD'));
  assert.match(ic.answer.toString(), /^-EXECABORT/);
});

test('redis codec: after SUBSCRIBE on RESP2 the connection is passed through', () => {
  const s = new RedisSession('k');
  const us = s.client(Buffer.from(RedisClient.cmd('SUBSCRIBE', 'ch') + RedisClient.cmd('PING')));
  assert.deepEqual(us.map((u) => u.req?.verb ?? 'pass'), ['SUBSCRIBE', 'pass']);
  s.sent(1, us[0]!);
  const ps = s.server(Buffer.from('*3\r\n$9\r\nsubscribe\r\n$2\r\nch\r\n:1\r\n*3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$1\r\nx\r\n'));
  assert.deepEqual(ps.map((p) => p.unit), [1, null]);
});

test('redis codec (review 3, 5): STORE past the 16th argument; HELLO, RESET and RESP3 subscribe pushes', () => {
  const long = ['SORT', 'l', ...Array.from({ length: 20 }, (_, i) => `x${i}`), 'STORE', 'dst'];
  const s0 = new RedisSession('k');
  const [u] = s0.client(Buffer.from(RedisClient.cmd(...long)));
  assert.equal(u!.req!.mutating, true, 'STORE found among later arguments');
  // HELLO 3 refused: still RESP2, so SUBSCRIBE turns the connection to passthrough.
  const s = new RedisSession('k');
  const [h] = s.client(Buffer.from(RedisClient.cmd('HELLO', '3')));
  s.sent(1, h!);
  s.server(Buffer.from('-NOPROTO unsupported protocol version\r\n'));
  const sub = s.client(Buffer.from(RedisClient.cmd('SUBSCRIBE', 'ch') + RedisClient.cmd('PING')));
  assert.deepEqual(sub.map((x) => x.req?.verb ?? 'pass'), ['SUBSCRIBE', 'pass']);
  // HELLO 3 accepted: SUBSCRIBE is answered by a push, and the next reply belongs to the next command.
  const t = new RedisSession('k');
  const [h3] = t.client(Buffer.from(RedisClient.cmd('HELLO', '3')));
  t.sent(1, h3!);
  t.server(Buffer.from('%1\r\n+proto\r\n:3\r\n'));
  const us = t.client(Buffer.from(RedisClient.cmd('SUBSCRIBE', 'ch') + RedisClient.cmd('PING')));
  assert.deepEqual(us.map((x) => x.req?.verb), ['SUBSCRIBE', 'PING']);
  us.forEach((x, i) => t.sent(i + 2, x));
  const ps = t.server(Buffer.from('>3\r\n$9\r\nsubscribe\r\n$2\r\nch\r\n:1\r\n+PONG\r\n>3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$1\r\nx\r\n'));
  assert.deepEqual(ps.map((p) => [p.unit, p.end?.reply ?? null]), [[2, '>3'], [3, '+PONG'], [null, null]]);
  // RESET ends MULTI.
  const r = new RedisSession('k');
  const step = (cmd: string[], reply: string, id: number) => {
    const [x] = r.client(Buffer.from(RedisClient.cmd(...cmd)));
    r.sent(id, x!);
    return r.server(Buffer.from(reply))[0]!.end!;
  };
  step(['MULTI'], '+OK\r\n', 1);
  assert.equal(r.txn(), 'in');
  step(['RESET'], '+RESET\r\n', 2);
  assert.equal(r.txn(), 'idle');
});

test('redis codec (real-db item 2): a wrong password is relayed as the backend answered it; the connection stays in step', () => {
  // Bytes recorded from Redis 7.0.15 with requirepass: AUTH wrong, PING, HELLO 3 AUTH default wrong, HELLO 3 AUTH default <right>.
  const replies = [
    '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    '-NOAUTH Authentication required.\r\n',
    '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    '%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$6\r\n7.0.15\r\n$5\r\nproto\r\n:3\r\n$2\r\nid\r\n:23\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n',
  ];
  const stream = Buffer.from(RedisClient.cmd('AUTH', 'wrong') + RedisClient.cmd('PING') + RedisClient.cmd('HELLO', '3', 'AUTH', 'default', 'wrong') + RedisClient.cmd('HELLO', '3', 'AUTH', 'default', 'rpw') + RedisClient.cmd('SUBSCRIBE', 'c'));
  const reply = Buffer.from(replies.join(''));
  for (let i = 1; i < reply.length; i += 7) {
    const s = new RedisSession('k');
    const us = s.client(stream);
    assert.deepEqual(us.map((u) => [u.req?.verb, u.req?.statement, u.req?.mutating]), [['AUTH', 'AUTH', false], ['PING', 'PING', false], ['HELLO', 'HELLO', false], ['HELLO', 'HELLO', false], ['SUBSCRIBE', 'SUBSCRIBE', false]], 'credentials are not recorded');
    us.slice(0, 4).forEach((u, j) => s.sent(j + 1, u));
    const ps = [...s.server(reply.subarray(0, i)), ...s.server(reply.subarray(i))];
    assert.deepEqual(ps.map((p) => [p.unit, p.end?.reply, p.end?.status]), [[1, '-WRONGPASS', 400], [2, '-NOAUTH', 400], [3, '-WRONGPASS', 400], [4, '%7', 200]], `reply split at ${i}`);
    assert.equal(Buffer.concat(ps.map((p) => p.bytes)).toString('latin1'), reply.toString('latin1'), 'the answers are forwarded byte for byte');
  }
  // A refused HELLO 3 leaves RESP2 in force; only the accepted one switches to RESP3 (SUBSCRIBE is then answered by a push, not passthrough).
  const t = new RedisSession('k');
  const [bad] = t.client(Buffer.from(RedisClient.cmd('HELLO', '3', 'AUTH', 'default', 'wrong')));
  t.sent(1, bad!);
  t.server(Buffer.from(replies[2]!));
  const [good] = t.client(Buffer.from(RedisClient.cmd('HELLO', '3', 'AUTH', 'default', 'rpw')));
  t.sent(2, good!);
  t.server(Buffer.from(replies[3]!));
  const [sub, after] = t.client(Buffer.from(RedisClient.cmd('SUBSCRIBE', 'c') + RedisClient.cmd('PING')));
  assert.ok(sub?.req && after?.req, 'RESP3 after the accepted HELLO: commands after SUBSCRIBE are still read');
});
