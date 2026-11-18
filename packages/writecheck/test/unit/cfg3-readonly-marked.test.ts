/**
 * MWS-CFG-3 ("In read-only mode a server MUST refuse every call to a write tool, whatever that tool's annotations declare"):
 * a tool marked read-only that has an entry in the manifest's `calls` is called in read-only mode (and under a CFG-2 deny-list)
 * with that entry's arguments, as the annotation checks call it. A batch run found a read-only-marked query tool that changed
 * the object under MWS-ANN-1 and was never tried in read-only mode. A change through such a tool is violated; no change counts
 * toward held, because the tool is a read unless it writes. A read-only-marked tool with no `calls` entry is not called.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { declaredWriteTools, readOnlyMarkedCalls } from '../../src/checks/coverage.js';
import { launchCheck, launchVerdicts } from '../../src/checks/launch.js';
import type { Tool } from '../../src/checks/types.js';
import { parseManifestText } from '../../src/core/manifest.js';

const M = (calls: string, settings = 'settings: { read_only: { env: RO, on: "true", valid: { "true": restrict, "false": permit } }, tool_filters: [ { env: DENY, kind: deny } ] }') =>
  parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
${settings}
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{prefix}}t" }, id: id }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
${calls}`,
    'm.yaml',
  );

const RO = { readOnlyHint: true };
const TOOLS: Tool[] = [
  { name: 'whoami', annotations: RO },
  { name: 'ticket_get', annotations: RO },
  { name: 'ticket_query', annotations: RO },
  { name: 'ticket_count', annotations: RO },
  { name: 'ticket_peek', annotations: RO },
  { name: 'ticket_create', annotations: { readOnlyHint: false } },
  { name: 'ticket_update', annotations: { readOnlyHint: false } },
  { name: 'ticket_delete', annotations: { readOnlyHint: false } },
  { name: 'ticket_tag', annotations: { readOnlyHint: false } },
] as Tool[];

const CALLS = `calls:
  ticket_query: { resource: ticket, args: { id: "{{id}}", stages: [ { set: { status: closed } } ] } }
  ticket_count: { args: { prefix: "{{prefix}}" } }
  whoami: { args: {} }
  ticket_tag: { resource: ticket, args: { id: "{{id}}", tag: x } }
`;

test('the tools marked read-only that have a calls entry naming the run\'s objects are listed for the launch checks, apart from the declared write tools', () => {
  const m = M(CALLS);
  const marked = readOnlyMarkedCalls(m, TOOLS);
  assert.deepEqual([...marked.keys()], ['ticket_query', 'ticket_count']);
  assert.equal(marked.get('ticket_query'), 'annotated readOnlyHint: true');
  // whoami: its arguments name no object of the run (no safe call); ticket_peek: no calls entry; ticket_tag: a declared write tool.
  const declared = declaredWriteTools(m, TOOLS);
  assert.ok(declared.has('ticket_tag'));
  assert.ok(!declared.has('ticket_query') && !declared.has('ticket_count'), 'the coverage rows and other checks keep their list');
});

test('the plan names the extra tools on the CFG-3 and CFG-2 lines, and is unchanged for a manifest without them', () => {
  const lines = launchCheck.plan({ manifest: M(CALLS), tools: TOOLS }).calls;
  const cfg3 = lines.find((l) => l.startsWith('MWS-CFG-3'))!;
  const cfg2 = lines.find((l) => l.startsWith('MWS-CFG-2'))!;
  assert.match(cfg3, /each tool marked read-only that has a calls entry \(ticket_query, ticket_count\)/);
  assert.match(cfg2, /ticket_query, ticket_count/);
  assert.doesNotMatch(lines.find((l) => l.startsWith('MWS-CFG-1'))!, /ticket_query/, 'CFG-1 compares the declared write tools only');
  const plain = launchCheck.plan({ manifest: M('calls:\n  whoami: { args: {} }\n  ticket_tag: { args: { id: "{{id}}" } }\n'), tools: TOOLS }).calls;
  assert.ok(plain.includes('MWS-CFG-3: start with RO=true; call every declared write tool on objects created before the restart; read back'), plain.join(' | '));
  assert.ok(plain.includes('MWS-CFG-2: start with DENY (deny-list) naming one misspelled tool; if it starts, a write probe'), plain.join(' | '));
});

const refused = (tool: string) => ({ tool, absent: false, ok: false, effect: null, step: 's', observed: true });
const marked = (o: Record<string, unknown>) => ({ tool: 'ticket_query', absent: false, ok: true, effect: null, step: 'q', observed: true, marked: 'annotated readOnlyHint: true', ...o });
const cfg3 = (calls: unknown[]) => launchVerdicts({ baseline: { started: true, reason: null }, cfg1: null, cfg2: [], cfg3: { env: 'RO', started: true, reason: null, calls } } as never).find((r) => r.requirement === 'MWS-CFG-3')!;
const cfg2 = (calls: unknown[]) => launchVerdicts({ baseline: { started: true, reason: null }, cfg1: null, cfg2: [{ env: 'DENY', kind: 'deny', value: 'x', started: true, reason: null, calls }], cfg3: null } as never).find((r) => r.requirement === 'MWS-CFG-2')!;

test('MWS-CFG-3: a tool marked read-only that writes in read-only mode is violated; the record names it, says it is marked read-only, and gives the change', () => {
  const v = cfg3([refused('ticket_update'), refused('ticket_delete'), marked({ effect: 'status' })]);
  assert.equal(v.verdict, 'violated', v.reason);
  assert.match(v.reason, /ticket_query \(marked read-only: annotated readOnlyHint: true\) still wrote \(status\)/);
  assert.match(v.reason, /whatever its annotations declare/);
  assert.deepEqual(v.steps, ['q']);
  assert.ok(v.notes.some((n) => /^ticket_query \(marked read-only: annotated readOnlyHint: true\): listed; answered as a success; changed status$/.test(n)), v.notes.join(' | '));
  // An error answer that still wrote is the same violation.
  assert.equal(cfg3([refused('ticket_update'), marked({ ok: false, effect: 'status' })]).verdict, 'violated');
});

test('MWS-CFG-3: a tool marked read-only that changes nothing counts toward held, even answered as a success', () => {
  const v = cfg3([refused('ticket_update'), refused('ticket_delete'), marked({})]);
  assert.equal(v.verdict, 'held', v.reason);
  assert.match(v.reason, /every declared write tool \(2\) was absent or refused/);
  assert.match(v.reason, /ticket_query changed nothing on read-back/);
  assert.ok(v.notes.some((n) => /ticket_query \(marked read-only: annotated readOnlyHint: true\): listed; answered as a success; no change on read-back/.test(n)), v.notes.join(' | '));
  // Refused, or not called (its scratch object could not be made): still no write seen through it, and the record says so.
  assert.equal(cfg3([refused('ticket_update'), marked({ ok: false })]).verdict, 'held');
  const nc = cfg3([refused('ticket_update'), marked({ step: null, skipped: 'scratch object: no create' })]);
  assert.equal(nc.verdict, 'held');
  assert.match(nc.reason, /ticket_query could not be called or read back/);
});

test('MWS-CFG-3: a genuine write tool answered as a success with no change still leaves the record not tested', () => {
  const v = cfg3([{ tool: 'ticket_update', absent: false, ok: true, effect: null, step: 's', observed: true }, marked({})]);
  assert.equal(v.verdict, 'not tested');
  assert.match(v.reason, /ticket_update was answered as a success/);
  assert.doesNotMatch(v.reason, /ticket_query was answered/, 'the read-only-marked tool is not what keeps it open');
  // With no declared write tool to call, the record stays not tested whatever the marked tools did (spec: held is about the write tools).
  assert.equal(cfg3([marked({})]).verdict, 'not tested');
  assert.equal(cfg3([marked({ effect: 'status' })]).verdict, 'violated');
});

test('MWS-CFG-2: under a deny-list, a write through a tool marked read-only is violated, and no change counts toward held', () => {
  const bad = cfg2([refused('ticket_update'), marked({ effect: 'status' })]);
  assert.equal(bad.verdict, 'violated');
  assert.match(bad.reason, /ticket_query \(marked read-only: annotated readOnlyHint: true\) still wrote \(status\)/);
  const ok = cfg2([refused('ticket_update'), marked({})]);
  assert.equal(ok.verdict, 'held', ok.reason);
  assert.match(ok.reason, /every declared write tool \(1\)/);
  const open = cfg2([{ tool: 'ticket_update', absent: false, ok: true, effect: null, step: 's' }, marked({})]);
  assert.equal(open.verdict, 'not tested');
  assert.doesNotMatch(open.reason, /ticket_query/);
});
