/**
 * Min mode: a small MCP client over stdio (newline-delimited JSON-RPC). It starts the server process itself (so it
 * can start it again for a restart step or with other settings), speaks revision 2026-07-28 where the server offers it
 * (server/discover first) and otherwise 2025-11-25 (initialize), answers ping and declines every other request the
 * server makes, and on an `input_required` result can retry once with accepting answers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { isObj, type Obj } from '../core/util.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';

export const LEGACY = '2025-11-25';
export const MODERN = '2026-07-28';

export interface ServerSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

export interface ToolResult {
  /** A JSON-RPC error, or null. */
  rpcError: { code: number; message: string } | null;
  timedOut: boolean;
  /** The process went away or the pipe broke before an answer. */
  transportError: string | null;
  isError: boolean;
  resultType: string | null;
  /** Every text block, joined by newlines. */
  text: string;
  structured: unknown;
  /** The raw result object (for the record, capped by the caller). */
  raw: Obj | null;
  inputRequired: { inputRequests: unknown; requestState: string | null } | null;
}

const ENVELOPE = (caps: Obj): Obj => ({ 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': caps, 'io.modelcontextprotocol/clientInfo': { name: SUITE_NAME, version: SUITE_VERSION } });

export class StdioServer {
  private child: ChildProcess | null = null;
  private pending = new Map<number, (m: Obj | null, err?: string) => void>();
  private nextId = 1;
  private exited: { code: number | null; signal: string | null } | null = null;
  private stderr: string[] = [];
  modern = false;
  protocol: string | null = null;
  /** Client capabilities declared on 2026-07-28 requests (elicitation, so that an input request may be sent). */
  caps: Obj = { elicitation: {} };

  constructor(readonly spec: ServerSpec, readonly timeoutMs = 15_000) {}

  get hasExited(): boolean {
    return this.exited !== null;
  }

  get exitInfo(): { code: number | null; signal: string | null } | null {
    return this.exited;
  }

  stderrTail(n = 15): string {
    return this.stderr.slice(-n).join('\n');
  }

  start(): void {
    this.exited = null;
    const child = spawn(this.spec.command, this.spec.args, { cwd: this.spec.cwd, env: this.spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.on('error', (e) => {
      this.exited ??= { code: null, signal: `spawn error: ${e.message}` };
      this.failAll(`could not start: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      this.failAll(`the server exited (${code ?? signal})`);
    });
    child.stdin!.on('error', () => {});
    createInterface({ input: child.stderr! }).on('line', (l) => {
      this.stderr.push(l.slice(0, 500));
      if (this.stderr.length > 60) this.stderr.shift();
    });
    createInterface({ input: child.stdout! }).on('line', (l) => this.onLine(l));
  }

  private failAll(why: string): void {
    for (const [, f] of this.pending) f(null, why);
    this.pending.clear();
  }

  private onLine(l: string): void {
    let m: unknown;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    if (typeof m['method'] === 'string' && m['id'] !== undefined) {
      // A request of the server: ping is answered, everything else declined (no model, no roots, no user).
      const reply = m['method'] === 'ping' ? { jsonrpc: '2.0', id: m['id'], result: {} } : { jsonrpc: '2.0', id: m['id'], error: { code: -32601, message: `${String(m['method'])} is not supported by this test client` } };
      this.write(reply);
      return;
    }
    if (typeof m['id'] === 'number' && this.pending.has(m['id'])) {
      const f = this.pending.get(m['id'])!;
      this.pending.delete(m['id']);
      f(m);
    }
  }

  private write(m: Obj): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(m)}\n`);
    } catch {
      /* the pipe is gone; the exit handler fails the pending requests */
    }
  }

  request(method: string, params: Obj, timeoutMs = this.timeoutMs): Promise<{ message: Obj | null; timedOut: boolean; error: string | null }> {
    if (!this.child || this.exited) return Promise.resolve({ message: null, timedOut: false, error: 'the server is not running' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve({ message: null, timedOut: true, error: null });
      }, timeoutMs);
      this.pending.set(id, (m, err) => {
        clearTimeout(t);
        resolve({ message: m, timedOut: false, error: m ? null : (err ?? 'no answer') });
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private params(p: Obj): Obj {
    return this.modern ? { ...p, _meta: { ...ENVELOPE(this.caps), ...(isObj(p['_meta']) ? p['_meta'] : {}) } } : p;
  }

  /** Starts the process and opens the session. Returns null when it is open, else why not. */
  async open(): Promise<string | null> {
    this.start();
    const d = await this.request('server/discover', { _meta: ENVELOPE(this.caps) }, Math.min(this.timeoutMs, 8000));
    const res = d.message && isObj(d.message['result']) ? d.message['result'] : null;
    const versions = res && Array.isArray(res['supportedVersions']) ? (res['supportedVersions'] as unknown[]) : [];
    if (versions.includes(MODERN)) {
      this.modern = true;
      this.protocol = MODERN;
      return null;
    }
    // why: a server on an older SDK may exit on a method it does not know; it is started again and initialized.
    if (this.exited || !d.message) {
      await this.stop();
      this.start();
    }
    const r = await this.request('initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: SUITE_NAME, version: SUITE_VERSION } });
    const ir = r.message && isObj(r.message['result']) ? r.message['result'] : null;
    if (!ir) return r.timedOut ? 'no answer to initialize' : (r.error ?? `initialize was refused: ${JSON.stringify(r.message?.['error'] ?? null).slice(0, 200)}`);
    this.protocol = typeof ir['protocolVersion'] === 'string' ? ir['protocolVersion'] : null;
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    return null;
  }

  async listTools(): Promise<Obj[] | null> {
    const out: Obj[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', this.params(cursor ? { cursor } : {}));
      const res = r.message && isObj(r.message['result']) ? r.message['result'] : null;
      if (!res || !Array.isArray(res['tools'])) return page ? out : null;
      out.push(...(res['tools'] as unknown[]).filter(isObj));
      if (typeof res['nextCursor'] !== 'string' || !res['nextCursor']) break;
      cursor = res['nextCursor'];
    }
    return out;
  }

  async call(name: string, args: Obj, extra: Obj = {}): Promise<ToolResult> {
    const r = await this.request('tools/call', this.params({ name, arguments: args, ...extra }));
    return toResult(r);
  }

  /**
   * Calls a tool; an `input_required` answer is retried once with accepting answers built from each request's schema
   * (booleans true, the first enum value, a string "yes"). Returns the first answer and, where retried, the final one.
   */
  async callAccepting(name: string, args: Obj): Promise<{ first: ToolResult; final: ToolResult }> {
    const first = await this.call(name, args);
    if (!first.inputRequired) return { first, final: first };
    const answers: Obj = {};
    const reqs = isObj(first.inputRequired.inputRequests) ? first.inputRequired.inputRequests : {};
    for (const [k, v] of Object.entries(reqs)) {
      const params = isObj(v) && isObj(v['params']) ? v['params'] : isObj(v) ? v : {};
      const schema = isObj(params['requestedSchema']) ? params['requestedSchema'] : {};
      const content: Obj = {};
      for (const [pk, ps] of Object.entries(isObj(schema['properties']) ? schema['properties'] : {})) {
        const t = isObj(ps) ? ps['type'] : undefined;
        content[pk] = t === 'boolean' ? true : isObj(ps) && Array.isArray(ps['enum']) ? (ps['enum'] as unknown[])[0] : t === 'number' || t === 'integer' ? 1 : 'yes';
      }
      answers[k] = { action: 'accept', content };
    }
    const final = await this.call(name, args, { inputResponses: answers, ...(first.inputRequired.requestState ? { requestState: first.inputRequired.requestState } : {}) });
    return { first, final };
  }

  async stop(): Promise<void> {
    const c = this.child;
    if (!c || this.exited) return;
    c.stdin?.end();
    c.kill('SIGTERM');
    const gone = await Promise.race([new Promise<boolean>((r) => c.once('exit', () => r(true))), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    if (!gone) {
      c.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export function toResult(r: { message: Obj | null; timedOut: boolean; error: string | null }): ToolResult {
  const m = r.message;
  const err = m && isObj(m['error']) ? { code: Number(m['error']['code']), message: String(m['error']['message'] ?? '') } : null;
  const res = m && isObj(m['result']) ? m['result'] : null;
  const texts = res && Array.isArray(res['content']) ? (res['content'] as unknown[]).filter((c): c is Obj => isObj(c) && c['type'] === 'text' && typeof c['text'] === 'string').map((c) => c['text'] as string) : [];
  const resultType = res && typeof res['resultType'] === 'string' ? res['resultType'] : null;
  return {
    rpcError: err,
    timedOut: r.timedOut,
    transportError: r.error && !m ? r.error : null,
    isError: !!res && res['isError'] === true,
    resultType,
    text: texts.join('\n'),
    structured: res ? res['structuredContent'] : undefined,
    raw: res,
    inputRequired: resultType === 'input_required' && res ? { inputRequests: res['inputRequests'] ?? null, requestState: typeof res['requestState'] === 'string' ? res['requestState'] : null } : null,
  };
}

/** A call answered with a tool result that is neither an error nor pending: what MWS-RES-2 calls a success. */
export const succeeded = (r: ToolResult): boolean => !r.rpcError && !r.timedOut && !r.transportError && !r.isError && r.raw !== null && (r.resultType === null || r.resultType === 'complete');
