/**
 * `run`: the only command that writes. In order, and stopping at the first refusal:
 *
 *   1. the manifest loads (no `# guessed` left), the target is declared test, no host looks like
 *      production, and no earlier run left open ledger entries
 *   2. tools/list (the only call before the confirmation); a production fingerprint is refused
 *   3. the plan is built and printed with its hash; the target and the hash are typed back (or
 *      given as --confirm-target and --plan-hash); there is no --yes
 *   4. the tenant guard: one read-only call whose result must match the manifest's pattern
 *   5. per resource: the object (the fixture, or one new object through the ledger, its returned id
 *      verified), the two fields set to the baseline, then the checks
 *   6. cleanup by ledger (also on SIGINT, SIGTERM and a crash), then the reports, SHA256SUMS and the
 *      optional signature
 *
 * The run stops on the first 429 and when the write budget would be exceeded; what it had not run
 * is reported as not tested.
 */

import { anyLoss, compare, inventory, withEarlier, type Inventory, type Loss } from '../checks/bystanders.js';
import { withLaterLoss, withLoss, type LaterLoss } from '../checks/targeting.js';
import { everyRequirement } from '../checks/coverage.js';
import { cutShortOf } from '../report/validity.js';
import { cellPass, inputRequiredTools } from '../checks/cells.js';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { measure } from '../checks/catalog.js';
import { CHECKS, GLOBAL_CHECKS } from '../checks/index.js';
import { newScope } from '../checks/scratch.js';
import { annotateInputs, mcpRecord } from '../report/protocol.js';
import { usePatterns } from '../checks/says.js';
import { useShapeCatalog, useShapes } from '../checks/shape.js';
import { scanValues, Scanner } from '../checks/secrets.js';
import { notRun, type Observation, type RunContext, type Tool } from '../checks/types.js';
import { Capture } from '../core/capture.js';
import { safeCommand, stripUrlSecrets } from '../core/command-line.js';
import { cleanupLedger, unfinished, type CleanupReport } from '../core/cleanup.js';
import { Driver } from '../core/driver.js';
import { egressFor, lockGlobalFetch } from '../core/egress.js';
import { Ledger, refuseIfOpen } from '../core/ledger.js';
import { loadManifest, reviewSpec, type Manifest, type ReviewSpec } from '../core/manifest.js';
import { createVerified } from '../core/objects.js';
import { buildPlan, planHash, renderPlan } from '../core/plan.js';
import { Redactor, type ScrubPath } from '../core/redact.js';
import { checkFingerprint, checkTarget, confirm, guardBasis, targetHosts, targetStopped, tenantGuard, type GuardCall } from '../core/safety.js';
import { BudgetExhausted, RateLimited, Session, SessionInitFailed } from '../core/session.js';
import { render } from '../core/template.js';
import { canonical, diff, getPath, iso, parseConfigText, short, unsetPath, withoutIgnored, WritecheckError } from '../core/util.js';
import { createGate, type Gate } from '../gate/gate.js';
import { SPEC_VERSION } from '../requirements.js';
import { applyBaseline, exitCodeFor, loadBaseline, type BaselineOutcome } from '../report/baseline.js';
import { signChecksums, writeChecksums } from '../report/evidence.js';
import { buildIdentity, buildStamp, manifestProvenance, resolveProvenance } from '../core/identity.js';
import { catalogFingerprint as toolsFingerprintOf } from '../checks/catalog.js';
import { loadSigningKey, signResults } from '../report/sign.js';
import { hashExtras, stampTestHashes } from '../report/testhash.js';
import type { IdentityOptions } from './compare.js';
import { renderJunit } from '../report/junit.js';
import { renderMarkdown } from '../report/markdown.js';
import { coverageRows, postEvaluate } from '../checks/coverage.js';
import { RESULTS_FORMAT, scopeSentence, type ResultsDoc } from '../report/results.js';
import { result, type Result } from '../report/verdicts.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';

export interface RunOptions {
  manifest: string;
  /** `--pair-budget`: as limits.pair_budget (it enters the plan hash, so plan must be given the same). */
  pairBudget?: { repeats: number; pairs: number } | null;
  outRoot: string;
  stateDir: string;
  confirmTarget?: string;
  planHash?: string;
  baseline?: string;
  sign?: string;
  /** The run identity flags and the results signing key (`--provenance`, `--server-*`, `--backend-image`, `--sign-key`). */
  identity?: IdentityOptions;
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  ask?: (q: string) => Promise<string>;
  log: (s: string) => void;
  /** Tests: do not install process signal handlers. */
  noSignals?: boolean;
  /** A review answers file (same form as the manifest's review block); it overrides the manifest's. */
  review?: string;
  /** The run this one repeats (`rerun`). */
  rerunOf?: string;
}

export interface RunOutcome {
  exit: number;
  outDir: string;
  doc: ResultsDoc;
  baseline: BaselineOutcome;
}

/** Every secret value the manifest points at (passed-through variables, header and control credentials). */
export function secretsOf(m: Manifest, env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>([...m.server.env_passthrough, ...Object.values(m.server.headers_env).map((h) => h.env)]);
  for (const r of m.resources) if (r.control?.auth) names.add(r.control.auth.env);
  return [...names].map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length >= 6);
}

/**
 * The values session.init calls take from the environment, all secrets: `short`, those given under a secret-like name (masked
 * from three characters); `long`, the rest (masked from six, like every other secret).
 */
export function initSecretsOf(m: Manifest, env: NodeJS.ProcessEnv): { short: string[]; long: string[] } {
  const inits = m.session?.init ?? [];
  const named = new Set(inits.flatMap((c) => c.secret_env));
  const val = (ns: Iterable<string>) => [...new Set(ns)].map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v !== '');
  return { short: val(named), long: val(inits.flatMap((c) => c.env).filter((n) => !named.has(n))) };
}

export function redactorFor(m: Manifest, env: NodeJS.ProcessEnv): Redactor {
  const paths: ScrubPath[] = [{ prefix: resolve(process.cwd()), role: 'WORKSPACE' }, { prefix: homedir(), role: 'HOME' }];
  const init = initSecretsOf(m, env);
  return new Redactor([...secretsOf(m, env), ...init.long], { paths, short: init.short });
}

export function egressOf(m: Manifest, env: NodeJS.ProcessEnv) {
  return egressFor([m.server.url, ...m.resources.map((r) => (r.control ? (r.control.base ?? env[r.control.base_env!]) : null))]);
}

// why: review S6: the server command goes into results.json and the scope sentence; credentials in it are left out.
export const serverLabel = (m: Manifest): string => (m.server.url ? stripUrlSecrets(m.server.url) : m.server.stdio ? safeCommand(m.server.stdio) : `${safeCommand(m.server.launch!.command)} (launched by the tester)`);

/** The review answers in force: the manifest's review block, replaced by a --review file when one is given. */
export function reviewOf(m: Manifest, file: string | undefined): ReviewSpec | null {
  if (!file) return m.review;
  return reviewSpec(parseConfigText(readFileSync(file, 'utf8'), file), file);
}

export async function runCommand(o: RunOptions): Promise<RunOutcome> {
  const manifest = loadManifest(o.manifest, { pairBudget: o.pairBudget ?? null });
  usePatterns(manifest);
  useShapes(manifest);
  checkTarget(manifest, o.env);
  refuseIfOpen(o.stateDir);
  // why: F8: the stated build and the signing key are read before anything is written, so a bad --server-commit or key refuses the run.
  const prov = resolveProvenance(manifestProvenance(o.manifest), o.identity?.provenance);
  const signKey = loadSigningKey(o.identity?.signKey, o.env);
  const red = redactorFor(manifest, o.env);
  const egress = egressOf(manifest, o.env);
  const unlock = lockGlobalFetch(egress);
  const runId = randomBytes(5).toString('hex');
  const prefix = `${manifest.prefix}-${runId}-`;
  const outDir = resolve(o.outRoot, runId);
  // why: the manifest text is kept from the first read, and the state folder is made absolute, so a working folder that disappears
  // during the run cannot cost the results (gate-2 K8s B13).
  const manifestText = readFileSync(o.manifest, 'utf8');
  o = { ...o, stateDir: resolve(o.stateDir) };
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
  const capture = new Capture(join(outDir, 'capture'), red);
  const review = reviewOf(manifest, o.review);
  let gate: Gate | null = null;
  try {
    gate = createGate(manifest, o.env, { stateDir: join(o.stateDir, `gate-${runId}`), egress });
    await gate?.start();
  } catch (e) {
    unlock();
    throw e;
  }
  const scanner = new Scanner(scanValues(manifest, o.env), manifest.secrets.token_params);
  const session = new Session({ manifest, capture, redactor: red, egress, env: o.env, write_budget: manifest.limits.write_budget, min_interval_ms: Math.floor(1000 / manifest.limits.writes_per_second), throttle_file: join(o.stateDir, 'throttle'), history_file: join(outDir, 'history.jsonl'), gate, onResult: (e) => scanner.onResult(e) });
  const started = Date.now();
  let ledger: Ledger | null = null;
  let cleanupDone: CleanupReport | null = null;
  let stopped: string | null = null;
  /** Review R1: the index of the first record made after the run was cut short (write budget, rate limit, interrupt); only records from there on fail V-RUN. */
  let cutAt: number | null = null;
  /** The index of the first observation made after the cut (persisted as run.cut_at, so recheck knows which re-evaluated records are late). */
  let cutObs: number | null = null;
  const markCut = (record: number, observation: number) => {
    if (cutAt !== null) return;
    cutAt = record;
    cutObs = observation;
  };
  const results: Result[] = [];
  const firstWrite = new Map<string, string[]>();
  const observations: Observation[] = [];
  let tools: Tool[] = [];
  let fullCatalog: { prompts?: unknown[]; resourceTemplates?: unknown[] } = {};
  let hash = '';
  let guard: ResultsDoc['target']['guard'] = null;
  // why: review B2: every call of the guard's tool, in the ledger before it is sent, and counted in the report.
  const guardCalls: GuardCall[] = [];
  const onGuardCall = (c: GuardCall) => {
    ledger?.append({ kind: 'guard_call', step: c.step, tool: c.tool, phase: c.phase, basis: c.basis, context: 'run' });
    guardCalls.push(c);
  };
  let fingerprint = '';
  let measurements: ResultsDoc['measurements'] = null;
  let plan: ReturnType<typeof buildPlan> | null = null;
  let refusal: WritecheckError | null = null;
  const canaries: ResultsDoc['safety']['canaries'] = [];
  const fixturesRestored: ResultsDoc['safety']['fixtures_restored'] = [];
  const canaryBefore = new Map<string, unknown>();
  let protocol: string | null = null;
  /** Bystander losses outside any check's records (review S3): a failed set-up, or after the last check. */
  const runLosses: (Loss & { where: string })[] = [];
  let finalInventory: (() => Promise<void>) | null = null;

  let cleanupRun: Promise<CleanupReport | null> | null = null;
  const doCleanup = (): Promise<CleanupReport | null> => {
    if (!ledger) return Promise.resolve(null);
    const l = ledger;
    cleanupRun ??= cleanupLedger(l, manifest, session, o.env, prefix)
      .catch((e: unknown): CleanupReport => ({ deleted: [], left: [], failed: [], unknown: [], stopped: `cleanup failed: ${(e as Error).message}`, prefix }))
      .then((r) => {
        cleanupDone = r;
        // why: the GitHub Action's test (problem 14 in the Action's NOTES.md): a run is never complete while its own objects may be left
        // behind: a clean-up that stopped, a delete that failed, a create whose outcome is unknown, an object not verified.
        const why = unfinished(r);
        if (why.length) stopped = stopped ? `${stopped}; clean-up did not finish: ${why.join(', ')}` : `clean-up did not finish: ${why.join(', ')}; objects of this run may be left behind`;
        l.append({ kind: 'run_end', status: stopped ? 'stopped' : 'complete' });
        return r;
      });
    return cleanupRun;
  };
  let finished = false;
  let interrupted = false;
  let termIgnored = false;
  // Signal and crash path: stop sending, let the main flow unwind, clean up and write its report; if it
  // does not finish in time (a server that never answers), clean up here and exit. A second signal exits at once.
  const onSignal = (sig: string) => {
    // why: GitHub Action review B1: a CI cancel sends SIGINT, then SIGTERM a few seconds later, then SIGKILL; the SIGTERM must
    // not cut the clean-up short. After the first signal a SIGTERM (or a crash, such as EPIPE on a closed stdout) is ignored;
    // a second SIGINT (a person pressing Ctrl-C again) still exits at once.
    // review: the first SIGTERM after the signal is ignored (the CI runner's), a second one still forces the exit; a crash after
    // the signal is logged, not swallowed silently.
    if (interrupted && sig === 'SIGTERM' && !termIgnored) {
      termIgnored = true;
      try {
        o.log('SIGTERM: ignored once while the clean-up runs (send it again, or SIGINT, to exit at once)');
      } catch {
        /* a closed stdout */
      }
      return;
    }
    if (interrupted && sig !== 'SIGINT' && sig !== 'SIGTERM') {
      try {
        o.log(`after the signal: ${sig}; the clean-up goes on`);
      } catch {
        /* a closed stdout */
      }
      return;
    }
    if (interrupted) {
      session.killAll();
      process.exit(130);
    }
    interrupted = true;
    o.log(`\n${sig}: stopping; cleaning up this run's objects before exit…`);
    stopped = `interrupted by ${sig}`;
    markCut(results.length, observations.length);
    session.abort(stopped);
    setTimeout(() => {
      if (finished) return;
      void (async () => {
        await session.idle(5_000);
        await doCleanup();
        // why: review: the main flow writes the report after the clean-up; it gets a short grace before the forced exit.
        for (let i = 0; i < 30 && !finished; i++) await new Promise((r) => setTimeout(r, 100));
      })().finally(() => {
        session.killAll();
        process.exit(130);
      });
    }, 5_000).unref();
  };
  // why: B1: a write to a closed pipe (the runner stopped reading) is not a crash; the run goes on and cleans up.
  const isEpipe = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'EPIPE';
  const onPipeError = (e: unknown) => {
    if (!isEpipe(e)) onSignal(`an output error (${(e as Error)?.message})`);
  };
  const handlers: [string, (...a: unknown[]) => void][] = o.noSignals ? [] : [['SIGINT', () => onSignal('SIGINT')], ['SIGTERM', () => onSignal('SIGTERM')], ['uncaughtException', (e) => (isEpipe(e) ? undefined : onSignal(`a crash (${(e as Error)?.message})`))]];
  for (const [ev, h] of handlers) process.on(ev as NodeJS.Signals, h);
  if (!o.noSignals) for (const st of [process.stdout, process.stderr]) st.on('error', onPipeError);

  try {
    const catalog = await session.catalog('MAIN');
    fullCatalog = catalog as never;
    tools = catalog.tools as Tool[];
    useShapeCatalog(tools);
    plan = buildPlan(manifest, tools, targetHosts(manifest, o.env).map((h) => h.host), { catalog });
    fingerprint = plan.catalog_fingerprint;
    checkFingerprint(manifest, fingerprint);
    hash = planHash(plan);
    o.log(renderPlan(plan, hash));
    await confirm(manifest, hash, { ...(o.confirmTarget !== undefined ? { confirmTarget: o.confirmTarget } : {}), ...(o.planHash !== undefined ? { planHash: o.planHash } : {}), interactive: o.interactive, ...(o.ask ? { ask: o.ask } : {}) });
    // why: CLI feature B: from the confirmed plan on, every new connection runs session.init at once (none before: plan makes no tool call).
    session.armInit();
    ledger = new Ledger(join(o.stateDir, runId), runId, (s) => red.text(s));
    ledger.append({ kind: 'run_start', run_id: runId, prefix, manifest_sha256: manifest.source.sha256, hosts: plan.target.hosts });
    const g = await tenantGuard(manifest, session, 'MAIN', { onCall: onGuardCall });
    guard = { tool: manifest.target.guard!.tool, matched: g.matched, ...(g.basis === 'operator' ? { basis: 'operator' as const, note: `The tenant guard rests on the operator's declaration that this call only reads (target.guard.read_only_call), not on an annotation. It was sent three times before any other write, each counted as a write and recorded in the ledger, and answered identically each time; ${g.state}. A write that answers the same each time and changes nothing the manifest lets the tester read would not be detected. Between checks the run asked tools/list, not the declared call.` } : {}) };
    o.log(`tenant guard matched: ${g.matched}`);
    // Untouched state: the canaries are read before anything is written, and again after cleanup.
    for (const c of manifest.canaries) canaryBefore.set(c.name, await readCanary(session, c));
    let labelSeq = 0;
    let markerSeq = 0;
    const marker = (tag: string) => `${prefix}${tag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}${++markerSeq}`;
    const drivers = new Map<string, Driver>();
    for (const res of manifest.resources) drivers.set(res.name, new Driver(session, manifest, res, prefix, o.env));
    const checkLabels: string[] = [];
    const label = (p: string, res: string) => {
      const l = `${p}.${res}.${++labelSeq}`;
      checkLabels.push(l);
      return l;
    };
    const baseCtx = (resName: string): Omit<RunContext, 'driver'> => ({ manifest, tools, review, gated: !!gate, session, ledger: ledger!, prefix, label: (p: string) => label(p, resName), gate, env: o.env, drivers, marker });
    // why: k1: the run's own setup (its scopes, each object under test and its baseline), every check, the resets
    // between them and the server-wide checks are bracketed by the bystander inventory, so a loss in a fixture create, a reset or a
    // probe of any check is named. Opt-in mode (selector.send_empty_forms) brackets its selector resources whatever the inventory
    // gives (an inventory that cannot be taken blocks held); since the gate-2 re-run on 0295ed6 (k1 in default mode) every other
    // resource whose objects outside the tester's own can be listed at the start is bracketed too.
    const lastInv = new Map<string, Inventory>();
    const bracketed: Manifest['resources'] = [];
    let startInv = new Map<string, Inventory>();
    {
      const start = new Map<string, Inventory>();
      for (const r of manifest.resources) start.set(r.name, await inventory({ ...baseCtx(r.name), driver: drivers.get(r.name)! } as RunContext, r, 'MAIN'));
      const listable = manifest.resources.filter((r) => r.selector?.send_empty_forms || !start.get(r.name)!.unavailable);
      // why: a scope resource whose scopes another bracketed resource's inventory lists (as scope entries) is not listed twice.
      for (const r of listable) if (r.selector?.send_empty_forms || !listable.some((x) => x !== r && x.scope?.resource === r.name)) bracketed.push(r);
      for (const r of bracketed) lastInv.set(r.name, start.get(r.name)!);
      startInv = start;
    }
    finalInventory = async () => {
      // review S3: one last inventory after the clean-up, against the last one taken: a loss in the clean-up (or anything after the
      // tail bracket) is reported at run level and stops the run.
      for (const r of bracketed) {
        const last = lastInv.get(r.name);
        if (!last) continue;
        // why: validator re-run on f573a24 (r2-first-error-*, r9-restart-reid): after the clean-up only objects that were there at the
        // start and do not carry this run's prefix count; an object with the prefix the run made (its id not in the ledger: a create
        // that applied and then failed, ids changed by a restart) is the sweep's to delete.
        const atStart = startInv.get(r.name);
        const before: Inventory = { ...last, items: new Map([...last.items].filter(([k, e]) => (!atStart || atStart.items.has(k)) && !JSON.stringify(e.item ?? null).includes(prefix))) };
        try {
          const c = { ...baseCtx(r.name), driver: drivers.get(r.name)! } as RunContext;
          const l = await compare(c, r, 'CLEANUP', before, await inventory(c, r, 'CLEANUP'), { fixtures: true });
          if (anyLoss(l)) runLosses.push({ ...l, where: `${r.name}: after the last check (clean-up)` });
        } catch {
          /* an inventory that fails after the clean-up is not a loss */
        }
      }
    };
    /** Every loss since the last inventory (an earlier window's late effect, a reset, a set-up, a check that failed); lastInv moves on. */
    const gapLoss = async (ctxR0: Omit<RunContext, 'driver'>, what: string): Promise<{ losses: Loss[]; before: Map<string, Inventory> }> => {
      const out: Loss[] = [];
      const before = new Map<string, Inventory>();
      for (const r of bracketed) {
        const ctxR = { ...ctxR0, driver: drivers.get(r.name)! } as RunContext;
        try {
          const now = await inventory(ctxR, r, 'MAIN');
          const prev = lastInv.get(r.name);
          if (prev) {
            const l = await compare(ctxR, r, 'MAIN', prev, now, { fixtures: true });
            if (anyLoss(l) || l.unavailable || (l.partial ?? []).some((p) => /paging is not shown to be complete/.test(p))) out.push(l);
            // why: i13b: a list that leaves an entry out now and then; the last inventory taken completes this one (read by id).
            before.set(r.name, await withEarlier(ctxR, 'MAIN', now, prev));
          } else before.set(r.name, now);
          lastInv.set(r.name, now);
        } catch (e) {
          // why: review (13): a failed bracket never ends the run; it says the inventory could not be taken.
          out.push({ gone: [], changed: [], unavailable: `the inventory ${what} could not be taken: ${short((e as Error).message, 160)}` });
          lastInv.delete(r.name);
        }
      }
      return { losses: out, before };
    };
    /** The losses between `before` (taken by gapLoss) and now. */
    const afterLoss = async (ctxR0: Omit<RunContext, 'driver'>, before: Map<string, Inventory>): Promise<Loss[]> => {
      const out: Loss[] = [];
      for (const r of bracketed) {
        const b = before.get(r.name);
        if (!b) continue;
        const ctxR = { ...ctxR0, driver: drivers.get(r.name)! } as RunContext;
        try {
          const after = await inventory(ctxR, r, 'MAIN');
          const l = await compare(ctxR, r, 'MAIN', b, after, { fixtures: true });
          lastInv.set(r.name, after);
          if (anyLoss(l) || l.unavailable || (l.partial ?? []).some((p) => /paging is not shown to be complete/.test(p))) out.push(l);
        } catch (e) {
          out.push({ gone: [], changed: [], unavailable: `the inventory after the check could not be taken: ${short((e as Error).message, 160)}` });
          lastInv.delete(r.name);
        }
      }
      return out;
    };
    /**
     * Gate-2 re-run on 0295ed6 (k1): a loss seen in a window cannot be ruled out as a late effect of an earlier record's calls; every
     * record made before the window (up to `upto`) that is held becomes not tested and names it. `all`: name it in every earlier record.
     */
    const blockEarlier = (losses: Loss[], where: string, upto: number, all = false) => {
      const ls = losses.filter((l) => anyLoss(l));
      // why: nx1-x-lie (validator re-run on 9288cfc): a window that shows a list's paging incomplete makes every earlier held record
      // not tested, as a loss does (withLaterLoss, paging); recheck reproduces it from later_losses.
      const paging = [...new Set(losses.flatMap((l) => (l.partial ?? []).filter((p) => /paging is not shown to be complete/.test(p))))];
      if (!ls.length && !paging.length) return;
      const later: LaterLoss[] = [...ls.map((loss) => ({ where, loss, ...(all ? { all: true } : {}) })), ...(paging.length ? [{ where, loss: { gone: [], changed: [], unavailable: null }, paging }] : [])];
      for (let i = 0; i < Math.min(upto, results.length); i++) results[i] = withLaterLoss(results[i]!, later);
      for (const ob of observations.slice(0, obsBefore(upto))) ((ob as { later_losses?: LaterLoss[] }).later_losses ??= []).push(...later);
    };
    /** The observations whose records were pushed before results index `upto`. */
    const obsAt: number[] = [];
    const obsBefore = (upto: number) => obsAt.filter((n) => n < upto).length;
    // The run's scopes: every resource that declares one gets a container of its own, created first.
    for (const res of manifest.resources) {
      if (!res.scope || stopped) continue;
      const sc = await newScope(baseCtx(res.name), res, 'run', 'MAIN');
      if (sc.ok) drivers.get(res.name)!.scope = sc.key;
      else o.log(`${res.name}: the run scope could not be created (${sc.reason}); its objects go to the server's default`);
    }
    const fixtureOriginal = new Map<string, unknown[]>();
    // why: the GitHub Action's test (problem 14 in the Action's NOTES.md): a target or backend that stops answering mid-run stops the run.
    // Asked after every check (also one that failed), after a setup that failed, and after the global checks.
    const alive = async (): Promise<void> => {
      if (stopped) return;
      try {
        const dead = await targetStopped(manifest, session, 'MAIN', { onCall: onGuardCall });
        if (dead && !stopped) stopped = dead;
      } catch (e) {
        // why: a session.init that failed stops the run too (PR #14); only the write budget and a rate limit cut it short (V-RUN).
        if ((e instanceof RateLimited || e instanceof BudgetExhausted || e instanceof SessionInitFailed) && !stopped) {
          stopped = e.message;
          if (!(e instanceof SessionInitFailed)) markCut(results.length, observations.length);
        }
      }
    };
    const runChecks = async (res: (typeof manifest.resources)[number], d: Driver) => {
      // why: k1: the set-up of this resource (and anything since the last check: a reset, a set-up that failed).
      const setupStart = results.length;
      const setupLosses = (await gapLoss(baseCtx(res.name), `around the set-up of ${res.name}`)).losses;
      blockEarlier(setupLosses, `the set-up of ${res.name}`, setupStart);
      const planned = plan!.resources.find((r) => r.resource === res.name)!.checks;
      const ctx: RunContext = { ...baseCtx(res.name), driver: d };
      for (const c of planned) {
        results.push(...c.notRun);
        if (!c.runs) continue;
        const mod = CHECKS.find((m) => m.id === c.check)!;
        const rest = mod.requirements.filter((id) => !c.notRun.some((r) => r.requirement === id));
        const w = { resource: res.name, tool: res.update?.tool ?? res.create?.tool ?? res.read.tool, arm: 'mcp' as const };
        if (stopped) {
          results.push(...notRun(mod, rest, w, 'not tested', `the run stopped before this check: ${stopped}`));
          continue;
        }
        // why: spec R15-4: an object that could not be put back after an MWS-IN-4 control is used in no later test.
        if (d.unusable) {
          // why: review of lane F7 (one record per requirement and write path): a requirement an earlier check of this resource
          // already recorded for the same write path (MWS-IN-5 of a halted update tool) gets no second, generic record.
          const had = (id: string) => results.some((r) => r.requirement === id && r.write_path.resource === w.resource && r.write_path.tool === w.tool);
          results.push(...notRun(mod, rest.filter((id) => !had(id)), w, 'not tested', d.unusable));
          continue;
        }
        o.log(`${res.name}: ${c.check}…`);
        const start = results.length;
        // why: k1: every check is bracketed as a unit by the bystander inventory, so a loss in its fixture creates,
        // resets or probes is named, and no record of that check is held. The inventory before it is compared with the last one
        // (a check that failed, or a late effect of an earlier one, shows there).
        const pre = await gapLoss(ctx, 'before the check');
        let losses: Loss[] = [...pre.losses];
        try {
          const obs = await mod.collect(ctx, res).finally(() => session.release(checkLabels.splice(0)));
          observations.push(obs);
          obsAt.push(start);
          // why: review M3: the first-write finding of this resource's set-up goes with its observations, so recheck applies it too.
          if (firstWrite.has(res.name)) (obs as { first_write?: string[] }).first_write = firstWrite.get(res.name);
          let got = mod.evaluate(obs, { manifest, tools, review, gated: !!gate });
          if (setupLosses.length) {
            got = got.map((r) => withLoss(r, [], false, setupLosses));
            (obs as { setup_losses?: Loss[] }).setup_losses = setupLosses;
          }
          losses = [...losses, ...(await afterLoss(ctx, pre.before))];
          if (losses.length) {
            got = got.map((r) => withLoss(r, [], false, losses));
            (obs as { bracket_losses?: Loss[] }).bracket_losses = losses;
          }
          results.push(...got.filter((r) => !c.notRun.some((n) => n.requirement === r.requirement && n.write_path.tool === r.write_path.tool)));
          const stop = (obs.data as { stopped?: string | null })?.stopped;
          if (stop && /stopped:/.test(stop)) {
            stopped = stop;
            // why: review R1: the records of the check that was cut short (write budget, rate limit) come after the cut; a stop for
            // another reason (a session.init that failed, PR #14) stops the run without voiding them.
            if (cutShortOf(stop)) markCut(start, observations.length - 1);
          }
        } catch (e) {
          // why: a session.init that failed stops the run too (PR #14); only the write budget and a rate limit cut it short (V-RUN).
          if (e instanceof RateLimited || e instanceof BudgetExhausted || e instanceof SessionInitFailed) {
            stopped = e.message;
            if (!(e instanceof SessionInitFailed)) markCut(results.length, observations.length);
          }
          // the losses after a check that failed are compared at the next bracket (gapLoss), and named there
          results.push(...notRun(mod, rest, w, 'not tested', `the check failed: ${short((e as Error).message, 300)}`));
        }
        // why: validator re-run on f573a24 (i8, c4, c5, e2, i4, i4b, i5): a loss a check's own records report (a selector call's
        // comparison) blocks the earlier held records too, as a bracket's loss does.
        const own = [...new Set(results.slice(start).flatMap((r) => (Array.isArray(r.numbers['bystanders_lost']) ? (r.numbers['bystanders_lost'] as string[]) : [])))];
        blockEarlier([...losses, ...(own.length ? [{ gone: own, changed: [], unavailable: null } as Loss] : [])], `${res.name}: ${c.check}`, start);
        await alive();
      }
    };
    // why: research builds: a run in which no resource with an object under test could be set up tested nothing of it; it stops.
    const setupFailed: string[] = [];
    let setupDone = 0;
    for (const rp of plan.resources) {
      const res = manifest.resources.find((r) => r.name === rp.resource)!;
      const planned = rp.checks;
      const allNotRun = (why: string) => {
        for (const c of planned) {
          results.push(...c.notRun);
          if (c.runs) {
            const mod = CHECKS.find((m) => m.id === c.check)!;
            results.push(...notRun(mod, mod.requirements.filter((id) => !c.notRun.some((r) => r.requirement === id)), { resource: res.name, tool: res.update!.tool, arm: 'mcp' }, 'not tested', why));
          }
        }
      };
      if (stopped) {
        allNotRun(`the run stopped before this resource: ${stopped}`);
        continue;
      }
      const d = drivers.get(res.name)!;
      if (!res.update) {
        // No object under test: the checks that need none (targeting, creates, annotations) run on their own objects.
        await runChecks(res, d);
        continue;
      }
      if (!rp.setup.length) {
        allNotRun('no fixture and no cleanup policy');
        continue;
      }
      // The object under test.
      let setupRes1: Result | null = null;
      try {
        if (res.fixture) {
          d.id = res.fixture.id;
          const r = await d.readOnce('MAIN', session.stepId(`setup.${res.name}.fixture`));
          if (!r.ok) throw new WritecheckError(`the fixture ${JSON.stringify(res.fixture.id)} did not read back`);
          // why: the fixture is written to; it must be the object the manifest names, not whatever the id points at today.
          const np = res.fixture.name_path ?? res.create?.name_path ?? null;
          const name = np ? getPath(r.obj, np) : null;
          const isIt = np ? name === res.fixture.name : JSON.stringify(r.obj).includes(res.fixture.name);
          if (!isIt) throw new WritecheckError(`the fixture ${JSON.stringify(res.fixture.id)} does not read back as ${JSON.stringify(res.fixture.name)}${np ? ` (at ${np}: ${short(name, 60)})` : ''}; it was not written to`, 3);
          // why: a fixture is someone's object; its two fields are put back to these values at the end of the run.
          fixtureOriginal.set(res.name, res.fields!.map((f) => getPath(r.obj, f.path)));
        } else {
          const env = { ...d.vars(), marker: marker('main'), key: marker('main') };
          const c = await createVerified(session, ledger, res, prefix, { tool: res.create!.tool, args: render(res.create!.args, env), purpose: 'the object under test', label: 'MAIN', step: session.stepId(`setup.${res.name}.create`) });
          if (!c.ok) throw new WritecheckError(`could not create the object under test: ${c.reason}`);
          d.id = c.id;
        }
        // why: the first write after a create can change fields it does not name, and the later compared reads come after the
        // setup writes; that first write is read around and kept, so MWS-UPD-1 is never `held` over it (gate-2 Grafana item 12).
        const pre0 = res.fixture ? null : await d.readOnce('MAIN', session.stepId(`setup.${res.name}.first.before`));
        for (const [i, f] of res.fields!.entries()) {
          const r = await d.update('MAIN', f, f.values[0], { step: session.stepId(`setup.${res.name}.baseline.${i}`) });
          if (!r.ok) throw new WritecheckError(`could not set ${f.path} to the baseline value: ${short(r.text ?? r.rpc_error?.message ?? 'error', 160)}`);
          if (i === 0 && pre0?.ok) {
            const post0 = await d.readSettled('MAIN', `setup.${res.name}.first.after`, () => false);
            const moved = post0.ok ? withoutIgnored(diff(pre0.obj, post0.obj), [...res.read.ignore, ...(res.version ? [res.version.read] : [])]).map((e) => e.path).filter((p) => !(p === f.path || p.startsWith(`${f.path}.`) || p.startsWith(`${f.path}[`))) : [];
            if (moved.length) firstWrite.set(res.name, moved);
          }
        }
        d.baseline = [res.fields![0].values[0], res.fields![1].values[0]];
        if (!(await d.reset('MAIN'))) {
          // why: every baseline write was answered as a success and the values are not in effect: that is MWS-RES-1 itself (CLI-BUGS item 8).
          // why: each field is written alone and read back alone, so a reset of one field by the other's write (MWS-UPD-1) is not taken for
          // MWS-RES-1; a field is "not stored" only where it reads back, unchanged from before the write (NF-4: a field the read does not return is not compared).
          const missing: string[] = [];
          const steps: string[] = [];
          const conf: { ok: boolean; settled: boolean; f0Before: unknown; step: string }[] = [];
          for (const [i, f] of res.fields!.entries()) {
            const pre = await d.readOnce('MAIN', session.stepId(`setup.${res.name}.confirm.${i}.before`));
            const step = session.stepId(`setup.${res.name}.confirm.${i}`);
            const w = await d.update('MAIN', f, d.baseline![i], { step });
            const back = await d.readSettled('MAIN', `setup.${res.name}.confirm.${i}.read`, (o) => JSON.stringify(getPath(o, f.path)) === JSON.stringify(d.baseline![i]));
            conf.push({ ok: w.ok, settled: back.ok && back.settled, f0Before: pre.ok ? getPath(pre.obj, res.fields![0].path) : undefined, step });
            const now = back.ok ? getPath(back.obj, f.path) : undefined;
            if (w.ok && back.ok && !back.settled && pre.ok && now !== undefined && JSON.stringify(now) === JSON.stringify(getPath(pre.obj, f.path))) {
              missing.push(`${f.path} (asked ${short(d.baseline![i], 30)}, still reads ${short(now, 30)})`);
              steps.push(step);
            }
          }
          if (missing.length) setupRes1 = result('MWS-RES-1', { resource: res.name, tool: res.update!.tool, arm: 'mcp' }, { id: 'setup', version: '1' }, 'violated', `Setting the baseline, ${res.update!.tool} answered each write as a success, but ${missing.join(' and ')} did not change within the settle window of ${res.read.settle_ms} ms. The other checks of this resource could not run.`, { attribution: 'unresolved', steps });
          else {
            // why: each field stores when written alone, yet not both: writing one changed the other, the very behaviour MWS-UPD-1 is about (gate-2 Grafana item 1).
            const fin = await d.readSettled('MAIN', `setup.${res.name}.confirm.final`, () => false);
            // why: a field the read returned just before the other field's write and no longer returns was removed by that write, which
            // changes it as much as another value does (gate-2 Grafana 1 on d3b536f: GF-03 drops `labels`). The `clean` guard below
            // requires f0 to have read back as set right before f1's write, so a field the read never returns (NF-4) is not counted.
            const reset = fin.ok ? res.fields!.filter((f, i) => (i === 0 || getPath(fin.obj, f.path) !== undefined) && JSON.stringify(getPath(fin.obj, f.path)) !== JSON.stringify(d.baseline![i])) : [];
            // why: only where f0 was confirmed set by its own write, still read as set just before f1's write, and f1's write succeeded,
            // and only for a field patch (MWS-UPD-1 applies to that mode) (review).
            const b0 = JSON.stringify(d.baseline![0]);
            const clean = res.update!.mode === 'field_patch' && !res.update!.apply && conf[0]?.ok && conf[0].settled && conf[1]?.ok && JSON.stringify(conf[1].f0Before) === b0;
            if (clean && fin.ok && reset.length === 1 && reset[0] === res.fields![0]) setupRes1 = result('MWS-UPD-1', { resource: res.name, tool: res.update!.tool, arm: 'mcp' }, { id: 'setup', version: '1' }, 'violated', `Setting the baseline: ${res.fields![0].path} read back as set after its own write, and a following ${res.update!.tool} that named only ${res.fields![1].path} ${getPath(fin.obj, res.fields![0].path) === undefined ? 'removed it (the read no longer returns it)' : `changed it to ${short(getPath(fin.obj, res.fields![0].path), 40)}`}. The other checks of this resource could not run.`, { attribution: 'unresolved', steps: fin.call ? [fin.call.step] : [] });
          }
          throw new WritecheckError('the baseline values did not read back');
        }
      } catch (e) {
        // why: a session.init that failed stops the run too (PR #14); only the write budget and a rate limit cut it short (V-RUN).
        if (e instanceof RateLimited || e instanceof BudgetExhausted || e instanceof SessionInitFailed) {
          stopped = e.message;
          if (!(e instanceof SessionInitFailed)) markCut(results.length, observations.length);
        }
        allNotRun(`setup failed: ${(e as Error).message}`);
        setupFailed.push(`${res.name}: ${short((e as Error).message, 120)}`);
        await alive();
        if (setupRes1) {
          const r1 = setupRes1;
          for (let i = results.length - 1; i >= 0; i--) if (results[i]!.requirement === r1.requirement && results[i]!.write_path.tool === res.update!.tool && results[i]!.write_path.resource === res.name && results[i]!.verdict === 'not tested') results.splice(i, 1);
          results.push(r1);
          setupRes1 = null;
        }
        continue;
      }
      setupDone++;
      await runChecks(res, d);
      if (!stopped) await d.reset('MAIN').catch(() => false);
    }
    // why: research builds N3 (review): a reset that went through the declared control.patch is said in the resource's records.
    for (const [name, d] of drivers) if (d.resetViaControl) for (const [i, r] of results.entries()) if (r.write_path.resource === name) results[i] = { ...r, notes: [...r.notes, `The tool under test refused to put this resource's object back ${d.resetViaControl} time(s); the tester reset it through the declared control.patch (research builds N3).`] };
    const noSetup = setupFailed.length && !setupDone ? `the set-up of every resource with an object under test failed (${setupFailed.join('; ')})` : null;
    // Server-wide checks: launch settings (they restart the server) and the credential scan (it reads everything before it).
    for (const g of GLOBAL_CHECKS) {
      const p = plan.global.find((x) => x.check === g.id)!;
      results.push(...p.notRun);
      if (!p.runs) continue;
      const rest = g.requirements.filter((id) => !p.notRun.some((r) => r.requirement === id));
      const w = { resource: '(server)', tool: '(all)', arm: 'mcp' as const };
      if (stopped) {
        results.push(...notRun(g, rest, w, 'not tested', `the run stopped before this check: ${stopped}`));
        continue;
      }
      o.log(`server: ${g.id}…`);
      const start = results.length;
      // why: k1: the server-wide checks are bracketed too; the inventory before the first one also covers the
      // reset of the last resource.
      const pre = await gapLoss(baseCtx('(server)'), 'before the check');
      let losses: Loss[] = [...pre.losses];
      try {
        const obs = await g.collect({ ...baseCtx('(server)'), scan: scanner.log }).finally(() => session.release(checkLabels.splice(0)));
        observations.push(obs);
        obsAt.push(start);
        let got = g.evaluate(obs, { manifest, tools, review, gated: !!gate });
        losses = [...losses, ...(await afterLoss(baseCtx('(server)'), pre.before))];
        if (losses.length) {
          got = got.map((r) => withLoss(r, [], false, losses));
          (obs as { bracket_losses?: Loss[] }).bracket_losses = losses;
        }
        results.push(...got);
      } catch (e) {
        // why: a session.init that failed stops the run too (PR #14); only the write budget and a rate limit cut it short (V-RUN).
        if (e instanceof RateLimited || e instanceof BudgetExhausted || e instanceof SessionInitFailed) {
          stopped = e.message;
          if (!(e instanceof SessionInitFailed)) markCut(results.length, observations.length);
        }
        results.push(...notRun(g, rest, w, 'not tested', `the check failed: ${short((e as Error).message, 300)}`));
      }
      blockEarlier(losses, `server: ${g.id}`, start);
      await alive();
    }
    if (noSetup && !stopped) stopped = noSetup;
    // Fixtures: their two fields go back to the values they had before the run.
    for (const [name, values] of fixtureOriginal) {
      const res = manifest.resources.find((r) => r.name === name)!;
      const d = drivers.get(name)!;
      d.baseline = values as [unknown, unknown];
      const ok = await d.reset('MAIN').catch(() => false);
      // why: spec R15-4, review of 3283a69 (6): a restorable argument left changed on the operator's fixture is reported here too.
      const left = d.leftChanged ? `; ${d.leftChanged.arg} was left changed after an MWS-IN-4 control (${short(d.leftChanged.why, 160)}) and must be put back by hand` : '';
      const fine = ok && !d.leftChanged;
      fixturesRestored.push({ resource: name, restored: fine, ...(fine ? {} : { note: `${ok ? '' : `could not put ${res.fields!.map((f) => f.path).join(' and ')} back to ${short(values, 80)}`}${left}`.replace(/^; /, '') }) });
      // why: problem 14 in the GitHub Action's NOTES.md: an operator's object left changed means the run did not finish its own clean-up.
      if (!fine) stopped = stopped ? `${stopped}; the fixture ${name} could not be put back` : `the fixture ${name} could not be put back as it was`;
    }
    // why: k1: what happened after the last bracketed window (the last reset, the fixtures put back) is compared
    // too; a loss there is named in every record that made calls, and none of them is held.
    if (bracketed.length && !stopped) blockEarlier((await gapLoss(baseCtx('(run)'), 'after the last check')).losses, 'after the last check (the last reset, the fixtures put back)', results.length, true);
    results.push(...plan.catalog_results);
    // why: review M3: the whole-run adjustments are one step, shared with recheck (checks/coverage.ts postEvaluate).
    results.splice(0, results.length, ...postEvaluate(manifest, results, firstWrite));
    results.push(...coverageRows(manifest, tools, results));
    let second: Tool[] | null = null;
    try {
      second = (await session.listTools('LIST2')) as Tool[];
    } catch {
      second = null;
    }
    const jobs = observations.filter((x) => x.check === 'creates').flatMap((x) => ((x.data as { jobs?: { name: string; calls: number; ok: boolean; failed_at: number | null }[] }).jobs ?? []).map((j) => ({ resource: x.resource, ...j })));
    measurements = measure(tools, { second, largest: capture.largest, jobs });
  } catch (e) {
    if (e instanceof WritecheckError && (e.code === 2 || e.code === 3)) refusal = e;
    else stopped = stopped ?? (e as Error).message;
  } finally {
    // why: CLI feature B: a failed session.init stops the run, wherever it was caught; its reason is the run's.
    if (session.initFailure && !(stopped ?? '').includes(session.initFailure)) stopped = stopped ? `${stopped}; stopped: ${session.initFailure}` : `stopped: ${session.initFailure}`;
    protocol = session.protocolOf('MAIN') ?? null;
    await doCleanup();
    if (!refusal && finalInventory) await finalInventory().catch(() => undefined);
    // why: review S3: a loss outside every check's records is a safety fact; the run is not complete.
    if (runLosses.length && !stopped) stopped = `objects the tester did not create were lost outside any check's records (${runLosses.map((l) => l.where).join('; ')})`;
    if (!refusal) {
      for (const c of manifest.canaries) {
        if (!canaryBefore.has(c.name)) continue;
        try {
          const after = await readCanary(session, c, 'CLEANUP');
          const before = canaryBefore.get(c.name);
          const same = before === undefined || after === undefined ? null : canonical(before) === canonical(after);
          canaries.push({ name: c.name, tool: c.tool, unchanged: same, ...(same === false ? { note: `changed: ${diff(before, after).slice(0, 5).map((e) => e.path).join(', ')}` } : same === null ? { note: 'the read failed before or after the run' } : {}) });
        } catch (e) {
          canaries.push({ name: c.name, tool: c.tool, unchanged: null, note: `not read after the run: ${(e as Error).message}` });
        }
      }
    }
    await session.close();
    await gate?.stop().catch(() => undefined);
    // why: CI flake of review S4 (run 44452412733): after a signal the run ends in an exit with 130. A SIGTERM that comes after this
    // point, before the process exits, would meet no handler and kill it by the signal (no exit code), so the handlers stay
    // installed on an interrupted run; a later signal then exits with 130 at once, as onSignal says.
    if (!interrupted) {
      for (const [ev, h] of handlers) process.off(ev as NodeJS.Signals, h);
      if (!o.noSignals) for (const st of [process.stdout, process.stderr]) st.off('error', onPipeError);
    }
  }
  if (refusal) {
    // A refusal (target, confirmation, guard, usage): no report is written; the ledger says whether anything exists.
    capture.close();
    unlock();
    // why: review B2: a refusal never reads as "nothing was written" when a call that rests on the operator's declaration went out.
    const vouched = guardCalls.filter((c) => c.basis !== 'annotation');
    if (vouched.length && !/was sent \d+ time/.test(refusal.message)) throw new WritecheckError(`${refusal.message}; before this, the declared guard call ${vouched[0]!.tool} was sent ${vouched.length} time(s) (steps ${vouched.map((c) => c.step).join(', ')}) and may have changed state (the ledger records each call)`, refusal.code);
    throw refusal;
  }
  const cap = capture.close();
  unlock();
  // why: review B2: the report counts every guard call; one that rests on the operator's declaration is counted as a write.
  const guardRecord = (): ResultsDoc['target']['guard'] => {
    const g0 = manifest.target.guard;
    if (!guard && !guardCalls.length) return null;
    const base = guard ?? { tool: g0?.tool ?? '(none)', matched: '(the run stopped during the tenant guard)' };
    // B2 follow-up: a guard declared read-only (target.guard.read_only) rests on a declaration too.
    const vouched = g0 && guardBasis(g0) !== 'annotation' ? guardCalls.filter((c) => c.basis !== 'annotation').length : 0;
    return { ...base, calls: guardCalls.length, call_steps: guardCalls.map((c) => c.step), ...(vouched ? { counted_as_writes: vouched } : {}) };
  };
  // Reports.
  const cl = cleanupDone as CleanupReport | null;
  const leftovers = cl ? [...cl.left, ...cl.failed, ...cl.unknown.map((u) => ({ resource: u.resource, id: null, name: null, how: `create through ${u.tool} with an unknown outcome`, reason: u.reason }))] : [];
  // Spec 5.3 and 7.3, rules 10 and 11: the revision, transport and declared capabilities; what the tester answered to requests for input.
  const mcp = mcpRecord(manifest, protocol, session.inputRequests, session.notes);
  annotateInputs(results, mcp);
  // why: writesafe self-test T5 (spec 5.3): every requirement has a record, if only `not tested` with the reason.
  results.push(...everyRequirement(results, plan?.not_built ?? [], stopped ?? null));
  // why: F1/F6 (docs/CELLS.md): every MUST cell gets a record, duplicates go, records are stamped with their cell and validity.
  const celled = cellPass(manifest, tools, results, { stopped: stopped ?? null, late: (_r, i) => cutAt !== null && i >= cutAt, input_required_tools: inputRequiredTools(mcp) });
  results.splice(0, results.length, ...celled.results);
  const doc: ResultsDoc = {
    format: RESULTS_FORMAT,
    scope: scopeSentence({ server: serverLabel(manifest), catalog: fingerprint || 'sha256:unknown', resources: manifest.resources.map((r) => ({ name: r.name, tool: r.update?.tool ?? r.create?.tool ?? r.read.tool, fields: r.fields?.map((f) => f.path) ?? [] })), notBuiltCount: plan?.not_built.length ?? 0 }),
    suite: { name: SUITE_NAME, version: SUITE_VERSION },
    spec: { version: SPEC_VERSION },
    run: { id: runId, prefix, started: iso(started), ended: iso(Date.now()), status: stopped ? 'stopped' : 'complete', stopped_reason: stopped, writes: session.writes, processes_started: session.started.length, ...(cutAt !== null && celled.late_from !== null ? { cut_at: { record: celled.late_from, observation: cutObs ?? observations.length } } : {}) },
    target: { confirm: manifest.target.confirm, environment: manifest.target.environment, server: serverLabel(manifest), catalog_fingerprint: fingerprint, guard: guardRecord(), mcp },
    manifest: { path: 'manifest' + (o.manifest.endsWith('.json') ? '.json' : '.yaml'), sha256: manifest.source.sha256 },
    plan: { hash },
    results,
    cells: celled.cells,
    not_built: plan?.not_built ?? [],
    measurements,
    leftovers,
    cleanup: cl ? { deleted: cl.deleted, failed: cl.failed, unknown: cl.unknown, stopped: cl.stopped, prefix: cl.prefix } : null,
    observations,
    evidence: { capture: cap, checksums: 'SHA256SUMS', signature: null },
    safety: { canaries, fixtures_restored: fixturesRestored, gate: gate ? { route: gate.route, description: gate.describe() } : null, protocol, rerun_of: o.rerunOf ?? null, ...(plan?.warnings?.length ? { warnings: plan.warnings } : {}), ...(runLosses.length ? { run_losses: runLosses } : {}) },
  };
  // why: F8 (before/after pages): each record says which test it is; the run says which tester, test and build it was.
  const stamp = buildStamp();
  stampTestHashes(doc.results, { manifest, tools, tester: { name: SUITE_NAME, version: SUITE_VERSION, commit: stamp.commit, dirty: stamp.dirty }, extras: await hashExtras(manifest), review: review ?? null });
  doc.identity = buildIdentity({ manifestSha256: manifest.source.sha256, planHash: hash, toolsFingerprint: tools.length ? toolsFingerprintOf(tools) : 'sha256:unknown', launch: serverLabel(manifest), transport: mcp.transport, provenance: prov.provenance, sources: prov.sources, overridden: prov.overridden, started: doc.run.started, finished: iso(Date.now()), env: o.env, stamp });
  const hx = await hashExtras(manifest);
  doc.identity.hash_inputs = { pair_budget: o.pairBudget ?? null, ...(hx.in5_docs ? { in5_docs: hx.in5_docs } : {}) };
  const baseline = applyBaseline(results, o.baseline ? loadBaseline(o.baseline) : []);
  if (o.sign) doc.evidence.signature = 'SHA256SUMS.sig';
  const safe = red.value(doc);
  // why: review S1: the test inputs are argument names and hashes (never a value the run sent); masking an argument named
  // `password` would leave a record whose test_hash no longer follows from its inputs.
  safe.results.forEach((r, i) => {
    const inputs = doc.results[i]?.test_inputs;
    if (inputs) r.test_inputs = JSON.parse(JSON.stringify(inputs)) as typeof inputs;
  });
  // why: F8: the signature covers the file as written (after redaction), with evidence.signature null.
  if (signKey) safe.evidence.signature = signResults(safe, signKey, o.sign ? 'SHA256SUMS.sig' : null);
  // why: literal server.env values may hold secrets; the copies are redacted like everything else.
  // why: review S1: the copy stays YAML (a flow mapping such as `{ env: X, prefix: "Bearer " }` is not cut by the header rule).
  writeFileSync(join(outDir, doc.manifest.path), red.manifestText(manifestText));
  // why: dogfood C9: the whole catalog the fingerprint covers, so a plan from this file gives the same hash.
  // why: review S1: a tool argument named like a credential (`password`) keeps its schema; only string values are masked by name.
  writeFileSync(join(outDir, 'catalog.json'), JSON.stringify(red.catalogValue({ tools, prompts: fullCatalog.prompts ?? [], resourceTemplates: fullCatalog.resourceTemplates ?? [] }), null, 2) + '\n');
  if (plan) writeFileSync(join(outDir, 'plan.json'), JSON.stringify(red.value({ hash, plan }), null, 2) + '\n');
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(safe, null, 2) + '\n');
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(safe));
  writeFileSync(join(outDir, 'junit.xml'), renderJunit(safe, baseline));
  if (ledger) copyFileSync(ledger.file, join(outDir, 'ledger.jsonl'));
  writeChecksums(outDir);
  if (o.sign) {
    try {
      signChecksums(outDir, o.sign);
    } catch (e) {
      // why: a signing failure must not hide the verdict's exit status; the report says a signature was intended.
      o.log(`warning: ${(e as Error).message}; SHA256SUMS is written but not signed`);
    }
  }
  finished = true;
  // why: problem 14 in the GitHub Action's NOTES.md: an incomplete run (stopped, or clean-up not finished) exits 4 whatever its verdicts say.
  return { exit: interrupted ? 130 : stopped ? 4 : exitCodeFor(baseline) === 1 ? 1 : 0, outDir, doc: safe, baseline };
}

/** One canary read: the result (at `path`, without the ignored fields), or undefined when the call failed. */
async function readCanary(session: Session, c: Manifest['canaries'][number], label = 'MAIN'): Promise<unknown> {
  const r = await session.call(label, c.tool, c.args, { write: false, step: session.stepId(`canary.${c.name}`) });
  if (!r.ok) return undefined;
  let v = c.path ? getPath(r.data, c.path) : r.data;
  for (const p of c.ignore) v = unsetPath(v, p);
  return v ?? null;
}
