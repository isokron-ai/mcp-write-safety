/**
 * Review B2 (on e613620): a tenant guard declared with read_only_call rests on
 * the operator's word. It is now verified against the state the manifest lets the tester read (its canaries and its lists),
 * every call of it is counted as a write and reported before it goes out, a stop never says "no write was made" once it went
 * out, and it is never re-sent as the liveness check between checks.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseManifestText } from '../../src/core/manifest.js';
import { targetStopped, tenantGuard, type GuardCall } from '../../src/core/safety.js';
import { BudgetExhausted } from '../../src/core/session.js';
import { WritecheckError } from '../../src/core/util.js';

const ok = (data: unknown) => ({ ok: true, isError: false, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
const err = (t: string) => ({ ok: false, isError: true, data: null, text: t, timed_out: false, transport_error: null, rpc_error: null });

/** A dispatcher-only server (one tool, `exec`) over flags 7 and 8 and a counter, as PostHog's cli mode is shaped. */
function dispatcher(guard: (st: { flags: Map<string, unknown>; counter: number; n: number }) => ReturnType<typeof ok>, o: { budget?: number } = {}) {
  const st = { flags: new Map<string, unknown>([['7', { id: '7', key: 'bystander-a' }], ['8', { id: '8', key: 'bystander-b' }]]), counter: 0, n: 0 };
  const sent: string[] = [];
  let seq = 0;
  let writes = 0;
  let listTools = 0;
  const exec = { name: 'exec', annotations: { readOnlyHint: false } };
  const session = {
    stepId: (x: string) => `${x}#${++seq}`,
    listTools: async () => (listTools++, [exec]),
    reserveWrites(n: number, what: string) {
      if (writes + n > (o.budget ?? 1000)) throw new BudgetExhausted(what, o.budget ?? 1000);
      writes += n;
    },
    async call(_label: string, tool: string, args: { command?: string }) {
      const cmd = args?.command ?? tool;
      sent.push(cmd);
      if (cmd === 'flags list') return ok({ items: [...st.flags.values()] });
      if (cmd === 'stats') return ok({ count: st.counter });
      if (cmd.startsWith('flags get')) return ok({ id: '7' });
      st.n++;
      return guard(st);
    },
  };
  return { st, sent, session, writes: () => writes, listTools: () => listTools };
}

const man = (guardCmd: string, o: { list?: boolean; canary?: boolean } = {}) =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: { tool: exec, args: { command: "${guardCmd}" }, path: org, pattern: "^test-", read_only_call: true } }
${o.canary ? 'canaries:\n  - { name: stats, tool: exec, args: { command: stats } }\n' : ''}resources:
  - name: flag
    create: { tool: exec, args: { command: "flags create {{marker}}" }, id: id }
    read: { tool: exec, args: { command: "flags get {{id}}" } }
${o.list === false ? '' : '    list: { tool: exec, args: { command: "flags list" }, items: items, id: id, name: key }\n'}    cleanup: delete
    delete: { tool: exec, args: { command: "flags delete {{id}}" } }
`,
    'm.yaml',
  );

const refused = (re: RegExp[]) => (e: unknown) => {
  assert.ok(e instanceof WritecheckError, String(e));
  assert.equal(e.code, 3);
  for (const r of re) assert.match(e.message, r);
  assert.doesNotMatch(e.message, /no write was made|before any of its own writes|nothing was written/i);
  return true;
};

test('B2: a delete-shaped guard that answers the same each time is refused by the list read around it', async () => {
  // `flags delete 7` answers {org: test-org} every time; the first call deletes the bystander flag 7.
  const d = dispatcher((st) => (st.flags.delete('7'), ok({ org: 'test-org' })));
  const calls: GuardCall[] = [];
  await assert.rejects(tenantGuard(man('flags delete 7'), d.session as never, 'G', { onCall: (c) => calls.push(c) }), refused([/list exec .*changed across its three calls/, /was sent 3 time\(s\)/, /may have changed state/]));
  assert.equal(calls.length, 3, 'each call recorded before it was sent');
  assert.ok(calls.every((c) => c.basis === 'operator'));
  assert.equal(d.writes(), 3, 'each declared call counted against the write budget');
});

test('B2: a delete-shaped guard whose second answer differs: the stop says the call was sent twice and may have changed state', async () => {
  const d = dispatcher((st) => (st.flags.delete('7') ? ok({ org: 'test-org', deleted: '7' }) : ok({ org: 'test-org', deleted: null })));
  const calls: GuardCall[] = [];
  await assert.rejects(tenantGuard(man('flags delete 7'), d.session as never, 'G', { onCall: (c) => calls.push(c) }), refused([/answered differently/, /was sent 2 time\(s\)/, /may have changed state/, /flags delete 7/]));
  assert.deepEqual(calls.map((c) => c.phase), ['check', 'dry']);
});

test('B2: a counter-incrementing guard is refused by the canary read around it', async () => {
  const d = dispatcher((st) => (st.counter++, ok({ org: 'test-org' })));
  await assert.rejects(tenantGuard(man('touch', { list: false, canary: true }), d.session as never, 'G'), refused([/canary stats changed/, /was sent 3 time\(s\)/]));
  assert.equal(d.st.counter, 3);
});

test('B2: a guard that only reads passes; the record says what was compared and that it rests on the declaration', async () => {
  const d = dispatcher(() => ok({ org: 'test-org' }));
  const g = await tenantGuard(man('whoami --json', { canary: true }), d.session as never, 'G');
  assert.equal(g.basis, 'operator');
  assert.equal(g.calls.length, 3);
  assert.equal(d.writes(), 3);
  assert.match(g.state ?? '', /canary stats, list exec .* read the same before and after the three calls/);
  // the first read of the state comes before the first guard call, the second after the third
  assert.deepEqual(d.sent, ['stats', 'flags list', 'whoami --json', 'whoami --json', 'whoami --json', 'stats', 'flags list']);
});

test('B2: with nothing declared to read, the guard still passes on three identical answers and the record says nothing was compared', async () => {
  const d = dispatcher(() => ok({ org: 'test-org' }));
  const g = await tenantGuard(man('whoami --json', { list: false }), d.session as never, 'G');
  assert.match(g.state ?? '', /no canary and no list that needs no object/);
});

test('B2: the declared calls count against the write budget; a budget too small stops before the call is sent', async () => {
  const d = dispatcher(() => ok({ org: 'test-org' }), { budget: 2 });
  await assert.rejects(tenantGuard(man('whoami --json'), d.session as never, 'G'), (e) => e instanceof BudgetExhausted);
  assert.equal(d.st.n, 2, 'the third call was not sent');
});

test('B2: a failing first call says it was sent once (not "no write was made")', async () => {
  const d = dispatcher(() => err('boom'));
  await assert.rejects(tenantGuard(man('whoami --json'), d.session as never, 'G'), refused([/failed \(boom\)/, /was sent 1 time\(s\)/]));
});

test('B2 / S4: between checks, a declared guard call is never re-sent; tools/list is asked instead', async () => {
  const d = dispatcher(() => ok({ org: 'test-org' }));
  const calls: GuardCall[] = [];
  assert.equal(await targetStopped(man('flags create mws-guard'), d.session as never, 'G', { onCall: (c) => calls.push(c) }), null);
  assert.equal(d.st.n, 0, 'the declared call was not sent');
  assert.deepEqual(calls, []);
  assert.equal(d.listTools(), 1);
  // a server that stops answering tools/list is a stopped target
  const dead = { ...d.session, listTools: async () => { throw new WritecheckError('tools/list failed on G: closed', 4); } };
  assert.match((await targetStopped(man('flags create mws-guard'), dead as never, 'G')) ?? '', /tools\/list did not answer .*twice/);
});

test('B2: an annotated read-only guard re-read between checks is still recorded', async () => {
  const m = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: { tool: whoami, args: {}, path: org, pattern: "^test-" } }
resources:
  - name: flag
    create: { tool: exec, args: { command: "flags create {{marker}}" }, id: id }
    read: { tool: exec, args: { command: "flags get {{id}}" } }
    cleanup: delete
    delete: { tool: exec, args: { command: "flags delete {{id}}" } }
`,
    'm.yaml',
  );
  const d = dispatcher(() => ok({ org: 'test-org' }));
  const calls: GuardCall[] = [];
  assert.equal(await targetStopped(m, d.session as never, 'G', { onCall: (c) => calls.push(c) }), null);
  assert.deepEqual(calls.map((c) => [c.phase, c.basis]), [['alive', 'annotation']]);
  assert.equal(d.writes(), 0, 'a guard proven read-only is not counted as a write');
});
