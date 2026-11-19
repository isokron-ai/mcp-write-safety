/**
 * Corpus target t14 (run 44406854696): "an object the tester did not create changed during the run".
 *
 * The declaration has two resources over one table. `item` is the operator's fixture, keyed by a text id; `row` is what the
 * create tool makes, keyed by the row number the create answers with. The list of `row` shows the fixture of `item` under
 * its row number (`/1`), which no ledger entry and no fixture id names. Every check of `item` writes the fixture's two
 * declared fields, so the bystander inventory of `row` reported `/1 (status, title)` as an object the tester did not create,
 * and every record that was `held` became `not tested`.
 *
 * The backend here keeps every write it applied and has a tripwire: a second row, seeded before the run and given to the
 * tester by nothing in the declaration. A write that reaches it fails the test.
 *
 *   1. The fixture's writes are the tester's own: no record names a lost bystander, the tripwire stays untouched, and
 *      every write the backend saw is an insert, an update of the fixture by its declared id, or a delete of a row the run
 *      inserted.
 *   2. The inventory still sees: with a server whose update also writes the other row, that row is reported and no record
 *      that made calls is held.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand, type RunOutcome } from '../../src/cli/run.js';
import { assertViolationsHaveSteps } from '../steps-lint.js';
import { RecordsBackend, type Row } from './records-backend.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'records-server.js');
const FIXTURE = { id: 'mwsc-fx-1', name: 'mwsc-fx-1', title: 'seed-title', status: 'open', version: 1 };
const OTHER = { id: 'someone-elses', name: 'someone-elses', title: 'keep', status: 'open', version: 1 };

/** The t14 declaration, word for word apart from the server command and the limits. */
const MANIFEST = `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(SERVER)}]
  env_public: [RECORDS_URL]
  processes: separate
target:
  environment: test
  confirm: records-fake
  guard: { tool: list_tables, args: {}, path: "$[0].name", pattern: "^mwsc_items$", read_only: true }
limits: { write_budget: 10000, writes_per_second: 1000, pairs: 4, stale_reps: 2, timeout_ms: 15000, max_fuzz_cases: 60 }
patterns:
  conflict: '"rowsAffected":\\s*0\\b'
  applied: '"rowsAffected":\\s*1\\b|\\bRecord created successfully\\b'
resources:
  - name: item
    fixture: { id: mwsc-fx-1, name: mwsc-fx-1, name_path: name }
    read: { tool: read_records, args: { table: mwsc_items, conditions: { id: "{{id}}" } }, items: "$", match: id, ignore: [version] }
    update:
      tool: update_records
      mode: field_patch
      args: { table: mwsc_items, data: { "{{field}}": "{{value}}" }, conditions: { id: "{{id}}" } }
    fields: [ { path: title, values: [alpha, bravo] }, { path: status, values: [in_progress, closed] } ]
    missing_id: mwsc-no-such-id
    cleanup: leave
  - name: row
    create: { tool: create_record, args: { table: mwsc_items, data: { id: "{{marker}}", name: "{{marker}}", title: seed-title, status: open, version: 1 } }, id: insertedId, name_path: name }
    read: { tool: read_records, args: { table: mwsc_items, conditions: { rid: "{{id}}" } }, items: "$", match: rid, ignore: [version] }
    delete: { tool: delete_records, args: { table: mwsc_items, conditions: { rid: "{{id}}" } } }
    list: { tool: read_records, args: { table: mwsc_items }, items: "$", id: rid, name: name, ignore: [version] }
    cleanup: delete
`;

async function run(o: { alsoTouch?: number } = {}): Promise<{ r: RunOutcome; b: RecordsBackend; fixture: Row; other: Row }> {
  const b = new RecordsBackend(o);
  const fixture = b.seed(FIXTURE);
  const other = b.seed(OTHER, { protect: true });
  const url = await b.start();
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-t14-'));
  try {
    const manifest = join(dir, 'manifest.yaml');
    writeFileSync(manifest, MANIFEST);
    const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], RECORDS_URL: url };
    const quiet = () => {};
    const { hash } = await planCommand({ manifest, env, log: quiet });
    const r = await runCommand({ manifest, outRoot: join(dir, 'out'), stateDir: join(dir, 'state'), confirmTarget: 'records-fake', planHash: hash, interactive: false, env, log: quiet, noSignals: true });
    assertViolationsHaveSteps(r.doc);
    return { r, b, fixture, other };
  } finally {
    await b.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const lostOf = (r: RunOutcome) => r.doc.results.flatMap((x) => (Array.isArray(x.numbers['bystanders_lost']) ? (x.numbers['bystanders_lost'] as string[]).map((l) => `${x.requirement} ${x.write_path.resource}: ${l}`) : []));

test('t14: writes to the declared fixture are not a change to an object the tester did not create, and no write leaves the run\'s own objects', async () => {
  const { r, b, fixture, other } = await run();
  assert.equal(r.doc.run.status, 'complete', String(r.doc.run.stopped_reason));

  // The tripwire: nothing reached the row the declaration does not give to the tester, and it is as it was seeded.
  assert.deepEqual(b.tripped, [], 'a write reached a row the tester does not own');
  assert.deepEqual(b.rows.get(other.rid), { rid: other.rid, ...OTHER });

  // Every write the backend applied is one of the three the declaration allows.
  const inserted = new Set(b.writes.filter((w) => w.op === 'insert').flatMap((w) => w.rids));
  for (const w of b.writes) {
    if (w.op === 'insert') continue;
    if (w.op === 'update') {
      assert.deepEqual(w.conditions, { id: FIXTURE.id }, `an update not addressed to the fixture by its declared id: ${JSON.stringify(w)}`);
      assert.deepEqual(w.rids, [fixture.rid]);
      assert.ok(Object.keys(w.data ?? {}).every((k) => k === 'title' || k === 'status'), `an update of a field the declaration does not name: ${JSON.stringify(w)}`);
      continue;
    }
    assert.ok(w.rids.length === 1 && inserted.has(w.rids[0]!), `a delete of a row the run did not insert: ${JSON.stringify(w)}`);
  }
  assert.ok(b.writes.some((w) => w.op === 'update'), 'the fixture was written (the checks ran)');

  // The fixture is put back, and the run's own rows are gone.
  assert.deepEqual(b.rows.get(fixture.rid), { rid: fixture.rid, ...FIXTURE });
  assert.deepEqual([...b.rows.keys()].sort(), [fixture.rid, other.rid]);
  assert.deepEqual(r.doc.safety.fixtures_restored, [{ resource: 'item', restored: true }]);

  // No record names the fixture (or anything else) as a lost bystander, and records are held again.
  assert.deepEqual(lostOf(r), []);
  assert.equal((r.doc.safety as { run_losses?: unknown[] }).run_losses, undefined);
  const upd1 = r.doc.results.find((x) => x.requirement === 'MWS-UPD-1' && x.write_path.resource === 'item');
  assert.equal(upd1?.verdict, 'held', upd1?.reason);
  assert.ok(!r.doc.results.some((x) => /tester did not create/.test(x.reason)), 'no record is downgraded for a bystander');

  // The report says the fixture was recognised under the other resource's key, and what is still compared.
  const warnings = (r.doc.safety as { warnings?: string[] }).warnings ?? [];
  assert.ok(warnings.some((w) => /^row: .*\/1 is the declared fixture of item \(mwsc-fx-1\): the fields the tester writes on it \(title, status\) are not compared; any other change to it, and its loss, is reported$/.test(w)), warnings.join('\n'));
});

test('t14 control: a server whose update also writes another row is still reported, and nothing that made calls is held', async () => {
  // The defect: every update that matches a row also sets the same fields on row 2 (the protected one).
  const { r, b, other } = await run({ alsoTouch: 2 });
  assert.ok(b.tripped.length > 0, 'the stand-in defect did not reach the protected row');
  const lost = lostOf(r);
  assert.ok(lost.some((l) => new RegExp(`: /${other.rid} \\(`).test(l)), `the changed row is not reported: ${lost.slice(0, 5).join(' | ')}`);
  assert.ok(!lost.some((l) => /: \/1 \(/.test(l)), `the fixture is reported as a bystander: ${lost.slice(0, 5).join(' | ')}`);
  // No record of a tool that was called is held over the loss.
  const held = r.doc.results.filter((x) => x.verdict === 'held' && x.write_path.resource !== '(catalog)');
  assert.deepEqual(held.map((x) => `${x.requirement} ${x.write_path.resource}`), []);
});
