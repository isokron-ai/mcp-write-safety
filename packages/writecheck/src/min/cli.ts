/**
 * `mcp-writecheck min`: min mode from the command line.
 *
 *   mcp-writecheck min --spec openapi.yaml [--spec-url URL] --base-url-env NAME [--env NAME]... [--set NAME=VALUE]...
 *                      [--declaration writecheck.yaml] [--listen HOST:PORT] [--advertise URL] [--out DIR] -- <server command...>
 *
 * Exit: 0 complete, nothing violated; 1 complete with a violated record; 3 the plan was refused (a target that is not
 * the mock) or the server did not start against it; 2 usage.
 */

import { WritecheckError } from '../core/util.js';
import { readDeclaration } from './declaration.js';
import { capViolations, runMin, type MinDoc } from './run.js';

export const MIN_USAGE = `mcp-writecheck min --spec FILE --base-url-env NAME [--spec-url URL] [--env NAME]... [--set NAME=VALUE]...
    [--declaration FILE] [--listen HOST:PORT] [--advertise URL] [--out DIR] [--timeout-ms N] -- <server command...>
    Min mode: runs the MCP-layer requirements against a mock of the backend made from its OpenAPI 3.x description
    (built in; stateful, records every request, fails chosen requests deterministically). The server's base-URL
    variables point at the mock; every other variable it reads gets a dummy, a secret-like one a canary. No real
    credential, no egress. Requirements that need real backend semantics (UPD, CONC-1/2/3, TGT-1/3, RES-1, ATOM-2) are
    reported "not tested" (not_testable_mock), never held. --declaration: a writecheck manifest whose patterns,
    settings and selector min mode reads (members marked "# guessed" are ignored).`;

export interface MinCliArgs {
  flags: Map<string, string[]>;
  rest: string[];
}

export async function minCommand(a: MinCliArgs, log: (l: string) => void): Promise<number> {
  const one = (k: string) => a.flags.get(k)?.at(-1);
  const many = (k: string) => (a.flags.get(k) ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const spec = one('--spec');
  if (!spec || !a.rest.length) throw new WritecheckError(`min needs --spec FILE and -- <server command>\n\n${MIN_USAGE}`, 2);
  const set: Record<string, string> = {};
  for (const kv of a.flags.get('--set') ?? []) {
    const i = kv.indexOf('=');
    if (i < 1) throw new WritecheckError(`--set takes NAME=VALUE (got ${JSON.stringify(kv)})`, 2);
    set[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const listen = one('--listen');
  const lm = listen ? /^(.+):(\d+)$/.exec(listen) : null;
  if (listen && !lm) throw new WritecheckError('--listen takes HOST:PORT', 2);
  const decl = one('--declaration');
  const [command, ...args] = a.rest;
  const timeout = one('--timeout-ms');
  const doc: MinDoc = await runMin({
    spec,
    specUrl: one('--spec-url') ?? null,
    server: { command: command!, args, env: {}, ...(one('--cwd') ? { cwd: one('--cwd')! } : {}) },
    baseUrlEnv: many('--base-url-env'),
    envNames: many('--env'),
    set,
    ...(decl ? { declaration: readDeclaration(decl) } : {}),
    out: one('--out') ?? 'mwsc-min-results',
    ...(lm ? { listen: { host: lm[1]!, port: Number(lm[2]), ...(one('--advertise') ? { advertised: one('--advertise')! } : {}) } } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    log,
  });
  const bad = capViolations(doc);
  if (bad.length) throw new WritecheckError(`min mode produced a verdict it may not give (a bug of ours; nothing was written as final): ${bad.join('; ')}`, 4);
  for (const r of doc.results.filter((x) => x.verdict === 'violated')) log(`  ${r.requirement} (${r.level}) ${r.tool}${r.case ? ` [${r.case}]` : ''}: ${r.reason.slice(0, 200)}`);
  log(`min mode: ${doc.run.status}; spec ${doc.spec.url ?? doc.spec.file} sha256 ${doc.spec.sha256.slice(0, 12)}; ${doc.results.filter((x) => x.verdict === 'violated').length} violated record(s); ${doc.requirements.not_testable_mock.length} requirements not testable against a mock; results in ${one('--out') ?? 'mwsc-min-results'}/results.json`);
  if (doc.run.status !== 'complete') return 3;
  return doc.results.some((x) => x.verdict === 'violated') ? 1 : 0;
}
