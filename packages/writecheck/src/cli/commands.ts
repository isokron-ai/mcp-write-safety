/**
 * `plan`, `cleanup` and `recheck`.
 *
 *   plan     the manifest and tools/list only (or a saved catalog with --catalog); prints every
 *            call each check would make, the writes and creates at most, what will not be tested
 *            and why, and the plan hash `run` must be given. Makes no tool call.
 *   cleanup  processes every open ledger under the state folder through the manifest's cleanup
 *            policies; --abandon records them as left behind without touching the server.
 *   recheck  re-applies the current rules to a recorded run's observations, offline: no server,
 *            no network. The original evidence is not modified; the new results go to
 *            <folder>/recheck/.
 */

import { cellPass, CELLS_SCENARIO, inputRequiredTools } from '../checks/cells.js';
import type { Loss } from '../checks/bystanders.js';
import { withLaterLoss, withLoss, type LaterLoss } from '../checks/targeting.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkById } from '../checks/index.js';
import { usePatterns } from '../checks/says.js';
import { useShapes } from '../checks/shape.js';
import { annVerdicts, catalogFingerprint, isTool, measure } from '../checks/catalog.js';
import { declaredWriteTools } from '../checks/coverage.js';
import type { Observation, Tool } from '../checks/types.js';
import { NO_CAPTURE } from '../core/capture.js';
import { cleanupLedger, unfinished, type CleanupReport } from '../core/cleanup.js';
import { lockGlobalFetch } from '../core/egress.js';
import { Ledger, openRuns, readLedger } from '../core/ledger.js';
import { loadManifest, parseManifestText } from '../core/manifest.js';
import { buildPlan, planHash, renderPlan, type Plan } from '../core/plan.js';
import { checkTarget, targetHosts, tenantGuard, guardProblem, readOnlyToolsOf } from '../core/safety.js';
import { Redactor } from '../core/redact.js';
import { safeCommand, stripUrlSecrets } from '../core/command-line.js';
export { safeCommand } from '../core/command-line.js';
import { Session } from '../core/session.js';
import { WritecheckError } from '../core/util.js';
import { verifyChecksums } from '../report/evidence.js';
import { parseResultsBytes, verifyResults } from '../report/sign.js';
import { firstWriteOf, postEvaluate } from '../checks/coverage.js';
import { renderMarkdown } from '../report/markdown.js';
import type { ResultsDoc } from '../report/results.js';
import { result, writePathKey, type Result } from '../report/verdicts.js';
import { RESULTS_FORMAT } from '../report/results.js';
import { renderJunit } from '../report/junit.js';
import { writeChecksums } from '../report/evidence.js';
import { previewSentence, REQUIREMENTS, SPEC_VERSION, type RequirementId } from '../requirements.js';
import { egressOf, redactorFor, reviewOf, runCommand, type RunOptions, type RunOutcome } from './run.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';

export async function planCommand(o: { manifest: string; catalog?: string; pairBudget?: { repeats: number; pairs: number } | null; env: NodeJS.ProcessEnv; log: (s: string) => void }): Promise<{ plan: Plan; hash: string; warning: string | null }> {
  const manifest = loadManifest(o.manifest, { pairBudget: o.pairBudget ?? null });
  let warning: string | null = null;
  try {
    checkTarget(manifest, o.env);
  } catch (e) {
    warning = `run would refuse: ${(e as Error).message}`;
  }
  let tools: Tool[];
  let catalog: Catalog;
  if (o.catalog) {
    catalog = readCatalogFile(o.catalog);
    tools = catalog.tools as Tool[];
  } else {
    const unlock = lockGlobalFetch(egressOf(manifest, o.env));
    const s = new Session({ manifest, capture: NO_CAPTURE, redactor: redactorFor(manifest, o.env), egress: egressOf(manifest, o.env), env: o.env, write_budget: 0, min_interval_ms: 0 });
    try {
      catalog = await s.catalog('PLAN');
      tools = catalog.tools as Tool[];
    } finally {
      await s.close();
      unlock();
    }
  }
  const plan = buildPlan(manifest, tools, targetHosts(manifest, o.env).map((h) => h.host), { catalog });
  const hash = planHash(plan);
  o.log(renderPlan(plan, hash));
  if (!manifest.target.guard) warning = `${warning ? `${warning}; ` : ''}run would refuse: target.guard is missing (a read-only call whose result must match before any write)`;
  // why: a guard the run would refuse is reported here, before anyone confirms the plan (CLI-BUGS item 1).
  if (manifest.target.guard && tools.length) {
    const gp = guardProblem(manifest.target.guard, tools.find((t) => t.name === manifest.target.guard!.tool) as { annotations?: Record<string, unknown> } | undefined, { writeTools: new Set(declaredWriteTools(manifest, tools).keys()), anyAnnotated: tools.some((t) => !!t.annotations && Object.keys(t.annotations).length > 0), readOnlyTools: readOnlyToolsOf(tools as never) });
    if (gp) warning = `${warning ? `${warning}; ` : ''}run would refuse: ${gp}`;
  }
  if (manifest.target.guard && !/^\^/.test(manifest.target.guard.pattern)) o.log('\nnote: target.guard.pattern is not anchored (^…$); it matches anywhere in the value.');
  if (warning) o.log(`\nwarning: ${warning}`);
  o.log(`\nplan hash: ${hash}`);
  return { plan, hash, warning };
}

export async function cleanupCommand(o: { manifest: string; stateDir: string; run?: string; abandon?: boolean; confirmTarget?: string; interactive?: boolean; ask?: (q: string) => Promise<string>; env: NodeJS.ProcessEnv; log: (s: string) => void }): Promise<{ reports: { run: string; report: CleanupReport }[]; exit: number }> {
  const manifest = loadManifest(o.manifest);
  const runs = openRuns(o.stateDir).filter((r) => !o.run || r.run_id === o.run);
  if (!runs.length) {
    o.log('No open ledger entries: nothing to clean up.');
    return { reports: [], exit: 0 };
  }
  if (!o.abandon) {
    // Deletes go through the same seat belts as a run: the target, the hosts the run used, the typed-back target, the tenant guard.
    checkTarget(manifest, o.env);
    const hosts = [...new Set(targetHosts(manifest, o.env).map((h) => h.host))].sort();
    for (const r of runs) {
      const start = readLedger(join(r.dir, 'ledger.jsonl')).find((e) => e.kind === 'run_start') as { hosts?: string[] } | undefined;
      if (start?.hosts && JSON.stringify([...start.hosts].sort()) !== JSON.stringify(hosts)) throw new WritecheckError(`run ${r.run_id} reached ${start.hosts.join(', ') || 'no host'}; the environment now points at ${hosts.join(', ') || 'no host'}. Cleanup refuses to delete on a different target (use --abandon to record the objects as left behind).`, 3);
    }
    let target = o.confirmTarget;
    if (target === undefined) {
      if (!o.interactive || !o.ask) throw new WritecheckError('not a terminal: pass --confirm-target <target> to clean up (or --abandon)', 3);
      target = await o.ask(`Type the target to confirm (${manifest.target.confirm}): `);
    }
    if (target.trim() !== manifest.target.confirm) throw new WritecheckError(`the target typed (${JSON.stringify(target.trim())}) is not the manifest's target.confirm`, 3);
  }
  const unlock = lockGlobalFetch(egressOf(manifest, o.env));
  const s = new Session({ manifest, capture: NO_CAPTURE, redactor: redactorFor(manifest, o.env), egress: egressOf(manifest, o.env), env: o.env, write_budget: 10_000, min_interval_ms: Math.floor(1000 / manifest.limits.writes_per_second), throttle_file: join(o.stateDir, 'throttle') });
  const reports: { run: string; report: CleanupReport }[] = [];
  let exit = 0;
  try {
    // why: review B2: the guard's calls are recorded in every open run's ledger before they go out, and said on the console.
    const guardLedgers = runs.map((r) => new Ledger(r.dir, r.run_id, (x) => redactorFor(manifest, o.env).text(x)));
    if (!o.abandon)
      await tenantGuard(manifest, s, 'GUARD', {
        onCall: (c) => {
          for (const l of guardLedgers) l.append({ kind: 'guard_call', step: c.step, tool: c.tool, phase: c.phase, basis: c.basis, context: 'cleanup' });
          if (c.basis === 'operator') o.log(`tenant guard: sending the declared call ${c.tool} (${c.phase}); it rests on the operator's declaration and is recorded in the ledger`);
        },
      });
    for (const r of runs) {
      const red = redactorFor(manifest, o.env);
      const ledger = new Ledger(r.dir, r.run_id, (x) => red.text(x));
      const start = readLedger(ledger.file).find((e) => e.kind === 'run_start') as { prefix?: string } | undefined;
      const prefix = start?.prefix ?? `${manifest.prefix}-${r.run_id}-`;
      const rep = await cleanupLedger(ledger, manifest, s, o.env, prefix, { abandon: !!o.abandon });
      reports.push({ run: r.run_id, report: rep });
      o.log(`run ${r.run_id} (prefix ${prefix}): ${rep.deleted.length} deleted, ${rep.left.length} left, ${rep.failed.length} failed, ${rep.unknown.length} unknown${rep.stopped ? ` — ${rep.stopped}` : ''}`);
      for (const l of [...rep.left, ...rep.failed]) o.log(`  ${l.resource} ${JSON.stringify(l.id)}: ${l.reason}`);
      for (const u of rep.unknown) o.log(`  ${u.resource} create via ${u.tool}: ${u.reason} — search for ${prefix}`);
      // why: problem 14 in the GitHub Action's NOTES.md: a create of unknown outcome may have left an object behind, as a failed delete may.
      // S5: the same predicate as `run` (a "not verified" object counts; objects abandoned with --abandon do not).
      if (unfinished(rep).length) exit = 4;
    }
  } finally {
    await s.close();
    unlock();
  }
  return { reports, exit };
}

/** Re-evaluate a recorded run's observations with the current rules; nothing is sent anywhere. */
export function recheckCommand(o: { dir: string; review?: string; log: (s: string) => void }): { doc: ResultsDoc; changed: { key: string; before: string; after: string }[] } {
  const file = join(o.dir, 'results.json');
  if (!existsSync(file)) throw new WritecheckError(`${o.dir}: no results.json`, 2);
  // why: re-evaluate only evidence that is intact; a changed file would make the new verdicts meaningless.
  if (existsSync(join(o.dir, 'SHA256SUMS'))) {
    const v = verifyChecksums(o.dir);
    if (!v.ok) throw new WritecheckError(`${o.dir}: SHA256SUMS does not match ${v.bad.join(', ')}; not rechecking changed evidence`, 3);
  } else o.log('note: no SHA256SUMS in this folder; the evidence could not be checked');
  // why: p08: read as verify-results reads it (UTF-8, no repeated member, RFC 8785 numbers, no lone surrogate, bounded nesting).
  const doc = parseResultsBytes(readFileSync(file), file) as ResultsDoc;
  // why: review S4: a signed results.json that was changed after signing is not rechecked (and never signed again).
  const sig = verifyResults(doc, null);
  if (sig.status === 'invalid') throw new WritecheckError(`${o.dir}: the results signature does not verify (${sig.detail}); not rechecking a changed file`, 3);
  if (!/^manifest\.(yaml|json)$/.test(doc.manifest.path)) throw new WritecheckError(`${o.dir}: unexpected manifest path ${JSON.stringify(doc.manifest.path)}`, 2);
  const manifestFile = join(o.dir, doc.manifest.path);
  // why: review S7: the pair budget the run was given (it is not in the manifest copy).
  const pb = doc.identity?.hash_inputs?.pair_budget ?? null;
  const manifest = parseManifestText(readFileSync(manifestFile, 'utf8'), manifestFile, pb ? { pairBudget: pb } : {});
  const tools = readCatalogFile(join(o.dir, 'catalog.json')).tools as Tool[];
  usePatterns(manifest);
  useShapes(manifest, tools);
  const ctx = { manifest, tools, review: reviewOf(manifest, o.review), gated: !!manifest.backend?.gate };
  const fresh: Result[] = [];
  // why: review (F1 round 3): the cut of a run cut short is persisted (run.cut_at); a record re-evaluated from an observation made
  // after it stays late, and one from before it is never voided, whatever key it shares.
  const cut = doc.run.cut_at ?? null;
  const freshObs = new Map<Result, number>();
  for (const [oi, obs] of (doc.observations as Observation[]).entries()) {
    const mod = checkById(obs.check);
    if (!mod) throw new WritecheckError(`recheck: no check ${obs.check} in this version`, 2);
    const otherVersion = mod.version !== obs.version;
    if (otherVersion) o.log(`note: ${obs.check} was recorded at scenario version ${obs.version}; this release has ${mod.version}. Its re-evaluated records keep version ${obs.version} and the test hash recorded with them (none where none was recorded)`);
    // why: review (1): the losses an opt-in run saw around this check (k1) block held on recheck too.
    const runLosses = [...((obs as { setup_losses?: Loss[] }).setup_losses ?? []), ...((obs as { bracket_losses?: Loss[] }).bracket_losses ?? [])];
    // why: k1 (gate-2 re-run on 0295ed6): a loss seen later in the run blocks held on recheck too.
    const later = (obs as { later_losses?: LaterLoss[] }).later_losses ?? [];
    for (const r0 of mod.evaluate(obs, ctx)) {
      // why: review R1 (procedure version rule, MANIFEST.md "Recheck across a procedure version"): the observation is what the
      // recorded procedure sent; hashing it with this build's procedure would name a test that was never run.
      const r = otherVersion ? keepRecordedProcedure(r0, obs.version, mod.version, doc.results) : r0;
      const x = runLosses.length ? withLoss(r, [], false, runLosses) : r;
      const y = later.length ? withLaterLoss(x, later) : x;
      fresh.push(y);
      freshObs.set(y, oi);
    }
  }
  // Results decided without calls (not applicable, not tested, the catalog) are kept as recorded.
  const same = (x: Result, y: Result) => x.requirement === y.requirement && writePathKey(x.write_path) === writePathKey(y.write_path) && x.scenario.id === y.scenario.id;
  const kept = doc.results.filter((r) => !fresh.some((f) => same(f, r)));
  // why: review M3: the whole-run adjustments of `run` (the first write after a create, a declared override, an apply) are applied
  // here by the same step, so a recheck by the build that made the run gives the run's verdicts.
  const results = postEvaluate(manifest, [...kept, ...fresh], firstWriteOf(doc.observations as never, doc.results));
  for (const [i, r] of results.entries()) {
    const at = i - kept.length;
    if (at >= 0 && freshObs.has(fresh[at]!)) freshObs.set(r, freshObs.get(fresh[at]!)!);
  }
  const k = (r: Result) => `${r.requirement} ${writePathKey(r.write_path)} ${r.scenario.id}`;
  const before = new Map(doc.results.map((r) => [k(r), r.verdict]));
  const changed = results.filter((r) => before.get(k(r)) !== r.verdict).map((r) => ({ key: k(r), before: before.get(k(r)) ?? '(none)', after: r.verdict }));
  // why: F1/F6: the cells and validity are re-derived from the rechecked records (docs/CELLS.md).
  // why: review M2: the cell pass's own rows are re-derived, never kept (a rule or a record that changed would leave a stale one).
  // why: review R1: a record made after the run was cut short is known from the recorded validity (V-RUN), not from the stop text.
  const late = recheckLate(doc, freshObs);
  // why: the late records go last, so the rechecked file's run.cut_at.record again marks where they start.
  const input = results.filter((r) => r.scenario.id !== CELLS_SCENARIO.id);
  const ordered = cut ? [...input.filter((r) => !late(r)), ...input.filter(late)] : input;
  const celled = cellPass(manifest, tools, ordered, { stopped: doc.run.stopped_reason, late, input_required_tools: inputRequiredTools(doc.target.mcp) });
  const run = cut && celled.late_from !== null ? { ...doc.run, cut_at: { record: celled.late_from, observation: cut.observation } } : doc.run;
  const out: ResultsDoc = { ...doc, run, results: celled.results, cells: celled.cells, scope: `${doc.scope} Rechecked offline with this release's rules.` };
  const dir = join(o.dir, 'recheck');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), JSON.stringify(out, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), renderMarkdown(out));
  o.log(changed.length ? changed.map((c) => `${c.key}: ${c.before} → ${c.after}`).join('\n') : 'No verdict changed.');
  return { doc: out, changed };
}

/** The note on a record recheck re-evaluated across a procedure version that had no recorded test hash: finishRecheck leaves it unhashed. */
export const UNHASHED_PROCEDURE_NOTE = 'Not hashed by recheck: re-evaluated from an observation recorded at another procedure version';

/**
 * The procedure version rule of recheck (MANIFEST.md, "Recheck across a procedure version"): a record re-evaluated from an
 * observation whose procedure version differs from the check module's keeps the observation's version, and the test_hash,
 * test_hash_core and test_inputs of the original record of its slot and case (requirement, resource, tool, procedure id, that
 * version, case), unchanged. Where the original record carries no test_hash (or there is none), the record gets none: compare
 * then says `no-test-hash`. It is never hashed from the run folder's copies, which this build's procedure would read otherwise.
 */
export function keepRecordedProcedure(r: Result, recordedVersion: string, moduleVersion: string, original: Result[]): Result {
  const { test_hash: _h, test_hash_core: _c, test_inputs: _i, ...base } = r;
  const out: Result = { ...base, scenario: { id: r.scenario.id, version: recordedVersion } };
  const was = original.find((o) => o.requirement === r.requirement && o.write_path.resource === r.write_path.resource && o.write_path.tool === r.write_path.tool && o.scenario.id === r.scenario.id && o.scenario.version === recordedVersion && (o.case ?? '') === (r.case ?? ''));
  if (was && typeof was.test_hash === 'string') {
    out.test_hash = was.test_hash;
    if (typeof was.test_hash_core === 'string') out.test_hash_core = was.test_hash_core;
    if (was.test_inputs) out.test_inputs = was.test_inputs;
    out.notes = [...out.notes, `Re-evaluated by procedure ${r.scenario.id} version ${moduleVersion} from an observation recorded at version ${recordedVersion}: the record keeps version ${recordedVersion} and the test hash recorded with it.`];
  } else out.notes = [...out.notes, `${UNHASHED_PROCEDURE_NOTE} (${recordedVersion}; this build has ${moduleVersion}), and the original record carries no test hash: compare does not compare it.`];
  return out;
}

/**
 * Which records of a recheck were made after the run was cut short (V-RUN). With run.cut_at: a record re-evaluated from an
 * observation at or after cut_at.observation, or a kept record at or after cut_at.record. Without it (a file from before the
 * field), the records that failed V-RUN before, by requirement, write path and scenario.
 */
export function recheckLate(doc: Pick<ResultsDoc, 'run' | 'results'>, freshObs: Map<Result, number>): (r: Result) => boolean {
  const cut = doc.run.cut_at ?? null;
  const k = (r: Result) => `${r.requirement} ${writePathKey(r.write_path)} ${r.scenario.id}`;
  if (!cut) {
    const lateKeys = new Set(doc.results.filter((r) => r.validity?.failed.includes('V-RUN')).map(k));
    return (r) => lateKeys.has(k(r));
  }
  const keptAt = new Map(doc.results.map((r, i) => [r, i] as const));
  return (r) => (freshObs.has(r) ? freshObs.get(r)! >= cut.observation : keptAt.has(r) && keptAt.get(r)! >= cut.record);
}

/**
 * `review`: the review-only questions of a recorded run (the clauses a person answers), with the
 * captured evidence and the id to answer each under, and how each was answered if it was.
 */
export function reviewCommand(o: { dir: string; log: (s: string) => void }): { open: number; answered: number } {
  const file = join(o.dir, 'results.json');
  if (!existsSync(file)) throw new WritecheckError(`${o.dir}: no results.json (give the folder a run wrote, e.g. mwsc-results/<run id>)`, 2);
  const doc = parseResultsBytes(readFileSync(file), file) as ResultsDoc;
  const qid = (r: Result) => r.notes.find((n) => n.startsWith('question id '))?.slice('question id '.length) ?? /\(question id ([^)]+)\)/.exec(r.reason)?.[1] ?? null;
  const open = doc.results.filter((r) => r.verdict === 'not tested' && r.reason.startsWith('review-only clause'));
  const answered = doc.results.filter((r) => r.verdict === 'self-attested');
  if (!open.length && !answered.length) {
    o.log('No review-only question in this run.');
    return { open: 0, answered: 0 };
  }
  if (open.length) {
    o.log(`${open.length} question(s) to answer. Add the answers to the manifest's review block (review.answers.<id>: true | false, and review.by), then \`mcp-writecheck recheck ${o.dir}\` (or run again):\n`);
    for (const r of open) {
      o.log(`- ${qid(r)}`);
      o.log(`  ${r.reason.replace(/^review-only clause, not answered: /, '').replace(/ Answer it in the manifest.*$/, '')}`);
      for (const n of r.notes.filter((x) => x.startsWith('evidence:'))) o.log(`  ${n}`);
      if (r.steps.length) o.log(`  steps: ${r.steps.join(', ')}`);
    }
  }
  if (answered.length) {
    o.log(`\n${answered.length} answered (self-attested):`);
    for (const r of answered) o.log(`- ${qid(r) ?? `${r.requirement} ${writePathKey(r.write_path)}`}: ${r.reason}`);
  }
  return { open: open.length, answered: answered.length };
}

/**
 * `rerun`: run again what a recorded run ran. The manifest given must be byte-for-byte the one that
 * run used (its sha256 is in results.json); the plan is rebuilt from today's catalog, and if its
 * hash differs from the recorded one (the catalog, the suite or the hosts changed) that is printed
 * and the new hash is what must be confirmed. The new results record which run they repeat.
 */
export async function rerunCommand(o: Omit<RunOptions, 'rerunOf'> & { dir: string }): Promise<RunOutcome> {
  const file = join(o.dir, 'results.json');
  if (!existsSync(file)) throw new WritecheckError(`${o.dir}: no results.json (give the folder a run wrote, e.g. mwsc-results/<run id>)`, 2);
  const doc = parseResultsBytes(readFileSync(file), file) as ResultsDoc;
  const m = loadManifest(o.manifest, { pairBudget: o.pairBudget ?? null });
  if (m.source.sha256 !== doc.manifest.sha256) throw new WritecheckError(`${o.manifest} is not the manifest run ${doc.run.id} used (sha256 ${m.source.sha256.slice(0, 16)}… now, ${doc.manifest.sha256.slice(0, 16)}… then); a rerun repeats a recorded run exactly, so it refuses. Use \`run\` for a new plan.`, 3);
  if (doc.suite.version !== SUITE_VERSION) o.log(`note: run ${doc.run.id} was made with ${doc.suite.name} ${doc.suite.version}; this is ${SUITE_VERSION}, so scenario versions may differ.`);
  const { hash } = await planCommand({ manifest: o.manifest, env: o.env, log: () => {} });
  if (hash !== doc.plan.hash) o.log(`note: the plan changed since run ${doc.run.id} (recorded ${doc.plan.hash}, now ${hash}): the catalog, the suite, the limits or the target hosts differ. Confirm the new hash.`);
  else o.log(`The plan is the one run ${doc.run.id} used (${hash}).`);
  return runCommand({ ...o, rerunOf: doc.run.id });
}

type Catalog = { tools: unknown[]; prompts?: unknown[]; resourceTemplates?: unknown[] };

/**
 * A saved catalog, as `plan --catalog` and `catalog --catalog` read it: a tools/list answer, a bare list of tools, or a
 * catalog snapshot ({ catalog: { tools, prompts, resourceTemplates } }). One reader for both, so both fingerprint the same input.
 */
export function readCatalogFile(file: string): Catalog {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | unknown[];
  const snap = !Array.isArray(raw) && raw['catalog'] && typeof raw['catalog'] === 'object' ? (raw['catalog'] as Catalog) : null;
  const list = Array.isArray(raw) ? raw : (snap?.tools ?? (raw as { tools?: unknown[] }).tools ?? (raw as { result?: { tools?: unknown[] } }).result?.tools ?? []);
  const tools = list.filter(isTool);
  // why: dogfood C9: catalog.json is written as { tools, prompts, resourceTemplates }, so planning from it gives the live fingerprint.
  const top = !Array.isArray(raw) && Array.isArray(raw['tools']) && (Array.isArray(raw['prompts']) || Array.isArray(raw['resourceTemplates'])) ? (raw as unknown as Catalog) : null;
  const src = snap ?? top;
  return src ? { tools, prompts: src.prompts ?? [], resourceTemplates: src.resourceTemplates ?? [] } : { tools };
}


/**
 * Catalog-only mode: the verdicts that need nothing but tools/list (MWS-ANN-4 per tool), from a running server or a
 * saved tools/list answer, with every other requirement `not tested` because no tool was called. It makes no tool
 * call, needs no account and no test environment, and writes the usual results folder (results.json, report.md,
 * junit.xml, SHA256SUMS).
 */
export async function catalogCommand(o: { manifest?: string; catalog?: string; out: string; env: NodeJS.ProcessEnv; log: (s: string) => void }): Promise<{ exit: number; outDir: string; doc: ResultsDoc }> {
  if (!o.manifest && !o.catalog) throw new WritecheckError('catalog: give -m manifest.yaml (the server to start) or --catalog tools.json (a saved tools/list answer)', 2);
  let tools: Tool[];
  let catalog: Catalog;
  let server = '(a saved tools/list answer)';
  let manifestInfo = { path: '(none)', sha256: '' };
  // why: review S6: catalog mode writes through the same redactor as a run (the manifest's secrets, credential patterns).
  let red = new Redactor([]);
  if (o.catalog) {
    catalog = readCatalogFile(o.catalog);
    tools = catalog.tools as Tool[];
  } else {
    const manifest = loadManifest(o.manifest!);
    manifestInfo = { path: 'manifest.yaml', sha256: manifest.source.sha256 };
    red = redactorFor(manifest, o.env);
    // why: spec 5.3 (R10-9): how the server was started or reached (the command, the settings and the names of the variables),
    // never their values, and a credential given in the command or a setting left out.
    const sm = manifest.server;
    const vars = [...new Set([...Object.keys(sm.env ?? {}), ...(sm.env_public ?? []), ...(sm.env_passthrough ?? []), ...Object.values(sm.headers_env ?? {}).map((h) => h.env)])];
    server = `${safeCommand(sm.stdio ?? sm.launch?.command ?? (sm.url ? [stripUrlSecrets(sm.url)] : ['(server)']))}${vars.length ? `; variables given to it: ${vars.join(', ')} (names only, never values)` : ''}`;
    const unlock = lockGlobalFetch(egressOf(manifest, o.env));
    const s = new Session({ manifest, capture: NO_CAPTURE, redactor: redactorFor(manifest, o.env), egress: egressOf(manifest, o.env), env: o.env, write_budget: 0, min_interval_ms: 0 });
    try {
      catalog = await s.catalog('CATALOG');
      tools = catalog.tools as Tool[];
    } finally {
      await s.close();
      unlock();
    }
  }
  // why: gate-2 N1: the same computation over the same input as `plan` (tools, prompts and resource templates), so a
  // catalog-only report and a run report of one server carry one fingerprint.
  const fp = catalogFingerprint(catalog);
  const ann = annVerdicts(tools);
  const sc = { id: 'catalog-only', version: '1' };
  const rest = REQUIREMENTS.filter((r) => !ann.some((x) => x.requirement === r.id)).map((r) => result(r.id as RequirementId, { resource: '(catalog)', tool: '(no tool called)', arm: 'mcp' }, sc, 'not tested', 'catalog-only mode: only tools/list was read and no tool was called'));
  const results = [...ann, ...rest];
  const now = new Date().toISOString();
  const runId = `catalog-${fp.slice(7, 17)}`;
  const doc: ResultsDoc = {
    format: RESULTS_FORMAT,
    scope: `Scope: catalog only: no tool was called (only tools/list was read). Catalog ${fp.slice(0, 23)}… of ${server}. Every requirement other than MWS-ANN-4 is not tested; this is a statement about the catalog, not a result about any write path (spec 5.3).`,
    suite: { name: SUITE_NAME, version: SUITE_VERSION },
    spec: { version: SPEC_VERSION },
    run: { id: runId, prefix: '', started: now, ended: now, status: 'complete', stopped_reason: null, writes: 0, processes_started: o.catalog ? 0 : 1 },
    target: { confirm: '(catalog only)', environment: 'test', server, catalog_fingerprint: fp, guard: null },
    manifest: manifestInfo,
    plan: { hash: '' },
    results,
    // why: catalog only: no tool was called and no declaration names the write tools, so there are no cells (docs/CELLS.md).
    cells: [],
    not_built: [],
    measurements: measure(tools, {}),
    leftovers: [],
    cleanup: null,
    observations: [],
    evidence: { capture: null, checksums: 'SHA256SUMS', signature: null },
    safety: { canaries: [], fixtures_restored: [], gate: null, protocol: null, rerun_of: null },
  } as unknown as ResultsDoc;
  const outDir = join(o.out, runId);
  mkdirSync(outDir, { recursive: true });
  const safeDoc = red.value(doc) as ResultsDoc;
  writeFileSync(join(outDir, 'catalog.json'), JSON.stringify(red.catalogValue({ tools, prompts: catalog.prompts ?? [], resourceTemplates: catalog.resourceTemplates ?? [] }), null, 2) + '\n');
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(safeDoc, null, 2) + '\n');
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(safeDoc));
  writeFileSync(join(outDir, 'junit.xml'), renderJunit(safeDoc, null));
  writeChecksums(outDir);
  for (const r of ann.filter((x) => x.verdict === 'violated')) o.log(`${r.requirement} (${r.level}) ${writePathKey(r.write_path)}: ${r.reason}`);
  o.log(`${ann.length} catalog record(s) (MWS-ANN-4); ${rest.length} requirement(s) not tested in catalog-only mode.\n${previewSentence()}\nresults: ${outDir}/report.md`);
  return { exit: ann.some((x) => x.verdict === 'violated' && x.level === 'MUST') ? 1 : 0, outDir, doc: safeDoc };
}
