/**
 * The bystander inventory on its own (gate-2 re-run on 6b028ec, note 14): what it says it listed, what it leaves out as
 * changing by itself, and how a partial inventory reads in a record.
 *
 *   Kubernetes B20  the scope resource (namespace) has no list block: only the default namespace is listed, and the
 *                   inventory says so; a selector record on it is never held, a create record keeps its verdict with
 *                   "not seen to be lost"
 *   Kubernetes B19  a listed `Age` in read.ignore, a declared list `ignore`, an undeclared time that ticks: no changed
 *                   bystander; a real change is
 *   0295ed6 nx1     a list read through list.next that leaves out an object which still reads back by id: its paging is not
 *                   shown complete, the inventory is partial for the rest of the run (spec R10 Q8)
 *   0295ed6 k1      a loss seen later in the run turns an earlier held record (one that made calls) into not tested
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compare, inventory } from '../../src/checks/bystanders.js';
import { withLaterLoss, withLoss } from '../../src/checks/targeting.js';
import { wp, type RunContext } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { result } from '../../src/report/verdicts.js';

const man = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: namespace
    create: { tool: ns_create, args: { name: "{{key}}" }, id: name }
    read: { tool: ns_get, args: { name: "{{id}}" } }
    key: { arg: name, vary: { arg: label, path: label } }
    delete: { tool: ns_delete, args: { name: "{{id}}" } }
    cleanup: delete
  - name: pod
    scope: { resource: namespace, arg: namespace, default: default, list: { tool: pods_list, args: { namespace: "{{scope}}" }, items: pods, id: Name, name: Name, ignore: [Restarts] } }
    create: { tool: pod_run, args: { namespace: "{{?scope}}", name: "{{marker}}" }, id: name }
    read: { tool: pod_get, args: { namespace: "{{scope}}", name: "{{id}}" }, ignore: [Age] }
    delete: { tool: pod_delete, args: { name: "{{id}}" } }
    cleanup: delete
`,
  'm.yaml',
);
const pod = man.resources[1]!;

/** A context whose session answers pods_list from `pods()` and pod_get from the same list. */
function ctx(pods: () => Record<string, unknown>[], o: { own?: unknown[]; readable?: boolean } = {}): RunContext {
  const ok = (data: unknown) => ({ ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null, isError: false });
  const session = {
    stepId: (s: string) => s,
    async call(_l: string, tool: string, args: Record<string, unknown>) {
      if (tool === 'pods_list') return ok({ pods: args['namespace'] === 'default' ? pods() : [] });
      if (tool === 'pod_get') {
        const p = o.readable === false ? undefined : pods().find((x) => x['Name'] === args['name']);
        return p ? ok(p) : { ok: false, data: null, text: `pods "${String(args['name'])}" not found`, timed_out: false, transport_error: null, rpc_error: null, isError: true };
      }
      throw new Error(`unexpected ${tool}`);
    },
  };
  return { session, manifest: man, ledger: { entries: () => (o.own ?? []).map((id) => ({ kind: 'created', resource: 'pod', id })) }, prefix: 'mwsc-x-', label: (p: string) => p } as unknown as RunContext;
}

test('B20: a scope resource without a list block: only the default scope is listed, and the inventory says so', async () => {
  const c = ctx(() => [{ Name: 'web', Age: '5s', Status: 'Running', Restarts: 0 }]);
  const inv = await inventory(c, pod, 'T');
  assert.equal(inv.unavailable, null);
  assert.deepEqual(inv.covered.scopes, ['default']);
  assert.equal(inv.covered.objects, 1);
  assert.ok(inv.partial.some((p) => /namespace declares no list block, so only the default scope "default" was listed/.test(p)), inv.partial.join('\n'));
  const loss = await compare(c, pod, 'T', inv, await inventory(c, pod, 'T'));
  const held = result('MWS-TGT-1', wp('pod', 'pod_run'), { id: 'targeting', version: '1' }, 'held', 'The object was written in the named scope only.');
  const create = withLoss(held, [loss], false);
  assert.equal(create.verdict, 'held');
  assert.match(create.reason, /not seen to be lost; the inventory was partial/);
  const sel = withLoss(held, [loss], true);
  assert.equal(sel.verdict, 'not tested');
  assert.match(sel.reason, /seen to be lost, but the inventory was partial/);
  assert.deepEqual((sel.numbers['bystander_inventory'] as { scopes: unknown[] }).scopes, ['default']);
});

test('B19: an age that ticks and a declared list ignore are no change; a real change still is', async () => {
  let pods = [{ Name: 'web', Age: '5s', Status: 'Running', Restarts: 0, Seen: '2026-11-15T10:00:00Z' }];
  const c = ctx(() => pods);
  const before = await inventory(c, pod, 'T');
  pods = [{ Name: 'web', Age: '6s', Status: 'Running', Restarts: 1, Seen: '2026-11-15T10:00:01Z' }];
  const quiet = await compare(c, pod, 'T', before, await inventory(c, pod, 'T'));
  assert.deepEqual([quiet.gone, quiet.changed, quiet.missing], [[], [], []]);
  assert.ok(quiet.volatile!.includes('Seen'), JSON.stringify(quiet));
  pods = [{ Name: 'web', Age: '7s', Status: 'Failed', Restarts: 1, Seen: '2026-11-15T10:00:02Z' }];
  const real = await compare(c, pod, 'T', before, await inventory(c, pod, 'T'));
  assert.equal(real.changed.length, 1, JSON.stringify(real));
  assert.match(real.changed[0]!, /Status/);
});

test('an object missing from the list that reads back by id is no loss; one that reads as not found is gone', async () => {
  let pods = [{ Name: 'web', Age: '5s', Status: 'Running', Restarts: 0 }];
  let hidden = false;
  const c = ctx(() => pods);
  const before = await inventory(c, pod, 'T');
  const c2 = ctx(() => (hidden ? [] : pods));
  hidden = true;
  const after = await inventory(c2, pod, 'T');
  hidden = false;
  // the list hid it once; the read by id (through c, which still has it) shows it
  const moved = await compare(c, pod, 'T', before, after);
  assert.deepEqual([moved.gone, moved.changed, moved.missing], [[], [], []]);
  pods = [];
  const gone = await compare(c, pod, 'T', before, await inventory(c, pod, 'T'));
  assert.deepEqual(gone.gone, ['"default"/"web"']);
});

test('review 1: around a selector call, an object the read did not show before is not judged gone by the read after', async () => {
  const pods = [{ Name: 'web', Age: '5s', Status: 'Running', Restarts: 0 }];
  const c = ctx(() => pods, { readable: false });
  const before = await inventory(c, pod, 'T', { readById: true });
  const loss = await compare(c, pod, 'T', before, await inventory(c, pod, 'T', { readById: true }), { selector: true });
  assert.deepEqual([loss.gone, loss.changed, loss.missing], [[], [], []]);
  assert.equal(before.covered.read_back_by_id, false, 'the record does not claim every object was read back');
});

test('review 2: the tester\'s own object is its own whether its id is 7 or "7"', async () => {
  const c = ctx(() => [{ Name: 7, Age: '5s', Status: 'Running' }], { own: ['7'] });
  const inv = await inventory(c, pod, 'T');
  assert.equal(inv.covered.objects, 0);
});

test('review: a fixture scope is listed (it may hold others\' objects); a scope the run created is not; same-kind means the same read call', async () => {
  const m = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: project
    create: { tool: project_create, args: { key: "{{key}}" }, id: key }
    key: { arg: key }
    fixture: { id: mwsc-fix, name: mwsc-fix }
    read: { tool: project_get, args: { key: "{{id}}" } }
    list: { tool: projects_list, args: {}, items: projects, id: key }
    delete: { tool: project_delete, args: { key: "{{id}}" } }
    cleanup: delete
  - name: ticket
    scope: { resource: project, arg: project, default: mwsc-fix, list: { tool: tickets_list, args: { project: "{{scope}}" }, items: tickets, id: id } }
    create: { tool: ticket_create, args: { project: "{{?scope}}", title: "{{marker}}" }, id: id }
    read: { tool: get_entry, args: { collection: tickets, id: "{{id}}" } }
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    cleanup: delete
  - name: note
    create: { tool: note_create, args: { title: "{{marker}}" }, id: id }
    read: { tool: get_entry, args: { collection: notes, id: "{{id}}" } }
    list: { tool: notes_list, args: {}, items: notes, id: id }
    delete: { tool: note_delete, args: { id: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const listed: string[] = [];
  const ok = (data: unknown) => ({ ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null, isError: false });
  const session = {
    stepId: (s: string) => s,
    async call(_l: string, tool: string, args: Record<string, unknown>) {
      if (tool === 'projects_list') return ok({ projects: [{ key: 'mwsc-fix' }, { key: 'mwsc-x-run1' }] });
      if (tool === 'tickets_list') {
        listed.push(String(args['project']));
        return ok({ tickets: args['project'] === 'mwsc-fix' ? [{ id: 'T-9', title: 'someone else' }, { id: '12', title: 'mine' }] : [{ id: 'T-1', title: 'mine' }] });
      }
      throw new Error(`unexpected ${tool}`);
    },
  };
  // The run created scope mwsc-x-run1 and ticket 12; note 12 (another collection behind the same read tool) is not ticket 12.
  const own = [{ kind: 'created', resource: 'project', id: 'mwsc-x-run1' }, { kind: 'created', resource: 'note', id: '12' }];
  const c = { session, manifest: m, ledger: { entries: () => own }, prefix: 'mwsc-x-', label: (p: string) => p } as unknown as RunContext;
  const inv = await inventory(c, m.resources[1]!, 'L');
  assert.deepEqual(listed, ['mwsc-fix'], 'the run\'s own scope is not listed; the fixture scope is');
  const keys = [...inv.items.keys()];
  assert.ok(keys.some((k) => k.includes('"T-9"')), keys.join(' '));
  assert.ok(keys.some((k) => k.includes('"12"')), 'ticket 12 is not note 12: a different read call');
});

test('0295ed6 nx1: a paged list (list.next) that leaves out an object which still reads back makes the inventory partial, for the rest of the run', async () => {
  const paged = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: namespace
    create: { tool: ns_create, args: { name: "{{key}}" }, id: name }
    read: { tool: ns_get, args: { name: "{{id}}" } }
    key: { arg: name, vary: { arg: label, path: label } }
    delete: { tool: ns_delete, args: { name: "{{id}}" } }
    cleanup: delete
  - name: pod
    scope: { resource: namespace, arg: namespace, default: default, list: { tool: pods_list, args: { namespace: "{{scope}}" }, items: pods, id: Name, name: Name, next: { path: next, arg: cursor } } }
    create: { tool: pod_run, args: { namespace: "{{?scope}}", name: "{{marker}}" }, id: name }
    read: { tool: pod_get, args: { namespace: "{{scope}}", name: "{{id}}" } }
    delete: { tool: pod_delete, args: { name: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const ppod = paged.resources[1]!;
  const all = [{ Name: 'old', Status: 'Running' }, { Name: 'new', Status: 'Running' }];
  let lie = false;
  const ok = (data: unknown) => ({ ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null, isError: false });
  const session = {
    stepId: (x: string) => x,
    async call(_l: string, tool: string, args: Record<string, unknown>) {
      // one item per page, newest first; the lying cursor ends after the first page
      if (tool === 'pods_list') {
        const xs = args['namespace'] === 'default' ? [...all].reverse() : [];
        const at = Number(args['cursor'] ?? 0);
        return ok({ pods: xs.slice(at, at + 1), ...(!lie && at + 1 < xs.length ? { next: String(at + 1) } : {}) });
      }
      if (tool === 'pod_get') return ok(all.find((x) => x.Name === args['name']));
      throw new Error(`unexpected ${tool}`);
    },
  };
  const c = { session, manifest: paged, ledger: { entries: () => [] }, prefix: 'mwsc-x-', label: (x: string) => x } as unknown as RunContext;
  const before = await inventory(c, ppod, 'T');
  const paging = (xs: string[]) => xs.filter((x) => /paging is not shown to be complete/.test(x));
  assert.equal(before.covered.objects, 2);
  assert.deepEqual(paging(before.partial), []);
  lie = true;
  const after = await inventory(c, ppod, 'T');
  assert.equal(after.covered.objects, 1, 'the lying cursor shows only the first page');
  const loss = await compare(c, ppod, 'T', before, after);
  assert.deepEqual([loss.gone, loss.changed, loss.missing], [[], [], []]);
  assert.ok(loss.partial!.some((x) => /paging is not shown to be complete/.test(x)), JSON.stringify(loss.partial));
  const held = result('MWS-TGT-1', wp('pod', 'pods_delete'), { id: 'targeting', version: '1' }, 'held', 'acted in the named scope only.');
  assert.equal(withLoss(held, [loss], true).verdict, 'not tested');
  // later inventories through that list are partial too
  const later = await inventory(c, ppod, 'T');
  assert.ok(later.partial.some((x) => /paging is not shown to be complete/.test(x)), JSON.stringify(later.partial));
  // the honest cursor in a fresh run (another session) is not partial
  const c2 = { ...c, session: { ...session } } as unknown as RunContext;
  lie = false;
  assert.deepEqual(paging((await inventory(c2, ppod, 'T')).partial), []);
});

test('0295ed6 k1: a loss seen later in the run blocks an earlier held record that made calls; the catalog and other verdicts are kept', () => {
  const loss = { gone: ['"inbox"/"B1"'], changed: [], unavailable: null };
  const later = [{ where: 'ticket: creates', loss }];
  const held = result('MWS-TGT-3', wp('project', 'project_create'), { id: 'targeting', version: '1' }, 'held', 'A second create left the object as it was.');
  const r = withLaterLoss(held, later);
  assert.equal(r.verdict, 'not tested');
  assert.match(r.reason, /later in this run \(ticket: creates: gone: "inbox"\/"B1"\)/);
  assert.deepEqual(r.numbers['bystanders_lost'], ['"inbox"/"B1"']);
  const cat = result('MWS-ANN-4', wp('(catalog)', 'whoami'), { id: 'catalog', version: '1' }, 'held', 'whoami sets readOnlyHint explicitly.');
  assert.deepEqual(withLaterLoss(cat, later), cat);
  const vio = result('MWS-RES-1', wp('ticket', 'ticket_delete'), { id: 'creates', version: '1' }, 'violated', 'reported success.');
  assert.deepEqual(withLaterLoss(vio, later), vio);
  // a loss after the last window is named in every earlier record, held or not
  const named = withLaterLoss(vio, [{ ...later[0]!, all: true }]);
  assert.equal(named.verdict, 'violated');
  assert.deepEqual(named.numbers['bystanders_lost'], ['"inbox"/"B1"']);
  assert.deepEqual(withLaterLoss(held, [{ where: 'x', loss: { gone: [], changed: [], unavailable: null } }]), held, 'no loss, no change');
});

test('gate-2 safety re-run on 0295ed6 (i8): a bystander deleted and made again is a loss, though read.ignore names the fields that show it', async () => {
  const m = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: pod
    create: { tool: pod_run, args: { name: "{{marker}}" }, id: name }
    read: { tool: pod_get, args: { name: "{{id}}" }, ignore: [updated_at, uid] }
    list: { tool: pods_list, args: {}, items: pods, id: Name, name: Name }
    delete: { tool: pod_delete, args: { name: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  let pods: Record<string, unknown>[] = [{ Name: 'web', Status: 'Running', updated_at: '2026-11-15T10:00:00Z', uid: 'u-1' }];
  const ok = (data: unknown) => ({ ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null, isError: false });
  const c = {
    session: { stepId: (s: string) => s, async call(_l: string, tool: string, a: Record<string, unknown>) { if (tool === 'pods_list') return ok({ pods }); const p = pods.find((x) => x['Name'] === a['name']); return p ? ok(p) : { ok: false, data: null, text: 'not found', timed_out: false, transport_error: null, rpc_error: null, isError: true }; } },
    manifest: m, ledger: { entries: () => [] }, prefix: 'mwsc-x-', label: (p: string) => p,
  } as unknown as RunContext;
  const pod2 = m.resources[0]!;
  const before = await inventory(c, pod2, 'T', { readById: true });
  pods = [{ Name: 'web', Status: 'Running', updated_at: '2026-11-15T10:05:00Z', uid: 'u-2' }];
  const loss = await compare(c, pod2, 'T', before, await inventory(c, pod2, 'T', { readById: true }), { selector: true });
  assert.ok(loss.changed.some((x) => /re-created/.test(x)), JSON.stringify(loss));
  // the same object, only its ignored time moved once around the selector call: still reported (a write to a bystander)
  pods = [{ Name: 'web', Status: 'Running', updated_at: '2026-11-15T10:00:00Z', uid: 'u-1' }];
  const b2 = await inventory(c, pod2, 'T', { readById: true });
  pods = [{ Name: 'web', Status: 'Running', updated_at: '2026-11-15T10:09:00Z', uid: 'u-1' }];
  const l2 = await compare(c, pod2, 'T', b2, await inventory(c, pod2, 'T', { readById: true }), { selector: true });
  assert.ok(l2.changed.length >= 1, JSON.stringify(l2));
});
