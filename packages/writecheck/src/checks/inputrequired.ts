/**
 * MWS-RETRY-3: a tool that answers with an input_required result (revision 2026-07-28) must not have put the
 * write into effect in that call. The declaration says how to bring the result about (resource.input_required:
 * the tool, its arguments, and the answers to send on the retry).
 *
 *   black-box        read the object; call the tool (it must answer input_required); read again and compare;
 *                    retry under a new request id with the answers and the requestState; read again.
 *                    violated (the state changed before the retry) or not observed (spec 8.2, rule 8)
 *   proxy-assisted   with the backend gate: the backend requests from the start of the call to the result.
 *                    held when none was a write the backend accepted; a write the backend accepted is not
 *                    judged here (it may be staged state that the retry completes), unless the black-box
 *                    read showed the declared state changed
 */

import type { ResourceSpec } from '../core/manifest.js';
import { render } from '../core/template.js';
import { deepEqual, diff, getPath, short, withoutIgnored } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { scratch } from './scratch.js';
import { brief, notRun, toolByName, wp, type CallBrief, type CheckModule, type Observation, type PlanContext, type PlannedCheck, type RunContext } from './types.js';

const ID = 'input-required';
const VERSION = '1';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface IrObs {
  tool: string;
  skipped?: string;
  first: CallBrief | null;
  changed_before_retry: string[] | null;
  /** The declared effect of the write (input_required.effect) was in effect before the retry. */
  effect_before_retry?: boolean | null;
  retry: CallBrief | null;
  changed_after_retry: string[] | null;
  /** Backend requests from the start of the call to the input_required result (gate only). */
  backend: { method: string; path: string; status: number | null }[] | null;
  steps: string[];
}

export const inputRequiredCheck: CheckModule = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-RETRY-3'],
  plan(ctx: PlanContext, res: ResourceSpec): PlannedCheck {
    const base: PlannedCheck = { check: ID, version: VERSION, resource: res.name, runs: false, calls: [], writes: 0, creates: 0, notRun: [] };
    const irs = res.input_required ?? [];
    if (!irs.length) return base;
    const nr: Result[] = [];
    const calls: string[] = [];
    for (const ir of irs) {
      const w = wp(res.name, ir.tool);
      if (!toolByName(ctx.tools, ir.tool)) nr.push(...notRun(this, ['MWS-RETRY-3'], w, 'not tested', `${ir.tool} is not in tools/list`));
      else if (!res.create || !res.cleanup || res.cleanup === 'leave') nr.push(...notRun(this, ['MWS-RETRY-3'], w, 'not tested', 'needs a create block and a cleanup policy (it uses a scratch object)'));
      else calls.push(`scratch object; ${res.read.tool}; ${ir.tool} (expects input_required); ${res.read.tool}; ${ir.tool} again with the answers and requestState; ${res.read.tool}`);
    }
    return { ...base, runs: calls.length > 0, calls, writes: calls.length * 3, creates: calls.length, notRun: nr };
  },
  async collect(ctx: RunContext, res: ResourceSpec): Promise<Observation> {
    const out: IrObs[] = [];
    const label = ctx.label('IR');
    for (const ir of res.input_required ?? []) {
      if (!toolByName(ctx.tools, ir.tool)) continue;
      const o: IrObs = { tool: ir.tool, first: null, changed_before_retry: null, retry: null, changed_after_retry: null, backend: null, steps: [] };
      out.push(o);
      const s = await scratch(ctx, res, { tag: 'ir', purpose: `MWS-RETRY-3 ${ir.tool}`, label });
      if (!s.ok) {
        o.skipped = `scratch object: ${s.reason}`;
        continue;
      }
      const d = s.driver!;
      const r0 = await d.readOnce(label, ctx.session.stepId('retry3.read'));
      if (!r0.ok) {
        o.skipped = 'the object did not read back before the call';
        continue;
      }
      const args = render(ir.args, d.vars({ object: r0.obj, version: r0.version }));
      const meta = { 'io.modelcontextprotocol/clientCapabilities': ir.client_capabilities };
      const mark = ctx.gate ? ctx.gate.mark() : null;
      const step1 = ctx.session.stepId('retry3.call');
      const c1 = await ctx.session.call(label, ir.tool, args, { step: step1, meta });
      o.first = brief(c1);
      o.steps.push(step1);
      if (ctx.gate && mark !== null) o.backend = (await ctx.gate.since(mark)).map((q) => ({ method: q.method, path: q.path, status: q.status }));
      if (c1.result_type !== 'input_required') continue;
      const r1 = await d.readOnce(label, ctx.session.stepId('retry3.read2'));
      const ign = res.read.ignore;
      o.changed_before_retry = r1.ok ? withoutIgnored(diff(r0.obj, r1.obj), ign).map((e) => e.path) : null;
      if (ir.effect) o.effect_before_retry = r1.ok ? deepEqual(getPath(r1.obj, ir.effect.path), ir.effect.value) && !deepEqual(getPath(r0.obj, ir.effect.path), ir.effect.value) : null;
      const step2 = ctx.session.stepId('retry3.retry');
      const params: Record<string, unknown> = { inputResponses: ir.answers, ...(c1.input_required?.requestState ? { requestState: c1.input_required.requestState } : {}) };
      const c2 = await ctx.session.call(label, ir.tool, args, { step: step2, meta, params });
      o.retry = brief(c2);
      o.steps.push(step2);
      const r2 = await d.readOnce(label, ctx.session.stepId('retry3.read3'));
      o.changed_after_retry = r2.ok && r1.ok ? withoutIgnored(diff(r1.obj, r2.obj), ign).map((e) => e.path) : null;
    }
    return { check: ID, version: VERSION, resource: res.name, data: { tools: out } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    const res = ctx.manifest.resources.find((r) => r.name === obs.resource)!;
    return inputRequiredVerdicts((obs.data as { tools: IrObs[] }).tools, res);
  },
};

export function inputRequiredVerdicts(obs: IrObs[], res: ResourceSpec): Result[] {
  const sc = { id: ID, version: VERSION };
  const scp = { id: `${ID}.proxy`, version: VERSION };
  const out: Result[] = [];
  for (const o of obs) {
    const w = wp(res.name, o.tool);
    if (o.skipped) {
      out.push(result('MWS-RETRY-3', w, sc, 'not tested', o.skipped));
      continue;
    }
    if (!o.first || (o.first.indeterminate && o.first.result_type !== 'input_required')) {
      out.push(result('MWS-RETRY-3', w, sc, 'not tested', 'the first call\'s outcome is unknown'));
      continue;
    }
    if (o.first.result_type !== 'input_required') {
      out.push(result('MWS-RETRY-3', w, sc, 'not tested', `${o.tool} did not answer with an input_required result (${o.first.result_type ?? (o.first.ok ? 'a complete result' : 'an error')}: ${short(o.first.text ?? o.first.rpc_error?.message ?? '', 120)}); the declaration's way to bring it about did not work, or the session did not negotiate revision 2026-07-28`));
      continue;
    }
    const retryNote = o.retry ? `The retry with the answers ${o.retry.ok ? 'succeeded' : 'did not succeed'}${o.changed_after_retry ? ` and changed ${o.changed_after_retry.join(', ') || 'nothing'}` : ''}.` : 'No retry was sent.';
    if (o.changed_before_retry === null) out.push(result('MWS-RETRY-3', w, sc, 'not tested', 'the object did not read back after the input_required result'));
    else if (o.effect_before_retry === true) out.push(result('MWS-RETRY-3', w, sc, 'violated', `${o.tool} answered input_required, but before the retry the write the caller asked for was already in effect (${o.changed_before_retry.join(', ')}).`, { steps: o.steps.slice(0, 1), notes: [retryNote] }));
    // why: state staged before the result is part of the write unless the retry completes it (spec MWS-RETRY-3).
    else if (o.changed_before_retry.length && (!o.retry || !o.retry.ok)) out.push(result('MWS-RETRY-3', w, sc, 'violated', `${o.tool} answered input_required, and before the retry the object had already changed (${o.changed_before_retry.join(', ')}); the retry did not complete it.`, { steps: o.steps, notes: [retryNote] }));
    else if (o.changed_before_retry.length) out.push(result('MWS-RETRY-3', w, sc, 'not tested', `${o.tool} answered input_required and the object changed before the retry (${o.changed_before_retry.join(', ')}), but not in the declared effect of the write; whether it was staged state the retry completed is not established in this preview`, { notes: [retryNote] }));
    else out.push(result('MWS-RETRY-3', w, sc, 'not observed', `${o.tool} answered input_required and the object read back unchanged before the retry. The black-box test sees only the state it reads (spec 8.2, rule 8).`, { notes: [retryNote] }));
    if (o.backend) {
      const writes = o.backend.filter((q) => MUTATING.has(q.method.toUpperCase()) && q.status !== null && q.status < 400);
      if (!writes.length) out.push(result('MWS-RETRY-3', w, scp, 'held', `No backend request the server made before the input_required result was a write the backend accepted (${o.backend.length} request(s) seen at the gate).`));
      else if (o.changed_before_retry?.length) out.push(result('MWS-RETRY-3', w, scp, 'violated', `Before the input_required result the server sent ${writes.map((q) => `${q.method} ${q.path} (${q.status})`).join(', ')}, and the declared state changed.`, { steps: o.steps.slice(0, 1) }));
      else out.push(result('MWS-RETRY-3', w, scp, 'not tested', `Before the input_required result the server sent ${writes.map((q) => `${q.method} ${q.path} (${q.status})`).join(', ')}; whether that was staged state the retry completes is not established in this preview`));
    }
  }
  return out;
}
