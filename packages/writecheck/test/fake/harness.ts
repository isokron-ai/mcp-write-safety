/** Test harness: start the fake backend, write a manifest for the fake server, run the CLI's commands in-process. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand, type RunOutcome } from '../../src/cli/run.js';
import { TrackerBackend } from './backend.js';

export const SERVER_JS = join(dirname(fileURLToPath(import.meta.url)), 'server.js');

export interface FakeOptions {
  pairs?: number;
  staleReps?: number;
  control?: boolean;
  idempotency?: boolean;
  extra?: string;
  timeoutMs?: number;
  /** ticket_delete needs the version just read (start the fake with the variant 'versioned-delete'). */
  versionedDelete?: boolean;
}

export function fakeManifest(o: FakeOptions = {}): string {
  const control = o.control === false ? '' : `
    control:
      base_env: TRACKER_URL
      read: { http: [GET, "/tickets/{{id}}"] }
      patch: { http: [PATCH, "/tickets/{{id}}"], body: { "{{field}}": "{{value}}" } }
      write: { http: [PUT, "/tickets/{{id}}"], body: "{{object}}", headers: { if-match: "{{version}}" } }
      delete: { http: [DELETE, "/tickets/{{id}}"] }`;
  const common = (title: string) => `
    create: { tool: ticket_create, args: { title: "{{prefix}}${title}" }, id: id, name_path: title }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, settle_ms: 0, ignore: [updated_at] }
    fields:
      - { path: assignee, values: [ann, bob] }
      - { path: status, values: [blocked, closed] }
    version: { read: version }
    delete: { tool: ticket_delete, args: { id: "{{id}}"${o.versionedDelete ? ', version: "{{version}}"' : ''} } }
    list: { tool: ticket_list, args: { prefix: "{{prefix}}" }, items: items, id: id, name: title }
    cleanup: delete${control}`;
  return `mws: "0.9"
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(SERVER_JS)}]
  env_public: [TRACKER_URL, TRACKER_DEFECTS, TRACKER_SLOW_ERRORS_MS]
  processes: separate
target:
  environment: test
  confirm: fake-tracker
  guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsc-test-" }
limits: { write_budget: 20000, writes_per_second: 1000, pairs: ${o.pairs ?? 10}, stale_reps: ${o.staleReps ?? 3}, timeout_ms: ${o.timeoutMs ?? 10000}, max_fuzz_cases: 40 }
# Spec 7.3, rule 11 (note 19): the fake's wording, declared, so that the reading of an error is decided by a declared pattern.
patterns:
  applied: '(?<!\\bnot )\\b(was updated|were updated|updated to|remains applied|was created)\\b'
  outcome_unknown: 'not known whether'
  not_applied: '^invalid arguments:'
calls:
  whoami: { args: {} }
resources:
  - name: ticket${common('ticket')}
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    # assignee and priority are set by ticket_update and read back by ticket_get: the tester may set and put them back (Annex E, R15-4).
    restorable: [assignee, priority]${o.idempotency === false ? '' : `
    idempotency: { args: { title: "{{marker}}" }, key: { arg: idempotency_key }, replay_marker: replayed }`}
  - name: ticket-doc${common('doc')}
    update: { tool: ticket_replace, mode: full_replace, args: { id: "{{id}}", ticket: "{{object}}" } }
${o.extra ?? ''}`;
}

export interface Fake {
  backend: TrackerBackend;
  dir: string;
  manifest: string;
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export async function startFake(o: FakeOptions & { defects?: string[]; lostUpdate?: boolean; tenant?: string; manifestText?: string; slowErrorsMs?: number } = {}): Promise<Fake> {
  const backend = new TrackerBackend({ ...(o.lostUpdate ? { lostUpdate: true } : {}), ...(o.tenant ? { tenant: o.tenant } : {}) });
  const url = await backend.start();
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-test-'));
  const manifest = join(dir, 'manifest.yaml');
  writeFileSync(manifest, o.manifestText ?? fakeManifest(o));
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], TRACKER_URL: url, TRACKER_DEFECTS: (o.defects ?? []).join(','), ...(o.slowErrorsMs ? { TRACKER_SLOW_ERRORS_MS: String(o.slowErrorsMs) } : {}) };
  return {
    backend,
    dir,
    manifest,
    env,
    async close() {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function runFake(f: Fake, o: { baseline?: string; sign?: string } = {}): Promise<RunOutcome> {
  const quiet = () => {};
  const { hash } = await planCommand({ manifest: f.manifest, env: f.env, log: quiet });
  return runCommand({ manifest: f.manifest, outRoot: join(f.dir, 'out'), stateDir: join(f.dir, 'state'), confirmTarget: 'fake-tracker', planHash: hash, interactive: false, env: f.env, log: quiet, noSignals: true, ...(o.baseline ? { baseline: o.baseline } : {}), ...(o.sign ? { sign: o.sign } : {}) });
}
