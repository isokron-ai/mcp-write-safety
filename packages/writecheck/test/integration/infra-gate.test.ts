/**
 * The backend gate, both routes, against a small local backend: pass-through, the request log,
 * a hold that lets a second request finish first, the k-th request, and the three faults.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { egressFor } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { createGate, lastMutating, nthOf } from '../../src/gate/gate.js';
import { Forwarder } from '../../src/gate/forwarder.js';
import { HookGate } from '../../src/gate/hookgate.js';

interface Backend {
  url: string;
  seen: string[];
  server: Server;
}

async function backend(): Promise<Backend> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}${req.headers['authorization'] ? ` auth=${req.headers['authorization']}` : ''}`);
      res.writeHead(200, { 'content-type': 'application/json', etag: '"7"' }).end(JSON.stringify({ n: seen.length }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

test('base-URL gate: forwards faithfully, logs, holds the nth matching request, and injects the three faults', async () => {
  const b = await backend();
  const egress = egressFor([]);
  const g = new Forwarder('TRACKER_BACKEND_URL', `${b.url}/api`, egress, 1_000);
  await g.start();
  try {
    const base = g.serverEnv()['TRACKER_BACKEND_URL']!;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/api$/);
    assert.ok(egress.allow.some((h) => b.url.endsWith(h)), 'the upstream is put on the egress list');
    assert.match(g.describe(), /TRACKER_BACKEND_URL .*loopback gate.*forwards every request/);
    // Pass-through: path, query, body, headers, status and response headers.
    const m0 = g.mark();
    const r = await fetch(`${base}/t?x=1`, { method: 'POST', body: '{"a":1}', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('etag'), '"7"');
    assert.deepEqual(b.seen, ['POST /api/t?x=1 {"a":1} auth=Bearer tok']);
    const log = await g.since(m0);
    assert.deepEqual(log.map((x) => [x.seq, x.method, x.path, x.status, x.mutating]), [[1, 'POST', '/api/t', 200, true]]);

    // Hold the 2nd PUT /api/t/1: the first passes, the second is held while another request finishes.
    const h = g.hold({ method: 'PUT', path: '/api/t/1', nth: 2 });
    assert.equal((await fetch(`${base}/t/1`, { method: 'PUT', body: 'first' })).status, 200);
    const held = fetch(`${base}/t/1`, { method: 'PUT', body: 'A' });
    const hr = await h.waitHeld(2_000);
    assert.ok(hr, 'the request is held');
    assert.equal(hr.method, 'PUT');
    assert.equal(h.heldRequest?.seq, hr.seq);
    assert.equal((await fetch(`${base}/t/1`, { method: 'PUT', body: 'B' })).status, 200);
    assert.ok(!b.seen.some((s) => s.includes(' A')), 'A has not reached the backend');
    await h.release();
    assert.equal((await held).status, 200);
    assert.ok(h.releasedAt !== null);
    assert.deepEqual(b.seen.slice(-3).map((s) => s.split(' ')[2]), ['first', 'B', 'A'], 'B landed before the held A');
    assert.equal(await g.hold({ method: 'DELETE', path: '/nope', nth: 1 }).waitHeld(50), null);

    // Faults.
    const n0 = b.seen.length;
    const f1 = g.fault({ method: 'POST', path: '/api/x', nth: 1, kind: 'status', status: 503 });
    assert.equal((await fetch(`${base}/x`, { method: 'POST', body: 's' })).status, 503);
    assert.equal(b.seen.length, n0, 'status: the backend never saw it');
    assert.equal((await f1.waitHit(100))?.status, 503);
    g.fault({ method: 'POST', path: '/api/x', nth: 1, kind: 'commit_then_status', status: 504 });
    assert.equal((await fetch(`${base}/x`, { method: 'POST', body: 'c' })).status, 504);
    assert.equal(b.seen.length, n0 + 1, 'commit_then_status: the backend applied it');
    const f3 = g.fault({ method: 'POST', path: '/api/x', nth: 1, kind: 'commit_then_reset' });
    await assert.rejects(fetch(`${base}/x`, { method: 'POST', body: 'r' }));
    assert.equal(b.seen.length, n0 + 2, 'commit_then_reset: the backend applied it, the client got no answer');
    assert.equal((await f3.waitHit(100))?.status, null);
    assert.equal((await fetch(`${base}/x`, { method: 'POST', body: 'ok' })).status, 200, 'a fault applies once');
    // commit_then_hang (MWS-RETRY-2, the crash form of step (e)): the backend applies it, the answer is held until the client goes away.
    const f4 = g.fault({ method: 'POST', path: '/api/x', nth: 1, kind: 'commit_then_hang' });
    const ac = new AbortController();
    const hung = fetch(`${base}/x`, { method: 'POST', body: 'h', signal: ac.signal }).then(() => 'answered', () => 'cut');
    assert.equal((await f4.waitHit(2_000))?.status, null, 'the hit is reported once the backend answered');
    assert.equal(b.seen.length, n0 + 4, 'commit_then_hang: the backend applied it');
    assert.equal(await Promise.race([hung, new Promise((r) => setTimeout(() => r('still held'), 200))]), 'still held');
    ac.abort();
    assert.equal(await hung, 'cut');

    // clear() lets a held request through.
    g.hold({ method: 'GET', path: '/api/slow', nth: 1 });
    const slow = fetch(`${base}/slow`);
    await new Promise((r) => setTimeout(r, 50));
    g.clear();
    assert.equal((await slow).status, 200);

    const learned = await g.since(0);
    const last = lastMutating(learned)!;
    assert.equal(last.method, 'POST');
    assert.equal(nthOf(learned, last), learned.filter((x) => x.method === 'POST' && x.path === last.path).length);
  } finally {
    await g.stop();
    b.server.close();
  }
});

test('createGate: the route the manifest names; the base-URL route needs the upstream in the environment', async () => {
  const doc = (gate: string) => parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: x }
backend: { gate: ${gate} }
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`, '/tmp/m.yaml');
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-gate-'));
  try {
    assert.throws(() => createGate(doc('{ rewrite_env: BACKEND }'), {}, { stateDir: dir, egress: egressFor([]) }), /BACKEND is not set/);
    assert.equal(createGate(doc('{ rewrite_env: BACKEND }'), { BACKEND: 'http://127.0.0.1:9' }, { stateDir: dir, egress: egressFor([]) })?.route, 'base_url');
    const h = createGate(doc('{ node_import: true }'), {}, { stateDir: dir, egress: egressFor([]) });
    assert.equal(h?.route, 'node_import');
    assert.match(h!.describe(), /cooperative hook inside the server/);
    assert.match(h!.serverEnv()['NODE_OPTIONS']!, /^--import=file:\/\/.*register\.js$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node --import gate: the hook in the server process logs, holds and fails requests as the tester arms them', async () => {
  const b = await backend();
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-hook-'));
  const g = new HookGate(dir, [], 1_000);
  await g.start();
  const script = join(dir, 'server.mjs');
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', async (l) => {
  const [method, path] = l.split(' ');
  try {
    const r = await fetch(process.env.BACKEND + path, { method, ...(method === 'GET' ? {} : { body: path }) });
    console.log('done ' + path + ' ' + r.status);
  } catch (e) {
    console.log('done ' + path + ' error');
  }
});
`,
  );
  const child = spawn(process.execPath, [script], { env: { PATH: process.env['PATH'], BACKEND: b.url, ...g.serverEnv() }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  createInterface({ input: child.stdout! }).on('line', (l) => (lines.push(l), waiters.splice(0).forEach((w) => w(l))));
  const next = (path: string) => new Promise<string>((r) => {
    const look = () => {
      const i = lines.findIndex((l) => l.startsWith(`done ${path} `));
      if (i >= 0) return r(lines.splice(i, 1)[0]!);
      waiters.push(look);
    };
    look();
  });
  const send = (l: string) => child.stdin!.write(`${l}\n`);
  try {
    const m0 = g.mark();
    send('GET /a');
    assert.equal(await next('/a'), 'done /a 200');
    const log = await g.since(m0);
    assert.deepEqual(log.map((x) => [x.method, x.path, x.status]), [['GET', '/a', 200]]);

    const h = g.hold({ method: 'PUT', path: '/t/1', nth: 1 });
    send('PUT /t/1');
    const held = await h.waitHeld(3_000);
    assert.ok(held, 'held inside the server');
    assert.ok(!b.seen.some((s) => s.startsWith('PUT /t/1')));
    send('PUT /t/2');
    assert.equal(await next('/t/2'), 'done /t/2 200');
    await h.release();
    assert.equal(await next('/t/1'), 'done /t/1 200');
    assert.deepEqual(b.seen.slice(-2).map((s) => s.split(' ')[1]), ['/t/2', '/t/1']);

    const n0 = b.seen.length;
    const f = g.fault({ method: 'POST', path: '/x', nth: 1, kind: 'status', status: 503 });
    send('POST /x');
    assert.equal(await next('/x'), 'done /x 503');
    assert.equal(b.seen.length, n0);
    assert.equal((await f.waitHit(2_000))?.method, 'POST');
    g.fault({ method: 'POST', path: '/y', nth: 1, kind: 'commit_then_reset' });
    send('POST /y');
    assert.equal(await next('/y'), 'done /y error');
    assert.equal(b.seen.length, n0 + 1, 'the backend applied it; the server got no answer');
    // commit_then_hang: the hit is the hook's commit line; the server's fetch never settles.
    const fh = g.fault({ method: 'POST', path: '/z', nth: 1, kind: 'commit_then_hang' });
    send('POST /z');
    assert.equal((await fh.waitHit(3_000))?.method, 'POST');
    assert.equal(b.seen.length, n0 + 2);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!lines.some((l) => l.startsWith('done /z ')), 'no answer reached the server');
  } finally {
    child.kill('SIGKILL');
    await g.stop();
    b.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
