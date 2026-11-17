/**
 * The raw MCP client: JSON-RPC to the server itself, over stdio (newline-delimited JSON on the
 * server's stdin and stdout) or streamable HTTP (one POST per message), with nothing in between.
 * Every byte sent and received goes to the capture, redacted. No SDK: the client is small enough to
 * read and is the only thing that talks to the server.
 *
 * Also the raw HTTP helper used for the control (the platform's own API): node:http(s), not fetch,
 * so the headers recorded are the headers sent; every request passes the egress list first and a
 * redirect is never followed.
 */

import type { ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';

import type { CaptureSink } from './capture.js';
import { assertEgress, vettedLookup, type EgressPolicy } from './egress.js';
import { spawnSupervised, type Supervised } from './supervised.js';
import { isObj, nowMs, sleep, type Obj } from './util.js';

/** Environment every server process gets: no telemetry. */
export const TELEMETRY_OFF: Record<string, string> = { DO_NOT_TRACK: '1', TELEMETRY_DISABLED: '1', OTEL_SDK_DISABLED: 'true' };
/** The only variables of the tester's own environment a server inherits without being named (process basics). */
export const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'NODE_EXTRA_CA_CERTS'];

/** What one JSON-RPC request came to, from the client's side. */
export interface RpcOutcome {
  message: Obj | null;
  timed_out: boolean;
  transport_error: string | null;
  http_status: number | null;
  /** When the request left the client and when its answer arrived (or the timeout fired). */
  t_start_ms: number;
  t_end_ms: number;
  rpc_id: number | null;
}

export interface McpClient {
  readonly label: string;
  request(step: string, method: string, params: unknown, o?: { timeout_ms?: number }): Promise<RpcOutcome>;
  notify(step: string, method: string, params: unknown): Promise<RpcOutcome>;
  /** The protocol version the server answered initialize with (sent as mcp-protocol-version over HTTP). */
  negotiated(v: string | null): void;
  stop(): Promise<Record<string, unknown>>;
  /** Requests the server made of the tester (spec 7.3, rule 10: the record states what the tester answered), in order. */
  readonly serverRequests?: { method: string; answer: string }[];
}

/** What the tester answers a server request with, in words for the record. */
export const answerInWords = (m: Obj): string => (m['method'] === 'ping' ? 'an empty result (ping)' : 'a JSON-RPC error -32601: the tester declares no client capability for it, so it does not serve it');

export interface StdioSpec {
  command: string;
  args: string[];
  cwd: string | null;
  /** The whole environment of the server process (built by the session: base, passthrough, literals). */
  env: Record<string, string>;
}

/** The tester answers ping and declines every other request a server makes of it (it has no model, no roots, no user). */
export const serverRequestAnswer = (m: Obj): Obj => (m['method'] === 'ping' ? { jsonrpc: '2.0', id: m['id'], result: {} } : { jsonrpc: '2.0', id: m['id'], error: { code: -32601, message: `${String(m['method'])} is not supported by this test client` } });

const rpcMsg = (id: number | null, method: string, params: unknown): Obj => ({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, ...(params !== undefined ? { params } : {}) });

export class StdioClient implements McpClient {
  readonly serverRequests: { method: string; answer: string }[] = [];
  private child: ChildProcess | null = null;
  private sup: Supervised | null = null;
  private stderrLines: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<string, { step: string; resolve: (o: { message: Obj | null; transport_error: string | null }) => void }>();
  private readonly timedOut = new Map<string, string>();
  private exited = false;
  /** Whether the tester sent this server SIGTERM or SIGKILL; written on its `exit` event in the capture. */
  private stopSent = false;
  // why: an exit by SIGKILL that the tester did not send is, most often, the kernel's out-of-memory killer; the capture tells the two apart.
  private signal(how: 'term' | 'kill'): void {
    this.stopSent = true;
    if (how === 'term') this.sup?.term();
    else this.sup?.kill();
  }
  private closed: Promise<void> = Promise.resolve();
  readonly proc: Record<string, unknown> = { pid: null, supervisor_pid: null, exit_code: null, signal: null, terminated_by: null, stdin_error: null, spawn_error: null, server_requests: 0, stdout_nonjson: 0 };

  constructor(
    readonly label: string,
    private readonly spec: StdioSpec,
    private readonly t: CaptureSink,
    private readonly o: { timeout_ms: number; stop_timeout_ms: number },
  ) {}

  /** Start the process on first use, under the supervisor (its own process group, killed if the tester dies). */
  private start(step: string): void {
    if (this.child) return;
    const env = { ...this.spec.env, ...TELEMETRY_OFF };
    const sup = spawnSupervised(this.spec.command, this.spec.args, { env, cwd: this.spec.cwd, stdin: 'pipe' });
    const child = sup.proc;
    this.sup = sup;
    this.child = child;
    this.proc['supervisor_pid'] = child.pid ?? null;
    this.t.write({ label: this.label, step, dir: 'event', channel: 'process', event: 'spawn', supervisor_pid: child.pid ?? null, command: this.spec.command, args: this.spec.args, env_names: Object.keys(env).sort() });
    void sup.serverPid.then((pid) => {
      this.proc['pid'] = pid;
      if (pid !== null) this.t.write({ label: this.label, step: null, dir: 'event', channel: 'process', event: 'server_pid', pid });
    });
    void sup.startError.then((e) => {
      if (!e) return;
      this.proc['spawn_error'] = e;
      this.t.write({ label: this.label, step: null, dir: 'event', channel: 'process', event: 'spawn_error', error: e });
      this.ended(`could not start the server: ${e}`);
    });
    child.once('error', (e) => {
      this.proc['spawn_error'] = e.message;
      this.t.write({ label: this.label, step: null, dir: 'event', channel: 'process', event: 'spawn_error', error: e.message });
      this.ended(`could not start the server: ${e.message}`);
    });
    // why: a line written to a server that has just exited fails with EPIPE; recorded, never an uncaught error.
    child.stdin?.on('error', (e: NodeJS.ErrnoException) => {
      this.proc['stdin_error'] = e.code ?? e.message;
    });
    child.once('exit', (code, signal) => {
      this.proc['exit_code'] = code;
      this.proc['signal'] = signal;
    });
    this.closed = new Promise<void>((r) =>
      child.once('close', (code, signal) => {
        this.t.write({ label: this.label, step: null, dir: 'event', channel: 'process', event: 'exit', exit_code: code, signal, stop_sent: this.stopSent });
        this.ended(`the server exited (${code ?? signal ?? '?'}) before answering`);
        r();
      }),
    );
    createInterface({ input: child.stdout! }).on('line', (l) => this.onLine(l));
    createInterface({ input: child.stderr! }).on('line', (l) => {
      this.stderrLines.push(l);
      if (this.stderrLines.length > 20) this.stderrLines.shift();
      this.t.write({ label: this.label, step: null, dir: 'recv', channel: 'stderr' }, l);
    });
  }

  /** The last lines the server wrote on stderr (for a server that refused to start). */
  stderrTail(): string {
    return this.stderrLines.join('\n');
  }

  /** Whether the server process has exited, and how. */
  get exitInfo(): { exited: boolean; exit_code: number | null } {
    return { exited: this.exited, exit_code: (this.proc['exit_code'] as number | null) ?? null };
  }

  /** Resolves when the process has exited and its streams have closed. */
  whenClosed(): Promise<void> {
    return this.closed;
  }

  private ended(why: string): void {
    this.exited = true;
    for (const [, p] of this.pending) p.resolve({ message: null, transport_error: why });
    this.pending.clear();
  }

  private onLine(line: string): void {
    let m: Obj | null = null;
    try {
      const v = JSON.parse(line) as unknown;
      m = isObj(v) ? v : null;
    } catch {
      this.proc['stdout_nonjson'] = (this.proc['stdout_nonjson'] as number) + 1;
    }
    const key = m && m['id'] !== undefined && m['method'] === undefined ? JSON.stringify(m['id']) : null;
    const p = key ? this.pending.get(key) : undefined;
    const late = key ? this.timedOut.get(key) : undefined;
    this.t.write({ label: this.label, step: p?.step ?? late ?? null, dir: 'recv', channel: 'stdout', ...(m && m['id'] !== undefined ? { rpc_id: m['id'] } : {}), ...(m && typeof m['method'] === 'string' ? { method: m['method'] } : {}), ...(late ? { late_answer: true } : {}), ...(m ? {} : { json: false }) }, line);
    if (m && typeof m['method'] === 'string' && m['id'] !== undefined) {
      // A server-to-client request: ping is answered; anything else (sampling, elicitation, roots) is declined.
      this.proc['server_requests'] = (this.proc['server_requests'] as number) + 1;
      this.serverRequests.push({ method: String(m['method']), answer: answerInWords(m) });
      this.write(null, serverRequestAnswer(m), { auto: 'server_request_answer' });
      return;
    }
    if (p && key) {
      this.pending.delete(key);
      p.resolve({ message: m, transport_error: null });
    }
  }

  private write(step: string | null, msg: Obj, extra: Record<string, unknown> = {}): boolean {
    const line = JSON.stringify(msg);
    const closed = this.exited || !this.child?.stdin || this.child.stdin.destroyed;
    this.t.write({ label: this.label, step, dir: 'send', channel: 'stdin', ...(msg['id'] !== undefined ? { rpc_id: msg['id'] } : {}), ...(typeof msg['method'] === 'string' ? { method: msg['method'] } : {}), ...extra, ...(closed ? { not_sent: 'the server has exited or closed its stdin' } : {}) }, line);
    if (closed) return false;
    this.child!.stdin!.write(line + '\n');
    return true;
  }

  async request(step: string, method: string, params: unknown, ro: { timeout_ms?: number } = {}): Promise<RpcOutcome> {
    this.start(step);
    const id = this.nextId++;
    const key = JSON.stringify(id);
    const t0 = nowMs();
    const answer = new Promise<{ message: Obj | null; transport_error: string | null }>((r) => this.pending.set(key, { step, resolve: r }));
    if (!this.write(step, rpcMsg(id, method, params))) {
      this.pending.delete(key);
      return { message: null, timed_out: false, transport_error: this.exited ? 'the server has exited' : 'the server stdin is closed', http_status: null, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: id };
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ro.timeout_ms ?? this.o.timeout_ms)));
    const got = await Promise.race([answer, timeout]);
    clearTimeout(timer);
    if (got === 'timeout') {
      // The request stays unanswered for the client; a late answer is still recorded, marked late_answer.
      this.pending.delete(key);
      this.timedOut.set(key, step);
      return { message: null, timed_out: true, transport_error: null, http_status: null, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: id };
    }
    return { message: got.message, timed_out: false, transport_error: got.transport_error, http_status: null, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: id };
  }

  async notify(step: string, method: string, params: unknown): Promise<RpcOutcome> {
    this.start(step);
    const t0 = nowMs();
    const ok = this.write(step, rpcMsg(null, method, params));
    return { message: null, timed_out: false, transport_error: ok ? null : 'the server has exited', http_status: null, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: null };
  }

  negotiated(): void {}

  /** Close stdin (the stdio way to end a session), wait, then SIGTERM and SIGKILL the server's process group. */
  async stop(): Promise<Record<string, unknown>> {
    const c = this.child;
    if (!c) return { ...this.proc, started: false };
    if (!this.exited) {
      c.stdin?.end();
      const waited = await Promise.race([this.closed.then(() => true), sleep(this.o.stop_timeout_ms).then(() => false)]);
      if (!waited) {
        this.proc['terminated_by'] = 'SIGTERM';
        this.signal('term');
        if (!(await Promise.race([this.closed.then(() => true), sleep(2_500).then(() => false)]))) {
          this.proc['terminated_by'] = 'SIGKILL';
          this.signal('kill');
        }
      }
    }
    if (!this.proc['spawn_error']) await Promise.race([this.closed, sleep(2_000)]);
    return { ...this.proc, started: true };
  }

  /** Kill the server's process group at once, without waiting (crash path). */
  killNow(): void {
    if (!this.child || this.exited) return;
    this.signal('kill');
  }

  /** SIGKILL the server's process group and wait for it to go (a restart by a kill, MWS-RETRY-2 step (e)). */
  async kill(): Promise<Record<string, unknown>> {
    if (this.child && !this.exited) {
      this.proc['terminated_by'] = 'SIGKILL';
      this.signal('kill');
      await Promise.race([this.closed, sleep(5_000)]);
    }
    return { ...this.proc, started: !!this.child };
  }
}

/** Server-sent events: the `data:` payload of each complete event in `text`. */
function sseData(text: string): string[] {
  const out: string[] = [];
  for (const ev of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length) out.push(data.join('\n'));
  }
  return out;
}

/** The JSON-RPC messages in each part (a JSON body or an SSE data payload, batches included); other parts are skipped. */
function messages(parts: string[]): Obj[] {
  const out: Obj[] = [];
  for (const p of parts) {
    try {
      const v = JSON.parse(p) as unknown;
      for (const x of Array.isArray(v) ? v : [v]) if (isObj(x)) out.push(x);
    } catch {
      /* recorded as received; not (yet) a whole JSON-RPC message */
    }
  }
  return out;
}

/** The `_meta` key that marks a request as a 2026-07-28 (modern) request. */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const NAME_SOURCE: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** A header value as revision 2026-07-28 encodes it: printable ASCII as is, anything else base64 in a sentinel. */
export function encodeHeaderValue(v: string): string {
  const plain = v.length > 0 && v === v.trim() && [...v].every((c) => c === '\t' || (c >= ' ' && c <= '~')) && !(v.startsWith('=?base64?') && v.endsWith('?='));
  return plain ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/**
 * Revision 2026-07-28 over HTTP: a request whose `_meta` carries a protocol version also carries it,
 * the method and (for tools/call and the like) the name as headers, and the server checks they agree
 * with the body. Requests without the envelope get none of these (a 2025-11-25 exchange).
 */
export function envelopeHeaders(msg: Obj): Record<string, string> {
  const params = isObj(msg['params']) ? msg['params'] : null;
  const meta = params && isObj(params['_meta']) ? params['_meta'] : null;
  const v = meta?.[PROTOCOL_VERSION_META_KEY];
  if (typeof v !== 'string' || typeof msg['method'] !== 'string' || msg['id'] === undefined) return {};
  const out: Record<string, string> = { 'mcp-protocol-version': v, 'mcp-method': msg['method'] };
  const field = NAME_SOURCE[msg['method']];
  const name = field && params ? params[field] : undefined;
  if (typeof name === 'string') out['mcp-name'] = encodeHeaderValue(name);
  return out;
}

/** Methods node:http sends with no Content-Length when there is no body. */
const NO_DEFAULT_BODY = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

/** One HTTP exchange as the raw client sees it. */
export interface RawHttpResponse {
  status: number | null;
  /** Response headers as received, in order (name, value). */
  headers: [string, string][];
  body: Buffer;
  timed_out: boolean;
  error: string | null;
  /** The client stopped reading once it had what it waited for (an SSE stream left open). */
  stopped_early: boolean;
}

/**
 * One request with node:http(s), not fetch: the headers sent are exactly the ones recorded; nothing
 * is added on the way. The egress list is checked before the socket opens.
 */
export function rawHttp(url: string, method: string, given: Record<string, string>, body: string | undefined, timeoutMs: number, egress: EgressPolicy, stopWhen?: (text: string, contentType: string) => boolean): { sent: Record<string, string>; done: Promise<RawHttpResponse> } {
  const u = new URL(url);
  assertEgress(u, egress);
  const length = body !== undefined ? String(Buffer.byteLength(body)) : NO_DEFAULT_BODY.has(method) ? null : '0';
  const sent: Record<string, string> = { host: u.host, ...given, ...(length !== null ? { 'content-length': length } : {}), connection: 'close' };
  const done = new Promise<RawHttpResponse>((resolveP) => {
    const out: RawHttpResponse = { status: null, headers: [], body: Buffer.alloc(0), timed_out: false, error: null, stopped_early: false };
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.body = Buffer.concat(chunks);
      resolveP(out);
    };
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method, headers: sent, agent: false, lookup: vettedLookup as never }, (res) => {
      out.status = res.statusCode ?? null;
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
      const ct = String(res.headers['content-type'] ?? '');
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        if (stopWhen && stopWhen(Buffer.concat(chunks).toString('utf8'), ct)) {
          out.stopped_early = true;
          res.destroy();
          finish();
        }
      });
      res.on('end', finish);
      res.on('error', (e) => {
        if (!settled && !out.stopped_early) out.error = e.message;
        finish();
      });
      res.on('close', finish);
    });
    const timer = setTimeout(() => {
      out.timed_out = true;
      req.destroy(new Error('client timeout'));
    }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (!out.timed_out && !settled) out.error = `${e.message}${e.code && !e.message.includes(e.code) ? ` (${e.code})` : ''}`;
      finish();
    });
    req.end(body);
  });
  return { sent, done };
}

export class HttpMcpClient implements McpClient {
  readonly serverRequests: { method: string; answer: string }[] = [];
  private nextId = 1;
  private session: string | null = null;
  private protocol: string | null = null;
  readonly info: Record<string, unknown> = { session: null, requests: 0, server_requests: 0 };

  constructor(
    readonly label: string,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly t: CaptureSink,
    private readonly egress: EgressPolicy,
    private readonly o: { timeout_ms: number },
  ) {}

  negotiated(v: string | null): void {
    this.protocol = v;
  }

  private async post(step: string | null, msg: Obj, wantId: unknown, extra: Record<string, unknown> = {}, timeoutMs?: number): Promise<RpcOutcome> {
    const body = JSON.stringify(msg);
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers };
    if (this.session) h['mcp-session-id'] = this.session;
    if (this.protocol) h['mcp-protocol-version'] = this.protocol;
    Object.assign(h, envelopeHeaders(msg));
    const t0 = nowMs();
    // why: a server may ask the client something on the SSE stream of a call and wait for the answer
    // before it sends the call's result, so each server request is answered as soon as it is complete.
    const answered = new Set<string>();
    const autos: Promise<RpcOutcome>[] = [];
    const serverRequests = (msgs: Obj[]) => {
      for (const m of msgs) {
        if (typeof m['method'] !== 'string' || m['id'] === undefined) continue;
        const k = JSON.stringify(m['id']);
        if (answered.has(k)) continue;
        answered.add(k);
        this.info['server_requests'] = (this.info['server_requests'] as number) + 1;
        this.serverRequests.push({ method: String(m['method']), answer: answerInWords(m) });
        autos.push(this.post(null, serverRequestAnswer(m), undefined, { auto: 'server_request_answer' }));
      }
    };
    // why: an SSE stream may stay open after the answer; stop reading once the answer to this request is in.
    const onData = (text: string, ct: string) => {
      if (!ct.includes('text/event-stream')) return false;
      const parts = sseData(text);
      serverRequests(messages(parts));
      return wantId !== undefined && this.findAnswer(parts, wantId) !== null;
    };
    const rpcExtra = { ...(msg['id'] !== undefined ? { rpc_id: msg['id'] } : {}) };
    let sent: Record<string, string>;
    let done: Promise<RawHttpResponse>;
    try {
      ({ sent, done } = rawHttp(this.url, 'POST', h, body, timeoutMs ?? this.o.timeout_ms, this.egress, onData));
    } catch (e) {
      return { message: null, timed_out: false, transport_error: (e as Error).message, http_status: null, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: typeof msg['id'] === 'number' ? msg['id'] : null };
    }
    this.t.write({ label: this.label, step, dir: 'send', channel: 'mcp-http', method: 'POST', url: this.url, headers: Object.keys(sent), ...rpcExtra, ...(typeof msg['method'] === 'string' ? { rpc_method: msg['method'] } : {}), ...extra }, body);
    this.info['requests'] = (this.info['requests'] as number) + 1;
    const r = await done;
    const received = r.body.toString('utf8');
    this.t.write({ label: this.label, step, dir: 'recv', channel: 'mcp-http', status: r.status, ...rpcExtra, ...(r.stopped_early ? { stopped_early: true } : {}), ...(r.timed_out ? { timed_out: true } : {}), ...(r.error ? { transport_error: r.error } : {}) }, r.body);
    const rid = typeof msg['id'] === 'number' ? msg['id'] : null;
    if (r.timed_out || r.error) {
      await Promise.all(autos);
      return { message: null, timed_out: r.timed_out, transport_error: r.error, http_status: r.status, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: rid };
    }
    const header = (n: string) => r.headers.find(([k]) => k.toLowerCase() === n)?.[1] ?? null;
    const sid = header('mcp-session-id');
    if (sid && !this.session) this.session = this.info['session'] = sid;
    const sse = (header('content-type') ?? '').includes('text/event-stream');
    const msgs = messages(sse ? sseData(received) : received.trim() ? [received] : []);
    serverRequests(msgs);
    await Promise.all(autos);
    const answer = wantId !== undefined ? this.findAnswer(msgs.map((m) => JSON.stringify(m)), wantId) : null;
    return { message: answer, timed_out: false, transport_error: null, http_status: r.status, t_start_ms: t0, t_end_ms: nowMs(), rpc_id: rid };
  }

  private findAnswer(parts: string[], id: unknown): Obj | null {
    for (const p of parts) {
      try {
        const v = JSON.parse(p) as unknown;
        for (const x of Array.isArray(v) ? v : [v]) if (isObj(x) && x['method'] === undefined && JSON.stringify(x['id']) === JSON.stringify(id)) return x;
      } catch {
        /* an incomplete or non-JSON event */
      }
    }
    return null;
  }

  request(step: string, method: string, params: unknown, ro: { timeout_ms?: number } = {}): Promise<RpcOutcome> {
    const id = this.nextId++;
    return this.post(step, rpcMsg(id, method, params), id, {}, ro.timeout_ms);
  }

  notify(step: string, method: string, params: unknown): Promise<RpcOutcome> {
    return this.post(step, rpcMsg(null, method, params), undefined);
  }

  /** End the session with DELETE when the server gave one (best effort). */
  async stop(): Promise<Record<string, unknown>> {
    if (this.session) {
      try {
        const { done } = rawHttp(this.url, 'DELETE', { 'mcp-session-id': this.session }, undefined, 5_000, this.egress);
        await done;
      } catch {
        /* best effort */
      }
    }
    return { ...this.info };
  }
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  /** Where the server's URL is in its first stdout line (a JSON path; `$` for a line that is the URL itself). */
  url_from: string;
  ready_timeout_ms: number;
}

export type LaunchOutcome = { ok: true; url: string } | { ok: false; exit_code: number | null; reason: string; stderr_tail: string };

const LOOPBACK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i;

/**
 * A streamable HTTP server the tester starts itself (`server.launch`): run under the supervisor, its
 * URL read from the first line it prints on stdout. The URL must be a loopback address: the tester
 * started the process on this machine, so anything else is refused.
 */
export class LaunchedServer {
  private sup: Supervised | null = null;
  private stderrLines: string[] = [];
  private outcome: Promise<LaunchOutcome> | null = null;
  private exited = false;
  /** Whether the tester sent this server SIGTERM or SIGKILL; written on its `exit` event in the capture. */
  private stopSent = false;
  // why: an exit by SIGKILL that the tester did not send is, most often, the kernel's out-of-memory killer; the capture tells the two apart.
  private signal(how: 'term' | 'kill'): void {
    this.stopSent = true;
    if (how === 'term') this.sup?.term();
    else this.sup?.kill();
  }
  private exitCode: number | null = null;
  private closed: Promise<void> = Promise.resolve();

  constructor(
    readonly label: string,
    private readonly spec: LaunchSpec,
    private readonly t: CaptureSink,
    private readonly pathGet: (v: unknown, path: string) => unknown,
  ) {}

  start(step: string): Promise<LaunchOutcome> {
    if (this.outcome) return this.outcome;
    const env = { ...this.spec.env, ...TELEMETRY_OFF };
    // why: stdin stays an open pipe, so a server that exits on stdin EOF keeps running while it serves HTTP.
    const sup = spawnSupervised(this.spec.command, this.spec.args, { env, cwd: this.spec.cwd, stdin: 'pipe' });
    this.sup = sup;
    const child = sup.proc;
    this.t.write({ label: this.label, step, dir: 'event', channel: 'process', event: 'spawn', supervisor_pid: child.pid ?? null, command: this.spec.command, args: this.spec.args, env_names: Object.keys(env).sort(), launch: 'http' });
    child.stdin?.on('error', () => {});
    this.closed = new Promise<void>((r) =>
      child.once('close', (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.t.write({ label: this.label, step: null, dir: 'event', channel: 'process', event: 'exit', exit_code: code, signal, stop_sent: this.stopSent });
        r();
      }),
    );
    createInterface({ input: child.stderr! }).on('line', (l) => {
      this.stderrLines.push(l);
      if (this.stderrLines.length > 20) this.stderrLines.shift();
      this.t.write({ label: this.label, step: null, dir: 'recv', channel: 'stderr' }, l);
    });
    this.outcome = new Promise<LaunchOutcome>((resolve) => {
      let done = false;
      const finish = (o: LaunchOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(o);
      };
      const timer = setTimeout(() => finish({ ok: false, exit_code: null, reason: `printed no URL within ${this.spec.ready_timeout_ms} ms`, stderr_tail: this.stderrTail() }), this.spec.ready_timeout_ms);
      let first = true;
      createInterface({ input: child.stdout! }).on('line', (l) => {
        this.t.write({ label: this.label, step: first ? step : null, dir: 'recv', channel: 'stdout' }, l);
        if (!first) return;
        first = false;
        let url: unknown = null;
        try {
          url = this.spec.url_from === '$' ? (/^https?:\/\//.test(l.trim()) ? l.trim() : this.pathGet(JSON.parse(l), '$')) : this.pathGet(JSON.parse(l), this.spec.url_from);
        } catch {
          url = null;
        }
        if (typeof url !== 'string') return finish({ ok: false, exit_code: null, reason: `its first stdout line has no URL at ${this.spec.url_from}`, stderr_tail: this.stderrTail() });
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          return finish({ ok: false, exit_code: null, reason: `its first stdout line names ${JSON.stringify(url)}, which is not a URL`, stderr_tail: this.stderrTail() });
        }
        if (!LOOPBACK_HOST.test(u.hostname)) return finish({ ok: false, exit_code: null, reason: `it printed ${u.host}, which is not a loopback address; a server the tester launches must listen on this machine`, stderr_tail: this.stderrTail() });
        finish({ ok: true, url });
      });
      void sup.startError.then((e) => e && finish({ ok: false, exit_code: null, reason: `could not start: ${e}`, stderr_tail: this.stderrTail() }));
      void this.closed.then(() => finish({ ok: false, exit_code: this.exitCode, reason: `exited (${this.exitCode ?? 'signal'}) before printing its URL`, stderr_tail: this.stderrTail() }));
    });
    return this.outcome;
  }

  stderrTail(): string {
    return this.stderrLines.join('\n');
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** SIGTERM the server's group, then SIGKILL; waits for the process to go. Says how it ended (a graceful stop that needed SIGKILL is a kill). */
  async stop(): Promise<'not_running' | 'SIGTERM' | 'SIGKILL'> {
    if (!this.sup || this.exited) return 'not_running';
    this.signal('term');
    if (!(await Promise.race([this.closed.then(() => true), sleep(3_000).then(() => false)]))) {
      this.signal('kill');
      await Promise.race([this.closed, sleep(2_000)]);
      return 'SIGKILL';
    }
    return 'SIGTERM';
  }

  /** SIGKILL the server's group and wait for it to go. */
  async kill(): Promise<void> {
    if (!this.sup || this.exited) return;
    this.signal('kill');
    await Promise.race([this.closed, sleep(5_000)]);
  }

  killNow(): void {
    if (!this.exited) this.signal('kill');
  }
}
