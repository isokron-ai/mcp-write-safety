/**
 * Tool errors found by the research-build runs on 0295ed6, each pinned here or in test/integration/research-builds.test.ts:
 *
 *   N1  the clean-up sweep compared ids across resources: task 6 was abandoned because post 6 existed
 *   N2  the MWS-UPD-1 nested_subfield probe took an object-typed wrapper argument (`data`) for a document field
 *   N3  a reset that the tool under test refuses goes through the declared control.patch
 *   N5  a control delete that sends no version is not `platform`
 *   N6  a versioned delete on one resource hid the MWS-CONC-2 rows of others sharing that delete tool
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { coverageRows } from '../../src/checks/coverage.js';
import { wrapperArg } from '../../src/checks/readback.js';
import { deleteVerdicts, type DelObs } from '../../src/checks/stale.js';
import { cleanupLedger } from '../../src/core/cleanup.js';
import { Driver } from '../../src/core/driver.js';
import { Ledger } from '../../src/core/ledger.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { result } from '../../src/report/verdicts.js';

const HEAD = `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
`;
const ok = (data: unknown) => ({ ok: true, isError: false, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
const err = (t: string) => ({ ok: false, isError: true, data: null, text: t, timed_out: false, transport_error: null, rpc_error: null });

test('N1: an id created in another collection does not hide an object of this one from the clean-up sweep', async () => {
  const m = parseManifestText(
    `${HEAD}  - name: post
    create: { tool: post_create, args: { title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: post_get, args: { id: "{{id}}" } }
    list: { tool: posts_list, args: {}, items: posts, id: id, name: title }
    delete: { tool: post_delete, args: { id: "{{id}}" } }
    cleanup: delete
  - name: task
    create: { tool: task_create, args: { title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: task_get, args: { id: "{{id}}" } }
    list: { tool: tasks_list, args: {}, items: tasks, id: id, name: title }
    delete: { tool: task_delete, args: { id: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-n1-'));
  try {
    const ledger = new Ledger(dir, 'r1');
    const ip = ledger.intent('post', 'post_create', 'p');
    ledger.append({ kind: 'created', intent: ip, resource: 'post', id: 6, name: 'mwsc-r1-p', via: 'result' });
    // A task create whose outcome is unknown: it did apply, as task 6.
    const it = ledger.intent('task', 'task_create', 't');
    ledger.append({ kind: 'create_unknown', intent: it, resource: 'task', reason: 'timed out' });
    const tasks = new Map<number, string>([[6, 'mwsc-r1-t']]);
    const posts = new Map<number, string>([[6, 'mwsc-r1-p']]);
    const session = {
      stepId: (s: string) => s,
      listTools: async () => [{ name: 'task_delete', inputSchema: { type: 'object', properties: { id: {} } } }, { name: 'post_delete', inputSchema: { type: 'object', properties: { id: {} } } }],
      async call(_l: string, tool: string, args: Record<string, unknown>) {
        const id = Number(args['id']);
        if (tool === 'tasks_list') return ok({ tasks: [...tasks].map(([i, t]) => ({ id: i, title: t })) });
        if (tool === 'posts_list') return ok({ posts: [...posts].map(([i, t]) => ({ id: i, title: t })) });
        if (tool === 'task_get') return tasks.has(id) ? ok({ id, title: tasks.get(id) }) : err('not found');
        if (tool === 'post_get') return posts.has(id) ? ok({ id, title: posts.get(id) }) : err('not found');
        if (tool === 'task_delete') return tasks.delete(id) ? ok({ deleted: id }) : err('not found');
        if (tool === 'post_delete') return posts.delete(id) ? ok({ deleted: id }) : err('not found');
        return err(`unexpected ${tool}`);
      },
    };
    const rep = await cleanupLedger(ledger, m, session as never, {}, 'mwsc-r1-');
    assert.equal(tasks.size, 0, 'task 6 was found by the sweep and deleted');
    assert.equal(posts.size, 0);
    assert.ok(rep.deleted.some((d) => d.resource === 'task' && d.id === 6), JSON.stringify(rep));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N2: an object-typed argument the object does not carry as an object is a wrapper, not a nested field', () => {
  const m = parseManifestText(`${HEAD}  - name: listing
    create: { tool: c, args: { sku: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: locale, values: [en, de] }, { path: draft, values: [true, false] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  const res = m.resources[0]!;
  assert.equal(wrapperArg({ id: 1, locale: 'en', draft: false }, res, 'data'), true, 'Payload `data`: the read has no field data');
  assert.equal(wrapperArg({ id: 1, details: { component: 'core' } }, res, 'details'), false, 'a stored nested object');
});

test('N3: a reset the tool under test refuses goes through the declared control.patch', async () => {
  const m = parseManifestText(`${HEAD}  - name: cm
    create: { tool: c, args: { name: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: a, values: [x, y] }, { path: b, values: [x, y] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
    control:
      base: http://127.0.0.1:1
      read: { http: [GET, "/cm/{{id}}"] }
      patch: { http: [PATCH, "/cm/{{id}}"], body: { "{{field}}": "{{value}}" } }
`, 'm.yaml');
  const obj: Record<string, unknown> = { a: 'y', b: 'x' };
  const d = new Driver({ stepId: (s: string) => s } as never, m, m.resources[0]!, 'mwsc-x-', {});
  d.id = 1;
  d.baseline = ['x', 'x'];
  const read = async () => ({ ok: true, obj: { ...obj }, version: null, settled: true, reads: 1 });
  Object.assign(d, {
    readOnce: read,
    readSettled: async (_l: string, _s: string, until?: (o: unknown) => boolean) => ({ ...(await read()), settled: until ? until(obj) : true }),
    update: async () => ({ ok: false, isError: true, text: 'conflict: field a is managed by another writer' }),
    controlPatch: async (f: { path: string }, v: unknown) => ((obj[f.path] = v), { ok: true, status: 200 }),
  });
  assert.equal(await d.reset('MAIN'), true);
  assert.deepEqual(obj, { a: 'x', b: 'x' });
  assert.equal(d.resetViaControl, 1);
});

const VM = (controlDelete: string) =>
  parseManifestText(`${HEAD}  - name: ticket
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: a, values: [x, y] }, { path: b, values: [x, y] } ]
    version: { read: version, arg: version }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}", version: "{{version}}" } }
    control:
      base: http://127.0.0.1:1
      read: { http: [GET, "/t/{{id}}"] }
      patch: { http: [PATCH, "/t/{{id}}"], body: { "{{field}}": "{{value}}" } }
      delete: ${controlDelete}
`, 'm.yaml');

test('N5: a control delete that sends no version is not `platform`, and CONC-1 says why it is not tested', () => {
  const won = { version: 3, del: { step: 's', ok: true, isError: false, rpc_error: null, text: 'deleted', data: null, indeterminate: false }, gone: true, other_kept: null, steps: ['s'] };
  const o: DelObs = { tool: 'd', positive: { ok: true, effect: true, step: 'p' }, reps: [won], control: [{ status: 204, gone: true }] };
  const no = VM('{ http: [DELETE, "/t/{{id}}"] }');
  const r = deleteVerdicts(o, no.resources[0]!, { manifest: no, tools: [] });
  assert.equal(r.find((x) => x.requirement === 'MWS-CONC-2')!.verdict, 'violated');
  const c1 = r.find((x) => x.requirement === 'MWS-CONC-1')!;
  assert.equal(c1.verdict, 'not tested');
  assert.match(c1.reason, /sends no \{\{version\}\}/);
  const yes = VM('{ http: [DELETE, "/t/{{id}}"], headers: { if-match: "{{version}}" } }');
  assert.equal(deleteVerdicts(o, yes.resources[0]!, { manifest: yes, tools: [] }).find((x) => x.requirement === 'MWS-CONC-2')!.verdict, 'platform', 'with the version sent, the control decides');
});

test('N6: a CONC-2 record for a shared delete tool on one resource does not cover another resource', () => {
  const m = parseManifestText(`${HEAD}  - name: a
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: resources_delete, args: { id: "{{id}}" } }
  - name: b
    create: { tool: c2, args: { t: "{{marker}}" }, id: id }
    read: { tool: r2, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: resources_delete, args: { id: "{{id}}" } }
`, 'm.yaml');
  const tools = ['c', 'r', 'c2', 'r2', 'resources_delete'].map((name) => ({ name, inputSchema: { type: 'object' } }));
  const had = [result('MWS-CONC-2', { resource: 'a', tool: 'resources_delete', arm: 'mcp' }, { id: 'stale-write', version: '1' }, 'held', 'versioned')];
  const rows = coverageRows(m, tools as never, had).filter((x) => x.requirement === 'MWS-CONC-2');
  assert.deepEqual(rows.map((x) => `${x.write_path.resource}:${x.write_path.tool}`), ['b:resources_delete']);
});

test('N1 (review): a generic create tool shared by two collections does not make them one', async () => {
  const m = parseManifestText(
    `${HEAD}  - name: post
    create: { tool: create_item, args: { collection: posts, title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: get_item, args: { collection: posts, id: "{{id}}" } }
    list: { tool: list_items, args: { collection: posts }, items: items, id: id, name: title }
    delete: { tool: delete_item, args: { collection: posts, id: "{{id}}" } }
    cleanup: delete
  - name: task
    create: { tool: create_item, args: { collection: tasks, title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: get_item, args: { collection: tasks, id: "{{id}}" } }
    list: { tool: list_items, args: { collection: tasks }, items: items, id: id, name: title }
    delete: { tool: delete_item, args: { collection: tasks, id: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-n1b-'));
  try {
    const ledger = new Ledger(dir, 'r1');
    ledger.append({ kind: 'created', intent: ledger.intent('post', 'create_item', 'p'), resource: 'post', id: 6, name: 'mwsc-r1-p', via: 'result' });
    ledger.append({ kind: 'create_unknown', intent: ledger.intent('task', 'create_item', 't'), resource: 'task', reason: 'timed out' });
    const db: Record<string, Map<number, string>> = { posts: new Map([[6, 'mwsc-r1-p']]), tasks: new Map([[6, 'mwsc-r1-t']]) };
    const session = {
      stepId: (s: string) => s,
      listTools: async () => [{ name: 'delete_item', inputSchema: { type: 'object', properties: { collection: {}, id: {} } } }],
      async call(_l: string, tool: string, a: Record<string, unknown>) {
        const c = db[String(a['collection'])]!;
        const id = Number(a['id']);
        if (tool === 'list_items') return ok({ items: [...c].map(([i, t]) => ({ id: i, title: t })) });
        if (tool === 'get_item') return c.has(id) ? ok({ id, title: c.get(id) }) : err('not found');
        if (tool === 'delete_item') return c.delete(id) ? ok({ deleted: id }) : err('not found');
        return err(`unexpected ${tool}`);
      },
    };
    await cleanupLedger(ledger, m, session as never, {}, 'mwsc-r1-');
    assert.equal(db['tasks']!.size, 0, 'task 6 found and deleted although post 6 exists');
    assert.equal(db['posts']!.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N5 (review): {{json:version}} and {{?version}} in the control delete count as sending the version', () => {
  const won = { version: 3, del: { step: 's', ok: true, isError: false, rpc_error: null, text: 'deleted', data: null, indeterminate: false }, gone: true, other_kept: null, steps: ['s'] };
  const o: DelObs = { tool: 'd', positive: { ok: true, effect: true, step: 'p' }, reps: [won], control: [{ status: 204, gone: true }] };
  for (const t of ['{ http: [DELETE, "/t/{{id}}"], body: { v: "{{json:version}}" } }', '{ http: [DELETE, "/t/{{id}}"], headers: { if-match: "{{?version}}" } }']) {
    const mm = VM(t);
    assert.equal(deleteVerdicts(o, mm.resources[0]!, { manifest: mm, tools: [] }).find((x) => x.requirement === 'MWS-CONC-2')!.verdict, 'platform', t);
  }
});

test('N6 (review): a resource that sends a shared delete tool no version keeps its own "carries no {{version}}" row', async () => {
  const { staleCheck } = await import('../../src/checks/stale.js');
  const m = parseManifestText(`${HEAD}  - name: a
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    version: { read: version }
    cleanup: delete
    delete: { tool: resources_delete, args: { id: "{{id}}", rv: "{{version}}" } }
  - name: b
    create: { tool: c2, args: { t: "{{marker}}" }, id: id }
    read: { tool: r2, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: resources_delete, args: { id: "{{id}}" } }
`, 'm.yaml');
  const p = staleCheck.plan({ manifest: m, tools: [] } as never, m.resources[1]!);
  const row = p.notRun.find((x) => x.requirement === 'MWS-CONC-2' && x.write_path.resource === 'b');
  assert.ok(row, JSON.stringify(p.notRun.map((x) => x.requirement)));
  assert.match(row!.reason, /carry no \{\{version\}\}/);
});

test('GitHub Action review S6: the ledger redacts free text (a server error) as the report does, and keeps ids exact', async () => {
  const { readFileSync } = await import('node:fs');
  const { Redactor } = await import('../../src/core/redact.js');
  const red = new Redactor(['s3cr3t-token-value']);
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-s6-'));
  try {
    const l = new Ledger(dir, 'r1', (s) => red.text(s));
    const i = l.intent('task', 'task_create', 't');
    l.append({ kind: 'create_unknown', intent: i, resource: 'task', reason: 'upstream said: Authorization: Bearer s3cr3t-token-value rejected' });
    l.append({ kind: 'created', intent: i, resource: 'task', id: 'T-7', name: 'mwsc-r1-x', via: 'result' });
    const text = readFileSync(l.file, 'utf8');
    assert.ok(!text.includes('s3cr3t-token-value'), text);
    assert.match(text, /"id":"T-7"/);
    assert.match(text, /"name":"mwsc-r1-x"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatcher guard (PostHog cli mode): a call the operator declares read-only is verified and fails closed', async () => {
  const { tenantGuard, guardProblem } = await import('../../src/core/safety.js');
  const { WritecheckError } = await import('../../src/core/util.js');
  const man = (extra: string, args = '{ command: "whoami --json" }') => parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: { tool: exec, args: ${args}, path: org, pattern: "^test-"${extra} } }
resources:
  - name: flag
    create: { tool: exec, args: { command: "flags create {{marker}}" }, id: id }
    read: { tool: exec, args: { command: "flags get {{id}}" } }
    cleanup: delete
    delete: { tool: exec, args: { command: "flags delete {{id}}" } }
`, 'm.yaml');
  const exec = { name: 'exec', annotations: { readOnlyHint: false } };
  const session = (answers: unknown[]) => {
    let i = 0;
    return { stepId: (x: string) => x, listTools: async () => [exec], reserveWrites() {}, async call() { const a = answers[Math.min(i++, answers.length - 1)]; return a; } };
  };
  const good = ok({ org: 'test-org' });
  // without the declaration: refused, as before
  assert.match(guardProblem(man('').target.guard!, exec)!, /readOnlyHint: false/);
  // declared, three identical answers: the guard holds, and rests on the operator
  const g = await tenantGuard(man(', read_only_call: true'), session([good, good, good]) as never, 'G');
  assert.equal(g.basis, 'operator');
  // declared, but the answers differ (the call may change state): refused
  await assert.rejects(tenantGuard(man(', read_only_call: true'), session([good, ok({ org: 'test-org', n: 2 }), good]) as never, 'G'), (e) => e instanceof WritecheckError && e.code === 3 && /answered differently/.test(e.message));
  // declared, but the call errors: refused (fail closed)
  await assert.rejects(tenantGuard(man(', read_only_call: true'), session([good, err('boom')]) as never, 'G'), (e) => e instanceof WritecheckError && e.code === 3);
  // a templated declared call is refused at load
  assert.throws(() => man(', read_only_call: true', '{ command: "whoami {{prefix}}" }'), /written out in full/);
});

test('dispatcher guard (review): the declaration never turns off the other protections', async () => {
  const { guardProblem } = await import('../../src/core/safety.js');
  const g = { tool: 'exec', args: { command: 'whoami' }, path: null, pattern: '^t', read_only: false, read_only_call: true };
  assert.match(guardProblem(g, { annotations: { destructiveHint: true } })!, /destructiveHint/);
  assert.match(guardProblem(g, { annotations: { readOnlyHint: false } }, { readOnlyTools: ['whoami'] })!, /offers read-only tools/);
  assert.equal(guardProblem(g, { annotations: { readOnlyHint: false } }, { readOnlyTools: [] }), null);
});

test('review S6: credentials in the server command are left out of the label; short flags too', async () => {
  const { serverLabel } = await import('../../src/cli/run.js');
  const { safeCommand } = await import('../../src/core/command-line.js');
  for (const argv of [['npx', 'srv', '-k', 'sk_live_abcdef123'], ['srv', '-p', 'hunter2hunter2'], ['srv', '--api-key', 'abc123def']]) assert.ok(!/sk_live_abcdef123|hunter2hunter2|abc123def/.test(safeCommand(argv)), safeCommand(argv));
  assert.equal(safeCommand(['node', 'server.js', '-p', '3000', '-c', './conf.yaml', '-v', 'run']), 'node server.js -p 3000 -c ./conf.yaml -v run', 'numbers, paths and plain words stay');
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [npx, srv, --api-key, abc123def, -k, sk_live_zzz999] }
target: { environment: test, confirm: t }
resources:
  - name: a
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  assert.ok(!/abc123def|sk_live_zzz999/.test(serverLabel(m)), serverLabel(m));
});

test('gate-2 safety re-run on 0295ed6: F2 (the written value is passed), F3 (negation and echoes), F4 (an unmatched refusal)', async () => {
  const { gatedVerdicts } = await import('../../src/checks/gated.js');
  const { saysNotUsed } = await import('../../src/checks/schema.js');
  const { undecidedRefusal } = await import('../../src/checks/retry2.js');
  const { usePatterns, says } = await import('../../src/checks/says.js');
  const withP = <T>(p: Record<string, string>, f: () => T): T => {
    usePatterns({ patterns: p } as never);
    try {
      return f();
    } finally {
      usePatterns(null);
    }
  };
  // F2: an error that names the new value (bob) through a declared applied pattern is credited
  const m = parseManifestText(`${HEAD}  - name: ticket
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [open, closed] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  const call = { step: 's', ok: false, isError: true, rpc_error: null, text: 'Partly done: set to bob; the close was refused.', data: null, indeterminate: false };
  const o = { routing: 'loopback', independent: true, learned: [], trials: [], control: null, conc1: null, res2: { faulted: { seq: 1, method: 'PATCH', path: '/t/1', status: null }, call, changed: ['assignee'], applied: true, object: 'T1' }, atom: null } as never;
  const r = withP({ applied: '\\bset to\\b', outcome_unknown: 'not known whether', not_applied: 'refused' }, () => gatedVerdicts(o, m.resources[0]!).find((x) => x.requirement === 'MWS-RES-2'))!;
  assert.notEqual(r.verdict, 'violated', r.reason);
  // F3: a declared pattern does not match inside a negation or echoed data
  withP({ not_used: '\\bignored\\b|\\bunused\\b' }, () => {
    assert.equal(saysNotUsed('Note: the argument "ttle" was not ignored: it was stored with the ticket.', 'ttle'), false);
    assert.equal(saysNotUsed('Request echo: {"ttle":"x"}. Remaining unused quota: 3 calls.', 'ttle'), false);
    assert.equal(saysNotUsed('The argument ttle was ignored.', 'ttle'), true);
    assert.equal(says('not_used', 'Request: {"note":"ignored"}'), false);
  });
  // F4: with patterns.unavailable declared, a refusal it does not match stays undecided
  const c = { ok: false, isError: true, rpc_error: null, text: 'Request refused.', data: null, indeterminate: false, id: null, version: null } as never;
  assert.equal(withP({ unavailable: '\\brate limit' }, () => undecidedRefusal(c, 'k', [])), true);
  assert.equal(withP({ unavailable: '\\brefused\\b' }, () => undecidedRefusal(c, 'k', [])), false);
});

test('validator re-run on e613620: an ignored cursor ends the listing early; an ignored id is not a settable field; a shared create tool is checked per collection', async () => {
  const { listAll } = await import('../../src/core/lists.js');
  const { ignoreWarnings } = await import('../../src/core/plan.js');
  const { sameCollection } = await import('../../src/core/driver.js');
  let calls = 0;
  const session = { async call(_l: string, _t: string, a: Record<string, unknown>) { calls++; return ok({ items: [{ id: 1 }, { id: 2 }], next: Number(a['page'] ?? 1) + 1 }); } };
  const r = await listAll(session as never, 'L', { tool: 'list', args: {}, items: 'items', id: 'id', name: 'id', ignore: [], next: { path: 'next', arg: 'page' } } as never, {}, 's');
  assert.ok(r.partial && /already listed/.test(r.partial), r.partial ?? '');
  assert.ok(calls <= 3, `stopped after ${calls} calls, not ${200}`);
  const m = parseManifestText(`${HEAD}  - name: post
    create: { tool: create_item, args: { collection: posts, title: "{{marker}}" }, id: id }
    read: { tool: get_item, args: { collection: posts, id: "{{id}}" }, ignore: [id, updated_at] }
    list: { tool: list_items, args: { collection: posts }, items: items, id: id }
    update: { tool: update_item, mode: field_patch, args: { collection: posts, id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: a, values: [x, y] }, { path: b, values: [x, y] } ]
    cleanup: delete
    delete: { tool: delete_item, args: { collection: posts, id: "{{id}}" } }
  - name: page
    create: { tool: create_item, args: { collection: pages, title: "{{marker}}" }, id: id }
    read: { tool: get_item, args: { collection: pages, id: "{{id}}" } }
    list: { tool: list_items, args: { collection: pages }, items: items, id: id }
    cleanup: delete
    delete: { tool: delete_item, args: { collection: pages, id: "{{id}}" } }
`, 'm.yaml');
  const tools = [{ name: 'update_item', inputSchema: { type: 'object', properties: { id: {}, collection: {}, a: {}, b: {}, updated_at: {} } } }, { name: 'delete_many', inputSchema: { type: 'object', properties: { collection: {}, title: {} } } }];
  const w = ignoreWarnings(m, tools as never);
  assert.ok(!w.warnings.some((x) => /names id,/.test(x)), w.warnings.join(' | '));
  assert.ok(w.warnings.some((x) => /names updated_at/.test(x)), 'a settable field is still warned (and refused in opt-in mode)');
  assert.equal(sameCollection(m.resources[0]!, m.resources[1]!), false, 'posts and pages share create_item but are two collections');
});

test('B2 follow-up: a guard declared read-only on an unannotated server is charged to the write budget and never says "no write"', async () => {
  const { tenantGuard } = await import('../../src/core/safety.js');
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: { tool: whoami, args: {}, path: org, pattern: "^test-", read_only: true } }
resources:
  - name: a
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  let reserved = 0;
  const mk = (answer: unknown) => ({ stepId: (x: string) => x, listTools: async () => [{ name: 'whoami' }, { name: 'c' }, { name: 'r' }, { name: 'd' }], reserveWrites: (n: number) => (reserved += n), call: async () => answer });
  const g = await tenantGuard(m, mk(ok({ org: 'test-org' })) as never, 'G');
  assert.equal(reserved, 1);
  assert.equal(g.calls.length, 1);
  await assert.rejects(tenantGuard(m, mk(ok({ org: 'prod' })) as never, 'G'), (e) => /was sent 1 time/.test((e as Error).message) && !/no write was made$/.test((e as Error).message));
});

test('dogfood CI (C3, C9): null to a value is an addition; a saved catalog.json keeps prompts and resource templates', async () => {
  const { nonAdditive } = await import('../../src/checks/types.js');
  const { readCatalogFile } = await import('../../src/cli/commands.js');
  const { writeFileSync } = await import('node:fs');
  assert.deepEqual(nonAdditive({ claim: null }, { claim: { holder: 'a' } }), []);
  assert.deepEqual(nonAdditive({ claim: { holder: 'a' } }, { claim: null }), ['claim']);
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-c9-'));
  try {
    const f = join(dir, 'catalog.json');
    writeFileSync(f, JSON.stringify({ tools: [{ name: 't', inputSchema: { type: 'object' } }], prompts: [{ name: 'p' }], resourceTemplates: [] }));
    const c = readCatalogFile(f);
    assert.equal(c.tools.length, 1);
    assert.deepEqual(c.prompts, [{ name: 'p' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nx1-x-lie (validator re-run on 9288cfc): a later paging partial turns every earlier held record not tested, also on recheck', async () => {
  const { withLaterLoss } = await import('../../src/checks/targeting.js');
  const held = result('MWS-TGT-1', { resource: 'ticket', tool: 'ticket_create', arm: 'mcp' }, { id: 'targeting', version: '1' }, 'held', 'created in the named scope only.');
  const later = [{ where: 'ticket: stale-write', loss: { gone: [], changed: [], unavailable: null }, paging: ['ticket_list (scope "inbox") read to its last page did not show "B1", ... so its paging is not shown to be complete'] }];
  const r = withLaterLoss(held, later);
  assert.equal(r.verdict, 'not tested');
  assert.match(r.reason, /shown later in this run to be partial/);
  const cat = result('MWS-ANN-4', { resource: '(catalog)', tool: 't', arm: 'mcp' }, { id: 'catalog', version: '1' }, 'held', 'x');
  assert.equal(withLaterLoss(cat, later).verdict, 'held');
});

test('K9 (K9-IN4-OPTIONS): the controls decide a refusal, never the text; the name test is whole-token', async () => {
  const { refusedBy, counterpart, sameAnswer, namesWhole, refusalProblem, IN4_OPTION, in4NoCounterpart } = await import('../../src/checks/schema.js');
  // the isError short-circuit is gone: an unnamed error is decided by the controls in collect, not by its form alone
  assert.equal(refusedBy({ text: 'Could not read 5 (status 404).', rpc_error: null, isError: true } as never, 'id'), null);
  // counterparts of the same meaning (MWS-IN-1)
  assert.deepEqual(counterpart(5, 'string', true), { value: '5', what: 'the string "5"' });
  assert.deepEqual(counterpart('5', 'integer', true)?.value, 5);
  assert.deepEqual(counterpart('true', 'boolean', false)?.value, true);
  assert.equal(counterpart(null, 'string', false)?.omit, true);
  assert.equal(counterpart(null, 'string', true), null, 'null for a required argument has no use that keeps the meaning (Grafana uid)');
  assert.equal(counterpart({ a: 1 }, 'string', true), null, 'an object flattened changes the meaning');
  // case 3: 5 used as "5", then a not-found: the same answer, so the error follows from the use (not a rejection)
  const e = (text: string) => ({ ok: false, isError: true, text, rpc_error: null });
  assert.equal(sameAnswer(e('Could not read 5 (status 404).'), e('Could not read 5 (status 404).'), [5, '5']), true);
  assert.equal(sameAnswer(e('Invalid input'), e('Could not read 5 (status 404).'), [5, '5']), false, 'told apart before use: a rejection');
  // case 8: whole-token name test
  assert.equal(namesWhole('Invalid input', 'id'), false);
  assert.equal(namesWhole('invalid value at /uid', 'uid'), true);
  assert.equal(namesWhole('"id" must be a string', 'id'), true);
  assert.equal(namesWhole('username is required', 'name'), false);
  assert.match(refusalProblem({ prop: 'id', text: 'Invalid input', rpc_error: null } as never)!, /does not name the argument id/);
  // the switch between the owner's options flips one rule only
  assert.equal(in4NoCounterpart(), 'rejection');
  IN4_OPTION.value = 'B';
  try {
    assert.equal(in4NoCounterpart(), 'cannot_tell');
  } finally {
    IN4_OPTION.value = 'C';
  }
});


test('outcome_field with path mws.outcome (Annex B-9 write-result/0.1 shape) is read', async () => {
  const { outcomeByField, usePatterns } = await import('../../src/checks/says.js');
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
outcome_field: { path: mws.outcome, applied: applied, not_applied: not_applied, unknown: unknown }
resources:
  - name: a
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  usePatterns(m);
  try {
    assert.equal(outcomeByField({ data: { mws: { shape: 'write-result/0.1', outcome: 'unknown', repeat: 'read_first' } } })!.outcome, 'unknown');
    assert.equal(outcomeByField({ data: { mws: { shape: 'write-result/0.1', outcome: 'not_applied' } } })!.outcome, 'not_applied');
    assert.equal(outcomeByField({ data: { mws: { outcome: 'partial' } } }), null, 'a value the declaration does not list decides nothing');
  } finally {
    usePatterns(null);
  }
});

test('spec R14-4: an ATOM-1 step whose outcome is open for the server is named where the result says it is not known whether it was applied', async () => {
  const { gatedVerdicts } = await import('../../src/checks/gated.js');
  const { usePatterns } = await import('../../src/checks/says.js');
  const m = parseManifestText(`${HEAD}  - name: ticket
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [open, closed] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  const call = { step: 's', ok: false, isError: true, rpc_error: null, text: 'The labels step failed; it is not known whether the assignee change was applied.', data: null, indeterminate: false };
  const o = { routing: 'loopback', independent: true, learned: [], trials: [], control: null, conc1: null, res2: null, atom: { trials: [{ nth: 2, faulted: { seq: 2, method: 'PATCH', path: '/t/1', status: null }, call, changed: ['assignee'], applied: true }] } } as never;
  usePatterns({ patterns: { applied: 'was updated', outcome_unknown: 'not known whether' } } as never);
  try {
    const a1 = gatedVerdicts(o, m.resources[0]!).find((x) => x.requirement === 'MWS-ATOM-1')!;
    assert.notEqual(a1.verdict, 'violated', a1.reason);
    assert.notEqual(a1.verdict, 'not tested', a1.reason);
  } finally {
    usePatterns(null);
  }
});

test('K9 / R14-6: the comparison sets aside what differed between two sends of the probe', async () => {
  const { sameAnswer } = await import('../../src/checks/schema.js');
  const e = (text: string) => ({ ok: false, isError: true, text, rpc_error: null });
  assert.equal(sameAnswer(e('not found (request r-1)'), e('not found (request r-3)'), [5, '5'], e('not found (request r-2)')), true, 'a request id that changes per send is set aside');
  assert.equal(sameAnswer(e('not found (request r-1)'), e('not found (request r-3)'), [5, '5']), false, 'without a second send it is not');
  assert.equal(sameAnswer(e('Invalid input'), e('not found'), [5, '5'], e('Invalid input')), false);
  assert.equal(sameAnswer(e('a b c'), e('a b c'), [], e('a b')), null, 'two sends of the probe that differ in length: cannot tell');
});

test('Action CI SH-1: a multi-item tool bound by {{ids[n]}} or {{json:ids}} loads; one bound to neither ids nor scope is still refused', () => {
  const man = (args: string) => parseManifestText(`${HEAD}  - name: block
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
    multi:
      - { tool: m, args: ${args}, effect: deleted }
`, 'm.yaml');
  for (const a of ['{ id: "{{ids[0]}}" }', '{ ids: "{{json:ids}}" }', '{ ids: "{{ids}}" }', '{ project: "{{?scope}}" }']) assert.equal(man(a).resources[0]!.multi.length, 1, a);
  assert.throws(() => man('{ title_prefix: "{{batch}}" }'), /must bind the objects/);
  assert.throws(() => man('{ x: "{{idsx}}" }'), /must bind the objects/);
});

test('spec R14-5, rule 11 point 13: a declared text failure gives its verdict even where the outcome field says unknown', async () => {
  const { usePatterns } = await import('../../src/checks/says.js');
  const { readSecondClause } = await import('../../src/checks/types.js');
  const m = parseManifestText(`mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
outcome_field: { path: outcome, applied: applied, not_applied: not_applied, unknown: unknown }
patterns:
  not_applied: 'nothing was written'
resources:
  - name: a
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  usePatterns(m);
  try {
    const b = { text: 'Backend error; nothing was written.', data: { outcome: 'unknown' }, rpc_error: null };
    assert.equal(readSecondClause(b as never, ['assignee']).v, 'violated');
    assert.equal(readSecondClause({ text: 'Backend error.', data: { outcome: 'unknown' }, rpc_error: null } as never, ['assignee']).v, 'held', 'the field alone, with nothing false in the text');
  } finally {
    usePatterns(null);
  }
});

test('BL-4 / SH-1: multiBinding reads the parsed template roots (every placeholder form) and a literal under the scope key', async () => {
  const { multiBinding } = await import('../../src/core/manifest.js');
  for (const a of [{ project: '{{scope}}' }, { project: '{{ ?scope }}' }, { project: '{{json:scope}}' }, { project: '{{scope.id}}' }]) assert.equal(multiBinding(a, 'project').scope, true, JSON.stringify(a));
  assert.equal(multiBinding({ project: 'inbox' }, 'project').scope, true, 'a literal under the scope argument');
  for (const a of [{ ids: '{{ids}}' }, { id: '{{ids[0]}}' }, { ids: '{{json:ids}}' }]) assert.equal(multiBinding(a, null).ids, true, JSON.stringify(a));
  assert.deepEqual(multiBinding({ title_prefix: '{{batch}}' }, 'project'), { scope: false, ids: false });
});

test('Action CI SH-3: MWS-RETRY-2 on a second resource of a keyed create tool is not tested (declaration gap), never not applicable', async () => {
  const { idempotencyCheck } = await import('../../src/checks/idempotency.js');
  const m = parseManifestText(`${HEAD}  - name: page
    create: { tool: put_document, args: { t: "{{marker}}", kind: page }, id: id }
    read: { tool: get_page, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
    idempotency: { key: { arg: request_id } }
  - name: block
    create: { tool: put_document, args: { t: "{{marker}}", kind: block }, id: id }
    read: { tool: get_block, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
  - name: note
    create: { tool: put_note, args: { t: "{{marker}}" }, id: id }
    read: { tool: get_note, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
  - name: memo
    create: { tool: put_memo, args: { t: "{{marker}}" }, id: id }
    read: { tool: get_memo, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  const tools = [{ name: 'put_note', inputSchema: { type: 'object', properties: { t: {}, idempotency_key: { type: 'string' } } } }, { name: 'put_memo', inputSchema: { type: 'object', properties: { t: {} } } }];
  const row = (i: number) => idempotencyCheck.plan({ manifest: m, tools } as never, m.resources[i]!).notRun.find((x) => x.requirement === 'MWS-RETRY-2');
  assert.equal(row(1)!.verdict, 'not tested');
  assert.match(row(1)!.reason, /declared on page/);
  assert.equal(row(2)!.verdict, 'not tested');
  assert.match(row(2)!.reason, /input schema offers idempotency_key/);
  assert.equal(row(3)!.verdict, 'not applicable');
});

test('Action CI SH-4 and SH-5: the plan omits a failure call that names an object no one is under test for; ignored paths are listed once', async () => {
  const { createsCheck } = await import('../../src/checks/creates.js');
  const { ignoredPaths } = await import('../../src/checks/readback.js');
  const m = parseManifestText(`${HEAD}  - name: sea
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: sea_get, args: { id: "{{id}}" }, ignore: [metadata.resourceVersion, metadata.managedFields] }
    version: { read: metadata.resourceVersion }
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
    failures:
      - { name: foreign, tool: sea_update, args: { id: "{{id}}", token: bad } }
      - { name: foreign_json, tool: sea_update, args: { id: "{{json:id}}", token: bad } }
      - { name: bad_create, tool: c, args: { t: "" } }
`, 'm.yaml');
  const calls = createsCheck.plan({ manifest: m, tools: [] } as never, m.resources[0]!).calls.filter((c) => c.startsWith('MWS-RES-2 declared failure'));
  assert.deepEqual(calls, [], 'without an object under test, the write-faults check runs the declared failures');
  // B-GAP F4: a failure that names {{id}} runs on a scratch object; one that names neither an object nor a key is not sent.
  const { writeFaultsCheck } = await import('../../src/checks/writefaults.js');
  const tools = ['c', 'd', 'sea_get', 'sea_update'].map((name) => ({ name, inputSchema: { type: 'object' } }));
  const wf = writeFaultsCheck.plan({ manifest: m, tools } as never, m.resources[0]!);
  assert.deepEqual(wf.calls.filter((c) => c.startsWith('MWS-RES-2 declared failure')), ['MWS-RES-2 declared failure foreign: sea_update on a scratch object; sea_get around it', 'MWS-RES-2 declared failure foreign_json: sea_update on a scratch object; sea_get around it']);
  assert.match(wf.notRun.find((r) => r.write_path.tool === 'c' && /bad_create|neither an object/.test(r.reason))!.reason, /neither an object of sea/);
  assert.deepEqual(ignoredPaths(m.resources[0]!), ['metadata.resourceVersion', 'metadata.managedFields']);
});

test('Action CI SH-8: a write path whose receipt update failed or was not sent gets a not tested MWS-RES-4 record with the reason', async () => {
  const { createsVerdicts } = await import('../../src/checks/creates.js');
  const m = parseManifestText(`${HEAD}  - name: post
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: title, values: [a, b] }, { path: body, values: [c, d] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  const res = m.resources[0]!;
  const call = (o: object) => ({ step: 's', ok: false, isError: true, rpc_error: null, text: 'conflict: provenance changed', data: null, indeterminate: false, tool: 'u', ...o });
  const rec = (o: object) => createsVerdicts({ creates: [], failures: [], delete_case: null, jobs: [], ...o } as never, res, { manifest: m, tools: [] } as never).filter((r) => r.requirement === 'MWS-RES-4');
  const failed = rec({ update_skipped: null, update_receipt: { id: 'P1', call: call({}), field: 'title', arg: 'title', value: 'b', version: null, read_keys: null, changed: null } });
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.verdict, 'not tested');
  assert.match(failed[0]!.reason, /did not succeed .*provenance changed/);
  const notSent = rec({ update_skipped: 'the object under test could not be put back to its baseline before the update, so the update whose answer is the receipt was not sent', update_receipt: null });
  assert.equal(notSent[0]!.verdict, 'not tested');
  assert.match(notSent[0]!.reason, /could not be put back/);
  const unknown = rec({ update_skipped: null, update_receipt: { id: 'P1', call: call({ indeterminate: true, ok: false }), field: 'title', arg: 'title', value: 'b', version: null, read_keys: null, changed: null } });
  assert.match(unknown[0]!.reason, /unknown outcome/);
  assert.equal(rec({ update_receipt: null }).length, 0, 'older evidence without the field keeps its records');
});

test('spec R15-4, review of 3283a69 (5): restorable parses names, { arg, path } and { arg, call_only }, and only for a tool that updates one object by its identifier', () => {
  const man = (update: string, restorable: string, extra = '') => parseManifestText(`${HEAD}  - name: post
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: ${update}
    fields: [ { path: title, values: [a, b] }, { path: body, values: [c, d] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
    restorable: ${restorable}
${extra}`, 'm.yaml');
  const U = '{ tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }';
  assert.deepEqual(man(U, '[priority, { arg: note, path: meta.note }, { arg: force, call_only: true }]').resources[0]!.restorable, [{ arg: 'priority', path: 'priority' }, { arg: 'note', path: 'meta.note' }, { arg: 'force', path: 'force', call_only: true }]);
  assert.throws(() => man(U, 'priority'), /a list of argument names/);
  assert.throws(() => man(U, '[{ arg: force, call_only: true, path: x }]'), /call_only and path exclude each other/);
  assert.throws(() => man(U, '[{ arg: force, call_only: yes }]'), /call_only/);
  assert.throws(() => man(U, '[priority, priority]'), /listed twice/);
  assert.throws(() => man('{ tool: d, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }', '[priority]'), /also this resource's delete tool/);
  assert.throws(() => man('{ tool: u, mode: field_patch, args: { "{{field}}": "{{value}}" } }', '[priority]'), /do not name the object by \{\{id\}\} or \{\{object\}\}/);
  // re-review of 2443620: the same tool as another resource's delete tool (a dispatcher) is refused too
  assert.throws(() => man(U, '[priority]', `  - name: other
    create: { tool: c2, args: { t: "{{marker}}" }, id: id }
    read: { tool: r2, args: { id: "{{id}}" } }
    cleanup: delete
    delete: { tool: u, args: { id: "{{id}}" } }
`), /also other's delete tool/);
});

test('validator on 2443620: plan warns where an update tool declares fields but no restorable (R15-4: IN-1, IN-4, IN-6 not judged)', async () => {
  const { restorableWarnings } = await import('../../src/core/plan.js');
  const man = (extra: string) => parseManifestText(`${HEAD}  - name: post
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: title, values: [a, b] }, { path: body, values: [c, d] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
${extra}`, 'm.yaml');
  const w = restorableWarnings(man(''));
  assert.equal(w.length, 1);
  assert.match(w[0]!, /u declares fields but no restorable.*IN-1, IN-4 and IN-6 on u will be not judged.*MANIFEST\.md/);
  assert.deepEqual(restorableWarnings(man('    restorable: [title]\n')), []);
  // Action matrix on 7619465: where the loader would refuse restorable (the update tool is also a delete tool, or does not name the
  // object by its identifier), the warning says R15-4 excludes the tool and that listing restorable would not help.
  const sameAsDelete = parseManifestText(`${HEAD}  - name: post
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: title, values: [a, b] }, { path: body, values: [c, d] } ]
    cleanup: delete
    delete: { tool: u, args: { id: "{{id}}", op: delete } }
`, 'm.yaml');
  const x = restorableWarnings(sameAsDelete);
  assert.equal(x.length, 1);
  assert.match(x[0]!, /u is also this resource's delete tool.*R15-4 excludes it.*listing restorable would not help/);
  assert.doesNotMatch(x[0]!, /list the arguments the tester may send/);
  const noId = parseManifestText(`${HEAD}  - name: post
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: r, args: { id: "{{id}}" } }
    update: { tool: u, mode: field_patch, args: { "{{field}}": "{{value}}" } }
    fields: [ { path: title, values: [a, b] }, { path: body, values: [c, d] } ]
    cleanup: delete
    delete: { tool: d, args: { id: "{{id}}" } }
`, 'm.yaml');
  assert.match(restorableWarnings(noId)[0]!, /update\.args do not name the object by \{\{id\}\} or \{\{object\}\}.*listing restorable would not help/);
});
