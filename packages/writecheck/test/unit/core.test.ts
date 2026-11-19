import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Capture, verifyCapture } from '../../src/core/capture.js';
import { evaluate } from '../../src/core/conditions.js';
import { assertEgress, egressFor, EgressBlocked, lockGlobalFetch } from '../../src/core/egress.js';
import { Ledger, openRuns, readLedger, refuseIfOpen } from '../../src/core/ledger.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { guardProblem } from '../../src/core/safety.js';
import { deleteArgs } from '../../src/core/driver.js';
import { adjustResults } from '../../src/checks/coverage.js';
import { result } from '../../src/report/verdicts.js';
import { catalogCommand, planCommand } from '../../src/cli/commands.js';
import { Redactor, REDACTED } from '../../src/core/redact.js';
import { bareHost, checkTarget, hostsIn, confirm, productionReason, targetHosts } from '../../src/core/safety.js';
import { buildPlan, renderPlan } from '../../src/core/plan.js';
import { ruleOfThree, wilson } from '../../src/core/stats.js';
import { render } from '../../src/core/template.js';
import { canonical, diff, getPath, setPath, withoutIgnored, WritecheckError } from '../../src/core/util.js';

const MIN = `mws: "0.9"
server: { stdio: [node, server.js], env_public: [TRACKER_URL] }
target: { environment: test, confirm: "127.0.0.1:4100", guard: { tool: whoami, args: {}, path: tenant, pattern: "^test-" } }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [open, closed] } ]
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
`;

test('canonical JSON sorts keys and keeps numbers in shortest form', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 1.5, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,1.5,"x"],"b":1,"c":{"y":2,"z":1}}');
  assert.equal(canonical({ a: undefined, b: 1e21 }), '{"b":1e+21}');
  assert.throws(() => canonical({ a: NaN }));
});

test('paths, set and diff with ignored fields', () => {
  const o = { a: { b: [1, { c: 'x' }] }, 'k.y': 2 };
  assert.equal(getPath(o, 'a.b[1].c'), 'x');
  assert.equal(getPath(o, '$["k.y"]'), 2);
  const p = setPath(o, 'a.b[1].c', 'y');
  assert.equal(getPath(p, 'a.b[1].c'), 'y');
  assert.equal(getPath(o, 'a.b[1].c'), 'x', 'setPath copies');
  const d = diff({ a: 1, v: 1, t: 'x' }, { a: 2, v: 2, t: 'y' });
  assert.deepEqual(withoutIgnored(d, ['v', 't']).map((e) => e.path), ['a']);
});

test('templates keep the type of a whole-token value and render keys', () => {
  assert.deepEqual(render({ id: '{{id}}', '{{field}}': '{{value}}', t: 'x-{{id}}' }, { id: 7, field: 'status', value: { a: 1 } }), { id: 7, status: { a: 1 }, t: 'x-7' });
  assert.throws(() => render('{{nope}}', {}), /no variable/);
});

test('conditions compare references with variables, missing keys read as null', () => {
  const env = { VA: 'bob', final: { obj: { assignee: 'bob' } } };
  assert.equal(evaluate('final.obj.assignee == VA', env), true);
  assert.equal(evaluate({ all: ['final.obj.assignee == VA', 'final.obj.missing == null'] }, env), true);
  assert.equal(evaluate({ not: 'final.obj.missing' }, env), true);
});

test('Wilson upper bound and rule of three for 0 losses', () => {
  const w = wilson(0, 30)!;
  assert.equal(w.lo, 0);
  assert.ok(Math.abs(w.hi - 0.1135) < 0.001, `wilson hi ${w.hi}`);
  assert.equal(ruleOfThree(30)!.approx, 0.1);
  assert.ok(Math.abs(ruleOfThree(30)!.exact - 0.0950) < 0.001);
  assert.equal(wilson(0, 0), null);
});

test('redaction masks exact secrets (also JSON-escaped), token shapes and bearer values; markers carry nothing of the secret', () => {
  const r = new Redactor(['s3cret-value-123']);
  const out = r.body(JSON.stringify({ a: 's3cret-value-123', b: 's3cret\\u002dvalue-123', auth: 'Bearer abcdefghijklmnop', jwt: 'eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl' }));
  assert.ok(!out.includes('s3cret-value-123'));
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.ok(!out.includes('eyJhbGciOiJI'));
  assert.ok(out.includes(REDACTED));
  assert.equal(r.headers([['Authorization', 'Bearer x'], ['x-ok', 'fine']])['authorization'], REDACTED);
});

test('egress: only listed hosts, never the metadata address; the global fetch is locked', async () => {
  const p = egressFor(['http://127.0.0.1:4100/mcp']);
  assertEgress(new URL('http://127.0.0.1:4100/x'), p);
  assert.throws(() => assertEgress(new URL('http://127.0.0.1:4101/x'), p), EgressBlocked);
  assert.throws(() => assertEgress(new URL('http://169.254.169.254/'), { allow: ['169.254.169.254'] }), /metadata/);
  assert.throws(() => assertEgress(new URL('file:///etc/passwd'), p), /scheme/);
  const unlock = lockGlobalFetch(p);
  try {
    await assert.rejects(fetch('https://example.com/'), EgressBlocked);
  } finally {
    unlock();
  }
});

test('capture: redacted blobs, and the closing hash detects an edited file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-cap-'));
  try {
    const c = new Capture(dir, new Redactor(['topsecretvalue']));
    c.write({ label: 'A', step: 's1', dir: 'send', channel: 'stdin' }, '{"token":"topsecretvalue"}');
    c.close();
    assert.ok(verifyCapture(dir).ok);
    const lines = readFileSync(join(dir, 'capture.jsonl'), 'utf8');
    assert.ok(!lines.includes('topsecretvalue'));
    const rec = JSON.parse(lines.split('\n')[1]!) as { blob: { sha256: string; redacted: boolean; original_sha256?: string } };
    assert.equal(rec.blob.redacted, true);
    assert.equal(rec.blob.original_sha256, undefined, 'no hash of an unredacted secret-bearing body');
    assert.ok(!readFileSync(join(dir, 'blobs', 'sha256', rec.blob.sha256), 'utf8').includes('topsecretvalue'));
    writeFileSync(join(dir, 'capture.jsonl'), lines.replace('"A"', '"B"'));
    assert.equal(verifyCapture(dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: the minimum loads; guessed markers, unknown keys and unsafe choices are refused', () => {
  const m = parseManifestText(MIN, 'm.yaml');
  // why: review S2: the pair budget is opt-in; a manifest with no limits keeps the defaults (and its plan hash).
  assert.equal(m.limits.write_budget, 500);
  assert.equal(m.limits.pair_repeats, undefined);
  assert.equal(m.limits.pair_budget, undefined);
  assert.equal(m.limits.writes_per_second, 5);
  assert.equal(m.limits.pairs, 40, 'enough runs to reach 30 overlapped pairs');
  assert.equal(m.resources[0]!.update!.mode, 'field_patch');
  assert.throws(() => parseManifestText(MIN.replace('cleanup: delete', 'cleanup: delete # guessed'), 'm.yaml'), /guessed/);
  assert.throws(() => parseManifestText(MIN.replace('cleanup: delete', 'cleanup: delete\n    colour: red'), 'm.yaml'), /unknown key colour/);
  assert.throws(() => parseManifestText(MIN.replace('mode: field_patch, ', ''), 'm.yaml'), /mode/);
  assert.throws(() => parseManifestText(MIN.replace('    delete: { tool: ticket_delete, args: { id: "{{id}}" } }\n', ''), 'm.yaml'), /delete needs a delete block/);
  assert.throws(() => parseManifestText(MIN.replace('create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }', 'fixture: { id: T1, name: my-ticket }'), 'm.yaml'), /mwsc-/);
  assert.throws(() => parseManifestText(MIN.replace('    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }\n', ''), 'm.yaml'), /create .* or fixture/);
  assert.throws(() => parseManifestText(MIN.replace('mws: "0.9"', 'mws: "1.0"'), 'm.yaml'), /mws/);
});

test('safety: environment must be test; production-looking hosts are refused unless listed', () => {
  const m = parseManifestText(MIN, 'm.yaml');
  checkTarget(m, { TRACKER_URL: 'http://127.0.0.1:4100' });
  assert.throws(() => checkTarget(m, { TRACKER_URL: 'https://api.example.com' }), /production front door/);
  assert.throws(() => checkTarget(m, { TRACKER_URL: 'https://tracker.prod.example.com' }), /production label/);
  assert.throws(() => checkTarget(m, { TRACKER_URL: 'https://github.com/x' }), /hosted service/);
  const allowed = parseManifestText(MIN.replace('confirm: "127.0.0.1:4100",', 'confirm: "127.0.0.1:4100", allow_hosts: [api.example.com],'), 'm.yaml');
  checkTarget(allowed, { TRACKER_URL: 'https://api.example.com' });
  const prod = parseManifestText(MIN.replace('environment: test', 'environment: production'), 'm.yaml');
  assert.throws(() => checkTarget(prod, {}), /declared as test/);
  assert.equal(productionReason('localhost:3000'), null);
  assert.equal(productionReason('staging-tracker.internal:443'), null);
});

test('safety: a backend URL in the server command line is a target host (shown and checked)', () => {
  const base = parseManifestText(MIN, 'm.yaml');
  const withArgv = (stdio: string[]) => ({ ...base, server: { ...base.server, stdio } });
  const local = withArgv(['node', 'server.js', 'redis://127.0.0.1:6379']);
  assert.deepEqual(targetHosts(local, {}).filter((h) => h.where.startsWith('server.stdio')), [{ host: '127.0.0.1:6379', where: 'server.stdio[2]' }]);
  checkTarget(local, { TRACKER_URL: 'http://127.0.0.1:4100' });
  const flag = withArgv(['node', 'server.js', '--url=postgres://u:p@db.prod.example.com:5432/x']);
  assert.deepEqual(targetHosts(flag, {}).filter((h) => h.where.startsWith('server.stdio')).map((h) => h.host), ['db.prod.example.com:5432']);
  assert.throws(() => checkTarget(flag, { TRACKER_URL: 'http://127.0.0.1:4100' }), /server\.stdio\[2\].*production label/);
  assert.deepEqual(targetHosts(withArgv(['node', 'server.js', '--verbose']), {}).filter((h) => h.where.startsWith('server.stdio')), []);
  assert.deepEqual(targetHosts(withArgv(['node', 'server.js', 'file:///tmp/db.sqlite']), {}).filter((h) => h.where.startsWith('server.stdio')), []);
  assert.deepEqual(targetHosts(withArgv(['node', 'server.js', '--peers=http://a:1,http://b:2']), {}).filter((h) => h.where.startsWith('server.stdio')).map((h) => h.host), ['a:1', 'b:2']);
});

test('safety: a bare host or IP address is read the same way URL hosts are, and anything else is not a host', () => {
  for (const [v, port, want] of [
    ['b0', undefined, 'b0'],
    ['b0', '3306', 'b0:3306'],
    ['DB.Example.TEST.', ' 5432 ', 'db.example.test:5432'],
    ['db_1', undefined, 'db_1'],
    ['10.0.0.7:6380', '6379', '10.0.0.7:6380'],
    ['::1', '5432', '[::1]:5432'],
    ['[fd00::2]:5432', undefined, '[fd00::2]:5432'],
    ['b0', 'abc', 'b0'],
    ['b0', '70000', 'b0'],
    // review item 5: one pair of surrounding quotes is dropped; an internationalized name is read in its ASCII form, as in a URL
    ['"db.example.test"', undefined, 'db.example.test'],
    ["'b0:5432'", undefined, 'b0:5432'],
    ['bücher.example.test', undefined, 'xn--bcher-kva.example.test'],
    ['sql.example.test\\INSTANCE1', undefined, 'sql.example.test'],
  ] as const) assert.equal(bareHost(v, port), want, `${v} ${port}`);
  for (const v of ['', ' ', 'true', 'FALSE', 'on', '1', '3306', '1.2', '300.1.1.1', '/var/run/db.sock', './data', 'C:\\db', 'a b', 'u@h', '-x', 'b0:99999', 'b0:', '0.0.0.0', '::', '[::]', 'a:b:c', 'x..y', '""', 'a,b'])
    assert.equal(bareHost(v), null, JSON.stringify(v));
  // round 3 item 5: a file name is not a host only in a flag's value; a variable's value is read
  for (const v of ['config.yaml', 'prod.env', 'warehouse.prod.sql']) assert.equal(bareHost(v, undefined, { flag: true }), null, v);
  assert.equal(bareHost('warehouse.prod.sql'), 'warehouse.prod.sql');
  // review item 3: with strict (SERVER, ADDR, ADDRESS, ENDPOINT and the list names), a single word without a port is a name...
  for (const v of ['b0', 'sql-1', 'hub']) assert.equal(bareHost(v, '5432', { strict: true }), null, v);
  assert.deepEqual(['b0:4222', 'db.example.test', '10.0.0.7'].map((v) => bareHost(v, undefined, { strict: true })), ['b0:4222', 'db.example.test', '10.0.0.7']);
  // ...unless it looks like production (round 3 item 3), and a listen address is read only then
  assert.deepEqual(['sql-prod', 'live', 'production'].map((v) => bareHost(v, '5432', { strict: true })), ['sql-prod:5432', 'live:5432', 'production:5432']);
  assert.deepEqual(['127.0.0.1', 'b0.internal', 'app.example.test', 'db.prod.example.com'].map((v) => bareHost(v, undefined, { listen: true })), [null, null, null, 'db.prod.example.com']);
  // review item 2: lists are read item by item; host,1433 is one host with its port
  assert.deepEqual(hostsIn('a.example.test:27017, b:27017,,c', '1'), ['a.example.test:27017', 'b:27017', 'c:1']);
  assert.deepEqual(hostsIn('sql.example.test,1433'), ['sql.example.test:1433']);
  // round 3 item 4: a named instance is dropped before the comma is read
  assert.deepEqual(hostsIn('sql.example.test\\INSTANCE1,1433'), ['sql.example.test:1433']);
  assert.deepEqual(hostsIn('tcp:sql.example.test,1433'), ['sql.example.test:1433']);
  assert.deepEqual(hostsIn('a\\I1,b\\I2'), ['a', 'b']);
  assert.deepEqual(hostsIn('http://a:1,b'), [], 'a URL is read as a URL, elsewhere');
});

test('safety: a host in a host variable is a target host, with the port from its sibling *_PORT variable (shown and checked)', () => {
  const base = parseManifestText(MIN, 'm.yaml');
  const withEnv = (env: Record<string, string>, more: Partial<typeof base.server> = {}) => ({ ...base, server: { ...base.server, env, ...more } });
  const env = (m: typeof base, e: NodeJS.ProcessEnv = {}) => targetHosts(m, e).filter((h) => !h.where.endsWith('TRACKER_URL'));
  const hosts = (e: Record<string, string>) => env(withEnv(e)).map((h) => h.host);
  assert.deepEqual(env(withEnv({ SQL_HOST: 'b0', SQL_PORT: '3306', SQL_USER: 'app' })), [{ host: 'b0:3306', where: 'server.env SQL_HOST' }]);
  assert.deepEqual(hosts({ PGHOST: 'pg.internal', PGPORT: '5433' }), ['pg.internal:5433']);
  assert.deepEqual(hosts({ CACHE_HOST: '127.0.0.1' }), ['127.0.0.1'], 'no sibling port: the host alone');
  assert.deepEqual(hosts({ DB_HOSTNAME: 'b1', DB_PORT: '3307' }), ['b1:3307']);
  assert.deepEqual(hosts({ QUEUE_SERVER: 'b2:4222', QUEUE_PORT: '9999' }), ['b2:4222'], 'a port in the value wins');
  assert.deepEqual(hosts({ STORE_ADDR: 'b3.internal', STORE_ADDRESS: '10.0.0.4', SEARCH_ENDPOINT: 'b5:9200' }), ['b3.internal', '10.0.0.4', 'b5:9200']);
  assert.deepEqual(hosts({ SEARCH_ENDPOINT: 'http://b5:9200' }), ['b5:9200'], 'a URL value is read once, as a URL');
  // review item 7: the sibling port is found in any case
  assert.deepEqual(hosts({ db_host: 'b0', db_port: '5432' }), ['b0:5432']);
  assert.deepEqual(hosts({ Db_Host: 'b0', DB_PORT: '5432' }), ['b0:5432']);
  // review item 2: plurals and list names, comma-separated lists, and host,port
  assert.deepEqual(hosts({ DOCS_HOSTS: 'a.internal:27017,b.internal:27017' }), ['a.internal:27017', 'b.internal:27017']);
  assert.deepEqual(hosts({ STREAM_BOOTSTRAP_SERVERS: 'k1.internal:9092', QUEUE_BROKERS: 'k2:9092', SEARCH_NODES: 'n1:9200', RING_SEEDS: '10.0.0.5', CACHE_SENTINELS: 's1:26379' }), ['k1.internal:9092', 'k2:9092', 'n1:9200', '10.0.0.5', 's1:26379']);
  assert.deepEqual(hosts({ SQL_SERVER: 'sql.internal,1433' }), ['sql.internal:1433']);
  assert.deepEqual(hosts({ DOCS_URI: 'docs.prod.example.com:27017/db', DATABASE_URL: 'db.prod.example.com:5432' }), [], '*_URI and *_URL without a scheme are not read');
  // a passed-through variable is read from the tester's environment, with its sibling port when that is passed through too
  const passed = withEnv({}, { env_public: ['TRACKER_URL', 'CACHE_HOST', 'CACHE_PORT'] });
  assert.deepEqual(env(passed, { CACHE_HOST: 'b7', CACHE_PORT: '6379' }), [{ host: 'b7:6379', where: 'server environment CACHE_HOST' }]);
  assert.deepEqual(env(passed, {}), []);
  // the rule: the word ends the name and starts it or follows an underscore; values that are not a hostname or an IP are not hosts
  assert.deepEqual(hosts({ HOST_HEADER: 'b8', GHOST: '1', GHOST_HOST: 'true', LOCALHOST_ONLY: 'yes', DB_HOST_PORT: 'b9', MCP_SERVER_NAME: 'b10', APP_HOST: '', DATA_HOST: '/var/lib/db', SOME_ADDR: '3306' }), []);
  // review item 3: a single word is not a host for SERVER/ADDR/ADDRESS/ENDPOINT names; a one-word name and a LISTEN or BIND name
  // are the server's own listen address
  assert.deepEqual(hosts({ TOOLS_SERVER: 'hub', EMBED_ENDPOINT: 'vendor', DEPLOY_ADDR: 'eu' }), []);
  checkTarget(withEnv({ TOOLS_SERVER: 'hub' }), { TRACKER_URL: 'http://127.0.0.1:4100' });
  assert.deepEqual(hosts({ DB_HOST: 'warehouse.prod.sql' }), ['warehouse.prod.sql'], 'round 3 item 5: no file-name filter for variables');
  // round 3 item 3: a single word that looks like production is read under every host name, and refused
  assert.deepEqual(hosts({ DB_SERVER: 'sql-prod', QUEUE_BROKERS: 'q-prod-0,q-prod-1', SEARCH_NODES: 'es-live', DB_HOST: 'pg-prod' }), ['sql-prod', 'q-prod-0', 'q-prod-1', 'es-live', 'pg-prod']);
  assert.throws(() => checkTarget(withEnv({ SEARCH_NODES: 'es-live' }), { TRACKER_URL: 'http://127.0.0.1:4100' }), /SEARCH_NODES: es-live has a production label/);
  // round 3 item 1: a stdio server does not listen, so a one-word HOST or SERVER is a target (with PORT)
  assert.deepEqual(hosts({ HOST: 'db.prod.example.com', PORT: '5432' }), ['db.prod.example.com:5432']);
  assert.deepEqual(hosts({ SERVER: 'db.prod.example.com', HOSTNAME: 'b0', ADDR: 'b1:1' }), ['db.prod.example.com', 'b0', 'b1:1']);
  assert.throws(() => checkTarget(withEnv({ SERVER: 'db.prod.example.com' }), { TRACKER_URL: 'http://127.0.0.1:4100' }), /server\.env SERVER: .*production label/);
  // for a launched server they are where it listens: read only when the value looks like production
  const launchedEnv = (e: Record<string, string>) => env(withEnv(e, { stdio: null, launch: { command: ['srv'], url_from: '$', ready_timeout_ms: 1000 } })).map((h) => h.host);
  assert.deepEqual(launchedEnv({ HOST: '127.0.0.1', PORT: '3000', ADDR: 'b0.internal:1', DB_HOST: 'b2' }), ['b2']);
  assert.deepEqual(launchedEnv({ HOST: 'db.prod.example.com' }), ['db.prod.example.com']);
  // round 3 item 6: BIND or LISTEN right before HOST/HOSTNAME/ADDR/ADDRESS/IP names a listen address; other BIND names count
  assert.deepEqual(hosts({ LISTEN_ADDR: 'b0.internal:8080', BIND_ADDRESS: '10.0.0.1', SERVER_LISTEN_HOST: 'b0', DIR_BIND_HOST: 'b1.internal' }), []);
  assert.deepEqual(hosts({ LISTEN_HOST: 'db.prod.example.com', BIND_SERVER: 'ns1.internal', REBIND_HOST: 'b3' }), ['db.prod.example.com', 'ns1.internal', 'b3']);
  // checked like a URL host
  const prod = withEnv({ DB_HOST: 'db.prod.example.com', DB_PORT: '5432' });
  assert.throws(() => checkTarget(prod, { TRACKER_URL: 'http://127.0.0.1:4100' }), /server\.env DB_HOST: db\.prod\.example\.com has a production label/);
  checkTarget({ ...prod, target: { ...prod.target, allow_hosts: ['db.prod.example.com'] } }, { TRACKER_URL: 'http://127.0.0.1:4100' });
  checkTarget(withEnv({ DB_HOST: 'b0', DB_PORT: '5432' }), { TRACKER_URL: 'http://127.0.0.1:4100' });
  assert.throws(() => checkTarget(withEnv({ DOCS_HOSTS: 'b0:1,b1.prod.example.com:2' }), { TRACKER_URL: 'http://127.0.0.1:4100' }), /DOCS_HOSTS: b1\.prod\.example\.com has a production label/);
  // and shown in the plan
  const shown = renderPlan(buildPlan(withEnv({ SQL_HOST: 'b0', SQL_PORT: '3306' }), [], targetHosts(withEnv({ SQL_HOST: 'b0', SQL_PORT: '3306' }), {}).map((h) => h.host)), 'h');
  assert.match(shown, /Hosts reached or given to the server: b0:3306\n/);
});

test('safety: a host after a host flag in the server command line is a target host, with its port flag', () => {
  const base = parseManifestText(MIN, 'm.yaml');
  const argv = (stdio: string[]) => targetHosts({ ...base, server: { ...base.server, stdio } }, {}).filter((h) => h.where.startsWith('server.stdio'));
  const hosts = (stdio: string[]) => argv(stdio).map((h) => h.host);
  assert.deepEqual(argv(['node', 'server.js', '--host', 'b0', '--port', '3306']), [{ host: 'b0:3306', where: 'server.stdio[3]' }]);
  assert.deepEqual(argv(['node', 'server.js', '--port=6379', '--host=b1']), [{ host: 'b1:6379', where: 'server.stdio[3]' }]);
  assert.deepEqual(hosts(['node', 'server.js', '--hostname', 'b2:5432', '--port', '1']), ['b2:5432']);
  assert.deepEqual(hosts(['node', 'server.js', '--host', 'http://b3:80']), ['b3'], 'a URL after the flag is read once, as a URL');
  // review item 1: the name rule on the flag's words: prefixed host flags, SERVER and ADDR flags, -H
  assert.deepEqual(hosts(['srv', '--db-host', 'b0', '--db-port', '3306', '--port', '9']), ['b0:3306']);
  assert.deepEqual(hosts(['srv', '--cache_host=b1']), ['b1']);
  assert.deepEqual(hosts(['srv', '--server', 'b2.internal', '--addr', 'b3:6379', '--store-hosts', 'a:1,b:2']), ['b2.internal', 'b3:6379', 'a:1', 'b:2']);
  assert.deepEqual(hosts(['srv', '--server', 'hub', '--addr', 'eu']), [], 'SERVER and ADDR flags need a dot, an IP or a port');
  assert.deepEqual(hosts(['srv', '--server', 'sql-prod']), ['sql-prod'], '...or a production label');
  assert.deepEqual(hosts(['srv', '-H', 'b4.internal']), ['b4.internal']);
  assert.deepEqual(hosts(['srv', '-H', 'b4', '-p', '6379']), ['b4:6379']);
  assert.deepEqual(hosts(['srv', '-H', 'b4']), [], '-H with a single word and no port flag is not read');
  // review item 1: -e NAME=value, --env NAME=value and --env=NAME=value go through the variable rule
  assert.deepEqual(argv(['runner', 'run', '-e', 'DB_HOST=b5', '-e', 'DB_PORT=5432', '--env', 'CACHE_HOST=b6', '--env=QUEUE_SERVER=b7.internal', 'image']), [
    { host: 'b5:5432', where: 'server.stdio[3]' },
    { host: 'b6', where: 'server.stdio[7]' },
    { host: 'b7.internal', where: 'server.stdio[8]' },
  ]);
  assert.deepEqual(hosts(['runner', '-e', 'HOST=0.0.0.0', '-e', 'PORT=3000', '-e', 'TOOLS_SERVER=hub']), []);
  // round 3 item 7: for a container runtime, -h and --hostname name the container itself; its -e and --env are still read
  assert.deepEqual(argv(['docker', 'run', '-h', 'app.prod.example.com', '--hostname', 'app.prod.example.com', '-p', '8080:80', '-e', 'db_host=db.prod.example.com', 'image']), [{ host: 'db.prod.example.com', where: 'server.stdio[9]' }]);
  assert.deepEqual(hosts(['/usr/bin/podman', 'run', '-h', 'b0.internal', 'image']), []);
  assert.deepEqual(hosts(['runner', '-e', 'DB_HOST', 'image']), [], 'a name without a value is not read');
  assert.deepEqual(hosts(['sh', '-c', 'node server.js --host db.prod.example.com']), [], 'a shell string is not parsed');
  // review item 4: -h is a host only with -p or --port, and never a file name
  assert.deepEqual(hosts(['srv', '-h', 'db.internal', '-p', '5432']), ['db.internal:5432']);
  assert.deepEqual(hosts(['srv', '-h', '10.0.0.7', '--port', '5432']), ['10.0.0.7:5432']);
  assert.deepEqual(hosts(['srv', '-h', 'config.yaml', '-p', '1']), []);
  // round 3 item 2: without a port flag, -h takes a dotted name, an IP or host:port (a single word may be help), never a file name
  assert.deepEqual(hosts(['srv', '-h', 'db.prod.example.com']), ['db.prod.example.com']);
  assert.deepEqual(hosts(['srv', '-h', '10.1.2.3']), ['10.1.2.3']);
  assert.deepEqual(hosts(['srv', '-h', 'b0:5432']), ['b0:5432']);
  assert.deepEqual(hosts(['srv', '-h', 'json']), []);
  assert.deepEqual(hosts(['srv', '-h', 'config.yaml']), []);
  assert.throws(() => checkTarget({ ...base, server: { ...base.server, stdio: ['srv', '-h', 'db.prod.example.com'] } }, { TRACKER_URL: 'http://127.0.0.1:4100' }), /server\.stdio\[2\].*production label/);
  assert.deepEqual(hosts(['srv', '--port', '1', '--host', 'b0', '--port', '2']), ['b0:2'], 'the port flag after the host wins');
  // review item 6: each host flag takes the port flag that follows it
  assert.deepEqual(hosts(['srv', '--host', 'a.internal', '--port', '1', '--host', 'b.internal', '--port', '2']), ['a.internal:1', 'b.internal:2']);
  // only after a known host flag, and only a hostname or an IP
  for (const a of [
    ['node', 'server.js', 'b0', '--port', '3306'],
    ['node', 'server.js', '--db', 'b0'],
    ['node', 'server.js', '--host'],
    ['node', 'server.js', '-h', '--verbose', '-p', '1'],
    ['node', 'server.js', '-H', 'Authorization: Bearer x'],
    ['node', 'server.js', '--host', '0.0.0.0', '--port', '3000'],
    ['node', 'server.js', '--host', 'true'],
    ['node', 'server.js', '-h=b0'],
    ['node', 'server.js', '--host-header', 'b0'],
    ['node', 'server.js', '--listen-addr', 'b0.internal:80', '--bind-host', 'b1'],
  ])
    assert.deepEqual(argv(a), [], a.join(' '));
  // review item 3: on server.launch.command an unprefixed --host/--port (or -h) is where the launched server listens
  const launched = (command: string[]) => targetHosts({ ...base, server: { ...base.server, stdio: null, launch: { command, url_from: '$', ready_timeout_ms: 1000 } } }, {}).filter((h) => h.where.startsWith('server.launch'));
  assert.deepEqual(launched(['srv', '--host', '127.0.0.1', '--port', '8000', '-h', 'b0', '-p', '1']), []);
  assert.deepEqual(launched(['srv', '--hostname', 'db.prod.example.com']).map((h) => h.host), ['db.prod.example.com'], 'unless it looks like production');
  assert.deepEqual(launched(['srv', '--host', '0.0.0.0', '--db-host', 'db.prod.example.com']), [{ host: 'db.prod.example.com', where: 'server.launch.command[4]' }]);
  assert.throws(() => checkTarget({ ...base, server: { ...base.server, stdio: ['srv', '--host', 'db.prod.example.com'] } }, { TRACKER_URL: 'http://127.0.0.1:4100' }), /server\.stdio\[2\].*production label/);
});

test('confirmation needs the target and the plan hash; without a terminal both must be flags', async () => {
  const m = parseManifestText(MIN, 'm.yaml');
  await confirm(m, 'abc', { confirmTarget: '127.0.0.1:4100', planHash: 'abc', interactive: false });
  await assert.rejects(confirm(m, 'abc', { interactive: false }), /there is no --yes/);
  await assert.rejects(confirm(m, 'abc', { confirmTarget: 'other', planHash: 'abc', interactive: false }), /target typed/);
  await assert.rejects(confirm(m, 'abc', { confirmTarget: '127.0.0.1:4100', planHash: 'abd', interactive: false }), /plan hash/);
  const asked: string[] = [];
  await confirm(m, 'abc', { interactive: true, ask: async (q) => (asked.push(q), q.includes('target') ? '127.0.0.1:4100' : 'abc') });
  assert.equal(asked.length, 2);
});

test('ledger: an intent without an outcome is open; a later run refuses; resolved entries close; a torn line is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-ledger-'));
  try {
    const l = new Ledger(join(dir, 'r1'), 'r1');
    const i1 = l.intent('ticket', 'ticket_create', 'x');
    l.append({ kind: 'created', intent: i1, resource: 'ticket', id: 'T1', name: 'mwsc-r1-t', via: 'result' });
    const i2 = l.intent('ticket', 'ticket_create', 'y');
    assert.deepEqual(l.open().objects.map((o) => o.id), ['T1']);
    assert.deepEqual(l.open().intents.map((o) => o.intent), [i2]);
    assert.throws(() => refuseIfOpen(dir), (e: unknown) => e instanceof WritecheckError && e.code === 3);
    l.append({ kind: 'deleted', resource: 'ticket', id: 'T1', via: 'delete' });
    l.append({ kind: 'create_failed', intent: i2, resource: 'ticket', reason: 'no' });
    appendFileSync(l.file, '{"kind":"intent","se');
    assert.equal(readLedger(l.file).length, 5);
    assert.deepEqual(openRuns(dir), []);
    refuseIfOpen(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI-BUGS 1 and 14: a declared read-only guard for an unannotated server; a manifest prefix', () => {
  const m = parseManifestText(MIN.replace('pattern: "^test-" }', 'pattern: "^test-", read_only: true }').replace('mws: "0.9"', 'mws: "0.9"\nprefix: mwsv'), 'm.yaml');
  const g = m.target.guard!;
  assert.equal(guardProblem(g, { annotations: {} }), null, 'declared read-only, no annotation: accepted');
  assert.match(guardProblem(g, { annotations: { readOnlyHint: false } })!, /readOnlyHint: false/, 'an explicit write annotation is refused anyway');
  assert.match(guardProblem({ ...g, read_only: false }, {})!, /read_only: true/, 'the refusal says how to declare it');
  assert.equal(m.prefix, 'mwsv');
  assert.equal(parseManifestText(MIN, 'm.yaml').prefix, 'mwsc');
  assert.throws(() => parseManifestText(MIN.replace('mws: "0.9"', 'mws: "0.9"\nprefix: "MW SV"'), 'm.yaml'), /lowercase/);
});

test('catalog-only mode: MWS-ANN-4 from a saved tools/list, everything else not tested, no call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-cat-'));
  try {
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ tools: [{ name: 'a', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'b', inputSchema: { type: 'object' } }] }));
    const r = await catalogCommand({ catalog: join(dir, 'tools.json'), out: join(dir, 'out'), env: {}, log: () => {} });
    const ann4 = r.doc.results.filter((x) => x.requirement === 'MWS-ANN-4');
    assert.deepEqual(ann4.map((x) => `${x.write_path.tool} ${x.verdict}`), ['a held', 'b violated']);
    assert.ok(r.doc.results.filter((x) => x.requirement !== 'MWS-ANN-4').every((x) => x.verdict === 'not tested'));
    assert.equal(r.doc.run.writes, 0);
    assert.equal(r.exit, 0, 'MWS-ANN-4 is a SHOULD');
    assert.ok(readFileSync(join(r.outDir, 'report.md'), 'utf8').startsWith('Scope: catalog only'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review and gate-2: guard read_only refused for a declared write tool or an annotated server; override only where the delete lists it', () => {
  const m = parseManifestText(MIN.replace('pattern: "^test-" }', 'pattern: "^test-", read_only: true }'), 'm.yaml');
  const g = m.target.guard!;
  assert.match(guardProblem({ ...g, tool: 'ticket_delete' }, {}, { writeTools: new Set(['ticket_delete']) })!, /declared as a write tool/);
  assert.match(guardProblem(g, {}, { anyAnnotated: true })!, /annotates some/);
  const r = parseManifestText(MIN.replace('    cleanup: delete\n    delete: { tool: ticket_delete, args: { id: "{{id}}" } }', '    cleanup: delete\n    version: { read: version, arg: v, optional: true, override: force }\n    delete: { tool: ticket_delete, args: { id: "{{id}}", v: "{{?version}}" } }'), 'm.yaml').resources[0]!;
  assert.deepEqual(deleteArgs(r, { id: 'T1' }, { properties: { id: {}, v: {}, force: {} } }), { id: 'T1', force: true });
  assert.deepEqual(deleteArgs(r, { id: 'T1' }, { properties: { id: {}, v: {} } }), { id: 'T1' }, 'never an argument the schema does not list');
  assert.deepEqual(deleteArgs(r, { id: 'T1', version: 3 }, { properties: { id: {}, v: {}, force: {} } }), { id: 'T1', v: 3 }, 'no override where the version is sent');
});

test('gate-2 Grafana 4 and K8s B7: a declared override takes CONC-1 away; an apply leaves CONC-2 open; held beside violated is annotated', () => {
  const m = parseManifestText(MIN.replace('args: { id: "{{id}}", "{{field}}": "{{value}}" } }', 'args: { id: "{{id}}", "{{field}}": "{{value}}", overwrite: true }, override: overwrite, apply: true }'), 'm.yaml');
  const w = { resource: 'ticket', tool: 'ticket_update', arm: 'mcp' as const };
  const sc = { id: 's', version: '1' };
  const out = adjustResults(m, [result('MWS-CONC-1', w, sc, 'violated', 'x'), result('MWS-CONC-2', w, sc, 'violated', 'y'), result('MWS-CONC-3', w, sc, 'violated', 'z'), result('MWS-CONC-3', w, { id: 't', version: '1' }, 'held', 'h')]);
  assert.deepEqual(out.map((r) => `${r.requirement} ${r.verdict}`), ['MWS-CONC-1 not tested', 'MWS-CONC-2 not tested', 'MWS-CONC-3 violated', 'MWS-CONC-3 held']);
  assert.ok(out[3]!.notes.some((n) => /that record decides/.test(n)));
});

test('gate-2 catalog fingerprint: catalog and plan compute the same fingerprint over the same catalog (tools, prompts and resource templates)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-catfp-'));
  try {
    const tool = (name: string, ro = false) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: ro } });
    const snapshot = { catalog: { tools: [tool('whoami', true), tool('ticket_get', true), tool('ticket_create'), tool('ticket_update'), tool('ticket_delete')], prompts: [{ name: 'triage' }], resourceTemplates: [{ uriTemplate: 'ticket://{id}', name: 'ticket' }] } };
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snapshot));
    writeFileSync(join(dir, 'm.yaml'), MIN);
    const { plan } = await planCommand({ manifest: join(dir, 'm.yaml'), catalog: join(dir, 'snapshot.json'), env: {}, log: () => {} });
    const r = await catalogCommand({ catalog: join(dir, 'snapshot.json'), out: join(dir, 'out'), env: {}, log: () => {} });
    assert.equal(r.doc.target.catalog_fingerprint, plan.catalog_fingerprint, 'the same catalog gives the same fingerprint in both commands');
    // A bare tools/list answer has no prompts: both commands fingerprint the tools alone, and agree again.
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ tools: snapshot.catalog.tools }));
    const p2 = await planCommand({ manifest: join(dir, 'm.yaml'), catalog: join(dir, 'tools.json'), env: {}, log: () => {} });
    const r2 = await catalogCommand({ catalog: join(dir, 'tools.json'), out: join(dir, 'out2'), env: {}, log: () => {} });
    assert.equal(r2.doc.target.catalog_fingerprint, p2.plan.catalog_fingerprint);
    assert.notEqual(r2.doc.target.catalog_fingerprint, r.doc.target.catalog_fingerprint, 'the prompts are part of the catalog');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
