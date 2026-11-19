/**
 * F1, F5, F6 (docs/CELLS.md): the cell universe, the applicability rules, the merge per tool, the duplicate rules (TB-B2-1,
 * TB-B2-2, the delete_ticket split across resources), evidence validity on violated records, and the pair budget.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readdirSync } from 'node:fs';

import { applicability, cellPass, CELLS_SCENARIO, dedupe, inputRequiredTools, PER_TOOL_MUST, toolRoles } from '../../src/checks/cells.js';
import { buildPlan, durationText, planHash, renderPlan } from '../../src/core/plan.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import type { ResultsDoc } from '../../src/report/results.js';
import { cutShortOf, STEPS_EXEMPT, SYNTHETIC_SCENARIO } from '../../src/report/validity.js';
import { withLoss } from '../../src/checks/targeting.js';
import { pairsBudgetVerdicts } from '../../src/checks/pairs.js';
import { staleCheck } from '../../src/checks/stale.js';
import { wp, type Tool } from '../../src/checks/types.js';
import type { ExperimentOutcome } from '../../src/core/exec.js';
import { defaultWriteBudget, parseManifestText, parsePairBudget, PAIR_BUDGET } from '../../src/core/manifest.js';
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
  assert.deepEqual(v(ok, 'stopped: create_ticket would exceed the write budget of 500').failed, ['V-RUN']);
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

const MINI = `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: item
    create: { tool: create, args: { name: "{{marker}}" }, id: id }
    read: { tool: get, args: { id: "{{id}}" } }
    update: { tool: update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [{ path: a, values: [x, y] }, { path: b, values: [x, y] }]
`;

test('F5 (review S2): the pair budget is opt-in; undeclared limits are as before, so the plan hash does not move', () => {
  const d = parseManifestText(MINI, 'm.yaml');
  assert.deepEqual(d.limits, { write_budget: 500, writes_per_second: 5, pairs: 40, stale_reps: 3, gate_reps: 2, timeout_ms: 30_000, max_fuzz_cases: 200 }, 'exactly the old keys and defaults');
  const declared = parseManifestText(MINI + 'limits: { pairs: 40, write_budget: 900 }\n', 'm.yaml');
  assert.deepEqual([declared.limits.pairs, declared.limits.pair_repeats, declared.limits.write_budget], [40, undefined, 900]);
  const opted = parseManifestText(MINI + 'limits: { pair_budget: { repeats: 2, pairs: 1500 } }\n', 'm.yaml');
  assert.deepEqual([opted.limits.pairs, opted.limits.pair_repeats, opted.limits.pair_budget], [1500, 2, { ...PAIR_BUDGET }]);
  assert.equal(opted.limits.write_budget, 1000 + 2 * 1501 * 4, 'the write budget is sized to fit a declared pair budget');
  assert.equal(opted.limits.write_budget, defaultWriteBudget(opted.resources, 1500, 2));
  const flag = parseManifestText(MINI, 'm.yaml', { pairBudget: parsePairBudget('3x500') });
  assert.deepEqual([flag.limits.pairs, flag.limits.pair_repeats, flag.limits.pair_budget], [500, 3, { repeats: 3, pairs: 500 }], '--pair-budget acts as the declaration');
  assert.throws(() => parsePairBudget('1500'), /repeats x pairs/);
  assert.throws(() => parseManifestText(MINI + 'limits: { pair_budget: { reps: 3 } }\n', 'm.yaml'));
  // The plan hash of tiny-tracker (which declares pairs: 40 and no budget) is the same with or without this change's keys.
  const t = tt();
  assert.equal(t.limits.pair_budget, undefined);
  assert.equal(t.limits.pair_repeats, undefined);
  const withFlag = parseManifestText(readFileSync(ttFile, 'utf8'), ttFile, { pairBudget: { repeats: 2, pairs: 1500 } });
  assert.notEqual(planHash(buildPlan(t, TOOLS)), planHash(buildPlan(withFlag, TOOLS)), 'the budget enters the hash');
  assert.match(renderPlan(buildPlan(withFlag, TOOLS), 'h'), /Estimated time for the writes at 1000 per second: .*Pair budget 2 × 1500: a target with a rate limit may answer 429/);
  assert.match(renderPlan(buildPlan(parseManifestText(MINI + 'limits: { pair_budget: { repeats: 2, pairs: 1500 } }\n', 'm.yaml'), []), 'h'), /Estimated time for the writes at 5 per second: about \d+ (s|min) at most/);
  assert.deepEqual([durationText(30), durationText(600), durationText(5400)], ['about 30 s', 'about 10 min', 'about 1 h 30 min']);
});

test('F5 (review S2): with no budget and one repeat the pairs record is exactly as before', () => {
  const res = tt().resources.find((r) => r.name === 'ticket')!;
  const [r] = pairsBudgetVerdicts([outcome({ valid: 40, overlapped: 40 })], res, true, null);
  assert.match(r!.reason, /^No lost update in 40 simultaneous pairs/);
  assert.equal(r!.numbers['pair_budget'], undefined);
});

test('F6 (review B1): only a cut-short stop (write budget, 429, interrupt) fails V-RUN; clean-up, fixture and bystander stops do not', () => {
  assert.equal(cutShortOf(null), null);
  assert.ok(cutShortOf('stopped: update_ticket would exceed the write budget of 500'));
  assert.ok(cutShortOf('stopped: the target answered 429 (rate limited) to x; nothing after it was run'));
  assert.ok(cutShortOf('interrupted by SIGINT'));
  assert.ok(cutShortOf('the fixture x could not be put back as it was; stopped: y would exceed the write budget of 9'), 'a top-level cut-short part after another part');
  for (const st of ['clean-up did not finish: delete failed; objects of this run may be left behind', 'the fixture ticket could not be put back as it was', "objects the tester did not create were lost outside any check's records (x)"]) {
    const r = result('MWS-UPD-1', wp('ticket', 'update_ticket'), sc, 'violated', 'lost field', { steps: ['s1'], attribution: 'server' });
    const v = validityOf(r, { stopped: st });
    assert.deepEqual([v.class, v.counts, v.failed], ['valid', true, []], st);
    assert.deepEqual(cellPass(tt(), TOOLS, [r], { stopped: st }).cells.find((c) => c.key === 'MWS-UPD-1@update_ticket')!.validity, 'valid');
  }
  const r = result('MWS-UPD-1', wp('ticket', 'update_ticket'), sc, 'violated', 'lost field', { steps: ['s1'], attribution: 'server' });
  assert.deepEqual(validityOf(r, { stopped: 'stopped: x would exceed the write budget of 500' }).failed, ['V-RUN']);
});

test('F6 (review B2): every violated producer in src/checks sets steps or is a listed exemption (catalog, launch, ledger facts)', () => {
  const dir = join(here, '..', '..', '..', 'src', 'checks');
  const scenarioOf: Record<string, string> = { 'catalog.ts': 'catalog', 'launch.ts': 'launch-settings', 'annotations.ts': 'annotation-effects' };
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      const m = /(?:result|add)\('(MWS-[A-Z]+-\d+)'[^;]*?'violated',/.exec(line);
      if (!m || /\bsteps\b/.test(line)) return;
      if (STEPS_EXEMPT.some((e) => e.requirement === m[1] && e.scenario === scenarioOf[f])) return;
      bad.push(`${f}:${i + 1} ${m[1]}`);
    });
  }
  assert.deepEqual(bad, []);
  // An exempt record keeps counting and names where its evidence is; the same record in another scenario does not.
  const ann4 = result('MWS-ANN-4', wp('(catalog)', 'add_label'), { id: 'catalog', version: '1' }, 'violated', 'no hint');
  assert.deepEqual([validityOf(ann4, { stopped: null }).class, validityOf(ann4, { stopped: null }).evidence.basis], ['valid', STEPS_EXEMPT[0]!.basis]);
  const cfg4 = result('MWS-CFG-4', wp('(server)', 'X_TOOLS'), { id: 'launch-settings', version: '1' }, 'violated', 'started');
  assert.equal(validityOf(cfg4, { stopped: null }).class, 'valid');
  const ann1 = result('MWS-ANN-1', wp('ticket', 'create_x'), { id: 'annotation-effects', version: '1' }, 'violated', 'created');
  assert.equal(validityOf(ann1, { stopped: null }).class, 'valid');
  const other = result('MWS-ANN-1', wp('ticket', 'create_x'), { id: 'annotations', version: '1' }, 'violated', 'created');
  assert.deepEqual(validityOf(other, { stopped: null }).failed, ['V-STEPS']);
});

test('F6 (F4 scenarios): injected-fault scenarios are synthetic; a cut answer (unknown outcome) is not', () => {
  for (const id of ['held-request', 'write-faults', 'multi-item.res2']) assert.ok(SYNTHETIC_SCENARIO.test(id), id);
  for (const id of ['held-request.unknown-outcome', 'write-faults.unknown-outcome', 'creates']) assert.ok(!SYNTHETIC_SCENARIO.test(id), id);
  const v = (id: string) => validityOf(result('MWS-RES-2', wp('ticket', 'add_label'), { id, version: '1' }, 'violated', 'said ok', { steps: ['s'] }), { stopped: null }).synthetic_fault;
  assert.deepEqual([v('write-faults'), v('multi-item.res2'), v('held-request.unknown-outcome')], [true, true, false]);
});

test('F1 (review B3): a tool the declaration gives a write role keeps its cells even when it declares readOnlyHint: true', () => {
  const lying = TOOLS.map((t) => (t.name === 'update_ticket' ? { ...t, annotations: { readOnlyHint: true } } : t));
  const r = result('MWS-UPD-1', wp('ticket', 'update_ticket'), sc, 'violated', 'lost field', { steps: ['s1'], attribution: 'server' });
  const { results, cells } = cellPass(tt(), lying, [r], { stopped: null });
  assert.equal(results[0]!.cell, 'MWS-UPD-1@update_ticket');
  assert.equal(cells.filter((c) => c.tool === 'update_ticket').length, 23);
  assert.equal(cells.find((c) => c.key === 'MWS-UPD-1@update_ticket')!.verdict, 'violated');
  // A read tool stays out of the cells.
  assert.ok(!cells.some((c) => c.tool === 'get_ticket'));
});

test('F1 (review S1): the schema decides in doubt: a version-like or scope-like argument makes CONC-2, CONC-4 and TGT-1 apply', () => {
  const m = tt();
  for (const r of m.resources) {
    r.version = null;
    r.versioned = [];
  }
  const roles = toolRoles(m, TOOLS);
  assert.equal(applicability('MWS-CONC-2', roles.get('update_ticket')!, new Set()), null, 'expected_version in the schema');
  assert.equal(applicability('MWS-CONC-4', roles.get('update_ticket')!, new Set()), null);
  assert.equal(applicability('MWS-CONC-2', roles.get('close_ticket')!, new Set())?.rule, 'CONC-2.no-version', 'close_ticket takes only an id');
  const ws = TOOLS.map((t) => (t.name === 'add_label' ? { ...t, inputSchema: { type: 'object', properties: { id: {}, name: {}, workspace_id: {} } } } : t));
  assert.equal(applicability('MWS-TGT-1', toolRoles(tt(), ws).get('add_label')!, new Set()), null, 'workspace_id names a container');
  assert.equal(applicability('MWS-TGT-1', toolRoles(tt(), TOOLS).get('add_label')!, new Set())?.rule, 'TGT-1.no-scope');
});

test('F1 (review M1): a violated record whose evidence does not count ranks below held; alone, the cell is violated and marked', () => {
  const suspect = result('MWS-CONC-1', wp('ticket', 'update_ticket'), { id: 'held-request', version: '1' }, 'violated', 'went over');
  const held = result('MWS-CONC-1', wp('ticket-replace', 'update_ticket'), { id: 'stale-write', version: '4' }, 'held', 'refused', { steps: ['s'] });
  const both = cellPass(tt(), TOOLS, [suspect, held], { stopped: null }).cells.find((c) => c.key === 'MWS-CONC-1@update_ticket')!;
  assert.deepEqual([both.verdict, both.validity], ['held', undefined]);
  const alone = cellPass(tt(), TOOLS, [suspect], { stopped: null });
  const c = alone.cells.find((x) => x.key === 'MWS-CONC-1@update_ticket')!;
  assert.deepEqual([c.verdict, c.validity], ['violated', 'harness-suspect']);
  const counted = result('MWS-CONC-1', wp('ticket', 'update_ticket'), { id: 'stale-write', version: '4' }, 'violated', 'x', { steps: ['s'] });
  assert.equal(cellPass(tt(), TOOLS, [held, counted], { stopped: null }).cells.find((x) => x.key === 'MWS-CONC-1@update_ticket')!.verdict, 'violated');
  // review M5: the report marks such a cell V?.
  const doc = { format: 'mws-results/1', scope: 's', suite: { name: 'x', version: '0' }, spec: { version: '0.9' }, run: { id: 'r', prefix: 'p', started: 'a', ended: 'b', status: 'complete', stopped_reason: null, writes: 0, processes_started: 0 }, target: { confirm: 't', environment: 'test', server: 's', catalog_fingerprint: 'f', guard: null }, manifest: { path: 'manifest.yaml', sha256: 'x' }, plan: { hash: 'h' }, results: alone.results, cells: alone.cells, not_built: [], measurements: null, leftovers: [], cleanup: null, observations: [], evidence: { capture: null, checksums: 'SHA256SUMS', signature: null }, safety: { canaries: [], fixtures_restored: [], gate: null, protocol: null, rerun_of: null } } as unknown as ResultsDoc;
  assert.match(renderMarkdown(doc), /\| update_ticket \|[^\n]*\| V\? \|/);
});

test('F1 (review M2): the cell pass re-derives its own rows; a stale cells row fed back is replaced', () => {
  const first = cellPass(tt(), TOOLS, [], { stopped: null });
  const stale = first.results.map((r) => (r.cell === 'MWS-UPD-1@update_ticket' ? { ...r, reason: 'stale' } : r));
  const again = cellPass(tt(), TOOLS, stale.filter((r) => r.scenario.id !== CELLS_SCENARIO.id), { stopped: null });
  assert.ok(!again.results.some((r) => r.reason === 'stale'));
  assert.equal(again.results.length, first.results.length);
});

test('F6 (review R1): a 429 or "rate limited" inside clean-up or a server message never cuts the run short', () => {
  const cleanup429 = 'clean-up did not finish: clean-up stopped (cleanup failed: stopped: the target answered 429 (rate limited) to tools/call delete_ticket (CLEANUP-3); nothing after it was run); objects of this run may be left behind';
  assert.equal(cutShortOf(cleanup429), null);
  assert.equal(cutShortOf('backend said: error 429 in parse'), null);
  assert.equal(cutShortOf('clean-up did not finish: the server said interrupted by SIGTERM'), null);
  assert.equal(cutShortOf('stopped: the server answered too many requests, 429'), null, 'only the tester\'s own message');
  assert.ok(cutShortOf('stopped: the target answered 429 (rate limited) to tools/call update_ticket (MAIN); nothing after it was run'));
  const r = result('MWS-UPD-1', wp('ticket', 'update_ticket'), sc, 'violated', 'lost', { steps: ['s1'], attribution: 'server' });
  assert.equal(cellPass(tt(), TOOLS, [r], { stopped: cleanup429 }).results[0]!.validity!.class, 'valid');
});

test('F6 (review R1): with the order known, only records made after the cut fail V-RUN', () => {
  const before = result('MWS-UPD-1', wp('ticket', 'update_ticket'), sc, 'violated', 'lost', { steps: ['s1'], attribution: 'server' });
  const after = result('MWS-RES-1', wp('ticket', 'update_ticket'), sc, 'violated', 'not in effect', { steps: ['s2'], attribution: 'server' });
  const stop = 'stopped: the target answered 429 (rate limited) to tools/call update_ticket (MAIN); nothing after it was run';
  const { results } = cellPass(tt(), TOOLS, [before, after], { stopped: stop, late: (_r, i) => i >= 1 });
  assert.deepEqual(results.slice(0, 2).map((x) => [x.requirement, x.validity!.failed]), [['MWS-UPD-1', []], ['MWS-RES-1', ['V-RUN']]]);
  // Without the order, the tester's own cut-short message voids every violation (the conservative fallback).
  assert.deepEqual(cellPass(tt(), TOOLS, [before], { stopped: stop }).results[0]!.validity!.failed, ['V-RUN']);
});

test('F6 (review R2): a targeting record turned into violated by a bystander loss carries the call\'s steps', () => {
  const held = result('MWS-TGT-2', wp('ticket', 'delete_tickets'), { id: 'targeting', version: '1' }, 'held', 'no form removed anything', { notes: ['n'] });
  const v = withLoss(held, [{ gone: ['other-1'], changed: [] } as never], true, [], ['tgt2.form.omitted.00042']);
  assert.equal(v.verdict, 'violated');
  assert.deepEqual(v.steps, ['tgt2.form.omitted.00042']);
  assert.equal(validityOf(v, { stopped: null }).class, 'valid');
  const own = result('MWS-TGT-1', wp('ticket', 'delete_tickets'), { id: 'targeting', version: '1' }, 'held', 'named scope only', { steps: ['own.1'] });
  assert.deepEqual(withLoss(own, [{ gone: ['other-1'], changed: [] } as never], true, [], ['x']).steps, ['own.1'], 'a record\'s own steps are kept');
});
