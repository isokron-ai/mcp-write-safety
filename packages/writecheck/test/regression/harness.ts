/**
 * Harness for the gate-2 regression tests: start the fixture backend, write a manifest for the
 * fixture server, run the CLI's own `plan` and `run` in-process (as test/fake/harness.ts does), and
 * read back what the server was asked to do.
 *
 * Each test in this folder pins one entry of a CLI-BUGS.md file of the gate-2 validation
 * (Payload, Kubernetes and Grafana runs) or one tester-safety
 * finding of SPEC-RECHECK.md. The test names start with the entry they pin. Each test file quotes the
 * spec sentences that decide its verdict; the quotes are from spec/mws.md on branch spec/0.9-review at
 * 4e341c5 (two later commits, to eb3313f, change MWS-RETRY-2 only). Evidence quoted as "validation rows" is from the run folders named in those CLI-BUGS.md files.
 *
 * The tests were written against the CLI at 7562919 and re-run at d3b536f, where the owners had fixed most
 * of the entries. A test for an entry that is fixed is kept and skipped, with the reason and the fixing
 * commit; set MWSC_REGRESSION_ALL=1 to run those too. A test that is not skipped fails on d3b536f, or is a
 * safety guard that must keep passing.
 */

import { assertViolationsHaveSteps } from '../steps-lint.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand, type RunOutcome } from '../../src/cli/run.js';
import type { Result } from '../../src/report/verdicts.js';
import { ShapeBackend, type BackendOptions } from './backend.js';

export const SERVER_JS = join(dirname(fileURLToPath(import.meta.url)), 'server.js');
export const CONFIRM = 'gate2-regression';

/** The top of every manifest: the fixture server over stdio, the target, the guard and the limits. */
export function head(o: { guard: string; gate?: boolean; limits?: string }): string {
  return `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(SERVER_JS)}]
  env_public: [SHAPE_URL, SHAPE_PROFILE, SHAPE_OPTS, SHAPE_CALL_LOG]
  processes: separate
target:
  environment: test
  confirm: ${CONFIRM}
  guard: ${o.guard}
${o.gate ? 'backend:\n  gate: { rewrite_env: SHAPE_URL, hold_timeout_ms: 1500 }\n' : ''}limits: ${o.limits ?? '{ write_budget: 20000, writes_per_second: 1000, pairs: 2, stale_reps: 1, gate_reps: 1, timeout_ms: 10000, max_fuzz_cases: 200 }'}
`;
}

/**
 * The `skip` option of a test whose bug the owners had fixed when the series was written. The tests are no
 * longer skipped (merged with the fixes for 0002 and 0003): they are the regression tests for those fixes and
 * run in `npm test`. The commit and entry stay as the record of what each pins.
 */
export const fixed = (_commit: string, _entry: string, _failsOn = '7562919'): string | false => false;

export const TRACKER_GUARD = '{ tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" }';

export interface Call {
  tool: string;
  args: Record<string, unknown>;
}

export interface Fixture {
  backend: ShapeBackend;
  dir: string;
  manifest: string;
  env: NodeJS.ProcessEnv;
  /** Every tools/call the server received so far, in order (from all of the run's server processes). */
  calls(): Call[];
  close(): Promise<void>;
}

export async function startFixture(o: { profile: 'tracker' | 'payload' | 'k8s'; opts?: string[]; backend?: BackendOptions; manifest: string; seed?: (b: ShapeBackend) => void }): Promise<Fixture> {
  const backend = new ShapeBackend(o.backend ?? {});
  const url = await backend.start();
  o.seed?.(backend);
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-regr-'));
  const manifest = join(dir, 'manifest.yaml');
  writeFileSync(manifest, o.manifest);
  const log = join(dir, 'calls.jsonl');
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], SHAPE_URL: url, SHAPE_PROFILE: o.profile, SHAPE_OPTS: (o.opts ?? []).join(','), SHAPE_CALL_LOG: log };
  return {
    backend,
    dir,
    manifest,
    env,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call) : []),
    async close() {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** `plan`, then `run` with the plan's hash, as a person would. `log` receives the run's progress lines. */
export async function runFixture(f: Fixture, o: { log?: (s: string) => void } = {}): Promise<RunOutcome> {
  const quiet = () => {};
  const { hash } = await planCommand({ manifest: f.manifest, env: f.env, log: quiet });
  const r = await runCommand({ manifest: f.manifest, outRoot: join(f.dir, 'out'), stateDir: join(f.dir, 'state'), confirmTarget: CONFIRM, planHash: hash, interactive: false, env: f.env, log: o.log ?? quiet, noSignals: true });
  // why: review R2 (lane F1): no violated record without its trace steps, unless its evidence is not a call trace.
  assertViolationsHaveSteps(r.doc);
  return r;
}

/** The records for one requirement on one write path (`resource:tool`); there is one per test method. */
export const rows = (rs: Result[], requirement: string, path: string): Result[] => rs.filter((r) => r.requirement === requirement && `${r.write_path.resource}:${r.write_path.tool}` === path);

/** One line per record, for assertion messages. */
export const show = (rs: Result[]): string => (rs.length ? rs.map((r) => `${r.requirement} ${r.write_path.resource}:${r.write_path.tool} [${r.scenario.id}] ${r.verdict}: ${r.reason}`).join('\n') : '(no record)');

/** The verdicts of the records for one requirement on one write path, without the review-only (self-attested or unanswered) ones. */
export function verdicts(rs: Result[], requirement: string, path: string): string[] {
  return rows(rs, requirement, path)
    .filter((r) => !/review-only/.test(r.reason) && r.verdict !== 'self-attested')
    .map((r) => r.verdict);
}
