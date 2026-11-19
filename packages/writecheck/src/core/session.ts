/**
 * One run's connection to the server under test and to the control: server processes (stdio) or
 * sessions (HTTP) by label, every call recorded in the capture and in a Jepsen-style history
 * (invoke, then ok, fail or info; a timeout is info, never fail), the write budget, the shared rate
 * limit, and the stop on the first 429.
 *
 * A label is one server process for stdio or one MCP session for HTTP. Barrier pairs in `separate`
 * mode use two labels, so the two writers are two processes, as two independent clients would be.
 */

import { appendFileSync } from 'node:fs';

import type { CaptureSink } from './capture.js';
import { BASE_ENV, HttpMcpClient, LaunchedServer, PROTOCOL_VERSION_META_KEY, rawHttp, StdioClient, type LaunchOutcome, type McpClient, type RpcOutcome } from './client.js';
import { egressFor, type EgressPolicy } from './egress.js';
import type { Gate } from '../gate/gate.js';
import { declaredDecodes, declaredExtracts, type Extract, type Manifest, type SessionInit } from './manifest.js';
import { render } from './template.js';
import type { Redactor } from './redact.js';
import { Throttle } from './throttle.js';
import { getPath, isObj, nowMs, parseStructured, sha256, sleep, WritecheckError, type Obj } from './util.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import { captureShape, freeWordsOfBlock, type ShapeCapture } from '../checks/shape.js';

export const PROTOCOL_VERSION = '2025-11-25';
/** The revision without initialize: server/discover, and a _meta envelope on every request. */
export const MODERN_PROTOCOL = '2026-07-28';
/** How long `auto` waits for server/discover before taking the 2025-11-25 path. */
const DISCOVER_TIMEOUT_MS = 5_000;

/**
 * Whether a revision negotiated by initialize predates the one the tester offered (2025-11-25). Revisions are dates
 * (YYYY-MM-DD), so they order as strings. A server that answers an older revision knows neither 2025-11-25 nor
 * 2026-07-28, the revision that introduced server/discover, so it is not asked server/discover.
 */
export const predatesOffered = (rev: string | null): boolean => typeof rev === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rev) && rev < PROTOCOL_VERSION;

/** What a call carried (B-9: same_key / same_version): true or false where the tester knows it, absent where it cannot tell (then the shape gives no held and no violated from it). */
export type Carried = { key?: boolean; version?: boolean };

export interface CallResult {
  kind: 'call';
  /** The result's resultType (2026-07-28), or null when absent (complete). */
  result_type?: string | null;
  /** For an input_required result: what the server asks for, and the state to echo on the retry. */
  input_required?: { inputRequests: unknown; requestState: string | null } | null;
  step: string;
  label: string;
  tool: string;
  /** An answer with no JSON-RPC error and no isError. */
  ok: boolean;
  isError: boolean;
  rpc_error: { code: number; message: string } | null;
  http_status: number | null;
  /** First text content (raw). */
  text: string | null;
  /** structuredContent when present, else the text parsed as JSON or YAML; for a wrapped result that was decoded, the parsed document (see `decoded`). */
  data: unknown;
  /**
   * Set where `data` is not structuredContent itself but the JSON document its only member `result` carried as a string (a
   * wrapped result, as Python FastMCP returns): `basis` says why it was decoded (the tool's outputSchema marks a wrapped
   * result, or the manifest declares `decode: json`). Absent for every other result.
   */
  decoded?: { from: 'structuredContent.result'; basis: DecodeBasis; text_mirrors?: 'structuredContent' };
  /** Where the result was decoded: structuredContent as received (the wrapper and its string), kept beside the decoded `data`. */
  raw_structured?: unknown;
  /**
   * Set where `data` is the JSON document taken out of the answer's text by the manifest's `decode.extract` (between two markers,
   * or a regex's capture group) and parsed. `refusals`: whether the structured refusal signals read it (declared); `text` is kept
   * as received, so the patterns read the answer as it came.
   */
  extracted?: { from: 'text'; by: 'between' | 'regex'; basis: 'manifest'; refusals: boolean };
  /** The shape fields of structuredContent and of each JSON text block that carry an `mws` field (spec 7.3, rule 11; src/checks/shape.ts), or null. */
  shape?: ShapeCapture | null;
  /** Whether the call carried an idempotency key and a version (B-9: same_key / same_version on a call that carried none is read as yes); set by the driver for the writes it builds, absent where not recorded. */
  carried?: Carried;
  /** Where the result carries a shape: the text blocks the patterns read, without the serialized structuredContent and any JSON block carrying the shape (B-9 v2). */
  prose_text?: string | null;
  timed_out: boolean;
  transport_error: string | null;
  rpc_id: number | null;
  t_start_ms: number;
  t_end_ms: number;
}

/** Why a wrapped result is decoded: the tool's declared outputSchema marks it, or the manifest opts in (`decode: json`). */
export type DecodeBasis = 'outputSchema' | 'manifest';

/**
 * Does a tool's outputSchema mark a wrapped result: an object schema whose only property is `result`, of type string or with no
 * type, with or without Python FastMCP's `x-fastmcp-wrap-result: true` (the MCP Python SDK wraps a non-object return the same
 * way, without the extension)? A `result` whose declared type excludes string never carries a JSON document as a string, so
 * it does not count, whatever the extension says.
 */
export function marksWrappedResult(schema: unknown): boolean {
  if (!isObj(schema)) return false;
  const props = isObj(schema['properties']) ? schema['properties'] : null;
  if (!props || Object.keys(props).length !== 1 || !Object.hasOwn(props, 'result')) return false;
  const r = props['result'];
  const t = isObj(r) ? r['type'] : undefined;
  return t === undefined || t === 'string' || (Array.isArray(t) && t.includes('string'));
}

/**
 * The JSON document a wrapped result carries: structuredContent is an object whose only member is `result`, a string that
 * parses as a JSON object or array. Anything else (other members, a string that is not JSON, JSON that is a scalar) gives
 * undefined, and the result is read as it is.
 */
export function unwrapResult(sc: unknown): unknown {
  if (!isObj(sc)) return undefined;
  const ks = Object.keys(sc);
  if (ks.length !== 1 || ks[0] !== 'result' || typeof sc['result'] !== 'string') return undefined;
  const s = sc['result'].trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface HttpResult {
  kind: 'http';
  step: string;
  method: string;
  path: string;
  ok: boolean;
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
  error: string | null;
  t_start_ms: number;
  t_end_ms: number;
}

export type StepResult = CallResult | HttpResult;

export interface HistoryEvent {
  op: number;
  phase: 'invoke' | 'ok' | 'fail' | 'info';
  kind: 'call' | 'http';
  label: string | null;
  step: string;
  name: string;
  write: boolean;
  t_ms: number;
  detail?: string;
}

export class RateLimited extends WritecheckError {
  constructor(what: string) {
    super(`stopped: the target answered 429 (rate limited) to ${what}; nothing after it was run`, 4);
  }
}

/** The run was interrupted; the call was not sent. */
export class Interrupted extends WritecheckError {
  constructor(why: string) {
    super(`stopped: ${why}`, 4);
  }
}

/** A `session.init` call failed: the run stops (a harness reason, not a verdict on the server's write path). */
export class SessionInitFailed extends Interrupted {}

export class BudgetExhausted extends WritecheckError {
  constructor(what: string, budget: number) {
    super(`stopped: ${what} would exceed the write budget of ${budget}`, 4);
  }
}

export interface SessionOptions {
  manifest: Manifest;
  capture: CaptureSink;
  redactor: Redactor;
  egress: EgressPolicy;
  /** The tester's own environment (the source of passthrough values). */
  env: NodeJS.ProcessEnv;
  write_budget: number;
  /** Minimum time between writes, shared across processes through the throttle file (0: none). */
  min_interval_ms: number;
  throttle_file?: string;
  history_file?: string;
  timeout_ms?: number;
  /** The backend gate: its environment goes into every server process the session starts. */
  gate?: Gate | null;
  /**
   * Called with every tools/call answer as the raw JSON text of the JSON-RPC message, before any
   * redaction (the credential scan needs the bytes the client received). Never stored here.
   */
  onResult?: (e: { step: string; label: string; tool: string; raw: string; isError: boolean }) => void;
}

interface Conn {
  client: McpClient;
  initialized: boolean;
  /** The revision spoken on this connection (null: an uninitialised 2025-era server). */
  protocol: string | null;
  capabilities: Obj | null;
  /** A server process started for this label alone (Session.launch), stopped with it. */
  own: LaunchedServer | null;
  /** The environment overrides a label started with Session.launch was given (a restart starts it again with the same). */
  launchEnv?: Record<string, string>;
  /** session.init on this connection: run once, before its first other tools/call. */
  init?: Promise<void>;
}

/** How a restart went (MWS-RETRY-2 step (e)): the stop asked for, the stop used (a graceful stop that needed SIGKILL is a kill), and when. */
export interface RestartResult {
  stop_requested: 'graceful' | 'kill';
  stop_used: 'graceful' | 'kill';
  /** How the process ended: closed stdin, SIGTERM, SIGKILL, or it had already exited. */
  ended_by: string;
  t_stop_ms: number;
  t_stopped_ms: number;
  /** When tools/list answered again on the new process (null: it did not). */
  t_ready_ms: number | null;
  started: boolean;
  reason: string | null;
}

export type LaunchResult = { started: true; protocol: string | null } | { started: false; exit_code: number | null; reason: string; stderr_tail: string };

const RATE_TEXT = /\bHTTP 429\b|\b429 Too Many|too many requests|rate[- ]limit(ed| exceeded)/i;

export class Session {
  writes = 0;
  readonly history: HistoryEvent[] = [];
  private readonly conns = new Map<string, Conn>();
  private stepSeq = 0;
  private op = 0;
  private readonly throttle?: Throttle;
  private closed = false;
  /** Server processes ever started, for the report. */
  readonly started: string[] = [];
  /** Spec 7.3, rule 10: every request for input the server made during a call, and what the tester answered. */
  readonly inputRequests: { step: string; tool: string; method: string; answer: string }[] = [];
  private aborted: string | null = null;
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];
  /** The shared HTTP server of a `server.launch` manifest, started on first use. */
  private main: LaunchedServer | null = null;
  private mainStart: Promise<LaunchOutcome> | null = null;
  /** Learned on the first connection: whether this server speaks 2026-07-28 (auto mode asks once). */
  private modern: boolean | null = null;
  /** Facts about the connection that are not verdicts (for the results' `target.mcp.notes`): e.g. a server that failed on server/discover. */
  readonly notes: string[] = [];
  /** Tools whose wrapped results are decoded, and why: the manifest's `decode: json`, or an outputSchema in tools/list that marks one. */
  private readonly decodeTools = new Map<string, DecodeBasis>();
  /** Tools the manifest declares `decode: none` for: never decoded, whatever their outputSchema says. */
  private readonly decodeOff = new Set<string>();
  /** Tools whose outputSchema marks a wrapped result (to say so where `decode: none` keeps one as it is). */
  private readonly schemaMarked = new Set<string>();
  /** Tools a decode (or a decode switched off) was already noted for (one note per tool). */
  private readonly decodeNoted = new Set<string>();
  /** Tools the manifest declares a read extraction for (`decode.extract`). */
  private readonly extracts: Map<string, Extract>;
  /** Tools an extraction (used, or declared and not matched) was noted for. */
  private readonly extractNoted = new Set<string>();
  /** Tools tools/list marks readOnlyHint: true (a session.init call to one is not counted as a write). */
  private readonly readOnlyTools = new Set<string>();
  /** session.init calls made, all sessions together (for the results). */
  initCalls = 0;
  /** Set where a session.init call failed: the reason the run stopped. */
  initFailure: string | null = null;

  constructor(readonly o: SessionOptions) {
    if (o.min_interval_ms > 0 && o.throttle_file) this.throttle = new Throttle(o.throttle_file, o.min_interval_ms);
    for (const [tool, mode] of o.manifest ? declaredDecodes(o.manifest) : []) {
      if (mode === 'json') this.decodeTools.set(tool, 'manifest');
      else this.decodeOff.add(tool);
    }
    this.extracts = o.manifest ? declaredExtracts(o.manifest) : new Map();
  }

  /** A new step id, unique in the run: `<prefix>.<seq>`. */
  stepId(prefix: string): string {
    this.stepSeq++;
    const p = prefix.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
    return `${p}.${String(this.stepSeq).padStart(5, '0')}`;
  }

  private hist(e: Omit<HistoryEvent, 't_ms'>): void {
    const ev = { ...e, t_ms: nowMs() };
    this.history.push(ev);
    if (this.o.history_file) appendFileSync(this.o.history_file, this.o.redactor.text(JSON.stringify(ev)) + '\n');
  }

  /** Count writes against the budget (a pair reserves both halves before the release). */
  reserveWrites(n: number, what: string): void {
    if (this.writes + n > this.o.write_budget) throw new BudgetExhausted(what, this.o.write_budget);
    this.writes += n;
  }

  /** Wait for the shared rate limit once (a pair waits once for both halves). */
  async pace(): Promise<void> {
    await this.throttle?.wait();
  }

  /** The server's environment: process basics, the named passthrough and public variables, literals, the gate's routing, then overrides. */
  serverEnv(overrides: Record<string, string> = {}): Record<string, string> {
    const m = this.o.manifest.server;
    const env: Record<string, string> = {};
    for (const k of BASE_ENV) if (this.o.env[k] !== undefined) env[k] = this.o.env[k]!;
    for (const k of [...m.env_passthrough, ...m.env_public]) if (this.o.env[k] !== undefined) env[k] = this.o.env[k]!;
    Object.assign(env, m.env);
    for (const [k, v] of Object.entries({ ...(this.o.gate ? this.o.gate.serverEnv() : {}), ...overrides })) {
      // why: the hook route adds --import to NODE_OPTIONS; a server's own NODE_OPTIONS is kept, not replaced.
      env[k] = k === 'NODE_OPTIONS' && env[k] && !env[k]!.includes(v) ? `${env[k]} ${v}` : v;
    }
    return env;
  }

  private timeout(): number {
    return this.o.timeout_ms ?? this.o.manifest.limits.timeout_ms;
  }

  private stdioClient(label: string, env: Record<string, string>): StdioClient {
    const m = this.o.manifest.server;
    const [command, ...args] = m.stdio!;
    return new StdioClient(label, { command: command!, args, cwd: m.cwd, env }, this.o.capture, { timeout_ms: this.timeout(), stop_timeout_ms: 3_000 });
  }

  private launched(label: string, env: Record<string, string>): LaunchedServer {
    const m = this.o.manifest.server;
    const [command, ...args] = m.launch!.command;
    return new LaunchedServer(label, { command: command!, args, cwd: m.cwd, env, url_from: m.launch!.url_from, ready_timeout_ms: m.launch!.ready_timeout_ms }, this.o.capture, (v, p) => getPath(v, p));
  }

  private httpClient(label: string, url: string): HttpMcpClient {
    const m = this.o.manifest.server;
    const headers: Record<string, string> = { 'user-agent': `${SUITE_NAME}/${SUITE_VERSION}` };
    for (const [h, v] of Object.entries(m.headers_env)) {
      const val = this.o.env[v.env];
      if (val === undefined) throw new WritecheckError(`server.headers_env.${h}: environment variable ${v.env} is not set`, 2);
      headers[h] = `${v.prefix}${val}`;
    }
    return new HttpMcpClient(label, url, headers, this.o.capture, this.o.egress, { timeout_ms: this.timeout() });
  }

  /** A launched server's URL goes on the egress list (it is loopback: LaunchedServer refuses anything else). */
  private allow(url: string): void {
    for (const h of egressFor([url]).allow) if (!this.o.egress.allow.includes(h)) this.o.egress.allow.push(h);
  }

  private async mainUrl(): Promise<string> {
    if (!this.main) {
      this.main = this.launched('SERVER', this.serverEnv());
      this.started.push('SERVER');
      this.mainStart = this.main.start(this.stepId('launch.SERVER'));
    }
    const r = await this.mainStart!;
    if (!r.ok) throw new WritecheckError(`the server did not start: ${r.reason}${r.stderr_tail ? `\n${r.stderr_tail}` : ''}`, 4);
    this.allow(r.url);
    return r.url;
  }

  private async newClient(label: string): Promise<McpClient> {
    const m = this.o.manifest.server;
    if (m.stdio) return this.stdioClient(label, this.serverEnv());
    if (m.launch) return this.httpClient(label, await this.mainUrl());
    return this.httpClient(label, m.url!);
  }

  /** The `_meta` envelope revision 2026-07-28 puts on every request. */
  private envelope(): Obj {
    return { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: SUITE_NAME, version: SUITE_VERSION } };
  }

  /** Request params for this connection: on a 2026-07-28 connection the envelope is merged into any _meta the caller gives. */
  private params(conn: Conn, params: Obj): Obj {
    if (conn.protocol !== MODERN_PROTOCOL) return params;
    const meta = isObj(params['_meta']) ? params['_meta'] : {};
    // why: the envelope's keys come first so a caller can declare client capabilities for one call (an input_required flow).
    return { ...params, _meta: { ...this.envelope(), ...meta } };
  }

  private request(conn: Conn, step: string, method: string, params: Obj, o: { timeout_ms?: number } = {}): Promise<RpcOutcome> {
    return conn.client.request(step, method, this.params(conn, params), o);
  }

  /**
   * The handshake. `auto`: server/discover first (once per session; the answer holds for every
   * connection to the same server program); a server that lists 2026-07-28 is spoken to in that
   * revision, anything else gets initialize (2025-11-25), and a server without initialize is called
   * uninitialised (stateless revisions).
   */
  private async handshake(conn: Conn, label: string, st: string): Promise<void> {
    const want = this.o.manifest.server.protocol;
    // why: corpus verification (robustness item 1): servers on the MCP Python SDK 1.6 exit on any message before initialize. In
    // `auto`, nothing goes out before initialize, unless an earlier connection's discover showed the server speaks 2026-07-28;
    // server/discover is asked after the handshake instead (probeModern). A declared 2026-07-28 is spoken from the first message.
    if (want === MODERN_PROTOCOL || (want === 'auto' && this.modern === true)) {
      const r = await conn.client.request(st, 'server/discover', { _meta: this.envelope() }, { timeout_ms: Math.min(DISCOVER_TIMEOUT_MS, this.timeout()) });
      const res = r.message && isObj(r.message['result']) ? r.message['result'] : null;
      const versions = res && Array.isArray(res['supportedVersions']) ? (res['supportedVersions'] as unknown[]) : [];
      if (versions.includes(MODERN_PROTOCOL)) {
        this.modern = true;
        conn.protocol = MODERN_PROTOCOL;
        conn.capabilities = isObj(res!['capabilities']) ? res!['capabilities'] : {};
        conn.initialized = true;
        conn.client.negotiated(MODERN_PROTOCOL);
        return;
      }
      if (want === MODERN_PROTOCOL) throw new WritecheckError(`server ${label} does not offer protocol revision ${MODERN_PROTOCOL} (server/discover: ${r.transport_error ?? (r.timed_out ? 'timed out' : JSON.stringify(r.message?.['error'] ?? res?.['supportedVersions'] ?? null).slice(0, 200))})`, 4);
      // why: only a definite answer settles it for the session; a transport failure may be this process alone.
      if (r.message) this.modern = false;
    }
    const r = await conn.client.request(st, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: SUITE_NAME, version: SUITE_VERSION } });
    const res = r.message && isObj(r.message['result']) ? r.message['result'] : null;
    if (!res) {
      // a server without initialize (stateless revisions): in `auto`, ask whether it speaks 2026-07-28; else calls go ahead uninitialised
      if (r.message && isObj(r.message['error'])) {
        if (want === 'auto' && this.modern === null) await this.probeModern(conn, label, st);
        return;
      }
      throw new WritecheckError(`server ${label} did not initialize: ${r.transport_error ?? (r.timed_out ? 'timed out' : 'no answer')}`, 4);
    }
    conn.protocol = typeof res['protocolVersion'] === 'string' ? res['protocolVersion'] : null;
    conn.capabilities = isObj(res['capabilities']) ? res['capabilities'] : {};
    conn.client.negotiated(conn.protocol);
    conn.initialized = true;
    await conn.client.notify(st, 'notifications/initialized', {});
    if (want === 'auto' && this.modern === null) {
      // why: corpus run 3 (t05): a server on an older MCP Python SDK exits on any method it does not know. One that negotiated a
      // revision older than the one offered cannot speak 2026-07-28, so server/discover is not sent to it at all.
      if (predatesOffered(conn.protocol)) {
        this.modern = false;
        this.note(label, st, `server/discover was not sent: the server negotiated protocol revision ${conn.protocol}, which predates ${PROTOCOL_VERSION} (offered) and ${MODERN_PROTOCOL} (where server/discover was introduced); the session uses initialize only.`);
        return;
      }
      await this.probeModern(conn, label, st);
    }
  }

  /** A note about the connection (not a verdict): kept for the results and written to the capture. */
  private note(label: string, step: string, text: string): void {
    this.notes.push(`${label}: ${text}`);
    this.o.capture.write({ label, step, dir: 'event', channel: 'process', event: 'note', note: text });
  }

  /** Whether a connection still answers after a failed request: the process has not exited, and it answers ping. */
  private async alive(conn: Conn, st: string): Promise<boolean> {
    if (conn.client instanceof StdioClient) {
      await Promise.race([conn.client.whenClosed(), sleep(200)]);
      if (conn.client.exitInfo.exited) return false;
    }
    const host = conn.own ?? (this.o.manifest.server.launch ? this.main : null);
    if (host?.hasExited) return false;
    const p = await conn.client.request(st, 'ping', {}, { timeout_ms: Math.min(DISCOVER_TIMEOUT_MS, this.timeout()) });
    return !!p.message;
  }

  /**
   * Start the server (or session) behind `conn` again after it failed on server/discover, and initialize it. Called at most once
   * per session: `modern` is settled to false first, so the new connection is never asked server/discover.
   */
  private async revive(conn: Conn, label: string, st: string): Promise<void> {
    await conn.client.stop().catch(() => undefined);
    if (conn.own) {
      await conn.own.stop();
      const own = this.launched(label, this.serverEnv(conn.launchEnv ?? {}));
      const r = await own.start(st);
      if (!r.ok) {
        await own.stop();
        throw new WritecheckError(`server ${label} did not start again after it failed on server/discover: ${r.reason}${r.stderr_tail ? `\n${r.stderr_tail}` : ''}`, 4);
      }
      this.allow(r.url);
      conn.own = own;
      conn.client = this.httpClient(label, r.url);
    } else if (this.o.manifest.server.stdio) {
      conn.client = conn.launchEnv ? this.stdioClient(label, this.serverEnv(conn.launchEnv)) : this.stdioClient(label, this.serverEnv());
    } else {
      // why: alive() already said no; a hung shared launch process is stopped and started again too, not reused (review, 17 Nov).
      if (this.main) {
        await this.main.stop();
        this.main = null;
        this.mainStart = null;
      }
      conn.client = await this.newClient(label);
    }
    this.started.push(label);
    conn.initialized = false;
    conn.protocol = null;
    conn.capabilities = null;
    await this.handshake(conn, label, st);
  }

  /**
   * `auto`, after the handshake (or after an initialize the server refused): does the server also speak 2026-07-28? Asked once per
   * session with server/discover; where it lists that revision, this connection and every later one speak it, else none does.
   */
  private async probeModern(conn: Conn, label: string, st: string): Promise<boolean> {
    const r = await conn.client.request(st, 'server/discover', { _meta: this.envelope() }, { timeout_ms: Math.min(DISCOVER_TIMEOUT_MS, this.timeout()) });
    const res = r.message && isObj(r.message['result']) ? r.message['result'] : null;
    const versions = res && Array.isArray(res['supportedVersions']) ? (res['supportedVersions'] as unknown[]) : [];
    if (!versions.includes(MODERN_PROTOCOL)) {
      const err = r.message && isObj(r.message['error']) ? r.message['error'] : null;
      if (r.message) {
        this.modern = false;
        if (err) this.note(label, st, `server/discover was answered with JSON-RPC error ${String(err['code'])}${err['code'] === -32601 ? ' (method not found)' : ''}; the session uses initialize (${conn.protocol ?? 'no revision'}) only.`);
        return false;
      }
      // why: corpus run 3 (t05): a server that crashes or hangs on server/discover. It is not asked again in this session; if it
      // died, it is started once more and initialized, and the run goes on. A note, not a violation.
      this.modern = false;
      const why = r.timed_out ? 'no answer within the discover timeout' : (r.transport_error ?? 'no answer');
      if (await this.alive(conn, st)) {
        this.note(label, st, `server/discover failed (${why}), but the server still answers; the session uses initialize (${conn.protocol ?? 'no revision'}) only.`);
        return false;
      }
      const code = conn.client instanceof StdioClient ? conn.client.exitInfo.exit_code : null;
      const tail = conn.client instanceof StdioClient ? conn.client.stderrTail() : (conn.own ?? this.main)?.stderrTail() ?? '';
      const last = tail.split('\n').filter((l) => l.trim()).pop()?.slice(0, 200);
      this.note(label, st, `the server failed on server/discover (${why}${code !== null ? `; exit code ${code}` : ''}${last ? `; last stderr line: ${JSON.stringify(last)}` : ''}). ${conn.own || this.main || this.o.manifest.server.stdio ? 'It was started again once' : 'A new session was opened'} and the session uses initialize only; server/discover is not sent again.`);
      await this.revive(conn, label, st);
      return false;
    }
    this.modern = true;
    conn.protocol = MODERN_PROTOCOL;
    conn.capabilities = isObj(res!['capabilities']) ? res!['capabilities'] : (conn.capabilities ?? {});
    conn.initialized = true;
    conn.client.negotiated(MODERN_PROTOCOL);
    return true;
  }

  /** Start (if needed) and initialize the server process or session `label`. */
  async connect(label: string): Promise<Conn> {
    if (this.closed) throw new WritecheckError('the session is closed');
    const have = this.conns.get(label);
    if (have) return have;
    const client = await this.newClient(label);
    const conn: Conn = { client, initialized: false, protocol: null, capabilities: null, own: null };
    this.conns.set(label, conn);
    this.started.push(label);
    await this.handshake(conn, label, this.stepId(`init.${label}`));
    return conn;
  }

  /** The revision negotiated on `label` (null before it connected, or for an uninitialised server). */
  protocolOf(label: string): string | null {
    return this.conns.get(label)?.protocol ?? null;
  }

  /** The capabilities the server declared on `label` (null before it connected, or none given). */
  capabilitiesOf(label: string): Obj | null {
    return this.conns.get(label)?.capabilities ?? null;
  }

  /**
   * Start a separate server process for `label` with `env` over the normal environment (a launch
   * check: a read-only setting, a tool filter) and connect to it. A server that exits, prints no URL
   * or does not complete the handshake has not started; that is an answer, not an error.
   */
  async launch(o: { label: string; env: Record<string, string>; timeout_ms?: number }): Promise<LaunchResult> {
    const m = this.o.manifest.server;
    if (!m.stdio && !m.launch) throw new WritecheckError('launch checks need server.stdio or server.launch: the tester can only start a server it has a command for', 2);
    if (this.closed) throw new WritecheckError('the session is closed');
    if (this.conns.has(o.label)) throw new WritecheckError(`launch: ${o.label} is already connected`);
    const env = this.serverEnv(o.env);
    const step = this.stepId(`launch.${o.label}`);
    this.started.push(o.label);
    if (m.launch) {
      const own = this.launched(o.label, env);
      const r = await own.start(step);
      if (!r.ok) {
        await own.stop();
        return { started: false, exit_code: r.exit_code, reason: r.reason, stderr_tail: r.stderr_tail };
      }
      this.allow(r.url);
      const conn: Conn = { client: this.httpClient(o.label, r.url), initialized: false, protocol: null, capabilities: null, own, launchEnv: o.env };
      this.conns.set(o.label, conn);
      try {
        await this.handshake(conn, o.label, step);
      } catch (e) {
        await this.release([o.label]);
        return { started: false, exit_code: null, reason: `it printed its URL but the handshake failed: ${(e as Error).message}`, stderr_tail: (conn.own ?? own).stderrTail() };
      }
      return { started: true, protocol: conn.protocol };
    }
    const client = this.stdioClient(o.label, env);
    const conn: Conn = { client, initialized: false, protocol: null, capabilities: null, own: null, launchEnv: o.env };
    this.conns.set(o.label, conn);
    let failed: string | null = null;
    try {
      await this.handshake(conn, o.label, step);
    } catch (e) {
      failed = (e as Error).message;
    }
    // why: the handshake may have started the server again after a failed server/discover (revive): judge the live process.
    const live = conn.client instanceof StdioClient ? conn.client : client;
    // why: a server that refuses its settings usually exits at once; one that answered initialize and then exits did not start either.
    if (!failed) await Promise.race([live.whenClosed(), new Promise((r) => setTimeout(r, 150))]);
    if (failed || live.exitInfo.exited) {
      await Promise.race([live.whenClosed(), new Promise((r) => setTimeout(r, 2_000))]);
      const tail = live.stderrTail();
      const code = live.exitInfo.exit_code;
      await this.release([o.label]);
      return { started: false, exit_code: code, reason: failed ?? `exited (${code ?? 'signal'}) right after starting`, stderr_tail: tail };
    }
    return { started: true, protocol: conn.protocol };
  }

  /**
   * Stop the server process of a label started with `launch`, and start it again with the same environment (the gate,
   * if any, stays in place), then wait until tools/list answers (MWS-RETRY-2 step (e)). `graceful`: closing stdin first
   * for stdio, then SIGTERM; a graceful stop after which the process did not exit by itself and was killed counts as a
   * kill. `kill`: SIGKILL at once.
   */
  async restart(label: string, stop: 'graceful' | 'kill'): Promise<RestartResult> {
    const c = this.conns.get(label);
    if (!c || !c.launchEnv) throw new WritecheckError(`restart: ${label} was not started with launch`);
    const env = c.launchEnv;
    const t0 = nowMs();
    let ended = 'not_running';
    if (c.own) {
      if (stop === 'kill') {
        await c.own.kill();
        ended = 'SIGKILL';
      } else ended = await c.own.stop();
    } else if (c.client instanceof StdioClient) {
      const p = stop === 'kill' ? await c.client.kill() : await c.client.stop();
      ended = typeof p['terminated_by'] === 'string' ? (p['terminated_by'] as string) : p['started'] ? 'closed stdin' : 'not_running';
    }
    this.conns.delete(label);
    const t1 = nowMs();
    const used: 'graceful' | 'kill' = stop === 'kill' || ended === 'SIGKILL' ? 'kill' : 'graceful';
    const out: RestartResult = { stop_requested: stop, stop_used: used, ended_by: ended, t_stop_ms: t0, t_stopped_ms: t1, t_ready_ms: null, started: false, reason: null };
    const r = await this.launch({ label, env });
    if (!r.started) return { ...out, reason: `it did not start again: ${r.reason}` };
    try {
      await this.listTools(label);
    } catch (e) {
      return { ...out, reason: `tools/list did not answer after the restart: ${(e as Error).message}` };
    }
    return { ...out, started: true, t_ready_ms: nowMs() };
  }

  /** tools/list, prompts/list and resources/templates/list (those the server declares a capability for), each paged to the end. */
  async catalog(label: string): Promise<{ tools: Record<string, unknown>[]; prompts: Record<string, unknown>[]; resourceTemplates: Record<string, unknown>[] }> {
    const conn = await this.connect(label);
    const caps = conn.capabilities;
    const tools = await this.listAll(conn, label, 'tools/list', 'tools');
    // why: as mcp-catalog-snap does: a list the server declares no capability for is recorded as empty, not asked for.
    // why: corpus verification (robustness item 2): a server that declares the capability and answers an optional list with
    // -32601 Method not found has none of it; the catalog goes on.
    const prompts = caps && caps['prompts'] ? await this.listAll(conn, label, 'prompts/list', 'prompts', true) : [];
    const resourceTemplates = caps && caps['resources'] ? await this.listAll(conn, label, 'resources/templates/list', 'resourceTemplates', true) : [];
    return { tools, prompts, resourceTemplates };
  }

  private async listAll(conn: Conn, label: string, method: string, key: string, optional = false): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: unknown;
    for (let i = 0; i < 1000; i++) {
      const r = await this.request(conn, this.stepId(method.replace(/\//g, '-')), method, cursor ? { cursor } : {});
      const res = r.message && isObj(r.message['result']) ? r.message['result'] : null;
      if (!res && optional && i === 0 && r.message && isObj(r.message['error']) && r.message['error']['code'] === -32601) return [];
      if (!res) throw new WritecheckError(`${method} failed on ${label}: ${r.transport_error ?? JSON.stringify(r.message).slice(0, 300)}`, 4);
      const page = (res[key] as Record<string, unknown>[] | undefined) ?? [];
      out.push(...page);
      // why: t17: a tool whose outputSchema marks a wrapped result has its structuredContent.result decoded where it is JSON.
      // `decode: none` in the manifest keeps them as they are.
      if (method === 'tools/list')
        for (const t of page) {
          if (isObj(t) && typeof t['name'] === 'string' && isObj(t['annotations']) && t['annotations']['readOnlyHint'] === true) this.readOnlyTools.add(t['name']);
          if (isObj(t) && typeof t['name'] === 'string' && marksWrappedResult(t['outputSchema'])) {
            this.schemaMarked.add(t['name']);
            if (!this.decodeTools.has(t['name']) && !this.decodeOff.has(t['name'])) this.decodeTools.set(t['name'], 'outputSchema');
          }
        }
      cursor = res['nextCursor'];
      if (!cursor) return out;
      const k = JSON.stringify(cursor);
      if (seen.has(k)) throw new WritecheckError(`${method} on ${label}: the server repeated a pagination cursor`, 4);
      seen.add(k);
    }
    throw new WritecheckError(`${method} on ${label}: more than 1000 pages`, 4);
  }

  async listTools(label: string): Promise<Record<string, unknown>[]> {
    const conn = await this.connect(label);
    return this.listAll(conn, label, 'tools/list', 'tools');
  }

  /**
   * Interrupted: from now on only cleanup calls (label CLEANUP) go out; everything else throws.
   * `idle` resolves when the calls already in flight have answered (or after `ms`).
   */
  abort(why: string): void {
    this.aborted = why;
  }

  idle(ms: number): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      this.idleWaiters.push(() => (clearTimeout(t), r()));
    });
  }

  private guard(label: string | null): void {
    if (this.aborted && label !== 'CLEANUP') throw new Interrupted(this.aborted);
  }

  private async tracked<T>(p: () => Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await p();
    } finally {
      this.inflight--;
      if (this.inflight === 0) for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  /** One tools/call. `write: false` for calls that read; every other call counts against the budget and the rate limit. */
  async call(label: string, tool: string, args: unknown, o: { step?: string; write?: boolean; paced?: boolean; counted?: boolean; meta?: Record<string, unknown>; params?: Record<string, unknown>; init?: true } = {}): Promise<CallResult> {
    this.guard(label);
    const step = o.step ?? this.stepId(`call.${tool}`);
    const write = o.write !== false;
    const conn = await this.connect(label);
    if (!o.init && this.o.manifest.session?.init.length) await (conn.init ??= this.runInit(label));
    if (write) {
      if (!o.counted) this.reserveWrites(1, `tools/call ${tool}`);
      if (!o.paced) await this.pace();
    }
    const op = ++this.op;
    this.hist({ op, phase: 'invoke', kind: 'call', label, step, name: tool, write });
    const params: Record<string, unknown> = { ...(o.params ?? {}), name: tool, arguments: args ?? {} };
    if (o.meta) params['_meta'] = o.meta;
    const before = conn.client.serverRequests?.length ?? 0;
    const r = await this.tracked(() => this.request(conn, step, 'tools/call', params));
    for (const q of conn.client.serverRequests?.slice(before) ?? []) if (q.method !== 'ping') this.inputRequests.push({ step, tool, method: q.method, answer: q.answer });
    if (o.params && Object.hasOwn(o.params, 'inputResponses')) this.inputRequests.push({ step, tool, method: 'input_required (the retry)', answer: `retried with inputResponses ${JSON.stringify(o.params['inputResponses']).slice(0, 300)}${o.params['requestState'] ? ' and the requestState the server returned' : ''}` });
    if (this.o.onResult && r.message) {
      // why: the scan sees exactly what the client received; nothing of it is kept by the session.
      try {
        this.o.onResult({ step, label, tool, raw: JSON.stringify(r.message), isError: isObj(r.message['result']) ? r.message['result']['isError'] === true : true });
      } catch {
        /* a scanner failure never changes the call's outcome */
      }
    }
    const out = toCallResult(r, step, label, tool, this.decodeTools.get(tool) ?? null, this.extracts.get(tool) ?? null);
    const ex = this.extracts.get(tool);
    if (ex && !this.extractNoted.has(tool)) {
      const how = 'between' in ex ? `between ${JSON.stringify(ex.between[0])} and ${JSON.stringify(ex.between[1])}` : `by the regex ${JSON.stringify(ex.regex)}`;
      if (out.extracted) {
        this.extractNoted.add(tool);
        this.note(label, step, `${tool} answers JSON inside its text; the manifest declares decode.extract, so its data (paths, a declared outcome field) is the JSON document taken out of the text ${how} and parsed; the call records mark it extracted, the text the patterns read is kept as received, and ${ex.refusals ? 'the structured refusal signals read the extracted document too (refusals: true)' : 'a refusal is classified on the answer as received (an error answer is not extracted, and the structured refusal signals do not read the extracted document)'}.`);
      } else if (out.ok && out.text !== null && r.message && isObj(r.message['result']) && r.message['result']['structuredContent'] === undefined) {
        this.extractNoted.add(tool);
        this.note(label, step, `${tool}: the manifest declares decode.extract (${how}), but an answer held no JSON object or array there; such an answer is read as received.`);
      }
    }
    if (out.decoded && !this.decodeNoted.has(tool)) {
      this.decodeNoted.add(tool);
      this.note(label, step, `${tool} answers a wrapped result (structuredContent {"result": "<JSON as a string>"}); every reading of its structured answer (paths, outcome fields, signals, the text searched) uses the decoded JSON document (basis: ${out.decoded.basis === 'manifest' ? 'the manifest declares decode: json' : "the tool's outputSchema marks a wrapped result"}); the call records keep structuredContent as received in raw_structured, and the capture keeps the whole answer.`);
    } else if (this.decodeOff.has(tool) && this.schemaMarked.has(tool) && !this.decodeNoted.has(tool) && unwrapResult(isObj(r.message?.['result']) ? r.message['result']['structuredContent'] : undefined) !== undefined) {
      this.decodeNoted.add(tool);
      this.note(label, step, `${tool}'s outputSchema marks a wrapped result and it answered one, but the manifest declares decode: none: its structured answer is read as received, the string not decoded.`);
    }
    if (out.result_type === 'input_required') this.inputRequests.push({ step, tool, method: 'input_required result', answer: 'not answered in this call: only the MWS-RETRY-3 check retries, with the answers the declaration gives; elsewhere the call is judged as an unknown outcome' });
    this.hist({ op, phase: out.ok ? 'ok' : out.timed_out || out.transport_error ? 'info' : 'fail', kind: 'call', label, step, name: tool, write, ...(out.timed_out ? { detail: 'client timeout: the outcome is unknown' } : out.transport_error ? { detail: out.transport_error } : {}) });
    if (out.http_status === 429 || (!out.ok && RATE_TEXT.test(out.text ?? out.rpc_error?.message ?? ''))) throw new RateLimited(`tools/call ${tool} (${step})`);
    return out;
  }

  /** Whether a session.init call counts as a write: unless declared read_only, or tools/list marks the tool readOnlyHint: true. */
  initCounted(c: SessionInit): boolean {
    return !c.read_only && !this.readOnlyTools.has(c.tool);
  }

  /**
   * session.init: each declared call, in order, on a new session, before its first other tools/call. The arguments' `{{env.NAME}}`
   * come from the tester's environment (their values are redacted in every record: see secretsOf). A call that fails (an error,
   * an isError answer, no answer) stops the run: every later call except clean-up is refused, and the reason names the call.
   */
  private async runInit(label: string): Promise<void> {
    const inits = this.o.manifest.session?.init ?? [];
    for (const [i, c] of inits.entries()) {
      const env: Record<string, string> = {};
      for (const n of c.env) {
        const v = this.o.env[n];
        if (v === undefined) return this.initFailed(label, i, c, `environment variable ${n} is not set`);
        env[n] = v;
      }
      const args = render(c.args, { env });
      const counted = this.initCounted(c);
      const r = await this.call(label, c.tool, args, { init: true, write: counted, step: this.stepId(`session-init.${label}.${c.tool}`) });
      this.initCalls++;
      if (!r.ok) return this.initFailed(label, i, c, r.timed_out ? 'no answer before the timeout' : r.transport_error ? r.transport_error : r.rpc_error ? `JSON-RPC error ${r.rpc_error.code}: ${r.rpc_error.message}` : r.isError ? `an error answer: ${(r.text ?? '').slice(0, 300)}` : `result type ${r.result_type}`);
      if (this.initCalls === i + 1) this.note(label, r.step, `session.init: ${c.tool} was called on session ${label} before its first other call (${counted ? 'counted as a write' : 'read-only, not counted as a write'}); it is called on every session the run opens.`);
    }
  }

  private initFailed(label: string, i: number, c: SessionInit, why: string): never {
    const msg = `session.init[${i}] (${c.tool}) failed on session ${label}, before any probe on it: ${this.o.redactor.text(why)}`;
    this.initFailure ??= msg;
    this.abort(msg);
    throw new SessionInitFailed(msg);
  }

  /** One control request (the platform's own API), through the egress list. */
  async http(method: string, url: string, headers: Record<string, string>, body: unknown, o: { step?: string; write?: boolean; paced?: boolean; counted?: boolean } = {}): Promise<HttpResult> {
    if (!o.counted) this.guard(null);
    const m = method.toUpperCase();
    const step = o.step ?? this.stepId(`http.${m.toLowerCase()}`);
    const write = o.write ?? !(m === 'GET' || m === 'HEAD');
    if (write) {
      if (!o.counted) this.reserveWrites(1, `${m} ${new URL(url).pathname}`);
      if (!o.paced) await this.pace();
    }
    const op = ++this.op;
    const path = new URL(url).pathname;
    this.hist({ op, phase: 'invoke', kind: 'http', label: null, step, name: `${m} ${path}`, write });
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h: Record<string, string> = { accept: 'application/json', 'user-agent': `${SUITE_NAME}/${SUITE_VERSION}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    const t0 = nowMs();
    const { sent, done } = rawHttp(url, m, h, payload, this.o.timeout_ms ?? this.o.manifest.limits.timeout_ms, this.o.egress);
    this.o.capture.write({ label: null, step, dir: 'send', channel: 'http', method: m, url, headers: this.o.redactor.headers(Object.entries(sent)) }, payload ?? '');
    const r = await this.tracked(() => done);
    this.o.capture.write({ label: null, step, dir: 'recv', channel: 'http', status: r.status, headers: this.o.redactor.headers(r.headers), ...(r.error ? { transport_error: r.error } : {}), ...(r.timed_out ? { timed_out: true } : {}) }, r.body);
    const text = r.body.toString('utf8');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the text */
    }
    const hdrs: Record<string, string> = {};
    for (const [k, v] of r.headers) hdrs[k.toLowerCase()] = v;
    const out: HttpResult = { kind: 'http', step, method: m, path, ok: r.status !== null && r.status >= 200 && r.status < 300, status: r.status, body: parsed, headers: hdrs, error: r.error ?? (r.timed_out ? 'timed out' : null), t_start_ms: t0, t_end_ms: nowMs() };
    this.hist({ op, phase: out.ok ? 'ok' : out.status === null ? 'info' : 'fail', kind: 'http', label: null, step, name: `${m} ${path}`, write, ...(out.error ? { detail: out.error } : {}) });
    if (out.status === 429) throw new RateLimited(`${m} ${path} (${step})`);
    return out;
  }

  /** Stop server processes (or end sessions); a server started for a label alone (launch) is stopped with it. */
  async release(labels: string[]): Promise<void> {
    for (const l of labels) {
      const c = this.conns.get(l);
      if (!c) continue;
      this.conns.delete(l);
      await c.client.stop();
      if (c.own) await c.own.stop();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.release([...this.conns.keys()]);
    if (this.main) await this.main.stop();
    this.closed = true;
  }

  /** Crash path: kill every server process now, without waiting. */
  killAll(): void {
    for (const c of this.conns.values()) {
      if (c.client instanceof StdioClient) c.client.killNow();
      c.own?.killNow();
    }
    this.main?.killNow();
  }
}

/**
 * The JSON document a declared extraction takes out of an answer's text (`decode.extract`), or undefined where the markers or
 * the regex find nothing, or what they find is not a JSON object or array. At most the first MiB of text is searched.
 */
export function extractJson(text: string, x: Extract): unknown {
  const t = text.length > 1 << 20 ? text.slice(0, 1 << 20) : text;
  let inner: string | undefined;
  if ('between' in x) {
    const a = t.indexOf(x.between[0]);
    if (a < 0) return undefined;
    const from = a + x.between[0].length;
    const b = t.indexOf(x.between[1], from);
    if (b < 0) return undefined;
    inner = t.slice(from, b);
  } else {
    const m = new RegExp(x.regex, 's').exec(t);
    inner = m ? m.slice(1).find((g) => g !== undefined) : undefined;
  }
  if (inner === undefined) return undefined;
  const s = inner.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function toCallResult(r: RpcOutcome, step: string, label: string, tool: string, decode: DecodeBasis | null = null, extract: Extract | null = null): CallResult {
  const body = r.message ?? {};
  const res = isObj(body['result']) ? body['result'] : null;
  const err = isObj(body['error']) ? { code: Number(body['error']['code']), message: String(body['error']['message']) } : null;
  const isError = res?.['isError'] === true;
  // why: the content of a result is every text block (spec MWS-IN-2 and RES-2 read "the content"); the first block alone may be parsed as data.
  const texts: string[] = [];
  for (const c of (res?.['content'] as Record<string, unknown>[] | undefined) ?? []) if (isObj(c) && c['type'] === 'text' && typeof c['text'] === 'string') texts.push(c['text']);
  const text: string | null = texts.length ? texts.join('\n') : null;
  let data = res && res['structuredContent'] !== undefined ? res['structuredContent'] : texts.length ? parseStructured(texts[0]!) : null;
  // why: t17: a wrapped result carries its data as a JSON document in a string; decoded only where the tool is marked (its
  // outputSchema, or the manifest's decode: json) and the value is exactly {"result": "<JSON object or array>"}.
  const unwrapped = decode && res ? unwrapResult(res['structuredContent']) : undefined;
  if (unwrapped !== undefined) data = unwrapped;
  // why: CLI feature A: a declared extraction takes the JSON out of an answer that wraps it in markup or prose; only where the
  // answer has no structuredContent, and (unless `refusals: true`) only for an answer that is not an error, so a refusal is
  // classified on the answer as received.
  const extracted = extract && res && res['structuredContent'] === undefined && text !== null && !err && (extract.refusals || !isError) ? extractJson(text, extract) : undefined;
  if (extracted !== undefined) data = extracted;
  // why: an adopted result shape is read at evaluation, from what is captured here for every call (cheap; null for most servers).
  // For a decoded wrapped result the shape is captured from the decoded document, as every other reading of it is (patternData
  // reads `data`): the tool's structured answer is that document, so the shape and the patterns read the same thing.
  const read = unwrapped !== undefined ? unwrapped : res ? res['structuredContent'] : undefined;
  const shape = res ? captureShape(read, texts) : null;
  // why: B-9 v2 ("Free words and the serialized block"): where the result carries a shape, the text the patterns read leaves out
  // a block whose whole text is the serialized structuredContent, and a JSON block that carries the shape; `text` itself is kept
  // whole for every other use (identifiers, fingerprints, quotes). Whether the tool adopts the shape is decided at reading.
  const sc = read;
  // why: PR #7 round 3: a text block that repeats a wrapped result is the serialized wrapper (structuredContent as received),
  // not the decoded document; for a decoded call it is the mirror too, and its free words are those of the decoded document.
  const rawSc = unwrapped !== undefined ? res!['structuredContent'] : undefined;
  const mirrors = (t: string): boolean => (sc !== undefined && sc !== null && isMirrorOf(t, sc)) || (rawSc !== undefined && isMirrorOf(t, rawSc));
  // The free words of each block left out (the mirror's shape, or the shape a JSON block carries) are kept, one per line, so a
  // reader of the text still reads them, as B-9 asks ("declared text patterns are applied to the other text blocks, and to
  // those free words"); member names and fixed values are not.
  const prose = shape
    ? texts.flatMap((t) => {
        const mirror = mirrors(t);
        if (!mirror && !carriesShape(t)) return [t];
        return freeWordsOfBlock(mirror ? (sc as Record<string, unknown>)['mws'] : (JSON.parse(t.trim()) as Record<string, unknown>)['mws']);
      })
    : null;
  // why: an input_required result (2026-07-28), or any other non-complete result type, is neither a success nor an error (spec MWS-RES-2).
  const resultType = res && typeof res['resultType'] === 'string' ? res['resultType'] : null;
  const pending = resultType !== null && resultType !== 'complete';
  return { kind: 'call', step, label, tool, ok: !err && !isError && res !== null && !pending && !r.timed_out && !r.transport_error, isError, result_type: resultType, input_required: resultType === 'input_required' ? { inputRequests: res!['inputRequests'] ?? null, requestState: typeof res!['requestState'] === 'string' ? res!['requestState'] : null } : null, rpc_error: err, http_status: r.http_status, text, data, ...(unwrapped !== undefined ? { decoded: { from: 'structuredContent.result' as const, basis: decode!, ...(texts.length === 1 && isMirrorOf(texts[0]!, rawSc) ? { text_mirrors: 'structuredContent' as const } : {}) }, raw_structured: rawSc } : {}), ...(extracted !== undefined ? { extracted: { from: 'text' as const, by: 'between' in extract! ? ('between' as const) : ('regex' as const), basis: 'manifest' as const, refusals: extract!.refusals } } : {}), shape, ...(prose ? { prose_text: prose.length ? prose.join('\n') : null } : {}), timed_out: r.timed_out, transport_error: r.transport_error, rpc_id: r.rpc_id, t_start_ms: r.t_start_ms, t_end_ms: r.t_end_ms };
}

/** Is a text block a JSON object that carries an `mws` member (the shape, B-9 v2)? */
function carriesShape(t: string): boolean {
  const x = t.trim();
  if (!x.startsWith('{')) return false;
  try {
    const o: unknown = JSON.parse(x);
    return !!o && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, 'mws');
  } catch {
    return false;
  }
}

/** Is a text block the serialized structuredContent (its whole text parses as JSON equal to it)? */
function isMirrorOf(t: string, sc: unknown): boolean {
  const s = t.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return false;
  try {
    return canonical(JSON.parse(s)) === canonical(sc);
  } catch {
    return false;
  }
}
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** A short, stable digest of a result's content for the history and observations (never the content itself). */
export const resultDigest = (r: CallResult): string | null => (r.text === null ? null : sha256(r.text).slice(0, 16));
