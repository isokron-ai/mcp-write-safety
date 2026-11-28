/**
 * Min mode: the checks. Each records trials on the context; run.ts combines them per requirement and tool (spec 8.2,
 * rule 13) and applies the min-mode caps (src/min/requirements-min.json). A check never judges a call the server
 * could not answer because of the mock (a crash on a mock reply, a request the description does not have): those are
 * `not tested`, the harness's limit.
 */

import { nonAdditive } from '../checks/types.js';
import { getPath, isObj, type Obj } from '../core/util.js';
import { KEY_ARG, VERSION_ARG, mutating2xx, prose, said, type Base, type Ctx, type Step, type Trial } from './context.js';
import type { MockRecord } from './mock.js';
import { succeeded, type ToolResult } from './mcp.js';
import { matchOperation } from './openapi.js';
import { mainType, matches, stringFor } from './values.js';

const MANAGED = /(^|\.)(version|updated_at|updatedAt|created_at|createdAt|etag)$/;
let faultN = 0;
const fid = (what: string) => `F${++faultN}-${what}`;

const unusable = (s: Step): string | null => (s.crashed ? 'the server exited during the call (a reply of the mock it could not handle is our limit, not a finding)' : s.final.timedOut ? 'the call timed out (indeterminate, spec 7.3 rule 5)' : s.final.transportError ? `no answer: ${s.final.transportError}` : s.recs.some((r) => r.kind === 'unmatched') ? 'the server sent a request the description does not have (mock_incomplete)' : null);

const T = (c: Ctx, t: Omit<Trial, 'method'> & { method?: Trial['method'] }): void => c.add({ method: 'black-box', ...t });

const mentions = (r: ToolResult, v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  const s = String(v);
  return s.length > 0 && said(r).includes(s);
};

/** A version stated in a result: a member named version (or current_version) with that value, or "version N" in the text. */
const statesVersion = (r: ToolResult, v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  const want = String(v);
  const walk = (x: unknown, depth = 0): boolean => {
    if (depth > 8) return false;
    if (Array.isArray(x)) return x.some((y) => walk(y, depth + 1));
    if (!isObj(x)) return false;
    return Object.entries(x).some(([k, y]) => (/(^|_)version$/i.test(k) && String(y) === want) || walk(y, depth + 1));
  };
  return walk(r.structured) || new RegExp(`\\bversion\\D{0,4}${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(r.text);
};

// ---------------------------------------------------------------------------------------------------------------- catalog

export function ann4(c: Ctx): void {
  for (const t of c.tools) {
    const a = c.ann(t.name);
    const ro = typeof a['readOnlyHint'] === 'boolean';
    const de = a['readOnlyHint'] === true || typeof a['destructiveHint'] === 'boolean';
    T(c, { requirement: 'MWS-ANN-4', tool: t.name, case: 'catalog', method: 'catalog', verdict: ro && de ? 'held' : 'violated', reason: ro && de ? 'readOnlyHint and (for a tool that is not read-only) destructiveHint are declared' : `the catalog declares ${!ro ? 'no readOnlyHint' : 'no destructiveHint'} for this tool`, steps: [] });
  }
}

// ---------------------------------------------------------------------------------------------------------------- ANN-1

/** A readOnlyHint tool that sent a mutating request the mock applied. Every call of the run counts (a search). */
export function ann1(c: Ctx): void {
  for (const t of c.tools.filter((x) => c.ann(x.name)['readOnlyHint'] === true)) {
    const steps = c.steps.filter((s) => s.tool === t.name && !s.crashed);
    if (!steps.length) {
      T(c, { requirement: 'MWS-ANN-1', tool: t.name, case: 'calls', verdict: 'not tested', reason: c.noBase.get(t.name) ?? 'not called', reason_code: 'no_successful_call', steps: [] });
      continue;
    }
    const bad = steps.filter((s) => mutating2xx(s.recs).length);
    T(c, bad.length
      ? { requirement: 'MWS-ANN-1', tool: t.name, case: 'calls', verdict: 'violated', reason: `declared readOnlyHint: true, but ${mutating2xx(bad[0]!.recs).map((r) => `${r.method} ${r.path}`).join(', ')} changed the mock's state`, steps: bad.map((s) => s.id), method: 'proxy-assisted' }
      : { requirement: 'MWS-ANN-1', tool: t.name, case: 'calls', verdict: 'not observed', reason: `no mutating request in ${steps.length} call(s) (a search: spec 8.2 rule 8)`, steps: steps.map((s) => s.id), method: 'proxy-assisted' });
  }
}

// ---------------------------------------------------------------------------------------------------------------- SEC-1

/** Provokes an error from every read tool (the mock answers 500), then searches every result of the run for a canary. */
export async function sec1Provoke(c: Ctx): Promise<void> {
  for (const b of [...c.bases.values()].filter((x) => !x.mutated)) {
    const args = c.again(b.tool) ?? b.args;
    c.mock.arm({ id: fid('sec1-500'), mutating: false, nth: 1, fault: { kind: 'status', status: 500, code: 'internal' } });
    await c.call(b.tool, args, `sec1-${b.tool}`);
    c.mock.disarm();
  }
}

export function sec1(c: Ctx): void {
  const leaks = c.steps.filter((s) => c.canaries.some((k) => JSON.stringify([s.first.raw, s.final.raw, s.final.rpcError]).includes(k)));
  for (const s of leaks) T(c, { requirement: 'MWS-SEC-1', tool: s.tool, case: 'results', verdict: 'violated', reason: 'a credential canary the server was given for its backend is in a tool result', steps: [s.id] });
  if (!leaks.length) T(c, { requirement: 'MWS-SEC-1', tool: '(server)', case: 'results', verdict: 'not observed', reason: `no canary in ${c.steps.length} result(s), ${c.steps.filter((s) => s.final.isError).length} of them errors (a search: spec 8.2 rule 8)`, steps: [] });
}

// ---------------------------------------------------------------------------------------------------------------- RES-2

export async function res2(c: Ctx): Promise<void> {
  for (const b of c.writeTools()) {
    const nMut = b.step.recs.filter((r) => r.mutating).length;
    for (const [label, fault] of [
      ['refused-422', { kind: 'status', status: 422, code: 'validation' }],
      ['failed-503', { kind: 'status', status: 503, code: 'unavailable' }],
    ] as const) {
      const args = c.again(b.tool);
      if (!args) continue;
      c.mock.arm({ id: fid(label), mutating: true, nth: 1, fault });
      const s = await c.call(b.tool, args, `res2-${label}-${b.tool}`);
      c.mock.disarm();
      const why = unusable(s);
      const base = { requirement: 'MWS-RES-2', tool: b.tool, case: label, steps: [s.id], method: 'proxy-assisted' as const };
      if (why) T(c, { ...base, verdict: 'not tested', reason: why, reason_code: 'indeterminate' });
      else if (!s.recs.some((r) => r.fault)) T(c, { ...base, verdict: 'not tested', reason: 'the call sent no mutating request, so the fault was not delivered', reason_code: 'condition_not_forced' });
      else if (succeeded(s.final) && !mutating2xx(s.recs).length) T(c, { ...base, verdict: 'violated', reason: `the mock answered the write ${fault.status} and applied nothing, and the result is a success (no isError): clause 1`, numbers: { status: fault.status } });
      else if (s.final.rpcError) T(c, { ...base, verdict: 'violated', reason: `the backend's ${fault.status} came back as a JSON-RPC error (${s.final.rpcError.code}), not a tool execution error: clause 3` });
      else if (s.final.isError && nMut === 1) T(c, { ...base, verdict: 'held', reason: `the refused write (${fault.status}) came back as a tool execution error and nothing remained applied` });
      else T(c, { ...base, verdict: 'not tested', reason: 'the call makes more than one write; what remains applied is judged under MWS-ATOM-1', reason_code: 'multi_step' });
    }
    // The lost answer: the mock applies the last mutating request of the call and cuts the connection before answering.
    const args = c.again(b.tool);
    if (!args || nMut < 1) continue;
    const id = fid('lost-answer');
    c.mock.arm({ id, mutating: true, nth: nMut, fault: { kind: 'apply_then_drop' } });
    const s = await c.call(b.tool, args, `res2-lost-${b.tool}`);
    c.mock.disarm();
    const base = { requirement: 'MWS-RES-2', tool: b.tool, case: 'lost-answer', steps: [s.id], method: 'proxy-assisted' as const };
    const why = unusable(s);
    if (why) {
      T(c, { ...base, verdict: 'not tested', reason: why, reason_code: 'indeterminate' });
      continue;
    }
    const cut = s.recs.find((r) => r.fault === id);
    if (!cut || !cut.applied) {
      T(c, { ...base, verdict: 'not tested', reason: 'the cut request was not applied by the mock, so no change remained', reason_code: 'condition_not_forced' });
      continue;
    }
    const sh = c.shape(s.final);
    const failed = c.pattern('write_failed');
    const retry = c.pattern('retry_invited') ?? c.pattern('repeat_invited');
    const unknown = c.pattern('outcome_unknown');
    const p = prose(s.final);
    const readNamed = c.tools.some((t) => c.ann(t.name)['readOnlyHint'] === true && p.includes(t.name)) || /\bread\b/i.test(p);
    if (succeeded(s.final) && !(failed && failed.test(p)) && !(sh && sh['outcome'] !== 'applied')) {
      T(c, { ...base, verdict: 'not tested', reason: 'the result reports success and the write is in effect: no verdict here (MWS-RES-1 judges it)', reason_code: 'no_verdict_in_trial' });
    } else if (sh && sh['outcome'] === 'not_applied') {
      T(c, { ...base, verdict: 'violated', reason: 'after the lost answer the write is in effect at the mock, and the adopted shape says outcome "not_applied" (kind change-unidentified)', numbers: { shape_outcome: 'not_applied' } });
    } else if (failed && failed.test(p)) {
      T(c, { ...base, verdict: 'violated', reason: `after the lost answer the write is in effect at the mock, and the text says it failed (declared pattern write_failed): "${p.slice(0, 160)}"` });
    } else if (sh && sh['outcome'] === 'unknown' && sh['repeat'] === 'yes') {
      T(c, { ...base, verdict: 'violated', reason: 'outcome unknown with repeat "yes": a blind repeat is invited (kind retry-invited)' });
    } else if (retry && retry.test(p) && !readNamed) {
      T(c, { ...base, verdict: 'violated', reason: `the text invites a repeat of a write whose outcome is open, naming no read (declared pattern): "${p.slice(0, 160)}" (kind retry-invited)` });
    } else if (!s.final.isError && !s.final.rpcError) {
      T(c, { ...base, verdict: 'violated', reason: 'a lost backend answer (a failure of the backend) came back without isError: clause 3' });
    } else if ((sh && sh['outcome'] === 'unknown') || (unknown && unknown.test(p))) {
      T(c, { ...base, verdict: 'held', reason: 'the error says the outcome is not known, and invites no blind repeat' });
    } else {
      T(c, { ...base, verdict: 'not tested', reason: `needs reading: no declared pattern or adopted shape decides what the error says ("${p.slice(0, 120)}")`, reason_code: 'declaration_missing' });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- CONC-4/6

export async function conc46(c: Ctx): Promise<void> {
  for (const b of c.writeTools()) {
    const muts = b.step.recs.filter((r) => r.mutating);
    const idx = muts.findIndex((r) => r.headers['if-match'] !== undefined || conflictDeclared(c, r));
    if (idx < 0) continue;
    const args = c.again(b.tool);
    if (!args) continue;
    c.mock.arm({ id: fid('conflict'), mutating: true, nth: idx + 1, fault: { kind: 'conflict' } });
    const s = await c.call(b.tool, args, `conc-${b.tool}`);
    c.mock.disarm();
    const why = unusable(s);
    const base = { tool: b.tool, steps: [s.id], method: 'proxy-assisted' as const };
    if (why || !s.recs.some((r) => r.fault)) {
      T(c, { ...base, requirement: 'MWS-CONC-4', case: 'conflict', verdict: 'not tested', reason: why ?? 'the conflict was not delivered', reason_code: 'indeterminate' });
      continue;
    }
    const applied = mutating2xx(s.recs);
    const sh = c.shape(s.final);
    if (!s.final.isError || applied.length) {
      T(c, { ...base, requirement: 'MWS-CONC-4', case: 'conflict', verdict: 'violated', reason: !s.final.isError ? `the mock refused the write with a conflict; the result has no isError: true${s.final.rpcError ? ` (a JSON-RPC error ${s.final.rpcError.code})` : ''}` : `after the conflict the call applied ${applied.map((r) => `${r.method} ${r.path}`).join(', ')}` });
    } else {
      T(c, { ...base, requirement: 'MWS-CONC-4', case: 'conflict', verdict: 'held', reason: 'the conflict came back as a tool execution error and nothing was applied' });
      const pat = c.pattern('conflict_says_not_applied');
      if (sh) T(c, { ...base, requirement: 'MWS-CONC-4', case: 'wording', method: 'review', verdict: 'self-attested', answer: sh['outcome'] === 'not_applied', reason: `the adopted shape says outcome "${String(sh['outcome'])}"` });
      else if (pat) T(c, { ...base, requirement: 'MWS-CONC-4', case: 'wording', method: 'review', verdict: 'self-attested', answer: pat.test(prose(s.final)), reason: `declared pattern conflict_says_not_applied ${pat.test(prose(s.final)) ? 'matches' : 'does not match'}` });
      else T(c, { ...base, requirement: 'MWS-CONC-4', case: 'wording', method: 'review', verdict: 'not tested', reason: 'review-only clause: no declared pattern says how a conflict states that nothing was applied', reason_code: 'declaration_missing' });
    }
    // CONC-6: the current state (the version the mock holds), else the declared re-read wording.
    const target = c.targets(s.recs.find((r) => r.fault)!)[0];
    const cur = target ? findObject(c, target) : undefined;
    if (cur && cur['version'] !== undefined && statesVersion(s.final, cur['version'])) {
      T(c, { ...base, requirement: 'MWS-CONC-6', case: 'conflict', verdict: 'held', reason: `the error carries the current version (${String(cur['version'])})` });
    } else {
      const pat = c.pattern('conflict_says_reread');
      if (pat) T(c, { ...base, requirement: 'MWS-CONC-6', case: 'conflict', method: 'review', verdict: 'self-attested', answer: pat.test(prose(s.final)), reason: `the error does not carry the current state; declared pattern conflict_says_reread ${pat.test(prose(s.final)) ? 'matches' : 'does not match'}: "${prose(s.final).slice(0, 160)}"` });
      else T(c, { ...base, requirement: 'MWS-CONC-6', case: 'conflict', method: 'review', verdict: 'not tested', reason: 'the error does not carry the current state, and no declared pattern says how it tells the caller to read again', reason_code: 'declaration_missing' });
    }
  }
}

const conflictDeclared = (c: Ctx, r: MockRecord): boolean => {
  const m = matchOperation(c.mock.model, r.method, r.path);
  return !!m && m.op.responses.some((x) => x.status === '412');
};

function findObject(c: Ctx, id: string): Obj | undefined {
  for (const col of c.mock.model.collections.filter((x) => !x.parent)) {
    const o = c.mock.get(col.path, id);
    if (o) return o;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------- CONC-5

export function conc5(c: Ctx): void {
  // The condition (the backend cannot detect a stale write) is shown by the declaration (spec MWS-CONC-5: no_version_check),
  // or not applicable where the description declares a precondition for the operation the tool's write used. A missing
  // precondition in the description alone is not a declaration: such a tool is noted, not judged.
  const pat = c.pattern('stale_writes_disclosed');
  for (const b of c.writeTools()) {
    const r = b.step.recs.find((x) => x.mutating && (x.method === 'DELETE' || x.method === 'PUT')) ?? b.step.recs.find((x) => x.mutating);
    const m = r ? matchOperation(c.mock.model, r.method, r.path) : null;
    const pre = !!m && (m.op.params.some((p) => p.in === 'header' && /^if-(match|unmodified-since)$/i.test(p.name)) || m.op.responses.some((x) => x.status === '412'));
    const base = { requirement: 'MWS-CONC-5', tool: b.tool, case: 'description', method: 'review' as const, steps: [b.step.id] };
    if (c.decl.noVersionCheck.includes(b.tool)) {
      const desc = c.tool(b.tool)?.description ?? '';
      if (!pat) T(c, { ...base, verdict: 'not tested', reason: 'the declaration lists the tool under no_version_check but gives no stale_writes_disclosed pattern', reason_code: 'declaration_missing' });
      else T(c, { ...base, verdict: 'self-attested', answer: pat.test(desc), reason: `the declaration states the backend has no version check for this tool; its description ${pat.test(desc) ? 'says' : 'does not say'} that stale writes are not detected (declared pattern)` });
    } else if (pre && m) T(c, { ...base, verdict: 'not applicable', reason: `the description declares a precondition for ${m.op.key}, so the backend can detect a stale write` });
  }
}

// ---------------------------------------------------------------------------------------------------------------- RES-3, RES-4

export async function res34(c: Ctx): Promise<void> {
  for (const b of c.writeTools()) {
    const args = c.again(b.tool);
    if (!args) continue;
    const s = await c.call(b.tool, args, `receipt-${b.tool}`);
    const why = unusable(s);
    if (why || !succeeded(s.final)) continue;
    const applied = mutating2xx(s.recs);
    const created = applied.flatMap((r) => r.effect.created);
    const changed = applied.flatMap((r) => r.effect.changed);
    const deleted = applied.flatMap((r) => r.effect.deleted);
    for (const ref of created) {
      const ok = mentions(s.final, ref.id);
      T(c, { requirement: 'MWS-RES-3', tool: b.tool, case: 'create', steps: [s.id], verdict: ok ? 'held' : 'violated', reason: ok ? `the result carries the identifier the mock assigned (${ref.id})` : `the mock created ${ref.id}; the result does not carry it` });
    }
    // RES-4: one object written (a create, or an update of one object), not a delete.
    const objs = [...new Set([...created, ...changed].map((r) => `${r.collection} ${r.id}`))];
    if (deleted.length || objs.length === 0) continue;
    const top = created.find((r) => !c.mock.model.collections.find((x) => x.path === r.collection)?.parent) ?? changed[0] ?? created[0]!;
    const topObjs = [...new Set(changed.map((r) => r.id))];
    if (!created.length && topObjs.length !== 1) continue;
    const o = findObject(c, top.id) ?? (created[0] && changed[0] ? findObject(c, changed[0].id) : undefined);
    const missing: string[] = [];
    const idShown = created.length ? created.every((r) => mentions(s.final, r.id)) : mentions(s.final, top.id);
    if (!idShown) missing.push('the identifier');
    const versionedObj = created.length && changed.length ? findObject(c, changed[0]!.id) : o;
    if (versionedObj && versionedObj['version'] !== undefined && !statesVersion(s.final, versionedObj['version'])) missing.push(`the new version (${String(versionedObj['version'])})`);
    if (!created.length) {
      // The fields the call changed, as the mock's state shows them (spec: "as the read-back shows").
      const fields = [...new Set(applied.flatMap((r) => r.changed_fields))].filter((k) => !MANAGED.test(k));
      const unnamed = fields.filter((f) => !said(s.final).includes(f) && !(o && o[f] !== null && typeof o[f] !== 'object' && mentions(s.final, o[f])));
      if (unnamed.length) missing.push(`the changed field(s) ${unnamed.join(', ')}`);
    }
    const sh = c.shape(s.final);
    const shv = sh && isObj(sh['object']) ? (sh['object'] as Obj)['version'] : undefined;
    const base = { requirement: 'MWS-RES-4', tool: b.tool, case: created.length ? 'create' : 'update', steps: [s.id] };
    if (shv !== undefined && versionedObj && String(shv) !== String(versionedObj['version'])) T(c, { ...base, verdict: 'violated', reason: `the adopted shape gives object.version ${String(shv)}; the mock returned version ${String(versionedObj['version'])}` });
    else T(c, { ...base, verdict: missing.length ? 'violated' : 'held', reason: missing.length ? `the receipt lacks ${missing.join(' and ')}` : 'the receipt names the object, its new version and what changed' });
  }
}

// ---------------------------------------------------------------------------------------------------------------- ATOM-1

export async function atom1(c: Ctx): Promise<void> {
  for (const b of c.writeTools()) {
    const muts = b.step.recs.filter((r) => r.mutating);
    const items = new Set(muts.flatMap((r) => c.targets(r)));
    if (items.size < 2) continue;
    const args = c.again(b.tool);
    if (!args) continue;
    const nth = muts.length >= 2 ? 2 : 1;
    c.mock.arm({ id: fid('atom-second'), mutating: true, nth, fault: { kind: 'status', status: 422, code: 'validation' } });
    const s = await c.call(b.tool, args, `atom1-${b.tool}`);
    c.mock.disarm();
    const base = { requirement: 'MWS-ATOM-1', tool: b.tool, case: nth === 2 ? 'second-write-fails' : 'batch-refused', steps: [s.id], method: 'proxy-assisted' as const };
    const why = unusable(s);
    if (why) {
      T(c, { ...base, verdict: 'not tested', reason: why, reason_code: 'indeterminate' });
      continue;
    }
    const targets = [...new Set(s.recs.filter((r) => r.mutating).flatMap((r) => c.targets(r)))];
    const done = new Set(mutating2xx(s.recs).flatMap((r) => [...r.effect.changed, ...r.effect.deleted, ...r.effect.created].map((x) => x.id)));
    const notDone = targets.filter((t) => !done.has(t));
    if (!notDone.length) {
      T(c, { ...base, verdict: 'not tested', reason: 'every item was applied after the fault (the server retried or worked around it)', reason_code: 'condition_not_forced' });
      continue;
    }
    const sh = c.shape(s.final);
    const p = prose(s.final);
    const all = c.pattern('applied_all');
    const rep = c.decl.multiReports[b.tool];
    const reported = rep ? getPath(s.final.structured, rep.applied) : undefined;
    const claimed = Array.isArray(reported) ? reported.map((x) => String(isObj(x) ? x[rep!.id] : x)) : null;
    const shItems = sh && Array.isArray(sh['items']) ? (sh['items'] as Obj[]) : [];
    let v: { verdict: Trial['verdict']; reason: string } | null = null;
    if (succeeded(s.final) && !(sh && sh['outcome'] !== 'applied')) v = { verdict: 'violated', reason: `${notDone.join(', ')} not applied, and the result is a success` };
    else if (sh && sh['outcome'] === 'applied') v = { verdict: 'violated', reason: `${notDone.join(', ')} not applied, and the adopted shape says outcome "applied"` };
    else if (all && all.test(p)) v = { verdict: 'violated', reason: `${notDone.join(', ')} not applied, and the text says the whole write took effect (declared pattern applied_all): "${p.slice(0, 120)}"` };
    else if (shItems.some((it) => notDone.includes(String(it['id'])) && it['outcome'] === 'applied')) v = { verdict: 'violated', reason: 'the adopted shape lists as applied an item the mock did not apply' };
    else if (claimed && claimed.some((x) => notDone.includes(x))) v = { verdict: 'violated', reason: `the result reports ${claimed.filter((x) => notDone.includes(x)).join(', ')} applied (declared report ${rep!.applied}); the mock applied ${[...done].join(', ') || 'nothing'}` };
    else if (claimed && [...done].some((x) => targets.includes(x) && !claimed.includes(x))) v = { verdict: 'violated', reason: `the mock applied ${[...done].join(', ')}, which the declared report ${rep!.applied} does not name` };
    else if (sh || claimed) v = { verdict: 'held', reason: `the result is not a success and names what was applied (${[...done].filter((x) => targets.includes(x)).join(', ') || 'nothing'}) and what was not` };
    else v = { verdict: 'not tested', reason: 'needs reading: no adopted shape or declared report says which items were applied', };
    T(c, { ...base, ...v, ...(v.verdict === 'not tested' ? { reason_code: 'declaration_missing' } : {}), numbers: { items: targets.length, applied: [...done].filter((x) => targets.includes(x)), not_applied: notDone } });
  }
}

// ---------------------------------------------------------------------------------------------------------------- RETRY-1, RETRY-2, ANN-3

/** A create whose identifier the mock assigned, on an operation that declares 201 and no 200 (the backend does not dedupe). */
function plainCreate(c: Ctx, s: Step): boolean {
  return mutating2xx(s.recs).some((r) => {
    if (r.kind !== 'create' || !r.effect.created.length) return false;
    const col = c.mock.model.collections.find((x) => x.path === r.effect.created[0]!.collection);
    if (col && isObj(r.body) && r.body[col.idField] !== undefined) return false;
    const m = matchOperation(c.mock.model, r.method, r.path);
    return !!m && m.op.responses.some((x) => x.status === '201') && !m.op.responses.some((x) => x.status === '200');
  });
}

const createdIn = (steps: Step[]): string[] => steps.flatMap((s) => mutating2xx(s.recs).flatMap((r) => r.effect.created.map((x) => x.id)));

export async function retry1(c: Ctx): Promise<void> {
  for (const b of c.writeTools().filter((x) => plainCreate(c, x.step))) {
    const key = Object.keys(c.props(b.tool).props).find((k) => KEY_ARG.test(k));
    const base = { requirement: 'MWS-RETRY-1', tool: b.tool, case: 'repeat' };
    if (key) {
      T(c, { ...base, verdict: 'held', reason: `the create offers an idempotency key (${key}); its behaviour is judged by MWS-RETRY-2`, steps: [b.step.id], method: 'catalog' });
      continue;
    }
    const args = c.again(b.tool);
    if (!args) continue;
    const s1 = await c.call(b.tool, args, `retry1-a-${b.tool}`);
    const s2 = await c.call(b.tool, args, `retry1-b-${b.tool}`);
    const n = createdIn([s1, s2]).length;
    T(c, { ...base, steps: [s1.id, s2.id], verdict: n >= 2 ? 'violated' : 'not applicable', reason: n >= 2 ? `two identical calls created two objects at the mock (${createdIn([s1, s2]).join(', ')}) and the tool accepts no idempotency key` : 'two identical calls did not create two objects' });
  }
}

export async function retry2(c: Ctx): Promise<void> {
  for (const b of c.writeTools().filter((x) => x.step.recs.some((r) => r.kind === 'create' && r.applied))) {
    const { props } = c.props(b.tool);
    const keyArg = Object.keys(props).find((k) => KEY_ARG.test(k));
    if (!keyArg) continue;
    const ks = props[keyArg] ?? {};
    const key = (n: string) => stringFor(ks, `mwsminkey${n}${Date.now().toString(36)}`, n.length) ?? `mwsminkey${n}`;
    const plain = plainCreate(c, b.step);
    const R = (cs: string, steps: Step[], verdict: Trial['verdict'], reason: string, method: Trial['method'] = 'black-box') => T(c, { requirement: 'MWS-RETRY-2', tool: b.tool, case: cs, steps: steps.map((s) => s.id), verdict, reason, method });
    // (a) the same key and arguments twice.
    let args = c.again(b.tool);
    if (!args) continue;
    const ka = key('a');
    const a1 = await c.call(b.tool, { ...args, [keyArg]: ka }, `retry2-a1-${b.tool}`);
    const a2 = await c.call(b.tool, { ...args, [keyArg]: ka }, `retry2-a2-${b.tool}`);
    const na = createdIn([a1, a2]);
    if (unusable(a1) || unusable(a2)) R('same-key', [a1, a2], 'not tested', unusable(a1) ?? unusable(a2)!);
    else if (na.length > 1) R('same-key', [a1, a2], 'violated', `one key, the same arguments, two objects at the mock (${na.join(', ')})${a1.recs.some((r) => r.headers['idempotency-key'] === ka) ? '' : '; the key was not forwarded to the backend'}`);
    else R('same-key', [a1, a2], 'held', 'applied once');
    // (b) a new key is a new write (only where the backend does not dedupe on its own).
    if (plain) {
      args = c.again(b.tool) ?? args;
      const b1 = await c.call(b.tool, { ...args, [keyArg]: key('b1') }, `retry2-b1-${b.tool}`);
      const b2 = await c.call(b.tool, { ...args, [keyArg]: key('b2') }, `retry2-b2-${b.tool}`);
      const nb = createdIn([b1, b2]).length;
      if (!unusable(b1) && !unusable(b2)) R('new-key', [b1, b2], nb === 2 ? 'held' : succeeded(b2.final) ? 'violated' : 'not tested', nb === 2 ? 'a new key made a new object' : 'a new key with the same arguments was not treated as a new write');
    }
    // (c) the same key with different arguments must be refused.
    args = c.again(b.tool) ?? args;
    const strArg = Object.keys(args).find((k) => typeof args![k] === 'string' && !KEY_ARG.test(k) && mainType(props[k]) === 'string' && !c.collectionFor(b.tool, k, props[k] ?? {}));
    if (strArg) {
      const kc = key('c');
      const c1 = await c.call(b.tool, { ...args, [keyArg]: kc }, `retry2-c1-${b.tool}`);
      const changed = stringFor(props[strArg] ?? {}, `${String(args[strArg]).slice(0, 40)}x`, 3) ?? `${String(args[strArg])}x`;
      const c2 = await c.call(b.tool, { ...args, [strArg]: changed, [keyArg]: kc }, `retry2-c2-${b.tool}`);
      if (!unusable(c1) && !unusable(c2) && succeeded(c1.final)) R('changed-arguments', [c1, c2], succeeded(c2.final) ? 'violated' : 'held', succeeded(c2.final) ? `the key was reused with ${strArg} changed and the call was answered as a success${c2.recs.length ? '' : ' without any request to the backend'}` : 'the reused key with changed arguments was refused');
    }
    // (d) a lost answer, then the caller's repeat with the same key.
    args = c.again(b.tool) ?? args;
    const kd = key('d');
    const idd = fid('retry2-lost');
    const createIdx = b.step.recs.filter((r) => r.mutating).findIndex((r) => r.kind === 'create') + 1;
    c.mock.arm({ id: idd, mutating: true, nth: Math.max(1, createIdx), fault: { kind: 'apply_then_drop' } });
    const d1 = await c.call(b.tool, { ...args, [keyArg]: kd }, `retry2-d1-${b.tool}`);
    c.mock.disarm();
    const d2 = await c.call(b.tool, { ...args, [keyArg]: kd }, `retry2-d2-${b.tool}`);
    const nd = createdIn([d1, d2]);
    if (d1.crashed || d2.crashed) R('lost-answer', [d1, d2], 'not tested', 'the server exited', 'proxy-assisted');
    else R('lost-answer', [d1, d2], nd.length > 1 ? 'violated' : 'held', nd.length > 1 ? `after a lost answer one key made ${nd.length} objects (${nd.join(', ')})` : 'after a lost answer and a repeat with the key, the write was applied once', 'proxy-assisted');
    // (e) a restart of the server between the two calls.
    args = c.again(b.tool) ?? args;
    const ke = key('e');
    const e1 = await c.call(b.tool, { ...args, [keyArg]: ke }, `retry2-e1-${b.tool}`);
    const why = await c.restart();
    if (why) {
      R('restart', [e1], 'not tested', `the server did not start again: ${why}`, 'launch');
      continue;
    }
    const e2 = await c.call(b.tool, { ...args, [keyArg]: ke }, `retry2-e2-${b.tool}`);
    const ne = createdIn([e1, e2]);
    if (!unusable(e1) && !unusable(e2)) R('restart', [e1, e2], ne.length > 1 ? 'violated' : 'held', ne.length > 1 ? `after a restart of the server one key made two objects (${ne.join(', ')})` : 'after a restart the repeat applied nothing new', 'launch');
  }
}

export async function ann3(c: Ctx): Promise<void> {
  for (const b of c.writeTools().filter((x) => c.ann(x.tool)['idempotentHint'] === true && c.ann(x.tool)['readOnlyHint'] !== true)) {
    const args = c.again(b.tool);
    if (!args) continue;
    const s1 = await c.call(b.tool, args, `ann3-a-${b.tool}`);
    const s2 = await c.call(b.tool, args, `ann3-b-${b.tool}`);
    if (unusable(s1) || unusable(s2)) continue;
    const second = plainCreate(c, s2) && !s2.recs.some((r) => r.headers['idempotency-key']);
    T(c, { requirement: 'MWS-ANN-3', tool: b.tool, case: 'repeat', steps: [s1.id, s2.id], verdict: second ? 'violated' : 'not tested', reason: second ? `declared idempotentHint: true, and the repeat created a second object at the mock (${createdIn([s2]).join(', ')}) through a create the description declares as 201 only` : 'the repeat sent no second plain create; whether it had a further effect needs the backend\'s state', ...(second ? {} : { reason_code: 'backend_state_needed' }) });
  }
}

// ---------------------------------------------------------------------------------------------------------------- ANN-2, ANN-5

export async function ann25(c: Ctx): Promise<void> {
  for (const b of c.writeTools().filter((x) => c.ann(x.tool)['destructiveHint'] === false && c.ann(x.tool)['readOnlyHint'] !== true)) {
    const args = c.again(b.tool);
    if (!args) continue;
    const before = c.mock.snapshot();
    const s = await c.call(b.tool, args, `ann25-${b.tool}`);
    const after = c.mock.snapshot();
    if (unusable(s)) continue;
    const lost: string[] = [];
    for (const [col, objs] of Object.entries(before)) {
      for (const [id, o] of Object.entries(objs)) {
        const a = after[col]?.[id];
        if (!a) lost.push(`${col}/${id}`);
        else for (const p of nonAdditive(o, a)) if (!MANAGED.test(p)) lost.push(`${col}/${id}.${p}`);
      }
    }
    const field = (p: string) => p.split('.')[1]?.split('[')[0] ?? '';
    const unnamed = lost.filter((p) => !p.includes('.') || !(field(p) in args));
    T(c, { requirement: 'MWS-ANN-5', tool: b.tool, case: 'call', steps: [s.id], verdict: lost.length ? 'violated' : 'not tested', reason: lost.length ? `declared destructiveHint: false, and the call removed or replaced ${lost.slice(0, 5).join(', ')} at the mock` : 'nothing was removed or replaced at the mock; additivity against the real backend needs its state', ...(lost.length ? {} : { reason_code: 'backend_state_needed' }) });
    T(c, { requirement: 'MWS-ANN-2', tool: b.tool, case: 'call', steps: [s.id], verdict: unnamed.length ? 'violated' : 'not tested', reason: unnamed.length ? `declared destructiveHint: false, and the call removed or changed data it did not name: ${unnamed.slice(0, 5).join(', ')}` : 'no data the call did not name was removed at the mock; the real backend\'s state is needed for more', ...(unnamed.length ? {} : { reason_code: 'backend_state_needed' }) });
  }
}

// ---------------------------------------------------------------------------------------------------------------- RETRY-3

export function retry3(c: Ctx): void {
  for (const s of c.steps.filter((x) => x.first.inputRequired && !x.crashed)) {
    if (c.trials.some((t) => t.requirement === 'MWS-RETRY-3' && t.tool === s.tool)) continue;
    const before = mutating2xx(s.firstRecs);
    T(c, { requirement: 'MWS-RETRY-3', tool: s.tool, case: 'input_required', method: 'proxy-assisted', steps: [s.id], verdict: before.length ? 'violated' : 'held', reason: before.length ? `before the input_required result the server sent ${before.map((r) => `${r.method} ${r.path}`).join(', ')}, which the mock applied` : 'no backend request changed state before the input_required result' });
  }
}

// ---------------------------------------------------------------------------------------------------------------- IN-1 .. IN-7

/** The value the server forwarded for an argument: the member of that name in a mutating request's body or query. */
function forwarded(recs: MockRecord[], arg: string): { found: boolean; value: unknown } {
  const walk = (x: unknown, depth = 0): { found: boolean; value: unknown } => {
    if (depth > 6) return { found: false, value: undefined };
    if (Array.isArray(x)) {
      for (const y of x) {
        const r = walk(y, depth + 1);
        if (r.found) return r;
      }
    } else if (isObj(x)) {
      if (Object.hasOwn(x, arg)) return { found: true, value: x[arg] };
      for (const y of Object.values(x)) {
        const r = walk(y, depth + 1);
        if (r.found) return r;
      }
    }
    return { found: false, value: undefined };
  };
  for (const r of recs.filter((x) => x.mutating)) {
    const w = walk(r.body);
    if (w.found) return w;
    if (Object.hasOwn(r.query, arg)) return { found: true, value: r.query[arg] };
  }
  return { found: false, value: undefined };
}

interface Probe {
  arg: string;
  value: unknown;
  kind: 'constraint' | 'type' | 'meaning';
  what: string;
  /** For a type or meaning probe: the value the conversion that keeps the meaning gives. */
  same?: unknown;
}

function probesFor(c: Ctx, tool: string, args: Obj): Probe[] {
  const { props } = c.props(tool);
  const out: Probe[] = [];
  for (const [k, s] of Object.entries(props)) {
    if (KEY_ARG.test(k) || VERSION_ARG.test(k)) continue;
    if (c.collectionFor(tool, k, s) && k in args) continue; // identifiers stay as the base call names them
    const t = mainType(s);
    if (Array.isArray(s['enum'])) out.push({ arg: k, value: backendEnumValue(c, k, s['enum'] as unknown[]) ?? 'mwsmin_not_in_enum', kind: 'constraint', what: 'a value outside the enum' });
    if (t === 'string') {
      if (typeof s['maxLength'] === 'number' && s['maxLength'] < 5000) out.push({ arg: k, value: 'x'.repeat(s['maxLength'] + 1), kind: 'constraint', what: `${s['maxLength'] + 1} characters (maxLength ${s['maxLength']})` });
      if (typeof s['pattern'] === 'string' && !matches(s['pattern'], '!! mwsmin !!')) out.push({ arg: k, value: '!! mwsmin !!', kind: 'constraint', what: 'a value the pattern does not match' });
      out.push({ arg: k, value: 42, kind: 'type', what: 'a number for a string', same: '42' });
      out.push({ arg: k, value: { a: 1 }, kind: 'meaning', what: 'an object for a string' });
    }
    if (t === 'integer' || t === 'number') {
      if (typeof s['maximum'] === 'number') out.push({ arg: k, value: s['maximum'] + 1, kind: 'constraint', what: `${s['maximum'] + 1} (maximum ${s['maximum']})` });
      if (typeof s['minimum'] === 'number') out.push({ arg: k, value: s['minimum'] - 1, kind: 'constraint', what: `${s['minimum'] - 1} (minimum ${s['minimum']})` });
      const v = c.plainValue(s, 'n', 1) as number;
      out.push({ arg: k, value: String(v), kind: 'type', what: 'a numeric string for a number', same: v });
      if (!(Array.isArray(s['type']) && (s['type'] as unknown[]).includes('null'))) out.push({ arg: k, value: null, kind: 'meaning', what: 'null for a number' });
    }
    if (t === 'boolean' && !/^(force|all|overwrite|cascade|recursive)$/i.test(k)) out.push({ arg: k, value: 'false', kind: 'meaning', what: 'the string "false" for a boolean', same: false });
  }
  return out.slice(0, 14);
}

/** A value of the backend's own enum for the member of that name that the tool's enum leaves out (so the backend takes it). */
function backendEnumValue(c: Ctx, k: string, mcpEnum: unknown[]): unknown {
  for (const col of c.mock.model.collections) {
    const ps = col.schema && isObj(col.schema['properties']) ? (col.schema['properties'] as Obj)[k] : undefined;
    if (isObj(ps) && Array.isArray(ps['enum'])) {
      const extra = (ps['enum'] as unknown[]).find((v) => v !== null && !mcpEnum.includes(v));
      if (extra !== undefined) return extra;
    }
  }
  return undefined;
}

export async function inputs(c: Ctx): Promise<void> {
  const notUsed = c.pattern('not_used');
  const reason = c.pattern('rejection_gives_reason') ?? c.pattern('refused_value');
  for (const b of c.writeTools()) {
    const { props, required } = c.props(b.tool);
    const optional = Object.keys(props).filter((k) => !required.includes(k) && !KEY_ARG.test(k) && !VERSION_ARG.test(k));
    // IN-2 / IN-7: an argument the schema does not define (a misspelling of an optional one).
    {
      const args = c.again(b.tool);
      if (args) {
        const real = optional.find((k) => mainType(props[k]) === 'string' && !c.collectionFor(b.tool, k, props[k] ?? {}));
        const name = real && real.length > 3 ? real.slice(0, 1) + real.slice(2) : 'mwsmin_undefined_argument';
        const value = real ? c.plainValue(props[real] ?? {}, 'mwsmin-extra', 5) : 'mwsmin-extra';
        const s = await c.call(b.tool, { ...args, [name]: value }, `in2-${b.tool}`);
        const base = { tool: b.tool, case: `undefined-argument ${name}`, steps: [s.id] };
        const why = unusable(s);
        if (why) {
          T(c, { ...base, requirement: 'MWS-IN-7', verdict: 'not tested', reason: why, reason_code: 'indeterminate' });
        } else if (!succeeded(s.final)) {
          const sent = mutating2xx(s.recs).length > 0;
          T(c, { ...base, requirement: 'MWS-IN-7', verdict: sent ? 'not tested' : 'held', reason: sent ? 'the call was refused after a write reached the mock' : `the undefined argument ${name} was refused`, ...(sent ? { reason_code: 'mixed' } : {}) });
          T(c, { ...base, requirement: 'MWS-IN-2', verdict: sent ? 'not tested' : 'held', reason: sent ? 'the call was refused after a write reached the mock' : `the undefined argument ${name} was refused, not dropped`, ...(sent ? { reason_code: 'mixed' } : {}) });
        } else {
          T(c, { ...base, requirement: 'MWS-IN-7', verdict: 'violated', reason: `the undefined argument ${name} was accepted, not refused` });
          const fw = forwarded(s.recs, name).found;
          if (fw) T(c, { ...base, requirement: 'MWS-IN-2', verdict: 'held', reason: `the undefined argument ${name} was passed on to the backend, not dropped` });
          else if (notUsed && notUsed.test(prose(s.final))) T(c, { ...base, requirement: 'MWS-IN-2', verdict: 'held', reason: `the result says ${name} was not used (declared pattern not_used)` });
          else if (notUsed) T(c, { ...base, requirement: 'MWS-IN-2', verdict: 'violated', reason: `${name} was dropped silently: not forwarded to the mock, and the result does not say it was not used (declared pattern not_used)` });
          else T(c, { ...base, requirement: 'MWS-IN-2', verdict: 'not tested', reason: `${name} was not forwarded; no declared pattern (not_used) says how the result would say it was not used`, reason_code: 'declaration_missing' });
        }
      }
    }
    for (const p of probesFor(c, b.tool, b.args)) {
      const args = c.again(b.tool);
      if (!args) break;
      const s = await c.call(b.tool, { ...args, [p.arg]: p.value }, `in-${p.kind}-${b.tool}-${p.arg}`);
      const why = unusable(s);
      const req = p.kind === 'constraint' ? 'MWS-IN-3' : p.kind === 'type' ? 'MWS-IN-6' : 'MWS-IN-1';
      const base = { tool: b.tool, case: `${p.arg}: ${p.what}`, steps: [s.id] };
      if (why) {
        T(c, { ...base, requirement: req, verdict: 'not tested', reason: why, reason_code: 'indeterminate' });
        continue;
      }
      const sent = s.recs.filter((r) => r.mutating);
      const fw = forwarded(sent, p.arg);
      if (!succeeded(s.final)) {
        if (sent.length) {
          T(c, { ...base, requirement: req, verdict: 'not tested', reason: 'the probe reached the mock before it was refused, so the refusal may be the backend\'s', reason_code: 'backend_refusal' });
          continue;
        }
        T(c, { ...base, requirement: req, verdict: 'held', reason: `the server refused ${p.what} for ${p.arg} without sending a write` });
        if (p.kind !== 'meaning') {
          const named = said(s.final).includes(p.arg);
          T(c, { ...base, requirement: 'MWS-IN-4', case: `${base.case}: names the argument`, verdict: named ? 'held' : 'violated', reason: named ? `the error names ${p.arg}` : `the error does not name the argument ${p.arg}: "${prose(s.final).slice(0, 120)}"` });
          if (reason) T(c, { ...base, requirement: 'MWS-IN-4', case: `${base.case}: gives a reason`, method: 'review', verdict: 'self-attested', answer: reason.test(prose(s.final)), reason: `declared reason pattern ${reason.test(prose(s.final)) ? 'matches' : 'does not match'}` });
        }
        continue;
      }
      if (p.kind === 'constraint') {
        if (!fw.found) T(c, { ...base, requirement: 'MWS-IN-3', verdict: 'violated', reason: `${p.what} for ${p.arg} was accepted (the call succeeded) and not passed on` });
        else {
          const valid = c.mock.requestValid(sent.find((r) => forwarded([r], p.arg).found)!);
          T(c, valid === true ? { ...base, requirement: 'MWS-IN-3', verdict: 'violated', reason: `${p.what} for ${p.arg} was not refused: it reached the mock, and the backend's own description accepts it` } : { ...base, requirement: 'MWS-IN-3', verdict: 'not tested', reason: `the value reached the mock; the backend's description ${valid === false ? 'refuses' : 'cannot say whether it accepts'} it, so the real backend might refuse it`, reason_code: 'backend_semantics_not_exercised' });
        }
        continue;
      }
      // Accepted with a wrong type: IN-6 (not rejected) and IN-1 (did the conversion keep the meaning?).
      T(c, { ...base, requirement: 'MWS-IN-6', verdict: 'violated', reason: `${p.what} for ${p.arg} was accepted${fw.found ? ` and passed on as ${JSON.stringify(fw.value)}` : ''}, not refused` });
      if (fw.found && p.value !== null && !(p.kind === 'meaning' && p.same === undefined && typeof fw.value === typeof p.value) && JSON.stringify(fw.value) !== JSON.stringify(p.same) && JSON.stringify(fw.value) !== JSON.stringify(p.value)) {
        T(c, { ...base, requirement: 'MWS-IN-1', verdict: 'violated', reason: `${p.what} for ${p.arg} was converted to ${JSON.stringify(fw.value)}, which changes its meaning` });
      } else if (fw.found && p.value === null && fw.value !== null) {
        T(c, { ...base, requirement: 'MWS-IN-1', verdict: 'violated', reason: `null for ${p.arg} was converted to ${JSON.stringify(fw.value)}, which changes its meaning` });
      } else if (fw.found) T(c, { ...base, requirement: 'MWS-IN-1', verdict: 'held', reason: `passed on as ${JSON.stringify(fw.value)}: the meaning is kept` });
    }
    // IN-5: values the schema allows that the declaration lists, refused by the server with the declared fixed-constraint wording.
    const tv = c.decl.tryValues[b.tool] ?? [];
    const fc = c.decl.fixedConstraints[b.tool] ?? [];
    if (!tv.length || !fc.length) {
      T(c, { requirement: 'MWS-IN-5', tool: b.tool, case: 'search', steps: [], verdict: 'not tested', reason: 'the declaration gives no try_values and fixed_constraints for this tool (spec R10-8: a refusal counts only where the constraint is declared fixed)', reason_code: 'declaration_missing' });
      continue;
    }
    for (const t of tv) {
      const args = c.again(b.tool);
      const s0 = props[t.arg];
      if (!args || !s0) continue;
      const v = 'y'.repeat(t.length);
      if (typeof s0['maxLength'] === 'number' && v.length > s0['maxLength']) continue;
      const s = await c.call(b.tool, { ...args, [t.arg]: v }, `in5-${b.tool}-${t.arg}`);
      if (unusable(s)) continue;
      const hit = fc.find((f) => f.arg === t.arg && f.pattern.test(prose(s.final)));
      const sent = s.recs.some((r) => r.mutating);
      T(c, { requirement: 'MWS-IN-5', tool: b.tool, case: `${t.arg} of ${t.length}`, steps: [s.id], verdict: !succeeded(s.final) && !sent && hit ? 'violated' : 'not observed', reason: !succeeded(s.final) && !sent && hit ? `a ${t.length}-character ${t.arg}, valid by the schema, was refused by the server with the declared fixed constraint: "${prose(s.final).slice(0, 120)}"` : 'the value the schema allows was not refused by an undeclared fixed constraint (a search: spec 8.2 rule 8)' });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- TGT-2

export async function tgt2(c: Ctx): Promise<void> {
  for (const sel of c.decl.selectors) {
    if (!c.bases.has(sel.tool)) continue;
    if (!sel.sendEmptyForms) continue; // the forms run only where the operator declared a disposable backend (spec 7.3 rule 1)
    for (const form of sel.forms.length ? sel.forms : [{ name: 'omitted', args: {} }]) {
      // The container: a fresh scope with objects of the mock in it.
      const scopeArg = Object.entries(sel.args).find(([, v]) => v === '{{scope}}')?.[0];
      const scopeCol = scopeArg ? c.collectionFor(sel.tool, scopeArg, c.props(sel.tool).props[scopeArg] ?? {}) : null;
      const member = c.mock.model.collections.find((x) => !x.parent && x.schema && scopeArg && isObj(x.schema['properties']) && scopeArg in (x.schema['properties'] as Obj));
      if (!scopeArg || !scopeCol || !member) {
        T(c, { requirement: 'MWS-TGT-2', tool: sel.tool, case: form.name, steps: [], verdict: 'not tested', reason: 'the declared selector names no scope argument the mock can fill', reason_code: 'declaration_missing' });
        continue;
      }
      const scope = c.fresh(scopeCol);
      const sid = String(scope[scopeCol.idField]);
      for (let i = 0; i < 3; i++) c.mock.addObject(member, { [scopeArg]: sid });
      const count = () => c.mock.objects(member.path).filter((o) => o[scopeArg] === sid).length;
      const before = count();
      const s = await c.call(sel.tool, { ...form.args, [scopeArg]: sid }, `tgt2-${sel.tool}-${form.name}`);
      const gone = before - count();
      if (unusable(s)) continue;
      T(c, { requirement: 'MWS-TGT-2', tool: sel.tool, case: form.name, steps: [s.id], verdict: gone > 0 ? 'violated' : 'not tested', reason: gone > 0 ? `with the selector ${form.name}, ${gone} of ${before} objects in the container were deleted` : `no object in the container was deleted (${before} remain); a held needs the real backend's fallback`, ...(gone > 0 ? {} : { reason_code: 'backend_state_needed' }) });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- CFG

export async function cfg(c: Ctx): Promise<void> {
  const writes = c.writeTools().slice(0, 4);
  const tryWrites = async (label: string): Promise<Step[]> => {
    const out: Step[] = [];
    for (const b of writes) {
      const args = c.again(b.tool);
      if (args) out.push(await c.call(b.tool, args, `${label}-${b.tool}`));
    }
    return out;
  };
  const started = async (env: Record<string, string>): Promise<boolean> => (await c.restart({ ...c.spec.env, ...env })) === null;
  const ro = c.decl.readOnly;
  if (!ro) for (const r of ['MWS-CFG-1', 'MWS-CFG-3']) T(c, { requirement: r, tool: '(server)', case: 'setting', method: 'launch', steps: [], verdict: 'not tested', reason: 'the declaration names no read-only setting (settings.read_only)', reason_code: 'declaration_missing' });
  if (ro && writes.length) {
    // CFG-3: read-only mode on; every write tool must refuse.
    if (await started({ [ro.env]: ro.on })) {
      for (const s of await tryWrites('cfg3')) {
        const w = mutating2xx(s.recs);
        T(c, { requirement: 'MWS-CFG-3', tool: s.tool, case: `${ro.env}=${ro.on}`, method: 'launch', steps: [s.id], verdict: w.length ? 'violated' : 'held', reason: w.length ? `in read-only mode ${w.map((r) => `${r.method} ${r.path}`).join(', ')} reached the mock and was applied` : 'refused in read-only mode; no write reached the mock' });
      }
    } else T(c, { requirement: 'MWS-CFG-3', tool: '(server)', case: `${ro.env}=${ro.on}`, method: 'launch', steps: [], verdict: 'not tested', reason: 'the server did not start in read-only mode', reason_code: 'start_failed' });
    // CFG-1: every restricting value, and one the server cannot recognize.
    const values = [...Object.entries(ro.valid).filter(([v, k]) => k === 'restrict' && v !== ro.on).map(([v]) => v), 'enabled'];
    for (const v of values) {
      if (!(await started({ [ro.env]: v }))) {
        T(c, { requirement: 'MWS-CFG-1', tool: '(server)', case: `${ro.env}=${v}`, method: 'launch', steps: [], verdict: 'held', reason: `the server did not start with ${ro.env}=${v}` });
        continue;
      }
      const steps = await tryWrites(`cfg1-${v}`);
      const w = steps.filter((s) => mutating2xx(s.recs).length);
      T(c, { requirement: 'MWS-CFG-1', tool: '(server)', case: `${ro.env}=${v}`, method: 'launch', steps: steps.map((s) => s.id), verdict: w.length ? 'violated' : 'held', reason: w.length ? `with ${ro.env}=${v} the server started with writes on: ${w.map((s) => s.tool).join(', ')} wrote to the mock` : `with ${ro.env}=${v} no write reached the mock` });
    }
  }
  const deny = c.decl.toolFilters.find((f) => f.kind === 'deny');
  const allow = c.decl.toolFilters.find((f) => f.kind === 'allow');
  if (!deny) T(c, { requirement: 'MWS-CFG-2', tool: '(server)', case: 'setting', method: 'launch', steps: [], verdict: 'not tested', reason: 'the declaration names no deny-list setting', reason_code: 'declaration_missing' });
  else if (writes.length) {
    const value = `${writes[0]!.tool},mwsmin_no_such_tool`;
    if (!(await started({ [deny.env]: value }))) T(c, { requirement: 'MWS-CFG-2', tool: '(server)', case: `${deny.env}=${value}`, method: 'launch', steps: [], verdict: 'held', reason: 'the server did not start with an unknown name in the deny-list' });
    else {
      const steps = await tryWrites('cfg2');
      const w = steps.filter((s) => mutating2xx(s.recs).length);
      T(c, { requirement: 'MWS-CFG-2', tool: '(server)', case: `${deny.env}=${value}`, method: 'launch', steps: steps.map((s) => s.id), verdict: w.length ? 'violated' : 'held', reason: w.length ? `with an unknown name in the deny-list the server started and ${w.map((s) => s.tool).join(', ')} wrote to the mock` : 'with an unknown name in the deny-list the server started with writes disabled' });
    }
  }
  if (!allow) T(c, { requirement: 'MWS-CFG-4', tool: '(server)', case: 'setting', method: 'launch', steps: [], verdict: 'not tested', reason: 'the declaration names no allow-list setting', reason_code: 'declaration_missing' });
  else {
    const read = c.tools.find((t) => c.ann(t.name)['readOnlyHint'] === true)?.name ?? c.tools[0]?.name ?? 'x';
    const value = `${read},mwsmin_no_such_tool`;
    const up = await started({ [allow.env]: value });
    T(c, { requirement: 'MWS-CFG-4', tool: '(server)', case: `${allow.env}=${value}`, method: 'launch', steps: [], verdict: up ? 'violated' : 'held', reason: up ? 'the server started with an unknown name in the allow-list' : 'the server did not start with an unknown name in the allow-list' });
  }
  await c.restart();
}

export type { Base };
