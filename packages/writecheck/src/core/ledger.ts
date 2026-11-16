/**
 * The write-ahead ledger: `<state>/<run id>/ledger.jsonl`. Before each create the tester appends an
 * intent line; after it, the id (or that the create failed, or that its outcome is unknown). Cleanup
 * appends what it did to each object. Every line is flushed before the call it announces, so a
 * crash leaves a file that says exactly what may exist.
 *
 * A run refuses to start while any earlier run's ledger has open entries (an object created and not
 * cleaned up, or a create whose outcome is unknown) until `cleanup` or `cleanup --abandon` has run.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isObj, nowMs, WritecheckError } from './util.js';

export type LedgerEntry =
  | { kind: 'run_start'; run_id: string; prefix: string; manifest_sha256: string; hosts: string[]; t_ms: number }
  | { kind: 'intent'; seq: number; resource: string; tool: string; purpose: string; t_ms: number }
  | { kind: 'created'; intent: number; resource: string; id: unknown; name: string | null; via: 'result' | 'sweep'; t_ms: number }
  | { kind: 'create_failed'; intent: number; resource: string; reason: string; marker?: string; t_ms: number }
  | { kind: 'create_unknown'; intent: number; resource: string; reason: string; t_ms: number }
  | { kind: 'deleted'; resource: string; id: unknown; via: string; t_ms: number }
  | { kind: 'delete_failed'; resource: string; id: unknown; reason: string; t_ms: number }
  | { kind: 'left'; resource: string; id: unknown; policy: string; reason: string; t_ms: number }
  | { kind: 'abandoned'; resource: string; id: unknown; intent: number | null; reason: string; t_ms: number }
  /** review B2: each call of the tenant guard's tool, before it is sent (a call that rests on the operator's declaration may write). */
  | { kind: 'guard_call'; step: string; tool: string; phase: string; basis: string; context?: 'run' | 'cleanup'; t_ms: number }
  | { kind: 'run_end'; status: string; t_ms: number };

export interface OpenObject {
  resource: string;
  id: unknown;
  name: string | null;
  intent: number;
}
export interface OpenIntent {
  resource: string;
  intent: number;
  tool: string;
  reason: string;
}

type Omit2<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

const FREE_TEXT = new Set(['reason', 'note', 'text', 'error', 'why', 'detail', 'purpose']);

export class Ledger {
  private seq = 0;
  readonly file: string;

  constructor(
    readonly dir: string,
    readonly runId: string,
    /** GitHub Action review S6: the free-text fields (a server's error text in a reason) are redacted as the report is. */
    private readonly redact: ((s: string) => string) | null = null,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'ledger.jsonl');
    if (existsSync(this.file)) this.seq = Math.max(0, ...readLedger(this.file).filter((e) => e.kind === 'intent').map((e) => (e as { seq: number }).seq));
  }

  /** Append one line and flush it to disk before returning. */
  append(e: Omit2<LedgerEntry, 't_ms'>): void {
    const fd = openSync(this.file, 'a', 0o600);
    try {
      // why: ids, names and markers stay exact (clean-up needs them); only the free-text fields are redacted.
      const r = this.redact;
      const out = r ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'string' && FREE_TEXT.has(k) ? r(v) : v])) : e;
      appendFileSync(fd, JSON.stringify({ ...out, t_ms: nowMs() }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  intent(resource: string, tool: string, purpose: string): number {
    const seq = ++this.seq;
    this.append({ kind: 'intent', seq, resource, tool, purpose });
    return seq;
  }

  entries(): LedgerEntry[] {
    return existsSync(this.file) ? readLedger(this.file) : [];
  }

  open(): { objects: OpenObject[]; intents: OpenIntent[] } {
    return openOf(this.entries());
  }
}

export function readLedger(file: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isObj(v) && typeof v['kind'] === 'string') out.push(v as unknown as LedgerEntry);
    } catch {
      // why: a torn last line from a crash is not an entry; everything before it still counts.
    }
  }
  return out;
}

const idKey = (resource: string, id: unknown) => `${resource}\u0000${JSON.stringify(id)}`;

/** Objects created and not resolved, and creates whose outcome is unknown, newest first. */
export function openOf(entries: LedgerEntry[]): { objects: OpenObject[]; intents: OpenIntent[] } {
  const created = new Map<string, OpenObject>();
  const resolvedIntents = new Set<number>();
  const intents = new Map<number, { resource: string; tool: string }>();
  const unknown = new Map<number, string>();
  for (const e of entries) {
    switch (e.kind) {
      case 'intent':
        intents.set(e.seq, { resource: e.resource, tool: e.tool });
        break;
      case 'created':
        resolvedIntents.add(e.intent);
        created.set(idKey(e.resource, e.id), { resource: e.resource, id: e.id, name: e.name, intent: e.intent });
        break;
      case 'create_failed':
        resolvedIntents.add(e.intent);
        break;
      case 'create_unknown':
        unknown.set(e.intent, e.reason);
        break;
      case 'deleted':
      case 'left':
        created.delete(idKey(e.resource, e.id));
        break;
      case 'abandoned':
        if (e.intent !== null) resolvedIntents.add(e.intent);
        if (e.id !== null && e.id !== undefined) created.delete(idKey(e.resource, e.id));
        break;
      default:
        break;
    }
  }
  const openIntents: OpenIntent[] = [];
  for (const [seq, i] of intents) if (!resolvedIntents.has(seq)) openIntents.push({ resource: i.resource, intent: seq, tool: i.tool, reason: unknown.get(seq) ?? 'no outcome was recorded (the run stopped during the create)' });
  return { objects: [...created.values()].sort((a, b) => b.intent - a.intent), intents: openIntents.sort((a, b) => b.intent - a.intent) };
}

/** Every run under the state folder whose ledger still has open entries. */
export function openRuns(stateDir: string): { run_id: string; dir: string; objects: OpenObject[]; intents: OpenIntent[] }[] {
  if (!existsSync(stateDir)) return [];
  const out: { run_id: string; dir: string; objects: OpenObject[]; intents: OpenIntent[] }[] = [];
  for (const d of readdirSync(stateDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = join(stateDir, d.name, 'ledger.jsonl');
    if (!existsSync(file)) continue;
    const o = openOf(readLedger(file));
    if (o.objects.length || o.intents.length) out.push({ run_id: d.name, dir: join(stateDir, d.name), ...o });
  }
  return out;
}

export function refuseIfOpen(stateDir: string): void {
  const open = openRuns(stateDir);
  if (!open.length) return;
  const lines = open.map((r) => `  run ${r.run_id}: ${r.objects.length} object(s) not cleaned up, ${r.intents.length} create(s) with unknown outcome`);
  throw new WritecheckError(`an earlier run left open ledger entries:\n${lines.join('\n')}\nRun \`mcp-writecheck cleanup\` (or \`cleanup --abandon\` to record them as left behind) before a new run.`, 3);
}
