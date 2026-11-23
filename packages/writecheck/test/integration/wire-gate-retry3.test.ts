/**
 * The checks that count a server's backend writes, through the wire gate (B1 review). The wire gate names a write by its own
 * classification (`mutating`); its verbs (UPDATE, INSERT) are not HTTP methods, so a count by method saw no write:
 *   - MWS-RETRY-3, proxy position: close_item writes to Postgres before it answers input_required; the record said held.
 *   - MWS-ATOM-1/2: close_items (one UPDATE per item) had 0 writes counted, so its failed-write trials were never applied.
 *   - MWS-RES-3: create_item (two INSERTs) was taken for a single-step create, so its late failure was skipped.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand } from '../../src/cli/run.js';
import type { Result } from '../../src/report/verdicts.js';
import { fakePostgres } from '../wire/pg.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'wire', 'pg-mcp-server.js');

async function run(mode: 'early' | 'correct'): Promise<{ rs: Result[]; table: Map<string, string> }> {
  const db = await fakePostgres({});
  const dir = mkdtempSync(join(tmpdir(), 'b1-ir-'));
  try {
    const manifest = join(dir, 'writecheck.yaml');
    writeFileSync(
      manifest,
      `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(SERVER)}]
  env_passthrough: [DATABASE_URL]
  env_public: [B1_IR]
  processes: separate
target:
  environment: test
  confirm: b1-wire
  guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" }
backend:
  gate: { rewrite_env: DATABASE_URL, hold_timeout_ms: 1500 }
limits: { write_budget: 20000, writes_per_second: 1000, pairs: 2, stale_reps: 1, gate_reps: 1, timeout_ms: 10000, max_fuzz_cases: 5 }
resources:
  - name: item
    create: { tool: create_item, args: { name: "{{marker}}" }, id: id, name_path: name }
    read: { tool: get_item, args: { id: "{{id}}" } }
    delete: { tool: delete_item, args: { id: "{{id}}" } }
    list: { tool: list_items, args: {}, items: items, id: id, name: name }
    cleanup: delete
    multi:
      - { tool: close_items, args: { ids: "{{ids}}" }, effect: { path: status, value: closed } }
    input_required:
      - { tool: close_item, args: { id: "{{id}}" }, answers: { confirm: { action: accept, content: { confirm: true } } }, effect: { path: status, value: closed } }
`,
    );
    const env = { PATH: process.env['PATH'], HOME: process.env['HOME'], DATABASE_URL: db.url, B1_IR: mode };
    const quiet = () => {};
    const { hash } = await planCommand({ manifest, env, log: quiet });
    const out = await runCommand({ manifest, outRoot: join(dir, 'out'), stateDir: join(dir, 'state'), confirmTarget: 'b1-wire', planHash: hash, interactive: false, env, log: quiet, noSignals: true });
    return { rs: out.doc.results, table: new Map(db.table) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  }
}

const proxyOf = (rs: Result[]) => rs.filter((r) => r.requirement === 'MWS-RETRY-3' && r.scenario.id === 'input-required.proxy');
// One run per server mode, shared by the tests below.
const runs = new Map<string, ReturnType<typeof run>>();
const once = (mode: 'early' | 'correct') => runs.get(mode) ?? (runs.set(mode, run(mode)), runs.get(mode)!);

test('wire gate, MWS-RETRY-3 proxy position: an UPDATE sent to Postgres before input_required is a write (violated, not held)', { timeout: 240_000 }, async () => {
  const { rs, table } = await once('early');
  const p = proxyOf(rs);
  assert.equal(p.length, 1, JSON.stringify(rs.filter((r) => r.requirement === 'MWS-RETRY-3').map((r) => `${r.scenario.id} ${r.verdict}: ${r.reason}`)));
  assert.equal(p[0]!.verdict, 'violated', p[0]!.reason);
  assert.match(p[0]!.reason, /UPDATE kv/, 'the record names the database write');
  assert.ok(p[0]!.steps.length > 0, 'a violated record carries its steps');
  assert.deepEqual([...table.keys()].filter((k) => /mwsc/.test(k)), [], 'the scratch items are cleaned up');
});

test('wire gate, MWS-ATOM-1: the learning pass counts the three UPDATEs, and the 2nd and the last are failed', { timeout: 240_000 }, async () => {
  const { rs } = await once('early');
  const recs = rs.filter((r) => r.requirement === 'MWS-ATOM-1' && r.write_path.tool === 'close_items');
  const atom = JSON.stringify(recs);
  assert.match(atom, /learning pass: 3 mutating backend request\(s\)/, atom);
  assert.match(atom, /mutating request 2 of 3 \(UPDATE kv\) failed with status 500, not forwarded/, atom);
  assert.match(atom, /mutating request 3 of 3 \(UPDATE kv\) failed with status 500, not forwarded/, atom);
  assert.ok(recs.some((r) => r.verdict !== 'not tested'), atom);
});

test('wire gate, MWS-RES-3: create_item (two INSERTs) gets its late failure, not "a single-step create"', { timeout: 240_000 }, async () => {
  const { rs } = await once('early');
  const r3 = JSON.stringify(rs.filter((r) => r.requirement === 'MWS-RES-3' && r.write_path.tool === 'create_item'));
  assert.doesNotMatch(r3, /single-step create|made 0 mutating/, r3);
  assert.match(r3, /With (its|the) last (backend write failed|of 2 backend writes failed)/, r3);
});

test('wire gate, MWS-RETRY-3 proxy position: a server that writes nothing before input_required is held', { timeout: 240_000 }, async () => {
  const { rs } = await once('correct');
  const p = proxyOf(rs);
  assert.equal(p.length, 1, JSON.stringify(rs.filter((r) => r.requirement === 'MWS-RETRY-3').map((r) => `${r.scenario.id} ${r.verdict}: ${r.reason}`)));
  assert.equal(p[0]!.verdict, 'held', p[0]!.reason);
  const bb = rs.find((r) => r.requirement === 'MWS-RETRY-3' && r.scenario.id === 'input-required')!;
  assert.notEqual(bb.verdict, 'violated', bb.reason);
});
