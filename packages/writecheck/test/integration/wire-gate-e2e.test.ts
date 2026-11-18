/**
 * End to end through `plan` and `run`: a stdio MCP server that writes to (fake) Postgres through
 * DATABASE_URL, with backend.gate on that variable. The run must interpose the wire gate, learn
 * the update's last write (an UPDATE on kv), hold it for MWS-CONC-3 while the other writer
 * finishes, and fail it for MWS-RES-2, with the existing checks unchanged.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand } from '../../src/cli/run.js';
import { fakePostgres } from '../wire/pg.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'wire', 'pg-mcp-server.js');

test('run: a database-backed server gets real held-request and gate-fault records through the wire gate', { timeout: 240_000 }, async () => {
  const db = await fakePostgres({ 'title:mwsc-fx-1': 'alpha', 'status:mwsc-fx-1': 'open' });
  const dir = mkdtempSync(join(tmpdir(), 'b1-e2e-'));
  try {
    const manifest = join(dir, 'writecheck.yaml');
    writeFileSync(
      manifest,
      `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(SERVER)}]
  env_passthrough: [DATABASE_URL]
  processes: separate
target:
  environment: test
  confirm: b1-wire
  guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" }
backend:
  gate: { rewrite_env: DATABASE_URL, hold_timeout_ms: 1500 }
patterns:
  outcome_unknown: "may or may not have been applied"
limits: { write_budget: 20000, writes_per_second: 1000, pairs: 2, stale_reps: 1, gate_reps: 1, timeout_ms: 10000, max_fuzz_cases: 20 }
resources:
  - name: item
    fixture: { id: mwsc-fx-1, name: mwsc-fx-1 }
    read: { tool: get_item, args: { id: "{{id}}" } }
    update: { tool: update_item, mode: field_patch, args: { id: "{{id}}", field: "{{field}}", value: "{{value}}" } }
    fields: [ { path: title, values: [alpha, bravo] }, { path: status, values: [open, closed] } ]
`,
    );
    const env = { PATH: process.env['PATH'], HOME: process.env['HOME'], DATABASE_URL: db.url };
    const quiet = () => {};
    const { hash } = await planCommand({ manifest, env, log: quiet });
    const out = await runCommand({ manifest, outRoot: join(dir, 'out'), stateDir: join(dir, 'state'), confirmTarget: 'b1-wire', planHash: hash, interactive: false, env, log: quiet, noSignals: true });
    const rs = out.doc.results;
    if (process.env["B1_DEBUG"]) for (const r of rs.filter((x) => /held-request/.test(x.scenario.id))) console.log(JSON.stringify({ q: r.requirement, s: r.scenario.id, v: r.verdict, why: r.reason, notes: r.notes }, null, 1).slice(0, 2500));
    const held = rs.filter((r) => r.requirement === 'MWS-CONC-3' && r.scenario.id === 'held-request');
    assert.equal(held.length, 1, JSON.stringify(rs.map((r) => `${r.requirement} ${r.scenario.id} ${r.verdict}`)));
    const h = held[0]!;
    assert.equal(h.verdict, 'held', `${h.verdict}: ${h.reason}`);
    const text = JSON.stringify(h);
    assert.match(text, /UPDATE kv/, 'the held request is named by the wire gate');
    assert.match(text, /loopback wire gate/, 'the record states the route');
    const res2 = rs.filter((r) => r.requirement === 'MWS-RES-2' && /held-request/.test(r.scenario.id));
    assert.ok(res2.length >= 1, 'the gate-fault RES-2 records exist');
    assert.ok(res2.every((r) => r.verdict !== 'not tested' || !/needs backend\.gate/.test(r.reason)), res2.map((r) => `${r.verdict}: ${r.reason}`).join('\n'));
    const provoked = res2.find((r) => r.scenario.id === 'held-request')!;
    assert.equal(provoked.verdict, 'held', provoked.reason);
    assert.match(provoked.reason, /failed #\d+ UPDATE kv with status 500 \(not forwarded\)/);
    const lost = res2.find((r) => r.scenario.id === 'held-request.unknown-outcome')!;
    assert.match(lost.reason, /the backend applied #\d+ UPDATE kv and the connection closed before the server received the answer/);
    assert.equal(lost.verdict, 'held', `the declared outcome_unknown pattern decides: ${lost.reason}`);
    assert.equal(db.table.get('title:mwsc-fx-1'), 'alpha', 'the fixture is put back');
    assert.equal(db.table.get('status:mwsc-fx-1'), 'open');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  }
});
