/**
 * F1, F5, F6 (docs/CELLS.md): the cell universe, the applicability rules, the merge per tool, the duplicate rules (TB-B2-1,
 * TB-B2-2, the delete_ticket split across resources), evidence validity on violated records, and the pair budget.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applicability, cellPass, CELLS_SCENARIO, dedupe, inputRequiredTools, PER_TOOL_MUST, toolRoles } from '../../src/checks/cells.js';
import { pairsBudgetVerdicts } from '../../src/checks/pairs.js';
import { staleCheck } from '../../src/checks/stale.js';
import { wp, type Tool } from '../../src/checks/types.js';
import type { ExperimentOutcome } from '../../src/core/exec.js';
import { defaultWriteBudget, parseManifestText, PAIR_BUDGET } from '../../src/core/manifest.js';
import { validityOf } from '../../src/report/validity.js';
import { result, type Result } from '../../src/report/verdicts.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');
const ttFile = join(repo, 'examples', 'tiny-tracker', 'writecheck.yaml');
const tt = () => parseManifestText(readFileSync(ttFile, 'utf8'), ttFile);
/** tiny-tracker 0.1.0's catalog: names, argument names and annotations (descriptions left out). */
const TOOLS: Tool[] = [{"name": "list_projects", "inputSchema": {"type": "object", "properties": {}}, "annotations": {"readOnlyHint": true, "openWorldHint": false}}, {"name": "create_project", "inputSchema": {"type": "object", "properties": {"key": {}, "name": {}, "idempotency_key": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}}, {"name": "delete_project", "inputSchema": {"type": "object", "properties": {"key": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "list_tickets", "inputSchema": {"type": "object", "properties": {"project": {}, "status": {}, "title_prefix": {}}}, "annotations": {"readOnlyHint": true, "openWorldHint": false}}, {"name": "get_ticket", "inputSchema": {"type": "object", "properties": {"id": {}}}, "annotations": {"readOnlyHint": true, "openWorldHint": false}}, {"name": "create_ticket", "inputSchema": {"type": "object", "properties": {"project": {}, "title": {}, "status": {}, "assignee": {}, "priority": {}, "description": {}, "details": {}, "labels": {}, "idempotency_key": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}}, {"name": "update_ticket", "inputSchema": {"type": "object", "properties": {"id": {}, "title": {}, "status": {}, "assignee": {}, "priority": {}, "description": {}, "details": {}, "expected_version": {}, "force": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "replace_ticket", "inputSchema": {"type": "object", "properties": {"id": {}, "expected_version": {}, "title": {}, "status": {}, "assignee": {}, "priority": {}, "force": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "delete_ticket", "inputSchema": {"type": "object", "properties": {"id": {}, "expected_version": {}, "force": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "delete_tickets", "inputSchema": {"type": "object", "properties": {"project": {}, "status": {}, "title_prefix": {}, "all": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "close_ticket", "inputSchema": {"type": "object", "properties": {"id": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "bulk_update_tickets", "inputSchema": {"type": "object", "properties": {"project": {}, "ids": {}, "status": {}, "assignee": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "add_comment", "inputSchema": {"type": "object", "properties": {"id": {}, "body": {}, "idempotency_key": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}}, {"name": "add_label", "inputSchema": {"type": "object", "properties": {"id": {}, "name": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}}, {"name": "remove_label", "inputSchema": {"type": "object", "properties": {"id": {}, "label_id": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}, {"name": "set_labels", "inputSchema": {"type": "object", "properties": {"id": {}, "labels": {}, "expected_version": {}, "force": {}}}, "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false}}];
const WRITE_TOOLS = ['create_project', 'delete_project', 'create_ticket', 'update_ticket', 'replace_ticket', 'delete_ticket', 'delete_tickets', 'close_ticket', 'bulk_update_tickets', 'add_comment', 'add_label', 'remove_label', 'set_labels'];
const sc = { id: 'x', version: '1' };

test('F1: the cell universe is the 23 per-tool MUST requirements on each declared write tool; read tools are not cells', () => {
  assert.equal(PER_TOOL_MUST.length, 23);
  const roles = toolRoles(tt(), TOOLS);
  assert.deepEqual([...roles.keys()].sort(), [...WRITE_TOOLS].sort());
  const { results, cells } = cellPass(tt(), TOOLS, [], { stopped: null });
  assert.equal(cells.filter((c) => c.scope === 'tool').length, 13 * 23);
  assert.equal(cells.filter((c) => c.scope === 'server').length, 3);
  assert.ok(!cells.some((c) => ['get_ticket', 'list_tickets', 'list_projects'].includes(c.tool)));
  // Every cell has at least one record, and every record of a cell names it.
  for (const c of cells) {
    assert.ok(c.records.length >= 1, c.key);
    for (const i of c.records) assert.equal(results[i]!.cell, c.key);
  }
  // An added record is not applicable with its rule, or not tested.
  for (const r of results) assert.equal(r.scenario.id, CELLS_SCENARIO.id);
  const na = cells.filter((c) => !c.applicable);
  assert.ok(na.every((c) => c.rule && /applicability rule/.test(c.reason)), 'every not-applicable cell carries its rule');
});

test('F1: applicability rules on tiny-tracker (roles from the declaration and the catalog)', () => {
  const roles = toolRoles(tt(), TOOLS);
  const ap = (req: Parameters<typeof applicability>[0], tool: string) => applicability(req, roles.get(tool)!, new Set())?.rule ?? 'applies';
  assert.equal(ap('MWS-UPD-1', 'create_ticket'), 'UPD-1.create');
  assert.equal(ap('MWS-UPD-1', 'delete_ticket'), 'UPD-1.delete');
  assert.equal(ap('MWS-UPD-1', 'replace_ticket'), 'UPD-1.replace');
  assert.equal(ap('MWS-UPD-1', 'add_label'), 'applies', 'a tool with no declared role is in doubt, so it applies');
  assert.equal(ap('MWS-UPD-1', 'bulk_update_tickets'), 'applies');
  assert.equal(ap('MWS-UPD-2', 'remove_label'), 'applies');
  assert.equal(ap('MWS-UPD-2', 'set_labels'), 'UPD-2.no-address');
  assert.equal(ap('MWS-CONC-2', 'delete_project'), 'applies', 'a delete with no version check still applies (rows 3 and 4)');
  assert.equal(ap('MWS-CONC-2', 'set_labels'), 'applies');
  assert.equal(ap('MWS-CONC-2', 'close_ticket'), 'CONC-2.no-version');
  assert.equal(ap('MWS-CONC-2', 'create_project'), 'CONC-2.create');
  assert.equal(ap('MWS-CONC-3', 'delete_tickets'), 'CONC-3.delete');
  assert.equal(ap('MWS-TGT-1', 'create_ticket'), 'applies');
  assert.equal(ap('MWS-TGT-1', 'update_ticket'), 'TGT-1.no-scope');
  assert.equal(ap('MWS-TGT-2', 'delete_tickets'), 'applies');
  assert.equal(ap('MWS-TGT-3', 'create_project'), 'applies');
  assert.equal(ap('MWS-TGT-3', 'create_ticket'), 'TGT-3.server-id');
  assert.equal(ap('MWS-RES-3', 'add_comment'), 'applies');
  assert.equal(ap('MWS-RES-3', 'update_ticket'), 'RES-3.not-create');
  assert.equal(ap('MWS-ATOM-1', 'bulk_update_tickets'), 'applies');
  assert.equal(ap('MWS-ATOM-1', 'update_ticket'), 'ATOM-1.single');
  assert.equal(ap('MWS-RETRY-2', 'add_comment'), 'applies');
  assert.equal(ap('MWS-RETRY-2', 'create_ticket'), 'applies');
  assert.equal(ap('MWS-RETRY-2', 'update_ticket'), 'RETRY-2.no-key');
  assert.equal(ap('MWS-RETRY-3', 'close_ticket'), 'applies');
  assert.equal(ap('MWS-RETRY-3', 'add_label'), 'RETRY-3.no-input');
  assert.equal(applicability('MWS-RETRY-3', roles.get('add_label')!, new Set(['add_label'])), null, 'a tool seen answering input_required applies');
  assert.equal(ap('MWS-ANN-2', 'add_label'), 'applies');
  assert.equal(ap('MWS-ANN-1', 'add_label'), 'ANN-1.hint');
  for (const t of WRITE_TOOLS) for (const q of ['MWS-RES-1', 'MWS-RES-2', 'MWS-SEC-1', 'MWS-IN-1'] as const) assert.equal(ap(q, t), 'applies', `${q} on ${t}`);
});

test('F1: cells merge per tool across resources: delete_ticket held under ticket, not tested under ticket-replace, is one held cell', () => {
  const recs = [
    result('MWS-CONC-2', wp('ticket', 'delete_ticket'), { id: 'stale-write', version: '4' }, 'held', 'refused in 3 of 3'),
    result('MWS-CONC-2', wp('ticket-replace', 'delete_ticket'), { id: 'stale-write', version: '4' }, 'not tested', "delete_ticket's arguments in the manifest carry no {{version}}"),
  ];
  const { cells } = cellPass(tt(), TOOLS, recs, { stopped: null });
  const c = cells.find((x) => x.key === 'MWS-CONC-2@delete_ticket')!;
  assert.equal(c.verdict, 'held');
  assert.deepEqual(c.resources.sort(), ['ticket', 'ticket-replace']);
  assert.equal(c.records.length, 2);
});

test('F1: TB-B2-1 (t11): a record written twice word for word is kept once', () => {
  const r = result('MWS-IN-2', wp('item', 'execute'), { id: 'schema-probes', version: '1' }, 'held', 'refused', { steps: ['a'] });
  assert.equal(dedupe([r, { ...r }, { ...r, reason: 'other' }]).length, 2);
  const { results } = cellPass(tt(), TOOLS, [r, structuredClone(r)], { stopped: null });
  assert.equal(results.filter((x) => x.requirement === 'MWS-IN-2' && x.write_path.tool === 'execute').length, 1);
});

test('F1: TB-B2-2 (t23): not applicable from a check beats not tested on the same write path; another resource\'s not tested stands', () => {
  const na = result('MWS-CONC-2', wp('ticket', 'add_label'), { id: 'stale-write', version: '4' }, 'not applicable', 'a field_patch update with no version argument');
  const ntSame = result('MWS-CONC-2', wp('ticket', 'add_label'), { id: 'stale-write', version: '4' }, 'not tested', 'the declaration states that the backend has no version check');
  const ntOther = result('MWS-CONC-2', wp('ticket-replace', 'add_label'), { id: 'stale-write', version: '4' }, 'not tested', 'needs scratch objects');
  assert.equal(cellPass(tt(), TOOLS, [na, ntSame], { stopped: null }).cells.find((c) => c.key === 'MWS-CONC-2@add_label')!.verdict, 'not applicable');
  assert.equal(cellPass(tt(), TOOLS, [na, ntOther], { stopped: null }).cells.find((c) => c.key === 'MWS-CONC-2@add_label')!.verdict, 'not tested');
  // A generic coverage row never outweighs a rule: IN on a tool with no arguments is not applicable.
  const m = tt();
  const noArgs = TOOLS.map((t) => (t.name === 'add_label' ? { ...t, inputSchema: { type: 'object', properties: {} } } : t));
  const cov = result('MWS-IN-1', wp('ticket', 'add_label'), { id: 'coverage', version: '1' }, 'not tested', 'not built in this preview');
  const c = cellPass(m, noArgs, [cov], { stopped: null }).cells.find((x) => x.key === 'MWS-IN-1@add_label')!;
  assert.equal(c.verdict, 'not applicable');
  assert.equal(c.rule, 'IN.no-args');
});

test('F1: TB-B2-2 at the source: stale.ts gives one record (not applicable) for a versionless update tool also listed in no_version_check', () => {
  const m = parseManifestText(
    `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: item
    create: { tool: create, args: { name: "{{marker}}" }, id: id }
    read: { tool: get, args: { id: "{{id}}" } }
    update: { tool: update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [{ path: a, values: [x, y] }, { path: b, values: [x, y] }]
    no_version_check: [update]
    delete: { tool: remove, args: { id: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const p = staleCheck.plan({ manifest: m, tools: [] }, m.resources[0]!);
  const conc2 = p.notRun.filter((r) => r.requirement === 'MWS-CONC-2' && r.write_path.tool === 'update');
  assert.deepEqual(conc2.map((r) => r.verdict), ['not applicable']);
});

test('F1: server-level requirements are one cell each on (server); a record on a setting lands there', () => {
  const r = result('MWS-CFG-1', { resource: '(server)', tool: 'TRACKER_READ_ONLY', arm: 'mcp' }, sc, 'held', 'refused');
  const { cells } = cellPass(tt(), TOOLS, [r], { stopped: null });
  assert.equal(cells.find((c) => c.key === 'MWS-CFG-1@(server)')!.verdict, 'held');
  assert.equal(cells.find((c) => c.key === 'MWS-CFG-2@(server)')!.verdict, 'not tested');
});

test('F1: the run-wide "(declaration)" row of a per-tool MUST requirement gives way to its cells', () => {
  const decl = result('MWS-UPD-2', { resource: '(declaration)', tool: '(none)', arm: 'mcp' }, { id: 'coverage', version: '1' }, 'not tested', 'no record');
  const { results } = cellPass(tt(), TOOLS, [decl], { stopped: null });
  assert.ok(!results.some((r) => r.write_path.resource === '(declaration)'));
});

test('F1: input_required tools are read from the mcp record', () => {
  assert.deepEqual(inputRequiredTools({ input_requests: [{ tool: 'close_ticket' }, { tool: 'close_ticket' }, { x: 1 }] }), ['close_ticket']);
  assert.deepEqual(inputRequiredTools(undefined), []);
});

test('F6: validity rules on violated records', () => {
  const v = (r: Result, stopped: string | null = null) => validityOf(r, { stopped });
  const ok = result('MWS-RETRY-2', wp('ticket', 'create_ticket'), sc, 'violated', 'twice', { steps: ['s1'] });
  assert.deepEqual([v(ok).class, v(ok).counts, v(ok).failed], ['valid', true, []]);
  const noSteps = result('MWS-RETRY-2', wp('ticket', 'create_ticket'), sc, 'violated', 'twice');
  assert.deepEqual([v(noSteps).class, v(noSteps).counts, v(noSteps).failed], ['harness-suspect', false, ['V-STEPS']]);
  assert.deepEqual(v(ok, 'the write budget ran out').failed, ['V-RUN']);
  const unresolved = result('MWS-UPD-1', wp('ticket', 'update_ticket'), sc, 'violated', 'moved', { steps: ['s'] });
  assert.equal(unresolved.attribution, 'unresolved');
  assert.deepEqual([v(unresolved).class, v(unresolved).counts], ['platform', true]);
  const pairsBad = result('MWS-CONC-3', wp('ticket', 'update_ticket'), { id: 'barrier-pairs', version: '1' }, 'violated', 'lost', { steps: ['s'], numbers: { both_ok: 0, lost: 1 }, attribution: 'server' });
  assert.deepEqual(v(pairsBad).failed, ['V-ACK']);
  const stated = result('MWS-RES-1', wp('ticket', 'update_ticket'), sc, 'violated', 'x', { steps: ['s'], attribution: 'server', evidence: { read_back: false } });
  assert.deepEqual(v(stated).failed, ['V-READBACK']);
  const synth = result('MWS-RES-2', wp('ticket', 'update_ticket'), { id: 'held-request', version: '1' }, 'violated', 'said ok', { steps: ['s'] });
  assert.deepEqual([v(synth).class, v(synth).synthetic_fault], ['valid', true]);
  // The cell pass stamps validity on violated records only, and a cell carries the best class of its violated records.
  const { results, cells } = cellPass(tt(), TOOLS, [noSteps, ok, result('MWS-RES-1', wp('ticket', 'create_ticket'), sc, 'held', 'h')], { stopped: null });
  assert.ok(results.filter((r) => r.verdict === 'violated').every((r) => r.validity));
  assert.ok(results.filter((r) => r.verdict !== 'violated').every((r) => !r.validity));
  assert.equal(cells.find((c) => c.key === 'MWS-RETRY-2@create_ticket')!.validity, 'valid');
});

const outcome = (o: { valid: number; overlapped: number; lost?: number; stopped?: string }): ExperimentOutcome =>
  ({ experiment: { arms: [], vars: {} }, arms: { validity: { counts: { valid: 1, both_kept: 1 }, reps: [] }, test: { counts: { valid: o.valid, overlapped: o.overlapped, silent_loss: o.lost ?? 0, both_ok: o.valid, one_error: 0 }, reps: [] } }, stopped: o.stopped ?? null }) as unknown as ExperimentOutcome;

test('F5: barrier pairs judged against the pair budget', () => {
  const res = tt().resources.find((r) => r.name === 'ticket')!;
  const budget = { repeats: 2, pairs: 1500 };
  const below = pairsBudgetVerdicts([outcome({ valid: 40, overlapped: 40 })], res, true, budget)[0]!;
  assert.equal(below.verdict, 'not observed');
  assert.match(below.reason, /^Not observed, below the pair budget \(40 of 2 × 1500 pairs run\)/);
  assert.equal(below.numbers['budget_met'], false);
  const full = pairsBudgetVerdicts([outcome({ valid: 1500, overlapped: 1490 }), outcome({ valid: 1500, overlapped: 1495 })], res, true, budget)[0]!;
  assert.equal(full.verdict, 'not observed');
  assert.match(full.reason, /^Not observed at the full pair budget \(2 × 1500 pairs\)/);
  assert.equal(full.numbers['pairs'], 3000);
  assert.equal(full.numbers['pairs_overlapped'], 2985);
  assert.equal(full.numbers['budget_met'], true);
  const lost = pairsBudgetVerdicts([outcome({ valid: 1500, overlapped: 1500 }), outcome({ valid: 1500, overlapped: 1500, lost: 1 })], res, false, budget)[0]!;
  assert.equal(lost.verdict, 'violated');
  assert.equal(lost.numbers['repeat'], 2);
  const stopped = pairsBudgetVerdicts([outcome({ valid: 1500, overlapped: 1500 }), outcome({ valid: 3, overlapped: 3, stopped: 'the write budget ran out' })], res, false, budget)[0]!;
  assert.equal(stopped.verdict, 'not tested', 'a stopped repeat gives not tested, never a partial result');
});

test('F5: limits: the pair budget defaults to 2 × 1500, a declared pairs keeps one repeat, and write_budget is sized to fit', () => {
  const base = `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: item
    create: { tool: create, args: { name: "{{marker}}" }, id: id }
    read: { tool: get, args: { id: "{{id}}" } }
    update: { tool: update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [{ path: a, values: [x, y] }, { path: b, values: [x, y] }]
`;
  const d = parseManifestText(base, 'm.yaml');
  assert.deepEqual(d.limits.pair_budget, { ...PAIR_BUDGET });
  assert.equal(d.limits.pairs, 1500);
  assert.equal(d.limits.pair_repeats, 2);
  assert.equal(d.limits.write_budget, defaultWriteBudget(d.resources, 1500, 2));
  assert.equal(d.limits.write_budget, 1000 + 2 * 1501 * 4);
  assert.ok(d.limits.write_budget >= 2 * 1500 * 4, 'the default budget fits the pairs');
  const declared = parseManifestText(base + 'limits: { pairs: 40, write_budget: 900 }\n', 'm.yaml');
  assert.deepEqual([declared.limits.pairs, declared.limits.pair_repeats, declared.limits.write_budget], [40, 1, 900]);
  const custom = parseManifestText(base + 'limits: { pair_budget: { repeats: 3, pairs: 500 } }\n', 'm.yaml');
  assert.deepEqual([custom.limits.pairs, custom.limits.pair_repeats], [500, 3]);
  assert.throws(() => parseManifestText(base + 'limits: { pair_budget: { reps: 3 } }\n', 'm.yaml'));
});
