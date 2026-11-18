/**
 * Seat belts, not proof. None of these can show a target is a test system; each refuses an obvious
 * mistake before the first write:
 *
 *   - the manifest must say `target.environment: test`
 *   - the target string is typed back (or given as --confirm-target), together with the plan hash
 *     (--plan-hash); there is no --yes
 *   - a host that looks like production (app., api., www., a "prod" label, a well-known SaaS host)
 *     in the server URL, the control base, a passed-through URL variable, a host variable (`DB_HOST`
 *     with `DB_PORT`) or a URL or host flag in the server's command line is refused unless listed under
 *     target.allow_hosts
 *   - a catalog fingerprint the user registered as production is refused
 *   - a positive tenant check: a read-only call whose result must match a pattern before any write
 */

import { declaredWriteTools } from '../checks/coverage.js';
import { createInterface } from 'node:readline';

import type { Manifest } from './manifest.js';
import type { Session } from './session.js';
import { render } from './template.js';
import { baseVars } from './driver.js';
import { listAll } from './lists.js';
import { canonical, getPath, short, unsetPath, WritecheckError } from './util.js';

const PROD_LABEL = /(^|[.-])(prod|production|live)([.-]|$)/i;
const PROD_FIRST = /^(app|api|www|console|dashboard|admin)\./i;
/** Hosts of widely used hosted services, where a test tenant is the exception and must be listed. */
const SAAS = [/(^|\.)github\.com$/i, /(^|\.)gitlab\.com$/i, /\.atlassian\.net$/i, /\.slack\.com$/i, /\.salesforce\.com$/i, /\.myshopify\.com$/i, /\.zendesk\.com$/i, /\.notion\.(so|com)$/i, /(^|\.)linear\.app$/i, /\.hubspot\.com$/i, /\.stripe\.com$/i];

export function productionReason(host: string): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || h.endsWith('.localhost') || h.endsWith('.test')) return null;
  if (PROD_LABEL.test(h)) return `${h} has a production label`;
  if (PROD_FIRST.test(h)) return `${h} starts like a production front door (app., api., www., …)`;
  for (const re of SAAS) if (re.test(h)) return `${h} is a hosted service's main domain`;
  return null;
}

/** A URL with a scheme inside one command-line argument (the whole argument, or after `--flag=`). */
const URL_IN_ARG = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,]+/gi;

/**
 * A backend host given without a URL: in a host variable (`DB_HOST=b0` with `DB_PORT=3306`) or after a host flag
 * (`--db-host b0 --db-port 3306`). The rule, on the words of the name (split on `_`, and on `-` for a flag):
 *   - the last word is HOST, HOSTNAME or HOSTS: any hostname or IP address is a host (`PGHOST` counts as one of these);
 *   - the last word is SERVER(S), ADDR(S), ADDRESS(ES), ENDPOINT(S), NODES, BROKERS, SEEDS or SENTINELS: only a value with a
 *     dot, an IP address or a port of its own is a host (a single word such as `production` is a name, not a host);
 *   - a name with a LISTEN or BIND word is where the server listens, not a target; so is a variable of one word (`HOST`,
 *     `PORT`, `ADDR`) and an unprefixed host flag (`--host`, `-h`) on server.launch.command;
 *   - `HOST_HEADER` (HOST is not the last word) and `GHOST` (not a word of its own) are not host names.
 * The port is the sibling with PORT for the last word (`DB_HOST` → `DB_PORT`, `PGHOST` → `PGPORT`, in any case), or the
 * matching port flag after the host flag (`--db-host` → `--db-port`; `--host`, `-h`, `-H` → `--port`, `-p`).
 */
const LENIENT_WORDS = new Set(['HOST', 'HOSTNAME', 'HOSTS']);
const STRICT_WORDS = new Set(['SERVER', 'SERVERS', 'ADDR', 'ADDRS', 'ADDRESS', 'ADDRESSES', 'ENDPOINT', 'ENDPOINTS', 'NODES', 'BROKERS', 'SEEDS', 'SENTINELS']);
const LISTEN_WORDS = new Set(['LISTEN', 'BIND']);
/** For a host name: whether its values need a dot, an IP or a port (strict), and the words before the last one. Null when it is not a host name. */
function hostName(name: string, split: RegExp): { strict: boolean; prefix: string[] } | null {
  const w = name.toUpperCase().split(split).filter(Boolean);
  if (w.length === 1 && w[0] === 'PGHOST') return { strict: false, prefix: ['PG'] };
  const last = w.at(-1) ?? '';
  if (w.some((x) => LISTEN_WORDS.has(x))) return null;
  if (LENIENT_WORDS.has(last)) return { strict: false, prefix: w.slice(0, -1) };
  if (STRICT_WORDS.has(last)) return { strict: true, prefix: w.slice(0, -1) };
  return null;
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const NOT_A_HOST = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'none', 'null', 'undefined']);
/** The last label of a file name, not of a host (`config.yaml`, `prod.env`). */
const FILE_EXT = new Set(['yaml', 'yml', 'json', 'jsonc', 'json5', 'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties', 'txt', 'js', 'mjs', 'cjs', 'ts', 'sql', 'db', 'sqlite', 'sqlite3', 'log', 'xml', 'csv', 'pem', 'key', 'crt', 'cert', 'lock']);
/** Addresses a server listens on, not hosts it reaches. */
const UNSPECIFIED = new Set(['0.0.0.0', '[::]']);
const portOk = (p: string | undefined): p is string => !!p && /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;
const ipv6 = (v: string): string | null => {
  try {
    return /^[0-9a-f:.]+$/i.test(v) ? new URL(`http://[${v}]/`).host : null;
  } catch {
    return null;
  }
};
const unquote = (v: string): string => (/^(["']).*\1$/s.test(v) && v.length >= 2 ? v.slice(1, -1).trim() : v);

/**
 * A bare host (no scheme) given as `host` or `host:port`, normalized as URL.host is (lower case, an internationalized name in
 * its ASCII form, an IPv6 address in brackets), with `port` added when the value has none; or null when the value is not a
 * hostname or an IP address: empty, a flag word (`true`, `off`), a number on its own, a path or a file name, or a
 * listen-on-everything address (`0.0.0.0`, `::`). With `strict`, a single word without a port is not a host either.
 * One pair of surrounding quotes is dropped, and so is a named instance (`host\INSTANCE`).
 */
export function bareHost(value: string | undefined, port?: string, strict = false): string | null {
  const v = unquote((value ?? '').trim()).toLowerCase().replace(/\\[a-z0-9_$-]+$/, '');
  if (!v || NOT_A_HOST.has(v) || /[/\\\s@?#,]/.test(v)) return null;
  let host: string | null;
  let p: string | undefined;
  let ip = true;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(v);
  if (bracketed) [host, p] = [ipv6(bracketed[1]!), bracketed[2]];
  else if ((v.match(/:/g) ?? []).length >= 2) host = ipv6(v);
  else {
    const hp = /^([^:]+)(?::(\d+))?$/.exec(v);
    if (!hp) return null;
    [host, p] = [hp[1]!.replace(/\.$/, ''), hp[2]];
    const labels = host.split('.');
    // digits and dots make a host only as a whole IPv4 address (`3306` and `1.2` are not hosts)
    if (labels.every((l) => /^\d+$/.test(l))) {
      if (!IPV4.test(host)) return null;
    } else {
      ip = false;
      if (labels.length > 1 && FILE_EXT.has(labels.at(-1)!)) return null;
      try {
        host = new URL(`http://${host}/`).hostname; // an internationalized name in its ASCII form, as for a URL host
      } catch {
        return null;
      }
      if (!host.split('.').every((l) => LABEL.test(l))) return null;
    }
  }
  if (!host || UNSPECIFIED.has(host)) return null;
  if (p !== undefined && !portOk(p)) return null;
  if (strict && !ip && !host.includes('.') && p === undefined) return null;
  const withPort = p ?? (portOk(port?.trim()) ? port!.trim() : undefined);
  return withPort ? `${host}:${+withPort}` : host;
}

/**
 * The hosts in one value: a comma-separated list is read item by item (`a:27017,b:27017`), and `host,1433` (the second item
 * only a port) is one host with its port. A URL is not read here (it is read as a URL).
 */
export function hostsIn(value: string, port?: string, strict = false): string[] {
  const v = unquote(value.trim());
  if (v.includes('://')) return [];
  const parts = v.split(',').map((s) => s.trim());
  if (parts.length === 2 && /^\d+$/.test(parts[1]!) && !parts[0]!.includes(':')) {
    const h = bareHost(`${parts[0]}:${parts[1]}`, undefined, strict);
    return h ? [h] : [];
  }
  return parts.map((s) => bareHost(s, port, strict)).filter((h): h is string => !!h);
}

type Found = { host: string; where: string };

/** Hosts in host variables (prefixed names only), each with its sibling port. */
function varHosts(vars: Map<string, { value: string; where: string }>, out: Found[]): void {
  const upper = new Map([...vars].map(([k, v]) => [k.toUpperCase(), v.value]));
  for (const [k, { value, where }] of vars) {
    const n = hostName(k, /_/);
    if (!n || (!n.prefix.length && k.toUpperCase() !== 'PGHOST')) continue;
    const portVar = k.toUpperCase() === 'PGHOST' ? 'PGPORT' : `${n.prefix.join('_')}_PORT`;
    for (const host of hostsIn(value, upper.get(portVar), n.strict)) out.push({ host, where });
  }
}

/** Hosts after host flags in one command line, and in `-e NAME=value` / `--env NAME=value` / `--env=NAME=value` variables. */
function argvHosts(cmd: string[], where: string, launch: boolean, out: Found[]): void {
  const vars = new Map<string, { value: string; where: string }>();
  const hosts: { i: number; key: string; strict: boolean; value: string; at: number; short?: 'h' | 'H' }[] = [];
  const ports: { i: number; key: string; value: string }[] = [];
  for (const [i, x] of cmd.entries()) {
    const setVar = (s: string | undefined, at: number) => {
      const eq = s?.indexOf('=') ?? -1;
      if (s && eq > 0) vars.set(s.slice(0, eq), { value: s.slice(eq + 1), where: `${where}[${at}]` });
    };
    if (x === '-e' || x === '--env') setVar(cmd[i + 1], i + 1);
    else if (x.startsWith('--env=')) setVar(x.slice(6), i);
    else if (x === '-h' || x === '-H') {
      if (cmd[i + 1] !== undefined) hosts.push({ i, key: '', strict: x === '-H', value: cmd[i + 1]!, at: i + 1, short: x === '-h' ? 'h' : 'H' });
    } else if (x === '-p') {
      if (cmd[i + 1] !== undefined) ports.push({ i, key: '', value: cmd[i + 1]! });
    } else if (/^--[a-z0-9]/i.test(x)) {
      const eq = x.indexOf('=');
      const name = x.slice(2, eq > 0 ? eq : undefined);
      const [value, at] = eq > 0 ? [x.slice(eq + 1), i] : [cmd[i + 1], i + 1];
      if (value === undefined) continue;
      const words = name.toUpperCase().split(/[-_]/).filter(Boolean);
      if (words.at(-1) === 'PORT') ports.push({ i, key: words.slice(0, -1).join('-'), value });
      const n = hostName(name, /[-_]/);
      if (n && !(launch && !n.prefix.length)) hosts.push({ i, key: n.prefix.join('-'), strict: n.strict, value, at });
    }
  }
  const unprefixedPort = ports.some((p) => p.key === '');
  for (const [k, h] of hosts.entries()) {
    if (h.short && (launch || (h.short === 'h' && !unprefixedPort))) continue; // -h is help unless a port is given; -H needs a port or a host-like value
    const prev = hosts[k - 1]?.i ?? -1;
    const next = hosts[k + 1]?.i ?? Infinity;
    const same = ports.filter((p) => p.key === h.key);
    const port = (same.find((p) => p.i > h.i && p.i < next) ?? same.filter((p) => p.i < h.i && p.i > prev).at(-1))?.value;
    for (const host of hostsIn(h.value, port, h.strict && !(h.short === 'H' && unprefixedPort))) out.push({ host, where: `${where}[${h.at}]` });
  }
  varHosts(vars, out);
}

/** Every host the run would reach directly, or that the server is pointed at through a passed-through variable. */
export function targetHosts(m: Manifest, env: NodeJS.ProcessEnv): { host: string; where: string }[] {
  const out: { host: string; where: string }[] = [];
  const add = (u: string | undefined | null, where: string) => {
    if (!u) return;
    try {
      const host = new URL(u).host;
      if (host) out.push({ host, where }); // file:///x and the like have no host
    } catch {
      /* not a URL */
    }
  };
  add(m.server.url, 'server.url');
  for (const n of [...m.server.env_passthrough, ...m.server.env_public]) add(env[n], `server environment ${n}`);
  for (const [k, v] of Object.entries(m.server.env)) add(v, `server.env ${k}`);
  // why: a server can be pointed at its backend by a command-line argument (`server redis://host:6379`, `--url=…`),
  // not only by its environment (corpus batch 1, 17 Nov). Such a host is shown in the plan and checked like the rest.
  const argv = (cmd: string[] | null | undefined, where: string) => {
    for (const [i, a] of (cmd ?? []).entries()) for (const u of a.match(URL_IN_ARG) ?? []) add(u, `${where}[${i}]`);
  };
  argv(m.server.stdio, 'server.stdio');
  argv(m.server.launch?.command, 'server.launch.command');
  // why: a server is as often pointed at its backend by a host and a port in separate variables (`DB_HOST=b0`, `DB_PORT=3306`)
  // or flags (`--db-host b0 --db-port 3306`), with no URL anywhere (corpus batch runs, 17 Nov). Such a host is shown in the plan
  // and checked like the rest. The variables are the ones the server is started with (a literal wins, as in Session.serverEnv).
  // A shell string (`sh -c "…"`) is not parsed.
  const vars = new Map<string, { value: string; where: string }>();
  for (const n of [...m.server.env_passthrough, ...m.server.env_public]) if (env[n] !== undefined) vars.set(n, { value: env[n]!, where: `server environment ${n}` });
  for (const [k, v] of Object.entries(m.server.env)) vars.set(k, { value: v, where: `server.env ${k}` });
  varHosts(vars, out);
  argvHosts(m.server.stdio ?? [], 'server.stdio', false, out);
  argvHosts(m.server.launch?.command ?? [], 'server.launch.command', true, out);
  for (const r of m.resources) if (r.control) add(r.control.base ?? env[r.control.base_env!], `resources.${r.name}.control`);
  return out;
}

export function checkTarget(m: Manifest, env: NodeJS.ProcessEnv): void {
  if (m.target.environment !== 'test') throw new WritecheckError(`target.environment is ${JSON.stringify(m.target.environment)}: mcp-writecheck runs only against an environment declared as test`, 3);
  const allowed = new Set(m.target.allow_hosts.map((h) => h.toLowerCase()));
  for (const { host, where } of targetHosts(m, env)) {
    const why = productionReason(host);
    if (why && !allowed.has(host.toLowerCase()) && !allowed.has(host.toLowerCase().replace(/:\d+$/, ''))) throw new WritecheckError(`${where}: ${why}. If this really is a test environment, add it to target.allow_hosts.`, 3);
  }
}

export function checkFingerprint(m: Manifest, fingerprint: string): void {
  if (m.target.refuse_fingerprints.includes(fingerprint)) throw new WritecheckError(`the server's catalog fingerprint ${fingerprint} is registered as production (target.refuse_fingerprints)`, 3);
}

/**
 * The confirmation: the target string and the plan hash, each typed back, or given as flags in CI.
 * A mismatch stops the run. There is no way to skip it.
 */
export async function confirm(m: Manifest, hash: string, o: { confirmTarget?: string; planHash?: string; interactive: boolean; ask?: (q: string) => Promise<string> }): Promise<void> {
  let target = o.confirmTarget;
  let ph = o.planHash;
  if (target === undefined || ph === undefined) {
    if (!o.interactive) throw new WritecheckError('not a terminal: pass --confirm-target <target> and --plan-hash <hash> (from `mcp-writecheck plan`); there is no --yes', 3);
    const ask = o.ask ?? askLine;
    if (target === undefined) target = await ask(`Type the target to confirm (${m.target.confirm}): `);
    if (ph === undefined) ph = await ask(`Type the plan hash to confirm (${hash}): `);
  }
  if (target.trim() !== m.target.confirm) throw new WritecheckError(`the target typed (${JSON.stringify(target.trim())}) is not the manifest's target.confirm (${JSON.stringify(m.target.confirm)})`, 3);
  if (ph.trim() !== hash) throw new WritecheckError(`the plan hash given (${ph.trim()}) is not this plan's (${hash}): the manifest, the catalog, the limits or the suite changed since it was printed; run \`plan\` again`, 3);
}

function askLine(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((r) => rl.question(q, (a) => (rl.close(), r(a))));
}

/** The positive tenant check: one read-only call whose result must match before any write. */
/** The tools that declare readOnlyHint: true. */
export const readOnlyToolsOf = (tools: Record<string, unknown>[]): string[] => tools.filter((t) => (t['annotations'] as Record<string, unknown> | undefined)?.['readOnlyHint'] === true).map((t) => String(t['name']));

/** One call of the guard's tool, as it is about to be sent (the ledger records it before it goes out). */
export interface GuardCall {
  step: string;
  tool: string;
  /** check: the tenant check; dry, after: the two repeats that verify a declared call; alive: the liveness re-read between checks. */
  phase: 'check' | 'dry' | 'after' | 'alive';
  /** What says the call only reads: the tool's readOnlyHint (annotation), the operator's read_only for an unannotated tool
   * (declared), or the operator's read_only_call for one call through a dispatcher (operator: not proven, counted as a write). */
  basis: 'annotation' | 'declared' | 'operator';
}
export interface GuardHooks {
  /** Called before each guard call is sent: the run appends it to the ledger and counts it in the report. */
  onCall?: (c: GuardCall) => void;
}

export const guardBasis = (g: NonNullable<Manifest['target']['guard']>): GuardCall['basis'] => (g.read_only_call ? 'operator' : g.read_only ? 'declared' : 'annotation');

/** The calls sent so far, in words, for a stop message: never "no write was made" once a call that may write went out. */
function sentText(g: NonNullable<Manifest['target']['guard']>, calls: GuardCall[]): string {
  // why: B2 follow-up: a tool declared read-only on an unannotated server rests on a declaration too.
  if (guardBasis(g) === 'annotation') return 'no write was made';
  if (guardBasis(g) === 'declared') return `the guard ${g.tool}, declared read-only (target.guard.read_only), was sent ${calls.length} time(s) (steps ${calls.map((c) => c.step).join(', ')}; the ledger records each call); no other write was made`;
  return `the declared call ${g.tool} ${short(JSON.stringify(g.args ?? {}), 120)} was sent ${calls.length} time(s) (steps ${calls.map((c) => c.step).join(', ')}); it rests on the operator's declaration that it only reads, so it may have changed state (the ledger records each call); no other write was made`;
}

/**
 * The state the declaration can be checked against (review B2): every canary, and every list the manifest declares that needs
 * no object, marker or scope, each read to the end. A key per list or canary; the value is canonical JSON with the declared
 * ignored fields left out, or null where the read failed (that one is not compared).
 */
async function stateSnapshot(m: Manifest, s: Session, label: string, step: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const c of m.canaries) {
    const k = `canary ${c.name}`;
    const r = await s.call(label, c.tool, c.args, { write: false, step: s.stepId(`${step}.canary.${c.name}`) });
    if (!r.ok) {
      out.set(k, null);
      continue;
    }
    let v = c.path ? getPath(r.data, c.path) : r.data;
    for (const p of c.ignore) v = unsetPath(v, p);
    out.set(k, canonical(v ?? null));
  }
  for (const r of m.resources) {
    const l = r.list ?? (r.read.items ? { tool: r.read.tool, args: r.read.args, items: r.read.items, id: r.read.match ?? 'id', name: 'name', ignore: [], next: null } : null);
    if (!l || /\{\{\s*(json:)?\s*(id|marker|key|scope)\b/.test(JSON.stringify(l.args ?? null))) continue;
    const args = render(l.args, baseVars(r, '', {}));
    const k = `list ${l.tool} ${canonical(args ?? null)}`;
    if (out.has(k)) continue;
    const got = await listAll(s, label, l, args, s.stepId(`${step}.list.${r.name}`));
    if (!got.ok) {
      out.set(k, null);
      continue;
    }
    const ignore = [...r.read.ignore, ...l.ignore];
    const items = got.items.map((it) => {
      let v = it;
      for (const p of ignore) v = unsetPath(v, p);
      return canonical(v ?? null);
    });
    out.set(k, canonical(items.sort()));
  }
  return out;
}

export async function tenantGuard(m: Manifest, s: Session, label: string, o: GuardHooks = {}): Promise<{ matched: string; step: string; basis?: 'operator'; calls: GuardCall[]; state?: string }> {
  const g = m.target.guard;
  if (!g) throw new WritecheckError('target.guard is required: a read-only tool call whose result must match a pattern (for example the tenant or workspace name) before any write', 2);
  const tools = await s.listTools(label);
  const def = tools.find((t) => t['name'] === g.tool) as { annotations?: Record<string, unknown> } | undefined;
  if (!def) throw new WritecheckError(`target.guard: ${g.tool} is not in tools/list`, 3);
  const gp = guardProblem(g, def, { writeTools: new Set(declaredWriteTools(m, tools as never).keys()), anyAnnotated: tools.some((t) => t['annotations'] && typeof t['annotations'] === 'object' && Object.keys(t['annotations'] as object).length > 0), readOnlyTools: readOnlyToolsOf(tools) });
  if (gp) throw new WritecheckError(gp, 3);
  const basis = guardBasis(g);
  const calls: GuardCall[] = [];
  const step = s.stepId('guard');
  const once = async (st: string, phase: GuardCall['phase']) => {
    // why: review B2: a call that rests on the operator's declaration is not proven to only read; it counts against the write
    // budget, and it is recorded (the ledger, the report) before it goes out.
    if (basis !== 'annotation') s.reserveWrites(1, `the declared guard call ${g.tool}`);
    const c: GuardCall = { step: st, tool: g.tool, phase, basis };
    o.onCall?.(c);
    calls.push(c);
    const r = await s.call(label, g.tool, render(g.args, {}), { step: st, write: false });
    if (!r.ok) throw new WritecheckError(`target.guard: ${g.tool} failed (${short(r.text ?? r.rpc_error?.message ?? r.transport_error ?? 'error', 160)}); ${sentText(g, calls)}`, 3);
    const v = g.path ? getPath(r.data, g.path) : r.text;
    const text = typeof v === 'string' ? v : JSON.stringify(v ?? null);
    if (!new RegExp(g.pattern).test(text)) throw new WritecheckError(`target.guard: ${g.tool}${g.path ? ` at ${g.path}` : ''} returned ${short(text, 80)}, which does not match ${g.pattern}; ${sentText(g, calls)}`, 3);
    return { text, whole: JSON.stringify([r.text, r.data]) };
  };
  if (basis !== 'operator') {
    const first = await once(step, 'check');
    return { matched: short(first.text, 80), step, calls };
  }
  // why: review B2: the guard rests on the operator's declaration, not an annotation, so it is checked: the state the manifest
  // lets the tester read (its canaries and every list that needs no object) is read before the first call and after the
  // third, and the same call made twice more must answer exactly as the first did. Any error, a different answer, or a changed
  // list or canary refuses the run. A write that changes nothing the manifest lets the tester read, and answers the same each
  // time, would still pass: the results say the guard rests on the declaration.
  const before = await stateSnapshot(m, s, label, 'guard.state.before');
  const first = await once(step, 'check');
  const differs = () => `target.guard: ${g.tool} is declared read-only (read_only_call), but the same call answered differently when made again, so it may change state; ${sentText(g, calls)}`;
  if ((await once(s.stepId('guard.dry'), 'dry')).whole !== first.whole) throw new WritecheckError(differs(), 3);
  if ((await once(s.stepId('guard.after'), 'after')).whole !== first.whole) throw new WritecheckError(differs(), 3);
  const after = await stateSnapshot(m, s, label, 'guard.state.after');
  const compared: string[] = [];
  for (const [k, v] of before) {
    if (v === null) continue;
    const w = after.get(k);
    if (w === null || w === undefined) throw new WritecheckError(`target.guard: ${g.tool} is declared read-only (read_only_call); ${k} answered before the guard's calls and not after them, so whether they changed state is not known; ${sentText(g, calls)}`, 3);
    if (w !== v) throw new WritecheckError(`target.guard: ${g.tool} is declared read-only (read_only_call), but ${k} changed across its three calls, so the call may change state (or something else changed the target meanwhile; either way the guard cannot be trusted); ${sentText(g, calls)}`, 3);
    compared.push(k);
  }
  const unread = [...before].filter(([, v]) => v === null).map(([k]) => k);
  const state = compared.length
    ? `${compared.join(', ')} read the same before and after the three calls${unread.length ? ` (${unread.join(', ')} could not be read, so not compared)` : ''}`
    : `the manifest declares no canary and no list that needs no object${unread.length ? ` that could be read (${unread.join(', ')} failed)` : ''}, so no state was compared around the three calls`;
  return { matched: short(first.text, 80), step, basis: 'operator', calls, state };
}

/**
 * Is the target still answering (the GitHub Action's test, problem 14 in the Action's NOTES.md)? Between checks: an answer that is not a
 * success, or that no longer matches, twice a second apart, says the target (or its backend) stopped answering. Returns why, or null.
 *
 * The guard's read is made again only where the guard is proven or declared read-only as a tool. A guard that rests on the
 * operator's declaration of one call (read_only_call) is never re-sent (review B2): the run asks tools/list instead, which
 * shows that the server answers, not that its backend does.
 */
export async function targetStopped(m: Manifest, s: Session, label: string, o: GuardHooks = {}): Promise<string | null> {
  const g = m.target.guard;
  if (!g) return null;
  const basis = guardBasis(g);
  let why = '';
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    if (basis === 'operator') {
      try {
        await s.listTools(label);
        return null;
      } catch (e) {
        if (['RateLimited', 'BudgetExhausted', 'Interrupted'].includes((e as Error).constructor?.name ?? '')) throw e;
        why = `tools/list did not answer (${short((e as Error).message, 160)})`;
      }
      continue;
    }
    try {
      const st = s.stepId('guard.alive');
      // B2 follow-up: a guard declared read-only (not annotated) is charged to the write budget on every call, as at the start.
      if (basis === 'declared') s.reserveWrites(1, `the declared guard call ${g.tool}`);
      o.onCall?.({ step: st, tool: g.tool, phase: 'alive', basis });
      const r = await s.call(label, g.tool, render(g.args, {}), { step: st, write: false });
      if (r.ok) {
        const v = g.path ? getPath(r.data, g.path) : r.text;
        if (new RegExp(g.pattern).test(typeof v === 'string' ? v : JSON.stringify(v ?? null))) return null;
        why = `${g.tool} no longer matches the tenant guard`;
      } else why = `${g.tool} failed (${short(r.text ?? r.rpc_error?.message ?? r.transport_error ?? (r.timed_out ? 'timed out' : 'error'), 160)})`;
    } catch (e) {
      // why: review: a rate limit, the budget or an interruption is its own stop; the caller handles it, and no second request goes out.
      if (['RateLimited', 'BudgetExhausted', 'Interrupted'].includes((e as Error).constructor?.name ?? '')) throw e;
      why = `${g.tool} could not be called (${short((e as Error).message, 160)})`;
    }
  }
  return basis === 'operator' ? `the target stopped answering: ${why}, twice` : `the target stopped answering: the tenant guard's read, ${why}, twice`;
}

/**
 * The guard must be a tool that only reads: by its own readOnlyHint: true, or, for a server that annotates no tool,
 * by the declaration (target.guard.read_only: true). A tool that declares readOnlyHint: false or destructiveHint:
 * true is refused either way. Shared by plan (which warns before the run) and the run.
 */
export function guardProblem(g: NonNullable<Manifest['target']['guard']>, def: { annotations?: Record<string, unknown> } | undefined, o: { writeTools?: Set<string>; anyAnnotated?: boolean; readOnlyTools?: string[] } = {}): string | null {
  if (!def) return `target.guard: ${g.tool} is not in tools/list`;
  // why: PostHog cli mode (research builds): a server whose only tool is a dispatcher can be guarded only by a call the operator
  // declares read-only; the run verifies it (tenantGuard) and the record says the guard rests on that declaration.
  const a = def.annotations ?? {};
  if (g.read_only_call) {
    // why: review: the declaration is for a server whose only route is a dispatcher; it never turns the other protections off.
    if (a['destructiveHint'] === true) return `target.guard: ${g.tool} declares destructiveHint: true; even a declared read-only call through it cannot be the guard`;
    if (o.readOnlyTools?.length) return `target.guard: read_only_call is for a server whose only tool is a dispatcher; this server offers read-only tools (${o.readOnlyTools.slice(0, 3).join(', ')}): use one of them`;
    return null;
  }
  if (a['readOnlyHint'] === true) return null;
  if (a['readOnlyHint'] === false || a['destructiveHint'] === true) return `target.guard: ${g.tool} declares readOnlyHint: false or destructiveHint: true; the positive tenant check must be a tool that only reads`;
  // why: read_only is for a server that annotates no tool, and never for a tool the same manifest declares as a write (review).
  if (g.read_only && o.writeTools?.has(g.tool)) return `target.guard: ${g.tool} is declared as a write tool in this manifest; it cannot be the guard`;
  if (g.read_only && o.anyAnnotated) return `target.guard: read_only: true is for a server that annotates no tool, and this server annotates some; choose a tool that declares readOnlyHint: true`;
  if (g.read_only) return null;
  return `target.guard: ${g.tool} does not declare readOnlyHint: true; the positive tenant check must be a read-only tool. If the server annotates no tool and ${g.tool} only reads, declare it: target.guard.read_only: true`;
}
