/**
 * F1: the cell universe (docs/CELLS.md). A cell is one MUST requirement on one declared write tool, or one server-level MUST
 * requirement (MWS-CFG-1..3) on the server. Every cell gets at least one record: where no check made one, the cell pass adds
 * `not applicable` (with the written rule that excludes it) or `not tested`. Records are merged per tool across resources and
 * scenarios; read tools are not cells. The pass also removes records written twice word for word (TB-B2-1) and stamps the
 * evidence validity of every violated record (report/validity.ts).
 *
 * Other checks need do nothing to take part: a record whose requirement is a per-tool MUST and whose write_path.tool is a
 * declared write tool lands in the cell `<requirement>@<tool>`, whatever its resource or scenario.
 */

import type { Manifest, ResourceSpec } from '../core/manifest.js';
import { isObj } from '../core/util.js';
import { REQUIREMENTS, type RequirementId } from '../requirements.js';
import { withValidity } from '../report/validity.js';
import { result, type Result, type Validity, type Verdict } from '../report/verdicts.js';
import { declaredWriteTools } from './coverage.js';
import { annotations, type Tool } from './types.js';

export const CELLS_SCENARIO = { id: 'cells', version: '1' } as const;
export const SERVER_CELL = '(server)';
/** Server-level MUST requirements: one cell each, on the server. */
export const SERVER_LEVEL: RequirementId[] = ['MWS-CFG-1', 'MWS-CFG-2', 'MWS-CFG-3'];
/** Per-tool MUST requirements: one cell per declared write tool. */
export const PER_TOOL_MUST: RequirementId[] = REQUIREMENTS.filter((r) => r.level === 'MUST' && !SERVER_LEVEL.includes(r.id)).map((r) => r.id);

export const cellKey = (req: string, tool: string): string => `${req}@${tool}`;

/** What the declaration and the catalog say a write tool does. */
export interface ToolRoles {
  tool: string;
  resources: string[];
  create: boolean;
  /** Creates an object inside another (a `creates` entry: a comment on a ticket). */
  append_create: boolean;
  /** The caller chooses the new object's key (a resource `key` block on this create tool). */
  key_create: boolean;
  patch: boolean;
  replace: boolean;
  delete: boolean;
  selector: boolean;
  multi: boolean;
  list_edit: boolean;
  input_required: boolean;
  /** The tool's arguments in the declaration carry the version the caller read, or its schema has the version argument. */
  versioned: boolean;
  idempotency_key: boolean;
  scope_arg: boolean;
  /** No role is declared for it (a `calls` entry, or a tool only named in another block): in doubt, it modifies. */
  other: boolean;
  args: string[];
  hints: Record<string, unknown>;
}

const schemaProps = (t: Tool | undefined): string[] => {
  const s = t?.inputSchema;
  return isObj(s) && isObj(s['properties']) ? Object.keys(s['properties']) : [];
};
const mentionsVersion = (args: unknown): boolean => /\{\{\s*\??\s*version\s*\}\}/.test(JSON.stringify(args ?? null));

/** Argument names that carry the version the caller read (S1: schema heuristic, in doubt applicable). */
const VERSION_ARG = /version|etag|revision|^rev$|_rev$|if_?match|if_?unmodified|precondition|sha$|^lock_?token$/i;
/** Argument names that usually name a scope or container (S1: schema heuristic for MWS-TGT-1, in doubt applicable). */
const SCOPE_ARG = /^(project|workspace|namespace|org|organization|organisation|team|tenant|space|scope|parent|container|folder|board|repo|repository|database|db|schema|collection|bucket|account|site|environment|env|cluster|zone|region|index|table)(_?(id|key|name|slug))?$/i;

/**
 * The tools that are cells: the declared write tools (coverage.ts), and every tool the manifest gives a write role, whatever its
 * annotations say. A write tool marked readOnlyHint: true keeps its cells, so a violation through it is never dropped (review B3).
 */
export function cellTools(m: Manifest, tools: Tool[]): Map<string, string> {
  const out = new Map(declaredWriteTools(m, tools));
  const add = (tool: string | undefined, res: string) => { if (tool && !out.has(tool)) out.set(tool, res); };
  for (const res of m.resources) {
    add(res.create?.tool, res.name);
    add(res.update?.tool, res.name);
    add(res.delete?.tool, res.name);
    add(res.archive?.tool, res.name);
    add(res.selector?.tool, res.name);
    add(res.list_edit?.tool, res.name);
    add(res.list_edit?.insert.tool, res.name);
    add(res.idempotency?.tool, res.name);
    for (const x of res.versioned) add(x.tool, res.name);
    for (const x of res.no_version_check) add(x, res.name);
    for (const x of res.multi) add(x.tool, res.name);
    for (const x of res.creates) add(x.tool, res.name);
    for (const x of res.input_required) add(x.tool, res.name);
  }
  // A read tool of a resource stays out unless a write role above named it.
  return out;
}

export function toolRoles(m: Manifest, tools: Tool[]): Map<string, ToolRoles> {
  const writes = cellTools(m, tools);
  const out = new Map<string, ToolRoles>();
  const get = (tool: string): ToolRoles | null => {
    if (!writes.has(tool)) return null;
    let r = out.get(tool);
    if (!r) {
      const t = tools.find((x) => x.name === tool);
      r = { tool, resources: [], create: false, append_create: false, key_create: false, patch: false, replace: false, delete: false, selector: false, multi: false, list_edit: false, input_required: false, versioned: false, idempotency_key: false, scope_arg: false, other: false, args: schemaProps(t), hints: annotations(t) };
      out.set(tool, r);
    }
    return r;
  };
  const on = (res: ResourceSpec, tool: string | undefined, f: (r: ToolRoles) => void, args?: unknown) => {
    if (!tool) return;
    const r = get(tool);
    if (!r) return;
    if (!r.resources.includes(res.name)) r.resources.push(res.name);
    if (args !== undefined && mentionsVersion(args)) r.versioned = true;
    f(r);
  };
  for (const res of m.resources) {
    if (res.create) on(res, res.create.tool, (r) => { r.create = true; if (res.key) r.key_create = true; }, res.create.args);
    if (res.update) on(res, res.update.tool, (r) => { if (res.update!.mode === 'full_replace') r.replace = true; else r.patch = true; if (res.version?.arg) r.versioned = true; }, res.update.args);
    if (res.delete) on(res, res.delete.tool, (r) => { r.delete = true; }, res.delete.args);
    if (res.archive) on(res, res.archive.tool, (r) => { r.patch = true; }, res.archive.args);
    for (const v of res.versioned) on(res, v.tool, (r) => { r.versioned = true; r.other = r.other || (!r.patch && !r.replace && !r.delete); }, v.args);
    for (const t of res.no_version_check) on(res, t, () => undefined);
    if (res.selector) on(res, res.selector.tool, (r) => { r.selector = true; r.delete = true; }, res.selector.args);
    for (const x of res.multi) on(res, x.tool, (r) => { r.multi = true; if (x.effect === 'deleted') r.delete = true; else r.patch = true; }, x.args);
    if (res.list_edit) on(res, res.list_edit.tool, (r) => { r.list_edit = true; }, res.list_edit.args);
    for (const c of res.creates) on(res, c.tool, (r) => { r.append_create = true; if (c.idempotency) r.idempotency_key = true; }, c.args);
    if (res.idempotency) on(res, res.idempotency.tool, (r) => { r.idempotency_key = true; if (res.idempotency!.kind === 'create') r.create = true; else if (res.idempotency!.kind === 'append') r.append_create = true; else r.patch = true; });
    for (const x of res.input_required) on(res, x.tool, (r) => { r.input_required = true; }, x.args);
  }
  for (const [tool, resource] of writes) {
    const r = get(tool)!;
    if (!r.resources.length) r.resources.push(resource);
    const res = m.resources.find((x) => r.resources.includes(x.name));
    if (res?.version?.arg && r.args.includes(res.version.arg)) r.versioned = true;
    if (r.args.some((a) => VERSION_ARG.test(a))) r.versioned = true;
    if (res?.scope && r.args.includes(res.scope.arg)) r.scope_arg = true;
    // why: review S1: a scope argument of any resource, or a name that usually names a container, makes MWS-TGT-1 apply.
    if (r.args.some((a) => m.resources.some((x) => x.scope?.arg === a) || SCOPE_ARG.test(a))) r.scope_arg = true;
    if (r.args.some((a) => /idempoten/i.test(a))) r.idempotency_key = true;
    if (!r.create && !r.append_create && !r.patch && !r.replace && !r.delete && !r.list_edit && !r.input_required && !r.multi) r.other = true;
  }
  return out;
}

/** A written applicability rule that excludes a cell: its id (docs/CELLS.md) and the reason printed in the record. */
export interface NotApplicable {
  rule: string;
  reason: string;
}

const modifies = (r: ToolRoles) => r.patch || r.replace || r.list_edit || r.input_required || r.other || (r.multi && !r.delete);
const createOnly = (r: ToolRoles) => (r.create || r.append_create) && !modifies(r) && !r.delete;
const deleteOnly = (r: ToolRoles) => r.delete && !modifies(r) && !r.create && !r.append_create;
const ADDRESS_ARG = /^(position|index|offset|pointer|path)$|_(index|position)$/i;
const SELECTOR_ARG = /^(filter|filters|where|query|selector|match|q|all)$|_(prefix|filter|query)$/i;
const BATCH_ARG = /^(ids|items|objects|operations|updates|batch)$|_ids$/i;
const KEY_ARG = /^(id|key|slug|uid)$/i;

/**
 * The applicability rules, one per requirement (docs/CELLS.md). Null: the cell applies. In doubt, a cell applies: a rule
 * excludes only on what the declaration or the catalog states. A record from a check always overrides a rule where it forces.
 */
export function applicability(req: RequirementId, r: ToolRoles, seenInputRequired: Set<string>): NotApplicable | null {
  const t = r.tool;
  switch (req) {
    case 'MWS-UPD-1':
      if (createOnly(r)) return { rule: 'UPD-1.create', reason: `${t} only creates objects: a new object has no fields the call did not name to keep` };
      if (deleteOnly(r)) return { rule: 'UPD-1.delete', reason: `${t} only deletes: it removes the whole object, no field patch` };
      if (r.replace && !r.patch && !r.other && !r.list_edit && !r.input_required) return { rule: 'UPD-1.replace', reason: `${t} is declared full_replace: a whole-object write is judged by MWS-CONC-2` };
      return null;
    case 'MWS-UPD-2':
      if (r.list_edit || r.args.some((a) => ADDRESS_ARG.test(a))) return null;
      return { rule: 'UPD-2.no-address', reason: `${t} takes no address of a list element (no list_edit block, and no position or index argument in its schema)` };
    case 'MWS-CONC-1':
      if (createOnly(r)) return { rule: 'CONC-1.create', reason: `${t} only creates objects: there is no earlier state whose concurrency control it could bypass` };
      return null;
    case 'MWS-CONC-2':
    case 'MWS-CONC-4': {
      const id = req === 'MWS-CONC-2' ? 'CONC-2' : 'CONC-4';
      if (createOnly(r)) return { rule: `${id}.create`, reason: `${t} only creates objects: no stale base to refuse` };
      if (r.delete || r.replace || r.versioned) return null;
      return { rule: `${id}.no-version`, reason: `${t} takes no version argument and neither replaces a whole object nor deletes: it carries no stale base to refuse` };
    }
    case 'MWS-CONC-3':
      if (createOnly(r)) return { rule: 'CONC-3.create', reason: `${t} only creates objects: no other part of an existing object for a concurrent writer to lose` };
      if (deleteOnly(r)) return { rule: 'CONC-3.delete', reason: `${t} only deletes whole objects: no other part to keep (a stale delete is MWS-CONC-2)` };
      return null;
    case 'MWS-TGT-1':
      return r.scope_arg ? null : { rule: 'TGT-1.no-scope', reason: `${t} takes no scope argument` };
    case 'MWS-TGT-2':
      if (r.selector || r.args.some((a) => SELECTOR_ARG.test(a))) return null;
      return { rule: 'TGT-2.no-selector', reason: `${t} takes no selector (no selector block, and no filter-like argument in its schema)` };
    case 'MWS-TGT-3':
      if (!r.create && !r.append_create) return { rule: 'TGT-3.not-create', reason: `${t} creates nothing` };
      if (r.key_create || r.args.some((a) => KEY_ARG.test(a) && !r.append_create)) return null;
      return { rule: 'TGT-3.server-id', reason: `${t} lets the server choose the new object's identifier (no key block, and no id or key argument in its schema): it cannot name an existing object to overwrite` };
    case 'MWS-RES-1':
    case 'MWS-RES-2':
    case 'MWS-SEC-1':
      return null;
    case 'MWS-RES-3':
      return r.create || r.append_create || r.key_create ? null : { rule: 'RES-3.not-create', reason: `${t} creates no object` };
    case 'MWS-ATOM-1':
      if (r.multi || r.selector || r.args.some((a) => BATCH_ARG.test(a))) return null;
      return { rule: 'ATOM-1.single', reason: `${t} writes one object (no multi or selector block, and no list of objects in its schema)` };
    case 'MWS-RETRY-2':
      return r.idempotency_key ? null : { rule: 'RETRY-2.no-key', reason: `${t} takes no idempotency key` };
    case 'MWS-RETRY-3':
      return r.input_required || seenInputRequired.has(t) ? null : { rule: 'RETRY-3.no-input', reason: `${t} is not declared to answer input_required and did not answer it in this run` };
    case 'MWS-IN-1':
    case 'MWS-IN-2':
    case 'MWS-IN-3':
    case 'MWS-IN-4':
      return r.args.length ? null : { rule: 'IN.no-args', reason: `${t} takes no arguments` };
    case 'MWS-ANN-1':
      return r.hints['readOnlyHint'] === true ? null : { rule: 'ANN-1.hint', reason: `${t} does not declare readOnlyHint: true` };
    case 'MWS-ANN-2':
      return r.hints['destructiveHint'] === false ? null : { rule: 'ANN-2.hint', reason: `${t} does not declare destructiveHint: false` };
    case 'MWS-ANN-3':
      return r.hints['idempotentHint'] === true ? null : { rule: 'ANN-3.hint', reason: `${t} does not declare idempotentHint: true` };
    default:
      return null;
  }
}

/** One cell: the merged view of its records. There is no total anywhere; a cell is one requirement on one tool. */
export interface Cell {
  key: string;
  requirement: RequirementId;
  tool: string;
  scope: 'tool' | 'server';
  verdict: Verdict;
  applicable: boolean;
  /** The applicability rule that excludes the cell (docs/CELLS.md), or null. */
  rule: string | null;
  /** The reason of the record that decides the cell. */
  reason: string;
  resources: string[];
  /** Indexes into results of every record in the cell. */
  records: number[];
  /** For a violated cell: the best validity among its violated records (valid, then platform, then harness-suspect). */
  validity?: Validity['class'];
}

const RANK: Verdict[] = ['violated', 'platform', 'held', 'not observed', 'self-attested'];
const GENERIC = new Set(['coverage', CELLS_SCENARIO.id]);
const isGeneric = (r: Result) => r.verdict === 'not tested' && GENERIC.has(r.scenario.id);

/** Strip the cell pass's own stamps (for a recheck, which runs the pass again). */
const unstamped = (r: Result): Result => {
  const { cell: _c, ...rest } = r;
  return rest;
};
/** A record's identity for the duplicate rule: everything it says (records from one code path share their key order). */
const identity = (r: Result): string => {
  const { cell: _c, validity: _v, ...rest } = r;
  return JSON.stringify(rest);
};

/** TB-B2-1: a record written twice word for word is one record (the second copy says nothing the first does not). */
export function dedupe(results: Result[]): Result[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = identity(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function decide(recs: Result[], rule: NotApplicable | null): { verdict: Verdict; deciding: Result; rule: string | null } {
  // why: review M1: a violated record whose evidence does not count ranks below held; a counted one decides.
  const suspect = (r: Result) => r.verdict === 'violated' && r.validity?.counts === false;
  const counted = recs.filter((r) => r.verdict === 'violated' && !suspect(r));
  if (counted.length) return { verdict: 'violated', deciding: counted[0]!, rule: null };
  for (const v of ['platform', 'held'] as Verdict[]) {
    const hit = recs.filter((r) => r.verdict === v);
    if (hit.length) return { verdict: v, deciding: hit[0]!, rule: null };
  }
  for (const v of RANK) {
    const hit = recs.filter((r) => r.verdict === v);
    if (hit.length) return { verdict: v, deciding: hit[0]!, rule: null };
  }
  const na = recs.filter((r) => r.verdict === 'not applicable');
  const nt = recs.filter((r) => r.verdict === 'not tested');
  if (!nt.length) return { verdict: 'not applicable', deciding: na[0]!, rule: na[0]!.scenario.id === CELLS_SCENARIO.id ? rule?.rule ?? null : null };
  // why: TB-B2-2: a check's not-applicable ruling for a write path beats a not-tested row for the same write path, and beats the
  // generic rows of the coverage and cell passes; a not-tested row from a check on another resource stands (in doubt, applicable).
  if (na.length && nt.every((x) => isGeneric(x) || na.some((y) => y.write_path.resource === x.write_path.resource))) return { verdict: 'not applicable', deciding: na[0]!, rule: null };
  if (!na.length && rule && nt.every(isGeneric)) return { verdict: 'not applicable', deciding: nt[0]!, rule: rule.rule };
  return { verdict: 'not tested', deciding: nt.find((x) => !isGeneric(x)) ?? nt[0]!, rule: null };
}

export interface CellRun {
  stopped: string | null;
  /**
   * Which input records were made after the run was cut short (write budget, rate limit, interrupt): only those fail V-RUN
   * (review R1). run.ts gives the index of the first such record; recheck the records that failed V-RUN before. Absent: the
   * stop reason alone decides (validity.ts cutShortOf), for every record.
   */
  late?: (r: Result, i: number) => boolean;
  /** Tools that answered input_required during the run (spec 7.3 rule 10; results.target.mcp.input_requests). */
  input_required_tools?: string[];
}

/**
 * The cell pass, run once at the end of a run (and by recheck): it removes word-for-word duplicates, adds a record to every
 * cell that has none, stamps `cell` on each record that belongs to a cell and `validity` on each violated record, and returns
 * the cells. Records keep their order; added records go at the end.
 */
export function cellPass(m: Manifest, tools: Tool[], input: Result[], run: CellRun): { results: Result[]; cells: Cell[] } {
  const roles = toolRoles(m, tools);
  const offered = new Set(tools.map((t) => t.name));
  const seen = new Set(run.input_required_tools ?? []);
  // why: review R1: whether a record came after the cut is decided on the input order, before duplicates go and records are added.
  const lateSet = run.late ? new Set(input.filter((r, i) => run.late!(r, i))) : null;
  const lateOf = new Map<Result, boolean>();
  let results = dedupe(input.map((r) => {
    const u = unstamped(r);
    if (lateSet) lateOf.set(u, lateSet.has(r));
    return u;
  }));
  // why: the cells now carry these requirements per tool; the run-wide "no record" row for them would be a second, emptier answer.
  if (roles.size) results = results.filter((r) => !(r.write_path.resource === '(declaration)' && PER_TOOL_MUST.includes(r.requirement)));
  const added: Result[] = [];
  for (const [tool, r] of roles) {
    for (const req of PER_TOOL_MUST) {
      if (results.some((x) => x.requirement === req && x.write_path.tool === tool)) continue;
      const na = applicability(req, r, seen);
      const w = { resource: r.resources[0] ?? '(manifest)', tool, arm: 'mcp' as const };
      if (na) added.push(result(req, w, CELLS_SCENARIO, 'not applicable', `${na.reason} (applicability rule ${na.rule}, docs/CELLS.md)`));
      else added.push(result(req, w, CELLS_SCENARIO, 'not tested', !offered.has(tool) ? `${tool} is not in tools/list` : run.stopped ? `no check made a record for ${req} on ${tool} before the run stopped (${run.stopped})` : `no check of this release exercised ${tool} for ${req}`));
    }
  }
  for (const req of SERVER_LEVEL) {
    if (results.some((x) => x.requirement === req)) continue;
    added.push(result(req, { resource: SERVER_CELL, tool: '(all)', arm: 'mcp' }, CELLS_SCENARIO, 'not tested', run.stopped ? `no check made a record for ${req} before the run stopped (${run.stopped})` : `no check of this run made a record for ${req}: the declaration gives no settings block for it`));
  }
  results = withValidity([...results, ...added], { stopped: run.stopped, ...(lateSet ? { late: (r: Result) => lateOf.get(r) ?? false } : {}) });
  const keyOf = (r: Result): string | null => {
    if (r.level !== 'MUST') return null;
    if (SERVER_LEVEL.includes(r.requirement)) return cellKey(r.requirement, SERVER_CELL);
    return roles.has(r.write_path.tool) && PER_TOOL_MUST.includes(r.requirement) ? cellKey(r.requirement, r.write_path.tool) : null;
  };
  const groups = new Map<string, number[]>();
  results = results.map((r, i) => {
    const k = keyOf(r);
    if (!k) return r;
    groups.set(k, [...(groups.get(k) ?? []), i]);
    return { ...r, cell: k };
  });
  const cells: Cell[] = [];
  for (const [key, idx] of groups) {
    const recs = idx.map((i) => results[i]!);
    const req = recs[0]!.requirement;
    const server = SERVER_LEVEL.includes(req);
    const tool = server ? SERVER_CELL : recs[0]!.write_path.tool;
    const rule = server ? null : applicability(req, roles.get(tool)!, seen);
    const d = decide(recs, rule);
    const cell: Cell = { key, requirement: req, tool, scope: server ? 'server' : 'tool', verdict: d.verdict, applicable: d.verdict !== 'not applicable', rule: d.rule, reason: d.verdict === 'not applicable' && d.rule && d.deciding.scenario.id !== CELLS_SCENARIO.id ? `${rule!.reason} (applicability rule ${d.rule}, docs/CELLS.md)` : d.deciding.reason, resources: [...new Set(recs.map((x) => x.write_path.resource))], records: idx };
    if (d.verdict === 'violated') {
      const cls = recs.filter((x) => x.verdict === 'violated').map((x) => x.validity!.class);
      cell.validity = cls.includes('valid') ? 'valid' : cls.includes('platform') ? 'platform' : 'harness-suspect';
    }
    cells.push(cell);
  }
  const order = (c: Cell) => [c.scope === 'server' ? 1 : 0, c.tool, REQUIREMENTS.findIndex((r) => r.id === c.requirement)] as const;
  cells.sort((a, b) => {
    const x = order(a), y = order(b);
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2];
  });
  return { results, cells };
}

/** The tools that answered input_required in a run, from the record of spec 7.3 rule 10 (results.target.mcp.input_requests). */
export function inputRequiredTools(mcp: unknown): string[] {
  const reqs = isObj(mcp) && Array.isArray(mcp['input_requests']) ? (mcp['input_requests'] as unknown[]) : [];
  return [...new Set(reqs.flatMap((x) => (isObj(x) && typeof x['tool'] === 'string' ? [x['tool']] : [])))];
}
