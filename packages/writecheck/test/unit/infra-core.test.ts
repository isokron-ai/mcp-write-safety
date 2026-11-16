/** Infrastructure units: JCS, the catalog fingerprint (catalog-snap's form), egress by resolved address, the 2026-07-28 headers. */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { catalogFingerprint } from '../../src/checks/catalog.js';
import { encodeHeaderValue, envelopeHeaders, rawHttp } from '../../src/core/client.js';
import { assertEgressResolved, EgressBlocked, egressFor, isMetadataAddress, lockGlobalFetch, resolveVetted, setResolver } from '../../src/core/egress.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { canonical, canonicalJson } from '../../src/core/util.js';

test('canonicalJson: JCS, the same bytes as the recursive form, and safe at any depth', () => {
  const samples: unknown[] = [{ b: 1, a: [true, null, 'x', { d: 2.5, c: 'é' }], z: undefined }, [1, 2, { '': 0, ä: 1, a: 2 }], 'str', 0, -1e21, 1e-7, { __proto__x: 1 }];
  for (const s of samples) assert.equal(canonicalJson(s), canonical(s));
  assert.equal(canonicalJson({ b: 1, a: [undefined] }), '{"a":[null],"b":1}');
  let deep: unknown = 0;
  for (let i = 0; i < 20_000; i++) deep = [deep];
  assert.equal(canonicalJson(deep).length, 40_001);
  assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
});

test("catalogFingerprint: equals mcp-catalog-snap's sha256 for the same catalog (vectors computed with its own canonical.ts)", () => {
  const tools = [
    { name: 'zeta', description: 'Z — ünïcode', inputSchema: { type: 'object', properties: { b: { type: 'integer', minimum: 1 }, a: { type: 'string' } }, required: ['a'] }, annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'alpha', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false }, _meta: { x: 1.5, y: null } },
  ];
  const prompts = [{ name: 'p2', description: 'two' }, { name: 'p1', arguments: [{ name: 'q', required: true }] }];
  const resourceTemplates = [{ uriTemplate: 'mem://{id}', name: 'm' }, { uriTemplate: 'file://{path}', name: 'f' }];
  assert.equal(catalogFingerprint({ tools, prompts, resourceTemplates }), 'sha256:362c4f9af29f184ec32436a6b9a7e90958a9cf2bb3fb4fa45cc8dcbc7bed8d31');
  assert.equal(catalogFingerprint({ tools, prompts: [], resourceTemplates: [] }), 'sha256:8656ce382eb86c770fc90fc7f74e3d2df986069e81a6fc9a5953edfd97e06bb7');
  // A bare tools array is a catalog with no prompts and no templates; the order of tools does not matter.
  assert.equal(catalogFingerprint([...tools].reverse()), 'sha256:8656ce382eb86c770fc90fc7f74e3d2df986069e81a6fc9a5953edfd97e06bb7');
});

test('metadata endpoints are refused by resolved address, not only by name', async () => {
  for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '169.254.170.2', 'fd00:ec2::254', 'fd00:ec2:0:0:0:0:0:254', '100.100.100.200']) assert.ok(isMetadataAddress(ip), ip);
  for (const ip of ['127.0.0.1', '10.0.0.1', '::1', '169.254.1.1']) assert.ok(!isMetadataAddress(ip), ip);
  const restore = setResolver(async (h) => (h === 'innocent.test' ? [{ address: '169.254.169.254', family: 4 }] : h === 'mixed.test' ? [{ address: '127.0.0.1', family: 4 }, { address: 'fd00:ec2::254', family: 6 }] : [{ address: '127.0.0.1', family: 4 }]));
  try {
    await assert.rejects(resolveVetted('innocent.test'), /resolves to 169\.254\.169\.254/);
    await assert.rejects(resolveVetted('mixed.test'), /metadata/);
    await assert.rejects(assertEgressResolved(new URL('http://innocent.test/'), { allow: ['innocent.test'] }), EgressBlocked);
    assert.deepEqual(await resolveVetted('fine.test'), [{ address: '127.0.0.1', family: 4 }]);
    // The raw client never connects to a vetted-out address, even for a host on the list.
    const { done } = rawHttp('http://innocent.test:80/x', 'GET', {}, undefined, 2_000, { allow: ['innocent.test'] });
    const r = await done;
    assert.equal(r.status, null);
    assert.match(r.error ?? '', /metadata/);
    // The locked global fetch checks the resolved address too.
    const unlock = lockGlobalFetch({ allow: ['innocent.test'] });
    try {
      await assert.rejects(fetch('http://innocent.test/'), /metadata/);
    } finally {
      unlock();
    }
  } finally {
    restore();
  }
});

test('the raw client connects to the address it vetted (an injected name served on loopback)', async () => {
  const srv = createServer((_q, s) => s.end('ok'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const restore = setResolver(async () => [{ address: '127.0.0.1', family: 4 }]);
  try {
    const { done } = rawHttp(`http://backend.test:${port}/`, 'GET', {}, undefined, 2_000, egressFor([`http://backend.test:${port}/`]));
    const r = await done;
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'ok');
  } finally {
    restore();
    srv.close();
  }
});

test('2026-07-28 requests carry their method and name as headers (base64 sentinel when not plain ASCII)', () => {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  assert.deepEqual(envelopeHeaders({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_ticket', arguments: {}, _meta: meta } }), { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'get_ticket' });
  assert.deepEqual(envelopeHeaders({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {});
  assert.equal(encodeHeaderValue('plain_name'), 'plain_name');
  assert.equal(encodeHeaderValue('naïve'), `=?base64?${Buffer.from('naïve').toString('base64')}?=`);
  assert.equal(encodeHeaderValue(' padded'), `=?base64?${Buffer.from(' padded').toString('base64')}?=`);
});

test('manifest: server.launch, protocol, cwd relative to the manifest, and one gate route', () => {
  const base = (server: string, extra = '') => `mws: "0.9"
server:
${server}
target: { environment: test, confirm: x }
${extra}
resources:
  - name: r
    fixture: { id: 1, name: mwsc-f }
    read: { tool: get, args: {} }
    update: { tool: upd, mode: field_patch, args: {} }
    fields: [ { path: a, values: [1, 2] }, { path: b, values: [1, 2] } ]
`;
  const m = parseManifestText(base('  launch: { command: [node, srv.js, server], url_from: mcp }\n  cwd: sub\n  protocol: "2026-07-28"'), '/tmp/x/manifest.yaml');
  assert.deepEqual(m.server.launch, { command: ['node', 'srv.js', 'server'], url_from: 'mcp', ready_timeout_ms: 15_000 });
  assert.equal(m.server.cwd, '/tmp/x/sub');
  assert.equal(m.server.protocol, '2026-07-28');
  assert.equal(parseManifestText(base('  stdio: [node, s.js]'), '/tmp/x/m.yaml').server.protocol, 'auto');
  assert.throws(() => parseManifestText(base('  stdio: [node, s.js]\n  launch: { command: [node] }'), 'm.yaml'), /exactly one of stdio/);
  assert.throws(() => parseManifestText(base('  stdio: [node, s.js]\n  protocol: "2024-01-01"'), 'm.yaml'), /protocol/);
  assert.throws(() => parseManifestText(base('  stdio: [node, s.js]', 'backend: { gate: { rewrite_env: URL, node_import: true } }'), 'm.yaml'), /exactly one route/);
  assert.throws(() => parseManifestText(base('  stdio: [node, s.js]', 'backend: { gate: {} }'), 'm.yaml'), /exactly one route/);
  const g = parseManifestText(base('  stdio: [node, s.js]', 'backend: { gate: { node_import: true, hold_timeout_ms: 2000 } }'), 'm.yaml');
  assert.deepEqual(g.backend?.gate, { rewrite_env: null, node_import: true, hold_timeout_ms: 2000 });
});
