/**
 * Coverage rows: every declared write tool gets a record for each per-tool requirement. Where no check
 * exercised a tool for a requirement, the record is `not tested` with the reason, so that a `held` on one
 * tool is never read as covering another (a report that is silent about a tool says nothing about it).
 */

import type { Manifest, ResourceSpec } from '../core/manifest.js';
import { isObj } from '../core/util.js';
import { REQUIREMENTS, type RequirementId } from '../requirements.js';
import { result, writePathKey, type Result } from '../report/verdicts.js';
import { annotations, wp, type Tool } from './types.js';

const SC = { id: 'coverage', version: '1' };
/** Requirements judged per write tool. */
export const PER_TOOL: RequirementId[] = ['MWS-RES-1', 'MWS-RES-2', 'MWS-IN-1', 'MWS-IN-2', 'MWS-IN-3', 'MWS-IN-4', 'MWS-IN-6', 'MWS-IN-7'];

function toolsIn(v: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(v)) for (const x of v) toolsIn(x, out);
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'tool' && typeof x === 'string') out.add(x);
      else toolsIn(x, out);
    }
  }
  return out;
}

function readTools(res: ResourceSpec): string[] {
  const r = res as unknown as Record<string, unknown>;
  const pick = (o: unknown): string | null => (isObj(o) && typeof o['tool'] === 'string' ? o['tool'] : null);
  const scope = isObj(r['scope']) ? r['scope'] : null;
  const creates = Array.isArray(r['creates']) ? (r['creates'] as unknown[]) : [];
  return [pick(r['read']), pick(r['list']), scope ? pick(scope['list']) : null, ...creates.map((c) => (isObj(c) ? pick(c['find']) : null))].filter((x): x is string => !!x);
}

/** The declared write tools, each with the resource it is declared under ('(manifest)' for top-level calls). */
export function declaredWriteTools(m: Manifest, tools: Tool[]): Map<string, string> {
  const ro = new Set<string>();
  for (const res of m.resources) for (const t of readTools(res)) ro.add(t);
  for (const t of tools) if (annotations(t)['readOnlyHint'] === true) ro.add(t.name);
  const out = new Map<string, string>();
  for (const res of m.resources) for (const t of toolsIn(res, new Set())) if (!ro.has(t) && !out.has(t)) out.set(t, res.name);
  const calls = (m as unknown as Record<string, unknown>)['calls'];
  if (isObj(calls)) for (const [t, c] of Object.entries(calls)) if (!ro.has(t) && !out.has(t)) out.set(t, isObj(c) && typeof c['resource'] === 'string' ? c['resource'] : '(manifest)');
  return out;
}

/** Arguments that point at the run's own object or prefix: the only `calls` entries the annotation checks make (annotations.ts). */
export const namesRunObject = (args: unknown): boolean => /\{\{\s*(id|prefix|marker|object)[.}\s]/.test(JSON.stringify(args));

/**
 * The tools the launch checks (MWS-CFG-2, MWS-CFG-3) call besides the declared write tools: each tool with an entry in the
 * manifest's `calls` that declaredWriteTools leaves out because it is marked read-only (readOnlyHint: true in tools/list, or a
 * read tool of a resource), where the entry's arguments name an object of the run, as the annotation checks require. A read-only
 * mode that lets such a tool write is the case MWS-CFG-3 is for ("whatever that tool's annotations declare"). A tool marked
 * read-only with no `calls` entry is not called: there are no safe arguments for it. The value says how the tool is marked.
 * Kept apart from declaredWriteTools, which the coverage rows and the other checks use.
 */
export function readOnlyMarkedCalls(m: Manifest, tools: Tool[]): Map<string, string> {
  const declared = declaredWriteTools(m, tools);
  const out = new Map<string, string>();
  const calls = (m as unknown as Record<string, unknown>)['calls'];
  if (!isObj(calls)) return out;
  for (const [t, c] of Object.entries(calls)) {
    if (declared.has(t) || !isObj(c) || !namesRunObject(c['args'])) continue;
    const tool = tools.find((x) => x.name === t);
    out.set(t, tool && annotations(tool)['readOnlyHint'] === true ? 'annotated readOnlyHint: true' : 'a read tool of the manifest');
  }
  return out;
}

export function coverageRows(m: Manifest, tools: Tool[], results: Result[]): Result[] {
  const out: Result[] = [];
  const offered = new Set(tools.map((t) => t.name));
  for (const [tool, resource] of declaredWriteTools(m, tools)) {
    for (const req of PER_TOOL) {
      if (results.some((r) => r.requirement === req && r.write_path.tool === tool)) continue;
      out.push(result(req, wp(resource, tool), SC, 'not tested', offered.has(tool) ? `${tool} was not exercised for ${req}: not built in this preview` : `${tool} is not in tools/list`));
    }
  }
  // MWS-CONC-2 applies to each tool that replaces a whole object, deletes, or accepts a version.
  for (const res of m.resources) {
    const r = res as unknown as Record<string, unknown>;
    const ts = new Set<string>();
    if (res.delete) ts.add(res.delete.tool);
    if (res.update && (res.update.mode === 'full_replace' || res.version)) ts.add(res.update.tool);
    for (const v of Array.isArray(r['versioned']) ? (r['versioned'] as unknown[]) : []) if (isObj(v) && typeof v['tool'] === 'string') ts.add(v['tool']);
    for (const tool of ts) {
      // why: research builds N6: a record for the same tool on another resource (a versioned delete there) does not cover this one.
      const mine = (x: Result) => x.requirement === 'MWS-CONC-2' && x.write_path.tool === tool && x.write_path.resource === res.name;
      if (results.some(mine) || out.some(mine)) continue;
      out.push(result('MWS-CONC-2', wp(res.name, tool), SC, 'not tested', offered.has(tool) ? `${tool} was not exercised with a stale write: not built in this preview` : `${tool} is not in tools/list`));
    }
  }
  return out;
}

/**
 * Adjustments that need the whole run: a declared explicit override in the update arguments takes MWS-CONC-1's default-arguments
 * arm away (NF-7; gate-2 Grafana item 4); an apply with field ownership leaves MWS-CONC-2 open (gate-2 K8s B7); and a `held`
 * beside a `violated` for the same requirement and write path says that the other trial decides.
 */
export function adjustResults(m: Manifest, results: Result[]): Result[] {
  return results.map((r) => {
    const res = m.resources.find((x) => x.name === r.write_path.resource);
    const u = res?.update;
    if (u && r.write_path.tool === u.tool) {
      if (u.override && r.requirement === 'MWS-CONC-1' && (r.verdict === 'violated' || r.verdict === 'held')) return { ...r, verdict: 'not tested' as const, attribution: null, reason: `the declared update arguments set the explicit override ${u.override} (spec NF-7), so the call with default arguments that MWS-CONC-1 asks for was not made; the run that was made would have given ${r.verdict}`, steps: [] };
      if (u.apply && r.requirement === 'MWS-CONC-2' && r.verdict !== 'not tested' && r.verdict !== 'not applicable') return { ...r, verdict: 'not tested' as const, attribution: null, reason: `${u.tool} sends an apply with field ownership (declared update.apply); how MWS-CONC-2 applies to it is an open question for the spec, so no verdict is given (the run that was made would have given ${r.verdict})`, steps: [] };
    }
    const NOTE = 'Another trial on this write path gives violated, and that record decides; this one covers only its own trial.';
    if (r.verdict === 'held' && !r.notes.includes(NOTE) && results.some((x) => x.requirement === r.requirement && x.verdict === 'violated' && writePathKey(x.write_path) === writePathKey(r.write_path))) return { ...r, notes: [...r.notes, NOTE] };
    return r;
  });
}

/** The reason the first-write rule gives (postEvaluate); recheck reads it back from a file written before first_write was kept. */
const FIRST_WRITE_REASON = 'the first write after the create';

/**
 * The whole-run adjustments made after the checks' evaluate(), one step for `run` and `recheck` (review M3), so a recheck by the
 * build that made the run gives the run's verdicts: the first write after a create that changed fields it did not name keeps
 * MWS-UPD-1 from `held`; then adjustResults (a declared explicit override for MWS-CONC-1, an apply with
 * field ownership for MWS-CONC-2, and the note on a held record beside a violated one). Idempotent.
 */
export function postEvaluate(m: Manifest, results: Result[], firstWrite: ReadonlyMap<string, string[]>): Result[] {
  const out = results.map((r) => {
    const moved = firstWrite.get(r.write_path.resource);
    const res = m.resources.find((x) => x.name === r.write_path.resource);
    if (!moved || !res?.update || !res.fields || r.requirement !== 'MWS-UPD-1' || r.verdict !== 'held' || r.write_path.tool !== res.update.tool) return r;
    return { ...r, verdict: 'not tested' as const, reason: `${FIRST_WRITE_REASON} (a setup write naming only ${res.fields[0].path}) changed fields it did not name: ${moved.slice(0, 5).join(', ')}; the compared reads come after the setup writes, and judging that first write against the platform is not built in this preview`, notes: [...r.notes, `Later writes changed only the fields they named: ${r.reason}`] };
  });
  return adjustResults(m, out);
}

/** The first-write findings of a recorded run: from its observations (first_write), else read back from its records' reasons. */
export function firstWriteOf(observations: { resource?: string; first_write?: string[] }[], recorded: Result[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const o of observations) if (o.resource && Array.isArray(o.first_write) && o.first_write.length) out.set(o.resource, o.first_write);
  for (const r of recorded) {
    if (r.requirement !== 'MWS-UPD-1' || r.verdict !== 'not tested' || !r.reason.startsWith(FIRST_WRITE_REASON) || out.has(r.write_path.resource)) continue;
    const m = /changed fields it did not name: (.*?); the compared reads/.exec(r.reason);
    if (m) out.set(r.write_path.resource, m[1]!.split(', '));
  }
  return out;
}

/** What the declaration must give for a requirement's test to run, where a run made no record for it (writesafe self-test T5). */
const WHAT: Partial<Record<string, string>> = {
  'MWS-UPD-2': 'a list_edit block (a tool that edits one element of a list held inside the object)',
  'MWS-TGT-1': 'a scope block (a container argument and a list call per scope)',
  'MWS-TGT-2': 'a scope block and a selector block (a delete or bulk tool with a selector)',
  'MWS-TGT-3': 'a key block (a create with a caller-chosen key)',
  'MWS-RETRY-3': 'an input_required block (a tool that answers input_required)',
  'MWS-ANN-1': 'resources whose tools the annotation checks call (read-only and write tools with calls or resource blocks)',
  'MWS-ANN-2': 'resources whose tools the annotation checks call (an additive tool, or a create with a key)',
  'MWS-ANN-3': 'resources whose tools the annotation checks call (an idempotent tool called twice)',
  'MWS-ANN-5': 'resources whose tools the annotation checks call (an additive tool)',
};

/**
 * Spec 5.3 (writesafe self-test T5): every requirement has a record in the results. A requirement no check made a record for,
 * and that is not listed as not built, gets one `not tested` record saying what the declaration would need to give.
 */
export function everyRequirement(results: Result[], notBuilt: { requirement: string }[], stopped: string | null = null): Result[] {
  const have = new Set([...results.map((r) => r.requirement), ...notBuilt.map((n) => n.requirement)]);
  return REQUIREMENTS.map((r) => r.id as RequirementId).filter((id) => !have.has(id)).map((id) => result(id, { resource: '(declaration)', tool: '(none)', arm: 'mcp' }, { id: 'coverage', version: '1' }, 'not tested', stopped ? `no check of this run made a record for ${id} before the run stopped (${stopped})` : `no check of this run made a record for ${id}: the declaration gives nothing its test needs${WHAT[id] ? ` (it needs ${WHAT[id]})` : ''}`));
}
