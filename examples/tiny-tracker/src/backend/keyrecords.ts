// Key records with in-flight, tombstone and fence states (0.3.0, features
// inflight and retention; decision 0004, design rule 4). This replaces the
// in-memory seam of 0.1.0 (memoryKeyRecords) behind the same KeyRecordSeam. The
// keyed path (src/backend/http.ts) calls get and put as before, begin and abort
// around the section (seams v2), and `screen` first (src/backend/durability.ts).
//
// Scope is (principal, key) (D5). The run is kept on each record for a
// run-scoped reset and is never part of a lookup.
//
// States of one (principal, key):
//   pending    a keyed write has begun and not committed; a same-key call
//              meanwhile answers in_progress (outcome unknown, repeat same_key)
//   completed  the stored answer (a StoredReply), replayed to a repeat
//   tombstone  an expired completed record under the `refuse` policy: what the
//              write was (execution id, digest, objects), not its answer
//   fenced     a lookup found no record and closed the key (settle-by-lookup,
//              review B9): a late original with the key is refused
//
// With a journal (feature durable) a pending record is a `pending` line and its
// end without a commit an `aborted` line; a completed record is rebuilt from its
// commit line. A fence is held in memory only: see the stream notes (it is not a
// line kind of journal-format/1).

import { digestOf, DOMAINS, fingerprintHash } from "../digest.js";
import { executionId } from "../records.js";
import type { Clock } from "../clock.js";
import type { CommitSink, CommittedTransaction, ObjectRef } from "./commit.js";
import type { InflightKeyRecordSeam, KeyExpirySeam, KeyScope, StoredReply } from "./seams.js";
import type { ExpiryPolicy } from "./expiry.js";

/** What an expired record keeps (decision 0004): enough to say the write was applied and where to read it. */
export interface Tombstone {
  fingerprintHash: string;
  executionId: string;
  resultDigest: string;
  committedAt: string;
  objects: ObjectRef[];
  seq: number;
}

/** A stored answer, with the objects its commit named (kept for the tombstone). */
export type KeptReply = StoredReply & { objects?: ObjectRef[] };

export type KeyState =
  | { state: "pending"; fingerprint: string; run: string | null; jseq?: number; since?: string }
  | { state: "completed"; reply: KeptReply }
  | { state: "tombstone"; tomb: Tombstone; run: string | null }
  | { state: "fenced"; at: string; run: string | null };

/** The answer the keyed path gives before it runs a write. `proceed`: no early answer (a new write, or a replay/reuse it decides itself). */
export type Screen =
  | { kind: "proceed" }
  | { kind: "in_progress" }
  | { kind: "reused" }
  | { kind: "expired"; tomb: Tombstone }
  | { kind: "fenced"; at: string };

/** Why a pending record ended with no commit (seams v2.1; v2 freezes refused, journal_unavailable, orphan_at_start). */
export type AbortReason = "refused" | "journal_unavailable" | "fault" | "internal_error" | "orphan_at_start";

/** The answer of get in seams v2.1 (coordinator note 7): what the keyed path branches on, in this order. */
export type KeyLookup =
  | { state: "completed"; reply: StoredReply }
  | { state: "pending"; since: string }
  | { state: "expired"; tombstone: Tombstone }
  | undefined;

/** Where key-state lines go when the store is durable (src/backend/journal.ts). */
export interface KeyLineWriter {
  /** Writes a pending line; returns its jseq. */
  pending(scope: KeyScope, key: string, fingerprint: string, run: string | null): number;
  aborted(pendingJseq: number, reason: AbortReason): void;
}

export interface KeyRecordOptions {
  clock: Clock;
  /** Retention (feature retention); none: kept for the life of the store. */
  expiry?: KeyExpirySeam;
  policy?: ExpiryPolicy;
}

/** `METHOD path canonicalJson(body)` back into its parts (the backend's comparison string). */
export function parseFingerprint(fp: string): { method: string; path: string; body: unknown } {
  const a = fp.indexOf(" ");
  const b = fp.indexOf(" ", a + 1);
  return { method: fp.slice(0, a), path: fp.slice(a + 1, b), body: JSON.parse(fp.slice(b + 1)) };
}

/** The frozen fingerprint_hash of a keyed request, from its comparison string. */
export function fingerprintHashOf(principal: string, fp: string): string {
  const { method, path, body } = parseFingerprint(fp);
  return fingerprintHash(principal, method, path, body);
}

/** The result digest under the execution-result domain ("" where the body cannot be canonicalized). */
export function resultDigestOf(body: unknown): string {
  try {
    return digestOf(DOMAINS.executionResult, body ?? null).digest;
  } catch {
    return "";
  }
}

const id = (scope: KeyScope, key: string) => `${scope.principal}\u0000${key}`;

export class DurableKeyRecords implements InflightKeyRecordSeam {
  private readonly states = new Map<string, KeyState>();
  /** Keys whose commit line the journal could not write (the abort that follows says journal_unavailable). */
  private readonly journalFailed = new Set<string>();
  /** The journal (feature durable), or none. */
  lines: KeyLineWriter | undefined;
  /** Under the key-record-after-effect defect: told of each completed record after the write is applied. */
  afterPut: ((scope: KeyScope, key: string, reply: KeptReply) => void) | undefined;

  constructor(readonly options: KeyRecordOptions) {}

  get policy(): ExpiryPolicy {
    return this.options.policy ?? "refuse";
  }

  /** The state of a key now, after expiry is applied (an expired record turns into a tombstone, or goes under forget). */
  state(scope: KeyScope, key: string): KeyState | undefined {
    const s = this.states.get(id(scope, key));
    if (s?.state !== "completed" || !this.options.expiry) return s;
    if (!this.options.expiry.isExpired(s.reply, this.options.clock.now())) return s;
    if (this.policy === "forget") {
      this.states.delete(id(scope, key));
      return undefined;
    }
    const next: KeyState = { state: "tombstone", tomb: this.toTombstone(scope, s.reply), run: s.reply.run };
    this.states.set(id(scope, key), next);
    return next;
  }

  private toTombstone(scope: KeyScope, reply: KeptReply): Tombstone {
    return {
      fingerprintHash: fingerprintHashOf(scope.principal, reply.fingerprint),
      executionId: executionId(reply.seq),
      resultDigest: resultDigestOf(reply.body),
      committedAt: reply.committedAt,
      objects: reply.objects ?? [],
      seq: reply.seq,
    };
  }

  /** When the key's record expires (null: no retention, or no completed record). */
  expiresAt(scope: KeyScope, key: string): string | null {
    const s = this.state(scope, key);
    if (!this.options.expiry || s?.state !== "completed") return null;
    return this.options.expiry.expiresAt(new Date(s.reply.committedAt)).toISOString();
  }

  // ---- KeyRecordSeam ----

  get(scope: KeyScope, key: string): StoredReply | undefined {
    const s = this.state(scope, key);
    return s?.state === "completed" ? s.reply : undefined;
  }

  put(scope: KeyScope, key: string, reply: StoredReply): void {
    this.journalFailed.delete(id(scope, key));
    this.states.set(id(scope, key), { state: "completed", reply });
    this.afterPut?.(scope, key, reply);
  }

  dropRun(scope: KeyScope, run: string): number {
    let n = 0;
    const prefix = `${scope.principal}\u0000`;
    for (const [k, s] of this.states) {
      if (!k.startsWith(prefix)) continue;
      if (s.state === "pending") {
        // seams v2.1: a run reset ends the run's pending records (journalled as aborted); they are not counted.
        if (s.run === run) this.abort(scope, k.slice(prefix.length), "refused");
        continue;
      }
      const r = s.state === "completed" ? s.reply.run : s.run;
      if (r === run) { this.states.delete(k); n++; }
    }
    return n;
  }

  // ---- InflightKeyRecordSeam ----

  begin(scope: KeyScope, key: string, fingerprint: string, run: string | null): void {
    const jseq = this.lines?.pending(scope, key, fingerprint, run);
    this.states.set(id(scope, key), { state: "pending", fingerprint, run, jseq, since: this.options.clock.now().toISOString() });
  }

  /**
   * Ends a pending record with no commit. Never throws (seams v2.1: it runs in a finally, where a throw would hide the
   * answer): a journal error is logged and the pending line is ended as orphan_at_start at the next start. Without a
   * reason it is journal_unavailable after a failed commit line, else refused.
   */
  abort(scope: KeyScope, key: string, reason?: AbortReason): void {
    const k = id(scope, key);
    const failed = this.journalFailed.delete(k);
    const s = this.states.get(k);
    if (s?.state !== "pending") return;
    this.states.delete(k);
    if (s.jseq === undefined) return;
    try {
      this.lines?.aborted(s.jseq, reason ?? (failed ? "journal_unavailable" : "refused"));
    } catch (e) {
      this.log?.(`tiny-tracker: could not journal the end of a pending key record (${(e as Error).message}); it ends at the next start`);
    }
  }

  /** Where abort reports a journal error (default: none). */
  log: ((message: string) => void) | undefined;

  /** The seams v2.1 shape of get: completed, pending or expired (a fence answers as pending: no write may begin). */
  lookup(scope: KeyScope, key: string): KeyLookup {
    const s = this.state(scope, key);
    if (!s) return undefined;
    if (s.state === "completed") return { state: "completed", reply: s.reply };
    if (s.state === "tombstone") return { state: "expired", tombstone: s.tomb };
    if (s.state === "pending") return { state: "pending", since: s.since ?? "" };
    return { state: "pending", since: s.at };
  }

  tombstone(scope: KeyScope, key: string) {
    const s = this.state(scope, key);
    return s?.state === "tombstone" ? s.tomb : undefined;
  }

  // ---- the keyed path's questions ----

  /** What a keyed request meets before it runs (decision 0004's answer table). */
  screen(scope: KeyScope, key: string, fingerprint: string): Screen {
    const s = this.state(scope, key);
    if (!s || s.state === "completed") return { kind: "proceed" };
    if (s.state === "pending") return s.fingerprint === fingerprint ? { kind: "in_progress" } : { kind: "reused" };
    if (s.state === "fenced") return { kind: "fenced", at: s.at };
    return s.tomb.fingerprintHash === fingerprintHashOf(scope.principal, fingerprint) ? { kind: "expired", tomb: s.tomb } : { kind: "reused" };
  }

  /**
   * Settle-by-lookup's fence (review B9): the state of the key, and when there is none and `write` is set, a fence in
   * the same synchronous step, so the original request can no longer apply if it arrives later.
   */
  fence(scope: KeyScope, key: string, run: string | null, write: boolean): KeyState | undefined {
    const s = this.state(scope, key);
    if (s || !write) return s;
    const fenced: KeyState = { state: "fenced", at: this.options.clock.now().toISOString(), run };
    this.states.set(id(scope, key), fenced);
    return fenced;
  }

  /** The jseq of the key's pending line, if it has one (a commit line names it). */
  pendingJseq(scope: KeyScope, key: string): number | undefined {
    const s = this.states.get(id(scope, key));
    return s?.state === "pending" ? s.jseq : undefined;
  }

  /** The journal could not write this key's commit line: the abort that follows is journal_unavailable. */
  markJournalFailure(scope: KeyScope, key: string): void {
    this.journalFailed.add(id(scope, key));
  }

  // ---- replay at start (no clock call, no line written) ----

  restore(scope: KeyScope, key: string, state: KeyState | undefined): void {
    if (state === undefined) this.states.delete(id(scope, key));
    else this.states.set(id(scope, key), state);
  }

  /** An aborted line: the pending record it names ends. */
  restorePendingEnd(jseq: number): void {
    for (const [k, s] of this.states) if (s.state === "pending" && s.jseq === jseq) this.states.delete(k);
  }

  /** Counts by state (tests and the build descriptor). */
  counts(): Record<KeyState["state"], number> {
    const c = { pending: 0, completed: 0, tombstone: 0, fenced: 0 };
    for (const s of this.states.values()) c[s.state]++;
    return c;
  }

  /** An observer sink: adds the commit's objects to the record it completed (a tombstone names them). */
  objectsSink(): CommitSink {
    return {
      name: "key-records",
      role: "observer",
      onCommit: (tx: CommittedTransaction) => {
        const key = tx.request.key;
        if (key === null || tx.kind !== "write") return;
        const s = this.states.get(id({ principal: tx.principal }, key));
        if (s?.state === "completed" && s.reply.seq === tx.seq && !s.reply.objects) s.reply = { ...s.reply, objects: tx.objects };
      },
    };
  }
}
