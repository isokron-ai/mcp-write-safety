/**
 * The bystander inventory and a declared fixture listed under another resource's key (corpus target t14, run 44406854696).
 *
 * `item` (the fixture, keyed by a text id) and `row` (keyed by the row number) are one table. The list of `row` shows the
 * fixture as `/1`. It is recognised only where the fixture, read by its own id through the same tool with the same fixed
 * arguments, carries that key and is the same form; then only the fields the declaration lets the tester write on it are left
 * out. Every other case stays a bystander.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compare, inventory } from '../../src/checks/bystanders.js';
import type { RunContext } from '../../src/checks/types.js';
import { sameFixedArgs } from '../../src/core/driver.js';
import { parseManifestText } from '../../src/core/manifest.js';

const manifest = (o: { rowTable?: string; restorable?: string } = {}) =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: item
    fixture: { id: mwsc-fx-1, name: mwsc-fx-1, name_path: name }
    read: { tool: read_records, args: { table: items, conditions: { id: "{{id}}" } }, items: "$", match: id, ignore: [version] }
    update: { tool: update_records, mode: field_patch, args: { table: items, data: { "{{field}}": "{{value}}" }, conditions: { id: "{{id}}" } } }
    fields: [ { path: title, values: [alpha, bravo] }, { path: status, values: [in_progress, closed] } ]${o.restorable ?? ''}
    cleanup: leave
  - name: row
    create: { tool: create_record, args: { table: ${o.rowTable ?? 'items'}, data: { id: "{{marker}}", name: "{{marker}}" } }, id: insertedId, name_path: name }
    read: { tool: read_records, args: { table: ${o.rowTable ?? 'items'}, conditions: { rid: "{{id}}" } }, items: "$", match: rid, ignore: [version] }
    delete: { tool: delete_records, args: { table: ${o.rowTable ?? 'items'}, conditions: { rid: "{{id}}" } } }
    list: { tool: read_records, args: { table: ${o.rowTable ?? 'items'} }, items: "$", id: rid, name: name, ignore: [version] }
    cleanup: delete
`,
    'm.yaml',
  );

type Rec = Record<string, unknown>;
const seed = (): Rec[] => [
  { rid: 1, id: 'mwsc-fx-1', name: 'mwsc-fx-1', title: 'seed', status: 'open', priority: 1, version: 1 },
  { rid: 2, id: 'theirs', name: 'theirs', title: 'keep', status: 'open', priority: 1, version: 1 },
];

/** A context whose session answers read_records from `tables()`, as the t14 server does (an array of the matching rows). */
function ctx(man: ReturnType<typeof manifest>, tables: () => Record<string, Rec[]>, o: { own?: unknown[]; calls?: { tool: string; args: Rec }[] } = {}): RunContext {
  const session = {
    stepId: (s: string) => s,
    async call(_l: string, tool: string, args: Rec) {
      o.calls?.push({ tool, args });
      if (tool !== 'read_records') throw new Error(`unexpected ${tool}`);
      const cond = (args['conditions'] ?? {}) as Rec;
      const data = (tables()[String(args['table'])] ?? []).filter((r) => Object.entries(cond).every(([k, v]) => String(r[k]) === String(v)));
      return { ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null, isError: false };
    },
  };
  return { session, manifest: man, ledger: { entries: () => (o.own ?? []).map((id) => ({ kind: 'created', resource: 'row', id })) }, prefix: 'mwsc-x-', label: (p: string) => p } as unknown as RunContext;
}

test('t14: the fixture listed under the other key is recognised, and writes to its declared fields are not a change', async () => {
  const man = manifest();
  const row = man.resources[1]!;
  let rows = seed();
  const calls: { tool: string; args: Rec }[] = [];
  const c = ctx(man, () => ({ items: rows }), { calls });
  const before = await inventory(c, row, 'T');
  assert.equal(before.unavailable, null);
  assert.equal(before.covered.objects, 2, 'the fixture stays in the inventory');
  assert.deepEqual(before.items.get('/1')?.own_fields, ['title', 'status']);
  assert.equal(before.items.get('/2')?.own_fields, undefined);
  assert.equal(before.covered.fixtures?.length, 1);
  assert.match(before.covered.fixtures![0]!, /^\/1 is the declared fixture of item \(mwsc-fx-1\): the fields the tester writes on it \(title, status\) are not compared$/);
  // The fixture was read by its own declared id, once, and by nothing else.
  assert.deepEqual(calls.filter((x) => x.args['conditions']).map((x) => x.args['conditions']), [{ id: 'mwsc-fx-1' }]);

  rows = rows.map((r) => (r['rid'] === 1 ? { ...r, title: 'alpha', status: 'closed' } : r));
  const loss = await compare(c, row, 'T', before, await inventory(c, row, 'T'));
  assert.deepEqual([loss.gone, loss.changed, loss.missing], [[], [], []]);
});

test('t14: the recognised fixture is still compared in every other field, and its loss is reported', async () => {
  const man = manifest();
  const row = man.resources[1]!;
  let rows = seed();
  const c = ctx(man, () => ({ items: rows }));
  const before = await inventory(c, row, 'T');

  rows = seed().map((r) => (r['rid'] === 1 ? { ...r, title: 'alpha', priority: 5 } : r));
  const other = await compare(c, row, 'T', before, await inventory(c, row, 'T'));
  assert.deepEqual(other.changed, ['/1 (priority)']);

  rows = seed().filter((r) => r['rid'] !== 1);
  const gone = await compare(c, row, 'T', before, await inventory(c, row, 'T'));
  assert.deepEqual([...gone.gone, ...(gone.missing ?? [])], ['/1'], JSON.stringify(gone));

  // Around a selector call the read forms are compared too: the same rule holds there.
  rows = seed();
  const b2 = await inventory(c, row, 'T', { readById: true });
  rows = seed().map((r) => (r['rid'] === 1 ? { ...r, status: 'closed' } : r));
  const quiet = await compare(c, row, 'T', b2, await inventory(c, row, 'T', { readById: true }), { selector: true });
  assert.deepEqual([quiet.gone, quiet.changed, quiet.missing], [[], [], []]);
  rows = seed().map((r) => (r['rid'] === 1 ? { ...r, status: 'closed', name: 'renamed' } : r));
  const sel = await compare(c, row, 'T', b2, await inventory(c, row, 'T', { readById: true }), { selector: true });
  assert.equal(sel.changed.length, 1, JSON.stringify(sel));
  assert.match(sel.changed[0]!, /^\/1 \(read back changed: name\)$/);
});

test('t14: a change to any other row is reported as before', async () => {
  const man = manifest();
  const row = man.resources[1]!;
  let rows = seed();
  const c = ctx(man, () => ({ items: rows }));
  const before = await inventory(c, row, 'T');
  rows = seed().map((r) => (r['rid'] === 2 ? { ...r, title: 'alpha', status: 'closed' } : r));
  const loss = await compare(c, row, 'T', before, await inventory(c, row, 'T'));
  assert.deepEqual(loss.changed, ['/2 (status, title)']);
});

test('t14: restorable arguments of the fixture are the tester\'s to write as well; call-only ones name no field', async () => {
  const man = manifest({ restorable: '\n    restorable: [priority, { arg: force, call_only: true }]' });
  const row = man.resources[1]!;
  const rows = seed();
  const before = await inventory(ctx(man, () => ({ items: rows })), row, 'T');
  assert.deepEqual(before.items.get('/1')?.own_fields, ['title', 'status', 'priority']);
});

test('t14: no fixture is recognised in another table, under another key value, or where the two forms differ', async () => {
  // Another table: the list's fixed arguments differ from the fixture's read, so the fixture is not even read.
  const other = manifest({ rowTable: 'copies' });
  const calls: { tool: string; args: Rec }[] = [];
  let copies = seed();
  const c1 = ctx(other, () => ({ items: seed(), copies }), { calls });
  const b1 = await inventory(c1, other.resources[1]!, 'T');
  assert.equal(b1.covered.fixtures, undefined);
  assert.equal(b1.items.get('/1')?.own_fields, undefined);
  assert.ok(!calls.some((x) => x.args['table'] === 'items'), 'the fixture of the other table was read');
  copies = seed().map((r) => (r['rid'] === 1 ? { ...r, title: 'alpha' } : r));
  assert.deepEqual((await compare(c1, other.resources[1]!, 'T', b1, await inventory(c1, other.resources[1]!, 'T'))).changed, ['/1 (title)']);
  assert.equal(sameFixedArgs(other.resources[0]!, other.resources[0]!.read, other.resources[1]!, other.resources[1]!.list!), false);

  // The same table, and the list answers a row with the fixture's key that is not the fixture's form (a list that lags, or
  // another object): it stays a bystander.
  const man = manifest();
  assert.equal(sameFixedArgs(man.resources[0]!, man.resources[0]!.read, man.resources[1]!, man.resources[1]!.list!), true);
  const listed = seed().map((r) => (r['rid'] === 1 ? { ...r, name: 'not-the-fixture', id: 'other' } : r));
  const session = {
    stepId: (s: string) => s,
    async call(_l: string, _tool: string, args: Rec) {
      const data = args['conditions'] ? seed().filter((r) => r['id'] === (args['conditions'] as Rec)['id']) : listed;
      return { ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null, isError: false };
    },
  };
  const c2 = { session, manifest: man, ledger: { entries: () => [] }, prefix: 'mwsc-x-', label: (p: string) => p } as unknown as RunContext;
  const b2 = await inventory(c2, man.resources[1]!, 'T');
  assert.equal(b2.covered.fixtures, undefined);
  assert.equal(b2.items.get('/1')?.own_fields, undefined);

  // The fixture does not read back: nothing is recognised, and the inventory is still taken.
  const c3 = ctx(man, () => ({ items: seed().map((r) => (r['rid'] === 1 ? { ...r, id: 'renamed' } : r)) }));
  const b3 = await inventory(c3, man.resources[1]!, 'T');
  assert.equal(b3.unavailable, null);
  assert.equal(b3.covered.fixtures, undefined);
  assert.equal(b3.covered.objects, 2);
});
