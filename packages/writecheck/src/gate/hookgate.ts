/**
 * The gate through the in-process hook (`backend.gate.node_import: true`): every Node server process
 * the session starts loads `mcp-writecheck/register` with NODE_OPTIONS=--import, which wraps fetch
 * inside the server (outbound.ts). The tester talks to the hook through two files under the state
 * folder: a rules file it rewrites (holds and faults, each with a fresh rule id) and a JSONL log the
 * hook appends to (one `begin` line per request on arrival, one `end` line when it finishes, `hold`
 * and `release` lines). Holds are released by creating the rule's release file.
 *
 * A result through this route was obtained with a cooperative hook inside the server, and says so.
 *
 * Several server processes may share the rules file; each counts matches for itself. A hold rule is
 * therefore removed from the file as soon as it has held a request, so that a second writer's
 * matching request (in another process, sent only after the hold) is not held as well.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { isObj, nowMs, sleep } from '../core/util.js';
import type { FaultRule } from './faults.js';
import { MUTATING, type FaultHandle, type FaultSpec, type Gate, type GateRequest, type HoldHandle, type HoldSpec } from './gate.js';

export const REGISTER_JS = fileURLToPath(new URL('./register.js', import.meta.url));
const POLL_MS = 5;
const HOLD_CEILING_MS = 120_000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

interface Line {
  kind?: string;
  pid?: number;
  rid?: number;
  rule?: string | null;
  method?: string;
  path?: string;
  t?: number;
  status?: number;
  err?: string | null;
}

export class HookGate implements Gate {
  readonly route = 'node_import' as const;
  private readonly dir: string;
  private readonly rulesFile: string;
  private readonly logFile: string;
  private rules: FaultRule[] = [];
  private n = 0;
  private releaseFiles: string[] = [];

  constructor(
    stateDir: string,
    private readonly redactEnv: string[],
    readonly holdTimeoutMs: number,
  ) {
    this.dir = join(stateDir, `gate-${randomBytes(4).toString('hex')}`);
    this.rulesFile = join(this.dir, 'rules.json');
    this.logFile = join(this.dir, 'outbound.jsonl');
  }

  describe(): string {
    return 'through a cooperative hook inside the server process (node --import of mcp-writecheck/register, which wraps fetch), not on the network; the server\'s author controls where such a hook sits, so this result is only as good as that placement';
  }

  serverEnv(): Record<string, string> {
    return {
      NODE_OPTIONS: `--import=${pathToFileURL(REGISTER_JS).href}`,
      MWSC_GATE_RULES: this.rulesFile,
      MWSC_OUTBOUND_LOG: this.logFile,
      ...(this.redactEnv.length ? { MWSC_REDACT_ENV: this.redactEnv.join(',') } : {}),
    };
  }

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.write();
    if (!existsSync(this.logFile)) writeFileSync(this.logFile, '', { mode: 0o600 });
  }

  /** Replace the rules file atomically (the hook re-reads it when its inode, size or mtime changes). */
  private write(): void {
    const tmp = `${this.rulesFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rules), { mode: 0o600 });
    renameSync(tmp, this.rulesFile);
  }

  private lines(): Line[] {
    let text = '';
    try {
      text = readFileSync(this.logFile, 'utf8');
    } catch {
      return [];
    }
    const out: Line[] = [];
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try {
        const v = JSON.parse(l) as unknown;
        if (isObj(v)) out.push(v as Line);
      } catch {
        /* a line still being written */
      }
    }
    return out;
  }

  /** Requests in order of arrival, with the status from their end line. */
  private requests(): { reqs: GateRequest[]; byKey: Map<string, GateRequest>; lines: Line[] } {
    const lines = this.lines();
    const reqs: GateRequest[] = [];
    const byKey = new Map<string, GateRequest>();
    for (const l of lines) {
      const key = `${l.pid}:${l.rid}`;
      if (l.kind === 'begin') {
        const r: GateRequest = { seq: reqs.length + 1, method: String(l.method ?? 'GET').toUpperCase(), path: String(l.path ?? ''), t_ms: Number(l.t ?? 0), mutating: MUTATING.has(String(l.method ?? '').toUpperCase()), status: null };
        reqs.push(r);
        byKey.set(key, r);
      } else if (l.kind === 'end') {
        const r = byKey.get(key);
        if (r) r.status = typeof l.status === 'number' && l.status > 0 ? l.status : null;
      }
    }
    return { reqs, byKey, lines };
  }

  mark(): number {
    return this.requests().reqs.length;
  }

  async since(mark: number, settleMs = 50): Promise<GateRequest[]> {
    if (settleMs > 0) await sleep(settleMs);
    return this.requests().reqs.filter((r) => r.seq > mark);
  }

  private add(rule: FaultRule): void {
    this.rules.push(rule);
    this.write();
  }

  private drop(id: string): void {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length !== before) this.write();
  }

  /** Poll the log for a line of `kind` naming `rule`; the request it is about, or null after `ms`. */
  private async waitLine(rule: string, kinds: string[], ms: number): Promise<GateRequest | null> {
    const until = Date.now() + ms;
    for (;;) {
      const { byKey, lines } = this.requests();
      const l = lines.find((x) => x.rule === rule && kinds.includes(String(x.kind)));
      if (l) return { ...(byKey.get(`${l.pid}:${l.rid}`) ?? { seq: 0, method: String(l.method ?? ''), path: String(l.path ?? ''), t_ms: Number(l.t ?? 0), mutating: false, status: null }) };
      if (Date.now() >= until) return null;
      await sleep(POLL_MS);
    }
  }

  hold(spec: HoldSpec): HoldHandle {
    const id = `hold-${++this.n}-${randomBytes(3).toString('hex')}`;
    const releaseFile = join(this.dir, `${id}.release`);
    this.releaseFiles.push(releaseFile);
    this.add({ id, fault: 'hold', ...matchOf(spec), nth: spec.nth, release_file: releaseFile, delay_ms: HOLD_CEILING_MS });
    let held: GateRequest | null = null;
    let releasedAt: number | null = null;
    const self = this;
    return {
      async waitHeld(ms) {
        if (held) return { ...held };
        const r = await self.waitLine(id, ['hold'], ms);
        if (r) {
          held = r;
          // why: other server processes count matches for themselves; once held, the rule must not hold anyone else.
          self.drop(id);
        }
        return r;
      },
      async release() {
        self.drop(id);
        writeFileSync(releaseFile, '');
        if (held && releasedAt === null) releasedAt = nowMs();
      },
      get heldRequest() {
        return held ? { ...held } : null;
      },
      get releasedAt() {
        return releasedAt;
      },
    };
  }

  fault(spec: FaultSpec): FaultHandle {
    const id = `fault-${++this.n}-${randomBytes(3).toString('hex')}`;
    this.add({ id, fault: spec.kind, ...matchOf(spec), nth: spec.nth, ...(spec.kind !== 'commit_then_reset' && spec.kind !== 'commit_then_hang' ? { status: spec.status ?? 500 } : {}) });
    // why: a held answer never ends (until the server is stopped); its hit is the hook's commit line, written once the backend answered.
    const kinds = spec.kind === 'commit_then_hang' ? ['commit'] : ['end'];
    return {
      waitHit: async (ms) => {
        const r = await this.waitLine(id, kinds, ms);
        if (r) this.drop(id);
        return r;
      },
      clear: () => this.drop(id),
    };
  }

  clear(): void {
    this.rules = [];
    this.write();
    for (const f of this.releaseFiles) writeFileSync(f, '');
  }

  async stop(): Promise<void> {
    this.clear();
    // why: a held request polls for its release file every few ms; give it a moment before the folder goes.
    await sleep(50);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The rule fields for a hold or fault spec: '*' as the method is any mutating request, '*' as the path any path. */
function matchOf(spec: { method: string; path: string }): { http_method?: string; mutating?: boolean; path?: string } {
  return { ...(spec.method === '*' ? { mutating: true } : { http_method: spec.method.toUpperCase() }), ...(spec.path === '*' ? {} : { path: `^${escapeRe(spec.path)}$` }) };
}
