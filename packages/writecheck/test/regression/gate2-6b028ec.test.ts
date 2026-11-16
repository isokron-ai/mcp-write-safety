/**
 * From the gate-2 re-run on 6b028ec (note 14, cases T1 to T12). Each test runs one of the re-run's reproducer cases against
 * the re-run's own fake server (gate2-fake-server.ts, vendored unchanged) with the re-run's seeded objects, in the mode the reproducer
 * names (`default`: the manifest as it was; `optin`: `selector.send_empty_forms: true`), and asserts what the fixed tool
 * must say. The ground truth (what really happened to the seeded objects) comes from the backend, not from the tool.
 *
 *   note 14 item 1  (T8)  a read by id that does not echo the id: the resource is tested; the empty-list text is still gone
 *   note 14 item 2  (T7)  a listed field that changes by itself is not a changed bystander
 *   note 14 item 4  (T2)  a scope missing once from the scope list is not a loss (no false violated)
 *   note 14 item 5  (T1, T6 k2) a lagging list, a fixture create that evicts: never held beside a loss
 *   note 14 item 6  (T3, T5, T4) prefix-carrying bystanders, a JSON object for a missing id, soft delete: reported; what was
 *                   listed is in the record
 *   note 14 item 7  (T9, T10) clean-up: no phantom leftovers for "nothing found" shapes; a soft delete is left, not deleted
 *   T12             no call to the selector tool after a loss around the MWS-TGT-1 create
 *
 * From the gate-2 re-run on 0295ed6 (safety-0295ed6/GATE2-RERUN-0295ed6-safety.md, T6 and section 4, "the bar"):
 *   k1              bystanders deleted by the creates of other checks: reported in both modes, and no record that made calls
 *                   is held in such a run (a later loss cannot be ruled out as an effect of an earlier record's calls)
 *   nx1-x-lie       a cursor that ends early hides the lost object: the paging is not shown complete, the inventory is
 *                   partial, and the selector records are not tested, never held; the honest cursor stays held
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand, type RunOutcome } from '../../src/cli/run.js';
import type { Result } from '../../src/report/verdicts.js';
import { ShapeBackend } from './backend.js';
import { rows, show } from './harness.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'gate2-fake-server.js');
const CONFIRM = 'mwsv-safety';
const NARROW = '      narrow: { title_prefix: "{{marker}}" }\n';
const FORMS = `      forms:
        - { name: omitted, args: {} }
        - { name: empty, args: { title_prefix: "" } }
`;
const CONTROL = `    control:
      base_env: FAKE_URL
      read: { http: [GET, "/c/tickets/{{id}}"] }
      patch: { http: [PATCH, "/c/tickets/{{id}}"], body: { "{{field}}": "{{value}}" } }
      delete: { http: [DELETE, "/c/tickets/{{id}}"] }
`;

interface Case {
  opts: string;
  /** false: no selector block (the n- and g- cases). */
  selector?: boolean;
  /** Gate-2 re-run on 0295ed6: list.next declared on the list and on the scope list (the cursor switch). */
  next?: boolean;
}
const NEXT = ', next: { path: next_cursor, arg: cursor }';

/** The manifest of safety-6b028ec/attack.mjs, unchanged. */
const manifest = (c: Case, mode: 'default' | 'optin'): string => `mws: "0.9"
prefix: mwsv
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FAKE)}]
  env_public: [FAKE_URL, FAKE_OPTS, FAKE_CALL_LOG]
  processes: separate
target:
  environment: test
  confirm: ${CONFIRM}
  guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsv-test-" }
limits: { write_budget: 20000, writes_per_second: 1000, pairs: 2, stale_reps: 1, gate_reps: 1, timeout_ms: 10000, max_fuzz_cases: 200 }
resources:
  - name: project
    create: { tool: project_create, args: { key: "{{key}}", name: "{{marker}}" }, id: key, name_path: key }
    read: { tool: project_list, args: {}, items: projects, match: key }
    key: { arg: key, vary: { arg: name, path: name } }
    delete: { tool: project_delete, args: { key: "{{id}}" } }
    cleanup: delete
  - name: ticket
    scope:
      resource: project
      arg: project
      default: inbox
      list: { tool: ticket_list, args: { project: "{{scope}}" }, items: tickets, id: id, name: title${c.next ? NEXT : ''} }
    create: { tool: ticket_create, args: { project: "{{?scope}}", title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: assignee, values: [ann, bob] }
      - { path: status, values: [blocked, closed] }
    version: { read: version }
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    list: { tool: ticket_list, args: { title_prefix: "{{prefix}}" }, items: tickets, id: id, name: title${c.next ? NEXT : ''} }
    cleanup: delete
${c.selector === false ? '' : `    selector:
      tool: tickets_delete
      args: { project: "{{scope}}" }
${NARROW}${mode === 'optin' ? '      send_empty_forms: true\n' : ''}${FORMS}`}${CONTROL}`;

const BYSTANDERS = [
  { id: 'B1', scope: 'inbox', title: 'customer ticket B1', status: 'open', assignee: 'carol' },
  { id: 'B2', scope: 'inbox', title: 'customer ticket B2', status: 'open', assignee: 'carol' },
  { id: 'B3', scope: 'inbox', title: 'mwsv-leftover-of-an-older-run', status: 'open', assignee: 'dave' },
  { id: 'B4', scope: 'ops', title: 'customer ticket B4', status: 'blocked', assignee: 'erin' },
];

interface Ran {
  r: RunOutcome;
  backend: ShapeBackend;
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Seeded objects (B…, C-…, the project ops) deleted or changed on the backend. */
  touched: string[];
  /** Every id named in some record's numbers.bystanders_lost. */
  reported: Set<string>;
}

async function run(c: Case, mode: 'default' | 'optin'): Promise<Ran> {
  const backend = new ShapeBackend({ tenant: 'mwsv-test-tenant' });
  const url = await backend.start();
  backend.seed('projects', { id: 'ops', key: 'ops', name: 'operations' });
  for (const t of BYSTANDERS) backend.seed('tickets', { ...t });
  const snap = () => Object.fromEntries([...backend.all('tickets').filter((t) => /^(B\d|C-)/.test(String(t['id']))), ...backend.all('projects').filter((p) => p['id'] === 'ops')].map((t) => [String(t['id']), JSON.stringify(t)]));
  const before = snap();
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-g2-'));
  const mf = join(dir, 'manifest.yaml');
  writeFileSync(mf, manifest(c, mode));
  const log = join(dir, 'calls.jsonl');
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], FAKE_URL: url, FAKE_OPTS: c.opts, FAKE_CALL_LOG: log };
  try {
    const { hash } = await planCommand({ manifest: mf, env, log: () => {} });
    const r = await runCommand({ manifest: mf, outRoot: join(dir, 'out'), stateDir: join(dir, 'state'), confirmTarget: CONFIRM, planHash: hash, interactive: false, env, log: () => {}, noSignals: true });
    const after = snap();
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((id) => after[id] === undefined || (before[id] !== undefined && before[id] !== after[id]));
    // the colliding tickets (collide=…) are made by the fake during the run: touched means gone at the end
    if (/collide=ops/.test(c.opts)) for (const id of ['C-EXT', 'C-UPPER', 'C-SUB']) if (after[id] === undefined && !touched.includes(id)) touched.push(id);
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: Record<string, unknown> }) : [];
    const reported = new Set(r.doc.results.flatMap((x) => (Array.isArray(x.numbers['bystanders_lost']) ? (x.numbers['bystanders_lost'] as string[]) : [])).flatMap((s) => [...String(s).matchAll(/"(B\d|C-[A-Z]+|ops)"/g)].map((m) => m[1]!)));
    // report.md is read before the folder goes
    const md = readFileSync(join(r.outDir, 'report.md'), 'utf8');
    (r as RunOutcome & { md?: string }).md = md;
    return { r, backend, calls, touched, reported };
  } finally {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const one = (rs: Result[], req: string, path: string): Result => {
  const x = rows(rs, req, path);
  assert.equal(x.length, 1, show(x));
  return x[0]!;
};
const lost = (r: Result): string[] => (Array.isArray(r.numbers['bystanders_lost']) ? (r.numbers['bystanders_lost'] as string[]) : []);
const anyLost = (rs: Result[]): Result[] => rs.filter((r) => lost(r).length > 0);
const testerTicketsLeft = (b: ShapeBackend) => b.all('tickets').filter((t) => String(t['title']).startsWith('mwsv-') && t['id'] !== 'B3' && !/^(C-|R-)/.test(String(t['id'])));

// ───────────────────────────── item 1 (T8): the id echo ─────────────────────────────

test('T8 g-idecho-off: a read by id that does not echo the id still tests the resource; the working delete is held', async () => {
  const x = await run({ opts: 'idecho=off', selector: false }, 'default');
  const setup = x.r.doc.results.filter((r) => r.write_path.resource === 'ticket' && /setup failed/.test(r.reason));
  assert.deepEqual(setup.map((r) => r.requirement), [], show(setup));
  assert.equal(one(x.r.doc.results, 'MWS-RES-1', 'ticket:ticket_delete').verdict, 'held');
  assert.equal(testerTicketsLeft(x.backend).length, 0, 'nothing of the run is left');
});

for (const opts of ['idecho=off,del=noop-ok', 'idecho=off0,del=noop-ok']) {
  test(`T8 ${opts}: a delete that deletes nothing is MWS-RES-1 violated, and the run exits non-zero (4: clean-up cannot finish)`, async () => {
    const x = await run({ opts, selector: false }, 'default');
    assert.equal(one(x.r.doc.results, 'MWS-RES-1', 'ticket:ticket_delete').verdict, 'violated');
    // problem 14 in the GitHub Action's NOTES.md: the same delete is clean-up's, so objects of the run stay; the run is stopped, and 4 takes precedence over 1.
    assert.equal(x.r.exit, x.r.doc.run.status === 'stopped' ? 4 : 1);
  });
}

test('T8 g-payload3: the empty-list text for a missing id is still not the object (the 6b028ec fix stays)', async () => {
  const x = await run({ opts: 'goneread=payload3', selector: false }, 'default');
  assert.equal(one(x.r.doc.results, 'MWS-RES-1', 'ticket:ticket_delete').verdict, 'held');
});

// ───────────────────────────── item 2 (T7): a field that changes by itself ─────────────────────────────

for (const mode of ['default', 'optin'] as const) {
  test(`T7 i12-volatile-list (${mode}): a listed field that changes by itself is no loss and blocks nothing`, async () => {
    const x = await run({ opts: 'listvolatile=1' }, mode);
    assert.deepEqual(x.touched, []);
    assert.deepEqual(anyLost(x.r.doc.results).map((r) => `${r.requirement}: ${lost(r).join(', ')}`), []);
    assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:ticket_create').verdict, 'held');
    if (mode === 'optin') {
      assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete').verdict, 'held');
      assert.equal(one(x.r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete').verdict, 'held');
    }
    assert.ok(!/Restore them from your backup/.test((x.r as RunOutcome & { md: string }).md));
  });
}

// ───────────────────────────── item 4 (T2): a scope missing once ─────────────────────────────

for (const opts of ['projlist=flaky', 'projlist=flaky1']) {
  for (const mode of ['default', 'optin'] as const) {
    test(`T2 ${opts} (${mode}): a scope missing once from the scope list is no loss; no violated on a correct server`, async () => {
      const x = await run({ opts }, mode);
      assert.deepEqual(x.touched, []);
      assert.deepEqual(anyLost(x.r.doc.results).map((r) => `${r.requirement}: ${lost(r).join(', ')}`), []);
      const tgt = x.r.doc.results.filter((r) => /^MWS-TGT-/.test(r.requirement));
      assert.deepEqual(tgt.filter((r) => r.verdict === 'violated').map((r) => r.reason), []);
      assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:ticket_create').verdict, 'held');
      assert.equal(one(x.r.doc.results, 'MWS-TGT-3', 'project:project_create').verdict, 'held');
      if (mode === 'optin') assert.equal(one(x.r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete').verdict, 'held');
    });
  }
}

// ───────────────────────────── item 5 (T1, T6): held beside a loss ─────────────────────────────

test('T1 i4-stale-list (optin): bystanders a lagging list still shows are read back by id; MWS-TGT-2 is violated and names them', async () => {
  const x = await run({ opts: 'empty=all,scope=default-when-empty,listlag=1' }, 'optin');
  assert.deepEqual(x.touched.sort(), ['B1', 'B2', 'B3'], 'ground truth');
  const t2 = one(x.r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
  assert.equal(t2.verdict, 'violated', show([t2]));
  for (const id of ['B1', 'B2', 'B3']) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
  assert.deepEqual(x.r.doc.results.filter((r) => r.verdict === 'held' && lost(r).length).map((r) => r.requirement), []);
});

test('T6 k2-create-evicts-unscoped (optin): a fixture create that evicts a bystander is reported, and that MWS-TGT-1 is not held', async () => {
  const x = await run({ opts: 'createside=unscoped' }, 'optin');
  assert.ok(x.touched.length >= 1, 'ground truth: a seeded ticket was evicted');
  const t1 = one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete');
  assert.notEqual(t1.verdict, 'held', show([t1]));
  for (const id of x.touched) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
  assert.deepEqual(x.r.doc.results.filter((r) => /^MWS-TGT-/.test(r.requirement) && r.verdict === 'held' && lost(r).length).map((r) => r.requirement), []);
});

test('k1 (optin): bystanders evicted by other checks\' fixture creates are reported, and that check is not held', async () => {
  const x = await run({ opts: 'createside=scoped' }, 'optin');
  assert.ok(x.touched.length >= 1, 'ground truth');
  for (const id of x.touched) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
  assert.deepEqual(x.r.doc.results.filter((r) => r.verdict === 'held' && lost(r).length).map((r) => `${r.requirement} ${r.write_path.tool}`), []);
});

// ───────────────────────────── T12 ─────────────────────────────

test('T12 k3-tgt1-create-deletes (optin): after a loss around the MWS-TGT-1 create, the selector tool is never called', async () => {
  const x = await run({ opts: 'createside=tgt1' }, 'optin');
  assert.equal(x.calls.filter((c) => c.tool === 'tickets_delete').length, 0);
  assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:ticket_create').verdict, 'not tested');
  assert.ok(x.reported.has('B1'));
});

// ───────────────────────────── item 6 (T3, T5, T4): losses not reported ─────────────────────────────

for (const [name, opts] of [['c4', 'narrow=prefix,scope=all,collide=ops,empty=all'], ['c5', 'narrow=substring,scope=all,collide=ops,empty=all']] as const) {
  test(`T3 ${name} (optin): a bystander whose title carries the run prefix is not taken for the tester's own; its loss is reported`, async () => {
    const x = await run({ opts }, 'optin');
    assert.ok(x.touched.length >= 1, 'ground truth');
    for (const id of x.touched) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
    assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete').verdict, 'violated');
  });
}

for (const [name, opts] of [['i10', 'narrow=ignore,scope=default,empty=all,goneread=nullobj'], ['i10b', 'narrow=ignore,scope=default,empty=all,goneread=emptyjson'], ['i5', 'narrow=ignore,scope=default,empty=all,bulk=soft,softread=object']] as const) {
  test(`T5 ${name} (optin): every bystander the call removed is reported`, async () => {
    const x = await run({ opts }, 'optin');
    assert.deepEqual(x.touched.sort(), ['B1', 'B2', 'B3'], 'ground truth');
    for (const id of x.touched) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
  });
}

// i8 (deleted and created again with the same id and content) is not here: the objects differ only in updated_at, which the
// manifest declares in read.ignore, so nothing the tester may compare changed.
for (const [name, opts] of [['i9 (the list fails after the call)', 'narrow=ignore,scope=default,empty=all,listfail=after-bulk'], ['i13b (a list that leaves B1 out now and then)', 'narrow=ignore,scope=default,empty=all,listflaky=1']] as const) {
  test(`review of the note-19 set, ${name} (optin): every bystander the call removed or changed is reported`, async () => {
    const x = await run({ opts }, 'optin');
    assert.ok(x.touched.length >= 1, 'ground truth');
    for (const id of x.touched) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
    assert.deepEqual(x.r.doc.results.filter((r) => /^MWS-TGT-/.test(r.requirement) && r.verdict === 'held' && lost(r).length).map((r) => r.requirement), []);
  });
}

test('T4 i1-hidden-project (optin): the record says what the inventory listed', async () => {
  const x = await run({ opts: 'empty=all,scope=all-when-empty,hideproj=ops' }, 'optin');
  const t2 = one(x.r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
  assert.notEqual(t2.verdict, 'held');
  const inv = t2.numbers['bystander_inventory'] as { scopes: unknown[]; objects: number } | undefined;
  assert.ok(inv && Array.isArray(inv.scopes) && inv.scopes.includes('inbox') && typeof inv.objects === 'number', JSON.stringify(t2.numbers));
  assert.ok(t2.notes.some((n) => /listed/.test(n) && /inbox/.test(n)), t2.notes.join('\n'));
});

test('T4 a held targeting record says the bystanders were not seen to be lost, and what was listed', async () => {
  const x = await run({ opts: '' }, 'optin');
  const t2 = one(x.r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete');
  assert.equal(t2.verdict, 'held', show([t2]));
  assert.match(t2.reason, /not seen to be lost/);
  assert.ok(t2.notes.some((n) => /listed/.test(n) && /ops/.test(n)), t2.notes.join('\n'));
});

// ───────────────────────────── item 7 (T9, T10): clean-up ─────────────────────────────

for (const shape of ['nullobj', 'nomatch', 'emptyjson', 'empty', 'nodocs', 'zero', 'none']) {
  test(`T9 g-${shape}: clean-up reports no leftover that does not exist, and the working delete is not violated`, async () => {
    const x = await run({ opts: `goneread=${shape}`, selector: false }, 'default');
    assert.equal(testerTicketsLeft(x.backend).length, 0, 'ground truth: nothing of the run is left');
    assert.deepEqual(x.r.doc.leftovers.map((l) => `${l.resource} ${String(l.id)}: ${l.reason}`), []);
    assert.equal(one(x.r.doc.results, 'MWS-RES-1', 'ticket:ticket_delete').verdict, 'held');
  });
}

test('T10 n2-soft-read-sentence: after a soft delete that the declared control read still returns, clean-up reports the rows as left', async () => {
  const x = await run({ opts: 'del=soft,softread=sentence,softlist=hide', selector: false }, 'default');
  const trashed = testerTicketsLeft(x.backend).filter((t) => t['trashed'] === true).map((t) => String(t['id']));
  assert.ok(trashed.length > 0, 'ground truth');
  const reported = x.r.doc.leftovers.filter((l) => l.resource === 'ticket').map((l) => String(l.id));
  for (const id of trashed) assert.ok(reported.includes(id), `${id} reported as left: ${reported.join(', ')}`);
});

// ───────────────────────────── gate-2 re-run on 0295ed6: k1 in both modes, nx1-x-lie ─────────────────────────────

/** Records that made calls and are held (the catalog's records are judged from tools/list alone). */
const heldWithCalls = (rs: Result[]): string[] => rs.filter((r) => r.verdict === 'held' && r.write_path.resource !== '(catalog)').map((r) => `${r.requirement} ${r.write_path.resource}:${r.write_path.tool}`);

for (const mode of ['default', 'optin'] as const) {
  test(`0295ed6 k1-create-evicts-scoped (${mode}): every bystander the creates of other checks deleted is reported, and no record that made calls is held`, async () => {
    const x = await run({ opts: 'createside=scoped' }, mode);
    assert.deepEqual(x.touched.sort(), ['B1', 'B2', 'B3'], 'ground truth');
    for (const id of x.touched) assert.ok(x.reported.has(id), `${id} reported: ${[...x.reported].join(', ')}`);
    assert.deepEqual(heldWithCalls(x.r.doc.results), []);
    assert.notEqual(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:ticket_create').verdict, 'held');
    if (mode === 'optin') {
      assert.notEqual(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete').verdict, 'held');
      assert.notEqual(one(x.r.doc.results, 'MWS-TGT-2', 'ticket:tickets_delete').verdict, 'held');
    }
    const md = (x.r as RunOutcome & { md: string }).md;
    assert.match(md, /## Objects the tester did not create were changed or deleted/);
    // the earlier records say why they are not held
    const tgt3 = one(x.r.doc.results, 'MWS-TGT-3', 'project:project_create');
    assert.equal(tgt3.verdict, 'not tested', show([tgt3]));
    assert.match(tgt3.reason, /later in this run/);
  });
}

test('0295ed6 k1 control (default): on the correct server the brackets report nothing and keep the held records', async () => {
  const x = await run({ opts: '' }, 'default');
  assert.deepEqual(x.touched, []);
  assert.deepEqual(anyLost(x.r.doc.results).map((r) => `${r.requirement}: ${lost(r).join(', ')}`), []);
  assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:ticket_create').verdict, 'held');
  assert.equal(one(x.r.doc.results, 'MWS-TGT-3', 'project:project_create').verdict, 'held');
  assert.equal(one(x.r.doc.results, 'MWS-RES-1', 'ticket:ticket_delete').verdict, 'held');
});

test('0295ed6 nx1-x-lie (optin): a cursor that ends early hides the lost object; the selector records are not tested, with the reason', async () => {
  const x = await run({ opts: 'cursor=lie,listpage=1,extradel=B1', next: true }, 'optin');
  assert.deepEqual(x.touched, ['B1'], 'ground truth');
  for (const req of ['MWS-TGT-1', 'MWS-TGT-2']) {
    const r = one(x.r.doc.results, req, 'ticket:tickets_delete');
    assert.equal(r.verdict, 'not tested', show([r]));
  }
  const t1 = one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete');
  assert.match(t1.reason, /partial/);
  assert.match(t1.reason, /paging is not shown to be complete/);
  assert.deepEqual(x.r.doc.results.filter((r) => r.write_path.resource === 'ticket' && r.write_path.tool === 'tickets_delete' && r.verdict === 'held').map((r) => r.requirement), []);
  // validator re-run on 9288cfc (R10 Q8): once the paging is shown partial, no earlier record stays held (MWS-TGT-1 ticket_create
  // included); the reason names the partial inventory.
  const create = one(x.r.doc.results, 'MWS-TGT-1', 'ticket:ticket_create');
  assert.notEqual(create.verdict, 'held', show([create]));
  const heldBefore = x.r.doc.results.filter((r) => r.verdict === 'held' && r.write_path.resource !== '(catalog)' && r.steps.length);
  for (const r of heldBefore) assert.doesNotMatch(r.reason + r.notes.join(' '), /paging is not shown to be complete/, show([r]));
});

test('0295ed6 nx1-ok-lie (optin): the same cursor on a correct server is not tested either (the paging is not shown complete)', async () => {
  const x = await run({ opts: 'cursor=lie,listpage=1', next: true }, 'optin');
  assert.deepEqual(x.touched, []);
  assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete').verdict, 'not tested');
});

test('0295ed6 nx1-ok-honest (optin, control): an honest cursor read to the end keeps MWS-TGT-1 and MWS-TGT-2 held', async () => {
  const x = await run({ opts: 'cursor=honest,listpage=1', next: true }, 'optin');
  assert.deepEqual(x.touched, []);
  for (const req of ['MWS-TGT-1', 'MWS-TGT-2']) {
    const r = one(x.r.doc.results, req, 'ticket:tickets_delete');
    assert.equal(r.verdict, 'held', show([r]));
    assert.doesNotMatch(r.reason, /partial/);
  }
});

test('0295ed6 nx1-x-honest (optin, control): with an honest cursor the lost bystander is found and the bulk delete is violated', async () => {
  const x = await run({ opts: 'cursor=honest,listpage=1,extradel=B1', next: true }, 'optin');
  assert.deepEqual(x.touched, ['B1'], 'ground truth');
  assert.ok(x.reported.has('B1'), [...x.reported].join(', '));
  assert.equal(one(x.r.doc.results, 'MWS-TGT-1', 'ticket:tickets_delete').verdict, 'violated');
});
