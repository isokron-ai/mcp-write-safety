/**
 * The backend gate (tier 3): a hold on the hop between the server and its backend, so the
 * interleaving a concurrency requirement is about can be forced instead of attempted, and a chosen
 * backend request can be made to fail (always the k-th matching request, never a probability).
 *
 * Two routes, chosen in the manifest's `backend.gate`:
 *
 *   rewrite_env: NAME   base-URL rewrite. The tester starts a loopback forwarder (forwarder.ts) and
 *                       starts the server with NAME pointing at it; the forwarder sends every request
 *                       on to the real backend (the tester's own value of NAME) with normal TLS
 *                       verification, and holds or fails the request it is told to.
 *                       When the variable holds a database URL (postgres://, redis://, mongodb://),
 *                       the wire gate (wire/proxy.ts) stands in instead: a loopback TCP listener that
 *                       reads the database protocol to name, hold and fail requests (docs/WIRE-GATE.md).
 *   node_import: true   the in-process hook (outbound.ts) loaded with `node --import` into a Node
 *                       server: it wraps fetch inside the server. Results through this route say so
 *                       (MWS 7.3: the server's author controls where a cooperative hook sits).
 *
 * The scheduler (learning pass, gated pair, mirrored schedule) is built on this interface by the
 * checks: learn = mark(), run writer A alone, since(mark); hold = hold A's last mutating request
 * (`lastMutating`) by method, path and its position among the matching requests of the learning pass
 * (`nthOf`).
 */

import type { EgressPolicy } from '../core/egress.js';
import type { Manifest } from '../core/manifest.js';
import { WritecheckError } from '../core/util.js';
import { Forwarder } from './forwarder.js';
import { HookGate } from './hookgate.js';
import { MongoSession, sharedMongo } from './wire/mongodb.js';
import { PostgresSession } from './wire/postgres.js';
import { WireGate } from './wire/proxy.js';
import { RedisSession } from './wire/redis.js';
import { wireProtocolOf, wireRefusal } from './wire/url.js';

/** What the wire gate knows of a request beyond method and path (docs/WIRE-GATE.md §4, §5). */
export interface WireInfo {
  protocol: string;
  /** The request with every value removed. */
  statement: string;
  /** Why the write-or-read classification is not certain. */
  uncertain?: string;
  statements?: number;
  /** The backend's answer class (CommandComplete UPDATE 1, -WRONGTYPE, ok:1 n:1). */
  reply?: string;
  /** Transaction state after the request. */
  txn?: string;
  /** The answer the server received was written by the gate, not the backend. */
  synthetic?: boolean;
  /** What the gate did to keep client and backend in step, or could not do. */
  note?: string;
  /** A commit_then_* fault on a write inside a transaction, applied at the commit (seq `to`). */
  deferred?: { to: number | null; outcome: 'pending' | 'committed' | 'rolled back' };
}

export interface GateRequest {
  /** Order of arrival at the gate (1-based, per gate). */
  seq: number;
  method: string;
  /** URL path, without the query. */
  path: string;
  t_ms: number;
  mutating: boolean;
  /** The status the server received (null while in flight, or when the connection was cut). Wire gate: the HTTP equivalent (docs/WIRE-GATE.md §5.4). */
  status: number | null;
  /** Wire gate only. */
  wire?: WireInfo;
}

/** Hold the nth request (1-based) matching method and exact path, counted from when hold() is called. */
export interface HoldSpec {
  method: string;
  path: string;
  nth: number;
}

export interface HoldHandle {
  /** The held request once it has arrived and is being held, or null after `ms`. */
  waitHeld(ms: number): Promise<GateRequest | null>;
  /** Let the held request through (also disarms a hold that never triggered). */
  release(): Promise<void>;
  readonly heldRequest: GateRequest | null;
  readonly releasedAt: number | null;
}

/**
 * Fail the nth request matching method and exact path:
 *   status              answer with `status` (default 500) without forwarding: the backend never sees it
 *   commit_then_status  forward (the write lands), then answer with `status`
 *   commit_then_reset   forward (the write lands), then cut the connection before any answer
 *   commit_then_hang    forward (the write lands), then hold the answer: the server hears nothing until it is
 *                       stopped (the crash form of MWS-RETRY-2 step (e)); the hit is reported once the backend answered
 */
export interface FaultSpec {
  /** An HTTP method, or '*' for any mutating request (POST, PUT, PATCH, DELETE). */
  method: string;
  /** An exact path, or '*' for any path. */
  path: string;
  nth: number;
  kind: 'status' | 'commit_then_status' | 'commit_then_reset' | 'commit_then_hang';
  status?: number;
}

export interface FaultHandle {
  /** The faulted request once the fault has been applied, or null after `ms`. */
  waitHit(ms: number): Promise<GateRequest | null>;
  clear(): void;
}

export interface Gate {
  readonly route: 'base_url' | 'node_import' | 'wire';
  /** How long a scheduler waits for writer B while A is held before it records "serialized by the server". */
  readonly holdTimeoutMs: number;
  /** One sentence: how the server's backend traffic is routed (for every gated result). */
  describe(): string;
  /** Environment to merge into every server process the session starts. */
  serverEnv(): Record<string, string>;
  start(): Promise<void>;
  /** Seq of the last request seen so far. */
  mark(): number;
  /** Requests after `mark`, waiting `settleMs` (default 50) for in-flight ones to be logged. */
  since(mark: number, settleMs?: number): Promise<GateRequest[]>;
  hold(spec: HoldSpec): HoldHandle;
  fault(spec: FaultSpec): FaultHandle;
  /** Drop armed holds and faults; any held request is let through. */
  clear(): void;
  stop(): Promise<void>;
}

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A write: the gate's own classification when it gave one (the wire gate always does), else the HTTP method. */
export function isMutating(r: Pick<GateRequest, 'method'> & { mutating?: boolean }): boolean {
  return typeof r.mutating === 'boolean' ? r.mutating : MUTATING.has(r.method.toUpperCase());
}

/** The request a gated pair holds: the last mutating request of the learning pass (null: none). */
export function lastMutating<T extends Pick<GateRequest, 'method'> & { mutating?: boolean }>(reqs: T[]): T | null {
  for (let i = reqs.length - 1; i >= 0; i--) if (isMutating(reqs[i]!)) return reqs[i]!;
  return null;
}

/** A request's position among the requests of the same method and path in a learned sequence (HoldSpec.nth). */
export function nthOf(reqs: GateRequest[], r: GateRequest): number {
  return reqs.filter((x) => x.seq <= r.seq && x.method === r.method && x.path === r.path).length;
}

/** The gate the manifest asks for, or null when it has no backend.gate. Not started yet. */
export function createGate(m: Manifest, env: NodeJS.ProcessEnv, o: { stateDir: string; egress: EgressPolicy }): Gate | null {
  const g = m.backend?.gate;
  if (!g) return null;
  if (!m.server.stdio && !m.server.launch) throw new WritecheckError('backend.gate needs a server the tester starts (server.stdio or server.launch): the tester can route only the backend traffic of a process it starts', 2);
  if (g.rewrite_env) {
    const upstream = env[g.rewrite_env];
    if (!upstream) throw new WritecheckError(`backend.gate.rewrite_env: ${g.rewrite_env} is not set in the tester's environment (it must hold the real backend URL; the server is given the gate's URL instead)`, 2);
    const wire = wireProtocolOf(upstream);
    if (wire) {
      const why = wireRefusal(upstream);
      if (why) throw new WritecheckError(`backend.gate.rewrite_env: ${g.rewrite_env} holds a ${wire} URL the wire gate cannot stand in for: ${why}`, 2);
      // why: Mongo transactions belong to a session (lsid) that may use several pooled connections; their state is shared per gate.
      const shared = sharedMongo();
      const codec = wire === 'postgres' ? (k: string) => new PostgresSession(k) : wire === 'redis' ? (k: string) => new RedisSession(k) : (k: string) => new MongoSession(k, shared);
      return new WireGate(wire, g.rewrite_env, upstream, o.egress, g.hold_timeout_ms, codec);
    }
    return new Forwarder(g.rewrite_env, upstream, o.egress, g.hold_timeout_ms);
  }
  return new HookGate(o.stateDir, m.server.env_passthrough, g.hold_timeout_ms);
}

export const GATE_NOT_CONFIGURED = 'no backend.gate in the manifest: the hop between the server and its backend is not interposed on';

/** @deprecated phase 1 stand-in, kept for older callers; every method refuses. Use createGate. */
export class GateNotBuilt {
  async start(): Promise<never> {
    throw new Error('the backend gate is not built by this stand-in; use createGate');
  }
}
