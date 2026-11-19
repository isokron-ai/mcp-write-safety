/**
 * The plan: everything a run would do, from the manifest and tools/list only. No tool call is made
 * to build it. The plan hash binds a run's confirmation to exactly this plan: the same manifest
 * bytes, the same catalog, the same suite version and the same limits give the same hash; any change
 * gives a new one, and a run started with an old hash is refused.
 */

import { WritecheckError } from './util.js';
import { annVerdicts, catalogFingerprint } from '../checks/catalog.js';
import { CHECKS, GLOBAL_CHECKS } from '../checks/index.js';
import type { PlannedCheck, Tool } from '../checks/types.js';
import { notRun as notRunFor } from '../checks/types.js';
import { REQUIREMENTS, SPEC_VERSION, type RequirementId } from '../requirements.js';
import type { NotRun, Result } from '../report/verdicts.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import { restorableExclusion, type Manifest, type ResourceSpec } from './manifest.js';
import { canonical, sha256 } from './util.js';
import { Redactor } from './redact.js';

export interface ResourcePlan {
  resource: string;
  object: string;
  setup: string[];
  setup_writes: number;
  setup_creates: number;
  checks: PlannedCheck[];
}

export interface Plan {
  format: 'mws-plan/1';
  suite: { name: string; version: string };
  spec: { version: string };
  manifest_sha256: string;
  catalog_fingerprint: string;
  /** `hosts`: every host the run reaches or points the server at, resolved from the environment; part of the hash. */
  target: { environment: string; confirm: string; hosts: string[] };
  limits: Manifest['limits'];
  resources: ResourcePlan[];
  /** Server-wide checks (launch settings, the credential scan), run once after the resources. */
  global: PlannedCheck[];
  catalog_results: Result[];
  /** Requirements this release does not test at all, with the reason. */
  not_built: NotRun[];
  writes_at_most: number;
  creates_at_most: number;
  /** Warnings about the declaration (an ignored field the tool under test can set). */
  warnings: string[];
  /**
   * `session.init`, where declared (absent otherwise, so a manifest without it keeps its plan hash): the calls made on every
   * session before its first other tools/call, with arguments as written (templates, secret-named values masked), and whether
   * each counts as a write.
   */
  session_init?: { tool: string; args: unknown; counted: boolean }[];
}

/**
 * i8: a field that read.ignore or a list's ignore names, and that the tool under test can set, hides a change of a
 * bystander from the inventory. Warned in the plan and the report; for a selector tool in opt-in mode refused, unless the field
 * is also declared server_managed.
 */
/**
 * Spec R15-4 (validator on 2443620): an update tool whose resource declares fields but no restorable gets no MWS-IN-4 counterpart that
 * writes the object, so its probes with such a counterpart are not judged and MWS-IN-1, IN-4 and IN-6 on it are not held.
 */
export function restorableWarnings(manifest: Manifest): string[] {
  return manifest.resources
    .filter((r) => r.update && r.fields && r.fields.length && !r.restorable.length)
    .map((r) => {
      const t = r.update!.tool;
      // why: Action matrix on 7619465: where the loader would refuse restorable, listing it is no help; say why instead.
      const why = restorableExclusion(r, manifest.resources);
      if (why) return `${r.name}: ${why}, so it is not a tool that updates one object named by its identifier (spec R15-4 excludes it): an MWS-IN-4 counterpart control that would write the object is never sent to it, and MWS-IN-1, IN-4 and IN-6 on ${t} will be not judged wherever a probe needs one; listing restorable would not help (the loader refuses it there)`;
      return `${r.name}: ${t} declares fields but no restorable, so an MWS-IN-4 counterpart control that would write the object is not sent (spec R15-4) and MWS-IN-1, IN-4 and IN-6 on ${t} will be not judged wherever a probe needs one; list the arguments the tester may send and put back under restorable (MANIFEST.md, restorable)`;
    });
}

export function ignoreWarnings(manifest: Manifest, tools: Tool[]): { warnings: string[]; refuse: string[] } {
  const warnings: string[] = [];
  const refuse: string[] = [];
  const propsOf = (name: string | undefined) => {
    const t = tools.find((x) => x.name === name);
    const ps = t && typeof t.inputSchema === 'object' && t.inputSchema !== null ? (t.inputSchema as { properties?: Record<string, unknown> }).properties : undefined;
    return ps ? Object.keys(ps) : [];
  };
  for (const res of manifest.resources) {
    const settable = new Map<string, string>();
    for (const t of [res.update?.tool, res.create?.tool, res.selector?.tool, ...res.multi.map((m) => m.tool)]) for (const p of propsOf(t)) if (!settable.has(p)) settable.set(p, t!);
    for (const f of res.fields ?? []) if (res.update) settable.set(f.arg, res.update.tool);
    const ignored = [...res.read.ignore.map((p) => ['read.ignore', p]), ...(res.list?.ignore ?? []).map((p) => ['list.ignore', p]), ...(res.scope?.list.ignore ?? []).map((p) => ['scope.list.ignore', p])] as [string, string][];
    // why: validator re-run on e613620: the id is the address of the call, not a field the tool sets on another object.
    const idPaths = new Set([res.create?.id, res.list?.id, res.scope?.list.id, 'id', ...Object.entries((res.read.args ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.includes('{{id}}')).map(([k]) => k)].filter((x): x is string => typeof x === 'string'));
    for (const [where, p] of ignored) {
      if (idPaths.has(p)) continue;
      const last = p.split('.').pop()!.replace(/\[.*\]$/, '');
      // why: review (15f): a nested path (meta.title) is not the top-level argument of the same last name.
      const tool = settable.get(p) ?? (p.includes('.') ? undefined : settable.get(last));
      if (!tool) continue;
      const managed = res.server_managed.includes(p) || res.server_managed.includes(last);
      if (managed) continue;
      warnings.push(`${res.name}: ${where} names ${p}, which ${tool} can set (its input schema declares ${last}); a change of that field to an object the tester did not create is not seen by the bystander inventory. Declare it in server_managed if the server sets it itself.`);
      if (res.selector?.send_empty_forms) refuse.push(`resources.${res.name}.${where}: ${p} can be set by ${tool}, and ${res.selector.tool} is run in opt-in mode (selector.send_empty_forms): an ignored field would hide a bystander change; declare it in server_managed only if the server sets it itself`);
    }
  }
  return { warnings, refuse };
}

/** Requirements with no automated check in this release: none (each has a check; what a manifest does not declare is `not tested` with the reason). */
export const NOT_BUILT: Partial<Record<RequirementId, string>> = {};

function setupOf(res: ResourceSpec): { object: string; setup: string[]; writes: number; creates: number } {
  if (!res.update || !res.fields) return { object: 'no object under test (no update tool declared); checks create their own objects', setup: [], writes: 0, creates: 0 };
  const set = `${res.update.tool} ${res.fields[0].path} and ${res.fields[1].path} to the baseline (${JSON.stringify(res.fields[0].values[0])}, ${JSON.stringify(res.fields[1].values[0])}); ${res.read.tool}`;
  if (res.fixture) return { object: `fixture ${JSON.stringify(res.fixture.id)} (${res.fixture.name}); its original values are restored at the end`, setup: [`${res.read.tool} the fixture (and record its original values)`, set], writes: 4, creates: 0 };
  const cleanup = res.cleanup ? `cleanup: ${res.cleanup}` : 'no cleanup policy';
  return { object: `one new object named {{prefix}}… (${cleanup})`, setup: [`${res.create!.tool} (ledger intent first); ${res.read.tool} to verify the returned id carries the run prefix`, set], writes: 3, creates: 1 };
}

export interface PlanOptions {
  /** The full catalog (tools, prompts, resource templates) for the fingerprint; defaults to the tools alone. */
  catalog?: { tools: unknown[]; prompts?: unknown[]; resourceTemplates?: unknown[] };
}

/** session.init as the plan states it: a call counts as a write unless declared read_only or marked readOnlyHint: true in tools/list. */
export function sessionInitPlan(manifest: Manifest, tools: Tool[]): Plan['session_init'] {
  const inits = manifest.session?.init;
  if (!inits?.length) return undefined;
  const ro = (name: string) => tools.some((t) => t.name === name && (t as { annotations?: { readOnlyHint?: unknown } }).annotations?.readOnlyHint === true);
  const mask = new Redactor([]);
  return inits.map((c) => ({ tool: c.tool, args: mask.value(c.args), counted: !c.read_only && !ro(c.tool) }));
}

export function buildPlan(manifest: Manifest, tools: Tool[], hosts: string[] = [], o: PlanOptions = {}): Plan {
  const ctx = { manifest, tools, gated: !!manifest.backend?.gate };
  const iw = ignoreWarnings(manifest, tools);
  if (iw.refuse.length) throw new WritecheckError(`manifest refused: ${iw.refuse.join('; ')}`, 2);
  const resources: ResourcePlan[] = [];
  for (const res of manifest.resources) {
    const s = setupOf(res);
    const blocked = !!res.update && !res.fixture && !res.cleanup;
    const checks = CHECKS.filter((c) => !c.needsUpdate || (res.update && res.fields)).map((c) => {
      const p = c.plan(ctx, res);
      if (!blocked || !p.runs) return p;
      // why: with no fixture and no cleanup policy the tester would have to create an object it has no way to remove.
      const w = { resource: res.name, tool: res.update?.tool ?? res.read.tool, arm: 'mcp' as const };
      return { ...p, runs: false, calls: [], writes: 0, creates: 0, notRun: [...p.notRun, ...notRunFor(c, c.requirements.filter((id) => !p.notRun.some((r) => r.requirement === id)), w, 'not tested', 'no fixture and no cleanup policy: the tester will not create an object it has no declared way to clean up')] };
    });
    resources.push({ resource: res.name, object: s.object, setup: blocked ? [] : s.setup, setup_writes: blocked ? 0 : s.writes, setup_creates: blocked ? 0 : s.creates, checks });
  }
  const global = GLOBAL_CHECKS.map((c) => c.plan(ctx));
  const not_built: NotRun[] = REQUIREMENTS.filter((r) => NOT_BUILT[r.id]).map((r) => ({ requirement: r.id, verdict: 'not tested' as const, reason: NOT_BUILT[r.id]! }));
  const writes = resources.reduce((n, r) => n + r.setup_writes + r.checks.reduce((m, c) => m + c.writes, 0), 0) + global.reduce((n, c) => n + c.writes, 0);
  const init = sessionInitPlan(manifest, tools);
  const initWarn = init?.some((c) => c.counted) ? [`session.init: ${init.filter((c) => c.counted).map((c) => c.tool).join(', ')} ${init.filter((c) => c.counted).length === 1 ? 'is' : 'are'} not declared read-only, so each call counts against the write budget, once per MCP session the run opens; that number depends on the run (concurrency pairs, restarts, launch checks, clean-up), so these calls are not in "at most" above, and the run stops if they would exceed the budget`] : [];
  const creates = resources.reduce((n, r) => n + r.setup_creates + r.checks.reduce((m, c) => m + c.creates, 0), 0) + global.reduce((n, c) => n + c.creates, 0);
  return {
    format: 'mws-plan/1',
    suite: { name: SUITE_NAME, version: SUITE_VERSION },
    spec: { version: SPEC_VERSION },
    manifest_sha256: manifest.source.sha256,
    catalog_fingerprint: catalogFingerprint(o.catalog ?? tools),
    target: { environment: manifest.target.environment, confirm: manifest.target.confirm, hosts: [...new Set(hosts)].sort() },
    limits: manifest.limits,
    resources,
    global,
    catalog_results: annVerdicts(tools),
    not_built,
    // why: review B2: a guard call that rests on the operator's declaration counts as a write (three, before any other).
    writes_at_most: writes + (manifest.target.guard?.read_only_call ? 3 : 0),
    creates_at_most: creates,
    // why: review: the operator confirms the plan knowing the tenant guard rests on their own declaration.
    ...(init ? { session_init: init } : {}),
    warnings: [...iw.warnings, ...initWarn, ...restorableWarnings(manifest), ...(manifest.target.guard?.read_only_call ? [`the tenant guard ${manifest.target.guard.tool} ${JSON.stringify(manifest.target.guard.args)} rests on your declaration that this call only reads (target.guard.read_only_call), not on an annotation; it is sent three times before any write, each call counted against the write budget and recorded in the ledger, with the canaries and the declared lists read before and after; between checks the run asks tools/list instead`] : [])],
  };
}

export const planHash = (p: Plan): string => sha256(canonical(p)).slice(0, 16);

export function renderPlan(p: Plan, hash: string): string {
  const L: string[] = [];
  L.push(`Plan ${hash} for target ${p.target.confirm} (environment: ${p.target.environment})`);
  L.push(`Hosts reached or given to the server: ${p.target.hosts.join(', ') || 'none (a local stdio server with no URL or host in its environment or command line)'}`);
  L.push(`${p.suite.name} ${p.suite.version}, requirements ${p.spec.version}, manifest sha256 ${p.manifest_sha256.slice(0, 16)}…, catalog ${p.catalog_fingerprint.slice(0, 23)}…`);
  L.push(`At most ${p.writes_at_most} writes and ${p.creates_at_most} created objects (write budget ${p.limits.write_budget}, ${p.limits.writes_per_second} writes per second).`);
  L.push('No tool call was made to build this plan.');
  for (const w of p.warnings ?? []) L.push(`warning: ${w}`);
  if (p.session_init?.length) {
    L.push('');
    L.push('Session init: on every MCP session the run opens, after the handshake and before its first other tools/call (tools/list alone does not trigger it); a failure stops the run:');
    for (const c of p.session_init) L.push(`  - ${c.tool} ${JSON.stringify(c.args)} (${c.counted ? 'counted as a write' : 'read-only, not counted'})`);
  }
  for (const r of p.resources) {
    L.push('');
    L.push(`Resource ${r.resource}: ${r.object}`);
    for (const s of r.setup) L.push(`  setup: ${s}`);
    for (const c of r.checks) {
      L.push(`  ${c.check} v${c.version}${c.runs ? '' : ' (not run)'}${c.writes ? `, up to ${c.writes} writes` : ''}${c.creates ? `, ${c.creates} creates` : ''}`);
      for (const call of c.calls) L.push(`    - ${call}`);
      for (const n of c.notRun) L.push(`    ${n.requirement} ${n.write_path.tool}: ${n.verdict} — ${n.reason}`);
    }
  }
  L.push('');
  L.push('Server-wide, after the resources:');
  for (const c of p.global) {
    L.push(`  ${c.check} v${c.version}${c.runs ? '' : ' (not run)'}${c.writes ? `, up to ${c.writes} writes` : ''}`);
    for (const call of c.calls) L.push(`    - ${call}`);
    for (const n of c.notRun) L.push(`    ${n.requirement} ${n.write_path.tool}: ${n.verdict} — ${n.reason}`);
  }
  L.push('');
  L.push('Catalog: MWS-ANN-4 from tools/list; Annex A measured, never judged.');
  if (p.not_built.length) {
    L.push('Not built in this release:');
    for (const n of p.not_built) L.push(`  ${n.requirement}: ${n.reason}`);
  }
  return L.join('\n');
}
