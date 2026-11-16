/**
 * MWS-SEC-1: no credential in a tool result, success or error. A search, so it can only give
 * `violated` or `not observed` (spec 8.2, rule 8).
 *
 * Every tools/call answer of the run is scanned raw (before redaction) as it arrives, for:
 *   - the value of every credential the server is started with (server.env_passthrough,
 *     server.headers_env) and of the control's credential, and the canary values the declaration
 *     names by environment variable (secrets.canaries_env)
 *   - URLs whose query carries a parameter the declaration names as a token or a signature
 *     (secrets.token_params)
 *   - general credential patterns: listed for a person to examine, never `violated` by themselves
 * Only where a match was (step, tool, which variable or parameter) is kept, never the value.
 *
 * Before the verdicts, each read tool is called once with an id that does not exist (missing_id),
 * so that error answers are in the scan too.
 */

import type { Manifest } from '../core/manifest.js';
import { baseVars } from '../core/driver.js';
import { render } from '../core/template.js';
import { result, type Result } from '../report/verdicts.js';
import { sw, type GlobalCheck, type Observation, type PlanContext, type PlannedCheck, type ScanHit, type ScanLog } from './types.js';

const ID = 'credential-scan';
const VERSION = '1';

const PATTERNS: [string, RegExp][] = [
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cloud access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['code host token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['chat app token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['basic credentials in a URL', /\bhttps?:\/\/[^\s/:@"']+:[^\s/@"']+@/i],
];

/** The values to look for, by name; never written anywhere. */
export function scanValues(m: Manifest, env: NodeJS.ProcessEnv): { name: string; value: string; kind: 'credential' | 'canary' }[] {
  const out: { name: string; value: string; kind: 'credential' | 'canary' }[] = [];
  const add = (name: string, kind: 'credential' | 'canary') => {
    const v = env[name];
    if (typeof v === 'string' && v.length >= 6 && !out.some((o) => o.value === v)) out.push({ name, value: v, kind });
  };
  for (const n of m.server.env_passthrough) add(n, 'credential');
  for (const h of Object.values(m.server.headers_env)) add(h.env, 'credential');
  for (const r of m.resources) if (r.control?.auth) add(r.control.auth.env, 'credential');
  for (const n of m.secrets.canaries_env) add(n, 'canary');
  return out;
}

/** The scanner the session's onResult hook feeds. */
export class Scanner {
  readonly log: ScanLog = { results: [], hits: [] };
  private readonly needles: { name: string; kind: 'credential' | 'canary'; forms: string[] }[];

  constructor(values: { name: string; value: string; kind: 'credential' | 'canary' }[], private readonly tokenParams: string[]) {
    // why: a value inside a JSON string can appear escaped; look for both forms.
    this.needles = values.map((v) => ({ name: v.name, kind: v.kind, forms: [...new Set([v.value, JSON.stringify(v.value).slice(1, -1)])] }));
  }

  onResult(e: { step: string; tool: string; raw: string; isError: boolean }): void {
    this.log.results.push({ step: e.step, tool: e.tool, isError: e.isError });
    const hit = (kind: ScanHit['kind'], name: string) => this.log.hits.push({ step: e.step, tool: e.tool, isError: e.isError, kind, name });
    for (const n of this.needles) if (n.forms.some((f) => e.raw.includes(f))) hit(n.kind, n.name);
    if (this.tokenParams.length) {
      const wanted = new Set(this.tokenParams.map((p) => p.toLowerCase()));
      for (const m of e.raw.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
        try {
          const u = new URL(m[0]);
          for (const k of u.searchParams.keys()) if (wanted.has(k.toLowerCase())) hit('token_url', k);
        } catch {
          /* not a URL */
        }
      }
    }
    for (const [name, re] of PATTERNS) if (re.test(e.raw)) hit('pattern', name);
  }
}

export const secretsCheck: GlobalCheck = {
  id: ID,
  version: VERSION,
  requirements: ['MWS-SEC-1'],
  plan(ctx: PlanContext): PlannedCheck {
    const probes = ctx.manifest.resources.filter((r) => r.missing_id !== null && r.missing_id !== undefined);
    return { check: ID, version: VERSION, resource: '(server)', runs: true, calls: ['scan every tool result of the run (success and error) for the server\'s credentials, canary values and token-bearing URLs', ...probes.map((r) => `${r.read.tool} with the missing id ${JSON.stringify(r.missing_id)} (an error answer to scan)`)], writes: 0, creates: 0, notRun: [] };
  },
  async collect(ctx) {
    const label = ctx.label('SEC');
    for (const r of ctx.manifest.resources) {
      if (r.missing_id === null || r.missing_id === undefined) continue;
      await ctx.session.call(label, r.read.tool, render(r.read.args, baseVars(r, ctx.prefix, { id: r.missing_id })), { write: false, step: ctx.session.stepId(`sec.${r.name}.missing`) });
    }
    return { check: ID, version: VERSION, resource: '(server)', data: { results: ctx.scan.results.length, by_tool: countBy(ctx.scan.results), errors: ctx.scan.results.filter((x) => x.isError).length, hits: ctx.scan.hits, values: scanValuesNames(ctx.manifest) } };
  },
  evaluate(obs: Observation, ctx: PlanContext): Result[] {
    return secretVerdicts(obs.data as SecObs, ctx.manifest.secrets.issuing_tools ?? [], ctx.manifest.secrets.canaries_env ?? []);
  },
};

interface SecObs {
  results: number;
  errors: number;
  by_tool: Record<string, number>;
  hits: ScanHit[];
  values: string[];
}

const countBy = (rs: { tool: string }[]): Record<string, number> => rs.reduce<Record<string, number>>((m, r) => ((m[r.tool] = (m[r.tool] ?? 0) + 1), m), {});
const scanValuesNames = (m: Manifest): string[] => [...new Set([...m.server.env_passthrough, ...Object.values(m.server.headers_env).map((h) => h.env), ...m.resources.flatMap((r) => (r.control?.auth ? [r.control.auth.env] : [])), ...m.secrets.canaries_env])];

export function secretVerdicts(o: SecObs, issuing: string[] = [], canaryNames: string[] = []): Result[] {
  const sc = { id: ID, version: VERSION };
  const out: Result[] = [];
  for (const [tool, n] of Object.entries(o.by_tool).sort()) {
    const hits = o.hits.filter((h) => h.tool === tool);
    // why: spec NF-16: a tool declared to issue a credential or a signed link may return one; a credential of the server itself is never excepted.
    const issued = issuing.includes(tool) ? hits.filter((h) => h.kind === 'token_url') : [];
    const real = hits.filter((h) => h.kind !== 'pattern' && !issued.includes(h));
    const review = hits.filter((h) => h.kind === 'pattern');
    const notes = review.length ? [`For a person to examine (a general credential pattern, not by itself a violation; spec NF-25: a match inside ordinary content a caller stored is never violated on that match alone): ${[...new Set(review.map((h) => h.name))].join(', ')} at ${[...new Set(review.map((h) => h.step))].slice(0, 5).join(', ')}`] : [];
    // why: R7-7: violated is decided only from exact values; a canary counts only where it was placed in a credential store or a credential-typed field.
    if (o.values.some((v) => canaryNames.includes(v))) notes.push(`The canary values (${o.values.filter((v) => canaryNames.includes(v)).join(', ')}) are taken to be placed in a credential store or a credential-typed field of the backend, as the declaration states, never in ordinary content a caller stored (spec R7-7).`);
    if (issued.length) notes.push(`${issued.length} token-bearing URL(s) in results of ${tool}, which the declaration lists as a tool that exists to issue a credential (spec NF-16); not judged.`);
    if (real.length) out.push(result('MWS-SEC-1', sw(tool), sc, 'violated', `${tool}'s ${[...new Set(real.map((h) => (h.isError ? 'error' : 'success')))].join(' and ')} result(s) carried ${[...new Set(real.map((h) => (h.kind === 'token_url' ? `a URL with the ${h.name} parameter` : `the value of ${h.name}`)))].join(', ')} (${real.length} match(es) in ${n} result(s)).`, { steps: [...new Set(real.map((h) => h.step))].slice(0, 10), notes }));
    else out.push(result('MWS-SEC-1', sw(tool), sc, 'not observed', `No credential of the run (${o.values.join(', ') || 'none declared'}) and no token-bearing URL in ${n} result(s) of ${tool}. A search cannot show that no credential is ever returned.`, { numbers: { results: n }, notes }));
  }
  if (!out.length) out.push(result('MWS-SEC-1', sw('(all tools)'), sc, 'not tested', 'no tool result was captured'));
  return out;
}
