// Key records with in-flight, tombstone and fence states (0.3.0, features
// inflight and retention; decision 0004, design rule 4). This replaces the
// in-memory seam of 0.1.0 (memoryKeyRecords) behind the same KeyRecordSeam. The
// keyed path (src/backend/http.ts) calls get and put as before, begin and abort
// around the section, and answers each state in the frozen order (seams v2.1).
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
//   fenced     the key can never be used again, nothing applied for it: either
//              a run reset ended its pending record (seams v2.1, by "reset"),
//              or a lookup found no record and closed it (settle-by-lookup,
//              review B9, by "lookup"). Fences never expire (owner decision).
//
// With a journal (feature durable) a pending record is a `pending` line and its
// end without a commit an `aborted` line, or a `fence` line when a run reset
// ended it; a completed record is rebuilt from its commit line; a lookup fence
// is a `lookup-fence` line (an additive line kind of journal-format/1).

import { digestOf, DOMAINS, fingerprintHash } from "../digest.js";
import { executionId } from "../records.js";
import type { Clock } from "../clock.js";
import type { CommitSink, CommittedTransaction, ObjectRef } from "./commit.js";
import type { AbortReason, InflightKeyRecordSeam, KeyExpirySeam, KeyRecordState, KeyScope, KeyTombstone, StoredReply } from "./seams.js";
import type { ExpiryPolicy } from "./expiry.js";

/** What an expired record keeps (decision 0004): enough to say the write was applied and where to read it. */
export interface Tombstone extends KeyTombstone {
  objects: ObjectRef[];
  seq: number;
}

/** A stored answer, with the objects its commit named (kept for the tombstone). */
export type KeptReply = StoredReply & { objects?: ObjectRef[] };

export type KeyState =
  | { state: "pending"; fingerprint: string; run: string | null; jseq?: number; since?: string }
  | { state: "completed"; reply: KeptReply }
  | { state: "tombstone"; tomb: Tombstone; run: string | null }
  | { state: "fenced"; at: string; run: string | null; by: "reset" | "lookup" };


/** Where key-state lines go when the store is durable (src/backend/journal.ts). */
export interface KeyLineWriter {
  /** Writes a pending line; returns its jseq. */
  pending(scope: KeyScope, key: string, fingerprint: string, run: string | null): number;
  aborted(pendingJseq: number, reason: AbortReason): void;
  /** Writes a fence line: a run reset ended the pending line `pendingJseq` (seams v2.1). */
  fence(scope: KeyScope, key: string, run: string, pendingJseq: number): void;
  /** Writes a lookup-fence line: a lookup closed a key that had no record (settle-by-lookup, B9). */
  lookupFence(scope: KeyScope, key: string, run: string | null, at: string): void;
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
  /** The point backend/after-effect-before-key (G2 fold-in 11): told of each keyed write before its record is kept. */
  beforeKeep: ((reply: StoredReply) => void) | undefined;
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

  /**
   * Seams v2.1: the state the keyed path branches on (completed, pending, fenced, expired). A tombstone answers
   * expired; a fence of either kind answers fenced (a lookup fence names the caller's run, or "" without one).
   */
  get(scope: KeyScope, key: string): KeyRecordState | undefined {
    const s = this.state(scope, key);
    if (!s) return undefined;
    if (s.state === "completed") return { state: "completed", reply: s.reply };
    if (s.state === "tombstone") return { state: "expired", tombstone: s.tomb };
    if (s.state === "pending") return { state: "pending", since: s.since ?? "" };
    return { state: "fenced", run: s.run ?? "", by: s.by };
  }

  /** The stored answer of a completed record, or undefined. */
  stored(scope: KeyScope, key: string): StoredReply | undefined {
    const s = this.state(scope, key);
    return s?.state === "completed" ? s.reply : undefined;
  }

  /** Set by the journal while it replays: a run reset then fences nothing (the fence lines that follow do). */
  replaying = false;

  put(scope: KeyScope, key: string, reply: StoredReply): void {
    this.beforeKeep?.(reply);
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
        // Seams v2.1: a run reset fences the run's pending records (a fence line, no aborted line); not counted.
        if (s.run === run && !this.replaying) {
          const key = k.slice(prefix.length);
          this.states.set(k, { state: "fenced", at: this.options.clock.now().toISOString(), run, by: "reset" });
          if (s.jseq !== undefined) {
            try {
              this.lines?.fence(scope, key, run, s.jseq);
            } catch (e) {
              // The reset is committed; the fence holds in memory. At the next start the reset's commit line fences the
              // pending line again and writes its fence line then (G2 fold-in 5), so the key stays fenced.
              this.log?.(`tiny-tracker: could not journal a fence (${(e as Error).message}); its pending line ends at the next start`);
            }
          }
        }
        continue;
      }
      // Fences never expire and are never reusable (owner decision): a reset does not remove them.
      if (s.state === "fenced") continue;
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
  abort(scope: KeyScope, key: string, reason: AbortReason): void {
    const k = id(scope, key);
    const failed = this.journalFailed.delete(k);
    const s = this.states.get(k);
    if (s?.state !== "pending") return;
    this.states.delete(k);
    if (s.jseq === undefined) return;
    try {
      // A commit line the journal could not write is journal_unavailable, whatever the keyed path saw.
      this.lines?.aborted(s.jseq, failed ? "journal_unavailable" : reason);
    } catch (e) {
      this.log?.(`tiny-tracker: could not journal the end of a pending key record (${(e as Error).message}); it ends at the next start`);
    }
  }

  /** Where abort reports a journal error (default: none). */
  log: ((message: string) => void) | undefined;

  tombstone(scope: KeyScope, key: string) {
    const s = this.state(scope, key);
    return s?.state === "tombstone" ? s.tomb : undefined;
  }

  // ---- settle-by-lookup ----

  /**
   * Settle-by-lookup's fence (review B9): the state of the key, and when there is none and `write` is set, a fence in
   * the same synchronous step, so the original request can no longer apply if it arrives later.
   */
  fence(scope: KeyScope, key: string, run: string | null, write: boolean): KeyState | undefined {
    const s = this.state(scope, key);
    if (s || !write) return s;
    const at = this.options.clock.now().toISOString();
    // Journalled first (lookup-fence line): a fence that a restart forgets would let a late original land.
    this.lines?.lookupFence(scope, key, run, at);
    const fenced: KeyState = { state: "fenced", at, run, by: "lookup" };
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

  /** A fence line: the pending record it names becomes fenced by its run's reset. */
  restoreFence(scope: KeyScope, key: string, run: string, at: string): void {
    this.states.set(id(scope, key), { state: "fenced", at, run, by: "reset" });
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
        const key = tx.request?.key ?? null;
        if (key === null || tx.kind !== "write") return;
        const s = this.states.get(id({ principal: tx.principal }, key));
        if (s?.state === "completed" && s.reply.seq === tx.seq && !s.reply.objects) s.reply = { ...s.reply, objects: tx.objects };
      },
    };
  }
}
