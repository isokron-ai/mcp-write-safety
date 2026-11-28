/**
 * Min mode: run the MCP-layer requirements of MWS against a mock of the backend made from its OpenAPI description.
 *
 *   1. Read the description (OpenAPI 3.x), build the mock, seed it, listen inside the sandbox.
 *   2. Accept the plan by rule only when every target the server is given is the mock (owner decision 27 Nov); any other
 *      target is refused and every requirement is `not tested`, reason code `target_not_standin`.
 *   3. Start the server with its base-URL variables pointed at the mock and canary credentials, read its tools, find a
 *      base call for each, run the checks (src/min/checks.ts).
 *   4. Combine the trials per requirement and tool (spec 8.2 rule 13), then apply the caps of requirements-min.json:
 *      `not_testable_mock` requirements are never held or violated; `partial` ones never held.
 *
 * The result is `mws-min-results/1`, with `mode: "min"`, the spec used (URL and sha256) and the requirements that ran.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { REQUIREMENTS, SPEC_VERSION, requirement as reqInfo } from '../requirements.js';
import { isObj, type Obj } from '../core/util.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import * as K from './checks.js';
import { Ctx, type Trial, type Verdict } from './context.js';
import { EMPTY_DECLARATION, type MinDeclaration } from './declaration.js';
import { Mock } from './mock.js';
import type { ServerSpec } from './mcp.js';
import { buildModel, loadDescription } from './openapi.js';
import MIN_DATA from './requirements-min.json' with { type: 'json' };

export type MinStatus = 'run' | 'partial' | 'not_testable_mock';
export const MIN_RESULTS_FORMAT = 'mws-min-results/1';
export const BASIS = 'stateful-mock';

export const MIN_REQUIREMENTS: Record<string, { min: MinStatus; why: string }> = (MIN_DATA as { requirements: Record<string, { min: MinStatus; why: string }> }).requirements;
export const minStatus = (id: string): MinStatus => MIN_REQUIREMENTS[id]?.min ?? 'not_testable_mock';

export interface MinRecord {
  requirement: string;
  level: 'MUST' | 'SHOULD';
  tool: string;
  case: string | null;
  verdict: Verdict;
  /** `not_testable_mock` where the mock cannot judge the requirement (the cap), else absent. */
  status?: 'not_testable_mock';
  reason_code?: string;
  reason: string;
  basis: typeof BASIS;
  method: Trial['method'];
  answer?: boolean;
  steps: string[];
  numbers: Obj;
  notes: string[];
}

export interface MinOptions {
  spec: string;
  specUrl?: string | null;
  server: ServerSpec;
  /** Env names to point at the mock (base URLs). */
  baseUrlEnv: string[];
  /** Env names the server reads; a URL-like name gets the mock, any other a canary. */
  envNames?: string[];
  /** Literal values the operator sets (never credentials); a URL-like value that is not the mock refuses the plan. */
  set?: Record<string, string>;
  declaration?: MinDeclaration;
  out?: string | null;
  listen?: { host: string; port: number; advertised?: string };
  timeoutMs?: number;
  /** Test only: turn a protection off, so that a mutation check can show the test that pins it goes red. */
  mutate?: { cap?: boolean };
  log?: (l: string) => void;
}

const URLISH = /(_URL|_URI|_HOST|_ENDPOINT|_BASE_URL|_ADDR|_BASE|_API|_SERVER)$/;
const SECRETISH = /(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION|PAT)/;

/** Combines trials into one record per requirement, tool and case (spec 8.2 rule 13). */
export function combine(trials: Trial[]): MinRecord[] {
  const groups = new Map<string, Trial[]>();
  for (const t of trials) {
    const k = `${t.requirement}\u0000${t.tool}\u0000${t.case}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const out: MinRecord[] = [];
  for (const ts of groups.values()) {
    const pick = (v: Verdict) => ts.find((t) => t.verdict === v);
    // violated where any trial is; held where one held and none was only not observed; then the review answer, a search, n/a.
    const first = pick('violated') ?? (pick('held') && !pick('not observed') ? pick('held') : undefined) ?? pick('self-attested') ?? pick('not observed') ?? pick('held') ?? pick('not applicable') ?? ts[0]!;
    const t0 = ts[0]!;
    out.push({
      requirement: t0.requirement,
      level: reqInfo(t0.requirement).level,
      tool: t0.tool,
      case: t0.case,
      verdict: first.verdict,
      ...(first.reason_code ? { reason_code: first.reason_code } : {}),
      reason: first.reason,
      basis: BASIS,
      method: first.method,
      ...(first.answer !== undefined ? { answer: first.answer } : {}),
      steps: [...new Set(ts.flatMap((t) => t.steps))],
      numbers: { trials: ts.length, ...Object.fromEntries(['violated', 'held', 'not tested', 'not observed'].map((v) => [v.replace(' ', '_'), ts.filter((t) => t.verdict === v).length])), ...(first.numbers ?? {}) },
      notes: ts.filter((t) => t !== first).map((t) => `${t.verdict}: ${t.reason}`).slice(0, 5),
    });
  }
  return out;
}

/**
 * The min-mode caps. Requirements the mock cannot judge (`not_testable_mock`) get one record, `not tested` with status
 * `not_testable_mock` and reason code `backend_semantics_not_exercised`, whatever the checks said; `partial` ones keep a
 * `violated` and turn every other verdict into that same `not tested` (an observable part that held is a note). A
 * requirement with no record gets `not tested`. This is the false-pass guard: it is applied last, to every record.
 */
export function applyCaps(records: MinRecord[], o: { off?: boolean } = {}): MinRecord[] {
  if (o.off) return records;
  const out: MinRecord[] = [];
  for (const r of REQUIREMENTS) {
    const st = minStatus(r.id);
    const mine = records.filter((x) => x.requirement === r.id);
    const capped = (why: string, notes: string[] = []): MinRecord => ({ requirement: r.id, level: r.level, tool: '(server)', case: null, verdict: 'not tested', status: 'not_testable_mock', reason_code: 'backend_semantics_not_exercised', reason: `not testable against a mock: ${why}`, basis: BASIS, method: 'black-box', steps: [], numbers: {}, notes });
    if (st === 'not_testable_mock') {
      out.push(capped(MIN_REQUIREMENTS[r.id]!.why, mine.length ? [`${mine.length} record(s) of the checks were replaced by this cap`] : []));
      continue;
    }
    if (st === 'partial') {
      const vio = mine.filter((x) => x.verdict === 'violated');
      if (vio.length) out.push(...vio);
      else out.push(capped(MIN_REQUIREMENTS[r.id]!.why, mine.map((x) => `${x.tool}${x.case ? ` (${x.case})` : ''}: ${x.verdict}: ${x.reason}`).slice(0, 8)));
      continue;
    }
    if (mine.length) out.push(...mine);
    else out.push({ requirement: r.id, level: r.level, tool: '(server)', case: null, verdict: 'not tested', reason_code: 'no_applicable_call', reason: 'min mode found no tool and call this requirement applies to (or the base call of each such tool did not succeed against the mock)', basis: BASIS, method: 'black-box', steps: [], numbers: {}, notes: [] });
  }
  return out;
}

/** The guard as a check: a min-mode document that holds or violates a requirement the mock cannot judge is refused. */
export function capViolations(doc: { results: MinRecord[] }): string[] {
  const bad: string[] = [];
  for (const r of doc.results) {
    const st = minStatus(r.requirement);
    if (st === 'not_testable_mock' && r.verdict !== 'not tested') bad.push(`${r.requirement} ${r.tool}: ${r.verdict} (min mode cannot judge it)`);
    if (st === 'not_testable_mock' && r.status !== 'not_testable_mock') bad.push(`${r.requirement} ${r.tool}: not marked not_testable_mock`);
    if (st === 'partial' && (r.verdict === 'held' || r.verdict === 'not observed')) bad.push(`${r.requirement} ${r.tool}: ${r.verdict} (min mode judges only its violated half)`);
  }
  for (const r of REQUIREMENTS) if (minStatus(r.id) === 'not_testable_mock' && !doc.results.some((x) => x.requirement === r.id)) bad.push(`${r.id}: no record (a requirement min mode cannot judge must say so: not_testable_mock)`);
  return bad;
}

export interface MinDoc {
  format: typeof MIN_RESULTS_FORMAT;
  mode: 'min';
  coverage_class: 'min';
  basis: typeof BASIS;
  suite: { name: string; version: string };
  mws: string;
  spec: { url: string | null; sha256: string; title: string; version: string; file: string; unexpressed: string[] };
  plan: { targets: string[]; accepted: boolean; accepted_by: 'rule' | null; rule: string; refused: string[] };
  mock: { kind: 'writecheck-min-mock/1'; url: string; routing: string; requests: number; unmatched: string[]; unmodelled: string[]; problems: string[] };
  server: { command: string; env_names: string[]; protocol: string | null; started: boolean; start_problem: string | null; tools: number };
  requirements: { run: string[]; partial: string[]; not_testable_mock: string[] };
  faults_injected: { id: string; step: string | null; seq: number; method: string; template: string | null; kind: string; status: number | null }[];
  declaration: { source: string | null; dropped_guessed: string[] };
  results: MinRecord[];
  notes: string[];
  run: { started_at: string; finished_at: string; status: 'complete' | 'refused' | 'server_did_not_start' };
}

/** Builds the server's environment: base URLs to the mock, canaries for anything secret-like, dummies for the rest. */
export function serverEnv(o: { mockUrl: string; baseUrlEnv: string[]; envNames: string[]; set: Record<string, string>; base: Record<string, string> }): { env: Record<string, string>; canaries: string[]; targets: string[]; refused: string[] } {
  const env: Record<string, string> = { ...o.base };
  const canaries: string[] = [];
  const targets = new Set<string>();
  const refused: string[] = [];
  for (const n of o.baseUrlEnv) {
    env[n] = o.mockUrl;
    targets.add(o.mockUrl);
  }
  for (const n of o.envNames) {
    if (n in env) continue;
    if (URLISH.test(n)) {
      env[n] = o.mockUrl;
      targets.add(o.mockUrl);
    } else if (SECRETISH.test(n)) {
      const c = `mwsmin-canary-${randomBytes(12).toString('hex')}`;
      env[n] = c;
      canaries.push(c);
    } else env[n] = 'mwsmin-dummy';
  }
  for (const [k, v] of Object.entries(o.set)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !v.startsWith(o.mockUrl)) refused.push(`${k} names ${v.replace(/\/\/[^@/]*@/, '//***@')}, which is not the min-mode mock`);
    env[k] = v;
  }
  return { env, canaries, targets: [...targets], refused };
}

export async function runMin(o: MinOptions): Promise<MinDoc> {
  const log = o.log ?? (() => {});
  const started = new Date().toISOString();
  const { doc, bytes } = loadDescription(o.spec);
  const model = buildModel(doc, bytes);
  const mock = new Mock(model);
  mock.seed();
  const url = await mock.listen(o.listen?.host ?? '127.0.0.1', o.listen?.port ?? 0, o.listen?.advertised);
  const decl = o.declaration ?? EMPTY_DECLARATION;
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'SYSTEMROOT', 'NODE_EXTRA_CA_CERTS']) if (process.env[k] !== undefined) base[k] = process.env[k]!;
  Object.assign(base, o.server.env);
  const se = serverEnv({ mockUrl: url, baseUrlEnv: o.baseUrlEnv, envNames: o.envNames ?? [], set: o.set ?? {}, base });
  const spec: ServerSpec = { ...o.server, env: { ...se.env, DO_NOT_TRACK: '1' } };
  const ctx = new Ctx(mock, decl, spec, se.canaries, o.timeoutMs ?? 15_000);
  const requirements = { run: [] as string[], partial: [] as string[], not_testable_mock: [] as string[] };
  for (const r of REQUIREMENTS) requirements[minStatus(r.id)].push(r.id);
  let status: MinDoc['run']['status'] = 'complete';
  let startProblem: string | null = null;
  const noTarget = se.targets.length === 0;
  const refused = [...se.refused, ...(noTarget ? ['no base-URL variable points the server at the mock (--base-url-env), so its backend is not known to be the mock'] : [])];
  try {
    if (refused.length) {
      status = 'refused';
      for (const r of REQUIREMENTS) ctx.add({ requirement: r.id, tool: '(server)', case: 'plan', method: 'black-box', verdict: 'not tested', reason: `the plan was not accepted: ${refused.join('; ')}`, reason_code: 'target_not_standin', steps: [] });
    } else {
      startProblem = await ctx.open();
      if (startProblem) {
        status = 'server_did_not_start';
        const tail = ctx.server.stderrTail(5);
        for (const r of REQUIREMENTS) ctx.add({ requirement: r.id, tool: '(server)', case: 'start', method: 'black-box', verdict: 'not tested', reason: `the server did not start against the mock: ${startProblem}${tail ? `; last stderr: ${tail.slice(0, 300)}` : ''}`, reason_code: /token|credential|auth|unauthori[sz]ed|api key/i.test(tail) ? 'start_requires_credentials' : 'start_failed', steps: [] });
      } else {
        log(`min: ${ctx.tools.length} tools; finding a base call for each`);
        K.ann4(ctx);
        await ctx.discover();
        log(`min: ${ctx.writeTools().length} write tool(s) with a base call; ${ctx.noBase.size} tool(s) without one`);
        for (const [name, fn] of [['RES-2', K.res2], ['CONC-4/6', K.conc46], ['RES-3/4', K.res34], ['ATOM-1', K.atom1], ['RETRY-1', K.retry1], ['RETRY-2', K.retry2], ['ANN-3', K.ann3], ['ANN-2/5', K.ann25], ['IN', K.inputs], ['TGT-2', K.tgt2], ['SEC-1 errors', K.sec1Provoke], ['CFG', K.cfg]] as const) {
          log(`min: ${name}`);
          await fn(ctx);
        }
        K.conc5(ctx);
        K.retry3(ctx);
        K.ann1(ctx);
        K.sec1(ctx);
      }
    }
  } finally {
    await ctx.server.stop();
    await mock.close();
  }
  const results = applyCaps(combine(ctx.trials), { off: o.mutate?.cap === false });
  const redact = (s: string) => se.canaries.reduce((a, c) => a.split(c).join('<canary>'), s);
  const out: MinDoc = {
    format: MIN_RESULTS_FORMAT,
    mode: 'min',
    coverage_class: 'min',
    basis: BASIS,
    suite: { name: SUITE_NAME, version: SUITE_VERSION },
    mws: SPEC_VERSION,
    spec: { url: o.specUrl ?? null, sha256: model.sha256, title: model.title, version: model.version, file: o.spec.split('/').pop() ?? o.spec, unexpressed: model.unexpressed },
    plan: { targets: se.targets, accepted: !refused.length, accepted_by: refused.length ? null : 'rule', rule: 'accepted without a person only when every target the server is given is the min-mode mock (owner decision, 27 Nov)', refused },
    mock: { kind: 'writecheck-min-mock/1', url, routing: `base-URL environment variables: ${o.baseUrlEnv.join(', ') || '(none)'}`, requests: mock.records.length, unmatched: [...new Set(mock.records.filter((r) => r.kind === 'unmatched').map((r) => `${r.method} ${r.path}`))].slice(0, 20), unmodelled: [...new Set(mock.records.filter((r) => r.unmodelled).map((r) => `${r.method} ${r.template}`))], problems: mock.problems.slice(0, 20) },
    server: { command: o.server.command.split('/').pop() ?? o.server.command, env_names: Object.keys(spec.env).filter((k) => !(k in base) || k in (o.server.env ?? {})).sort(), protocol: ctx.server.protocol, started: status === 'complete', start_problem: startProblem, tools: ctx.tools.length },
    requirements,
    faults_injected: mock.injected,
    declaration: { source: decl.source ? (decl.source.split('/').pop() ?? null) : null, dropped_guessed: decl.dropped },
    results: JSON.parse(redact(JSON.stringify(results))) as MinRecord[],
    notes: ctx.notes.map(redact).slice(0, 50),
    run: { started_at: started, finished_at: new Date().toISOString(), status },
  };
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, 'results.json'), `${JSON.stringify(out, null, 2)}\n`);
    writeFileSync(join(o.out, 'mock-requests.json'), `${redact(JSON.stringify(mock.records.slice(0, 5000), null, 1))}\n`);
  }
  return out;
}

/** What a min-mode document reports, as "<requirement>:<answer>" (violated, self-attested-no), like the defect matrix reads full runs. */
export function observedMin(doc: { results: MinRecord[] }): string[] {
  const seen = new Set<string>();
  for (const r of doc.results) {
    if (r.verdict === 'violated') seen.add(`${r.requirement}:violated`);
    if (r.verdict === 'self-attested' && r.answer === false) seen.add(`${r.requirement}:self-attested-no`);
  }
  return [...seen].sort();
}

export const isMinDoc = (d: unknown): d is MinDoc => isObj(d) && d['format'] === MIN_RESULTS_FORMAT && d['mode'] === 'min';
