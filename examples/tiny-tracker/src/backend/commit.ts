// The single commit point of the backend (frozen interface; design rule 9).
//
// Every write the backend applies goes through Store.commit(meta, mutate),
// in a frozen order (docs/INTERFACES.md 1.1):
//   0. before the section (async, may await): BackendOps.beforePatch (a
//      backend defect's wait), the pending key record (InflightKeyRecordSeam
//      .begin, 0.3.0), then the backend/before-commit fault hook
//      (BackendOptions.faults.beforeCommit);
//   1. the synchronous section: validate and compute (`mutate`), journal
//      append, apply, ledger and observers;
//   2. after the section: the backend/after-commit fault hook, then the reply.
// A journal error aborts the write with nothing applied (503
// journal_unavailable, reported to the ledger as a refusal); an error in the
// ledger or another sink stops the store (fail-stop).
//
// The section is synchronous: the store changes `mutate` makes, the key record
// the commit completes and every sink's onCommit happen with no await between
// them, so no other request runs between the effect and its records. Sinks
// are synchronous too: a sink that has to reach the disk does it with
// writeSync and fsyncSync inside onCommit.
//
// A CommittedTransaction is complete post-state: replaying the journal's
// transactions onto its header's seed rebuilds the store, its id counters,
// its applied-write log, its key records and its owners with no clock call
// and no operation re-run (journal-format/1, decision 0003). Every record time
// of one write is the transaction's `committedAt`, read once from the record
// clock at the start of the section.

import type { Project, Ticket } from "./store.js";

/** The tags a call carried (rule 3), from Tiny-Tracker-Run and Tiny-Tracker-Operation. */
export interface TxAttribution {
  run: string | null;
  operation: string | null;
}

export interface TxRequest {
  method: string;
  path: string;
  /**
   * The Idempotency-Key of a keyed POST, else null. A key header on any other write (PATCH, PUT, DELETE) is ignored and
   * is not recorded here, so an execution record never names a key that has no key record (seams v2.1).
   */
  key: string | null;
  /**
   * The backend's own comparison string for a keyed POST, `METHOD path canonicalJson(body)`, else null. It decides
   * whether a repeated key is the same request (key reuse). It is NOT what the records hash: see fingerprintHash.
   */
  fingerprint: string | null;
  /**
   * The records' fingerprint_hash, computed once by the HTTP layer for every write (keyed or not):
   * fingerprintHash(principal, method, path, body) in src/digest.ts, SHA-256 under
   * dev.writesafety.tiny-tracker/request-fingerprint/1 over the RFC 8785 bytes of {body, method, path, principal}.
   */
  fingerprintHash: string;
  /** The parsed request body (null when there was none): what fingerprintHash covers. */
  body: unknown;
}

/** What the HTTP layer knows about a write before it runs. */
export interface TxMeta {
  /** The principal whose token authorized the request (src/principals.ts). */
  principal: string;
  attribution: TxAttribution;
  /**
   * The client request. null for a run reset (Store.dropRun: its commit and its refusal), which no client request
   * carries: its ledger entry has `request: null` (seams v2.1; a fingerprint_hash is never made up for it).
   * Every write from the HTTP layer has one (WriteMeta).
   */
  request: TxRequest | null;
}

/** TxMeta of a client write (the HTTP layer's): `request` is always set. */
export type WriteMeta = TxMeta & { request: TxRequest };

export interface ObjectRef {
  type: "ticket" | "project" | "comment" | "label";
  id: string;
}

interface TxEvent extends TxMeta {
  /** The backend process's boot id (the build descriptor's process.boot_id when the fixture layer runs). */
  bootId: string;
  /** Wall time, ISO-8601. */
  at: string;
  /** The injected clock's offset at the event (0 on the wall clock). */
  clockOffsetMs: number;
  status: number;
}

/** The id counters after a commit: the last number given out for each kind (T-<n>, L-<n>, C-<n>). */
export interface IdCounters {
  ticket: number;
  label: number;
  comment: number;
}

/** Who created an object: its principal and the run tag of the request that created it. Comments and labels belong to their ticket. */
export interface ObjectOwner {
  type: "ticket" | "project";
  id: string;
  principal: string;
  run: string | null;
}

/**
 * One entry of the applied-write log, which recognizes a re-sent conditional write that was already applied. The log
 * keeps the last 20 entries per ticket (older ones are dropped, so a re-send older than that gets the normal 412).
 */
export interface AppliedWrite {
  ticket: string;
  /**
   * The principal whose write it was (seams v2.1). A re-send is a replay only for the same principal: another
   * principal sending the same If-Match write gets the normal 412.
   */
  principal: string;
  fromVersion: number;
  toVersion: number;
  /** The store's comparison string (`PATCH canonicalJson(fields)` or `PUT ...`). */
  fingerprint: string;
  /** The commit that applied it: a replay answered from this entry names it as originalSeq. */
  seq: number;
}

/** What one commit leaves behind, complete: replaying it needs no clock call and no operation re-run. */
export interface PostState {
  /** Every project and ticket the commit created or changed, whole, as committed (comments and labels inside). */
  upserts: { projects: Project[]; tickets: Ticket[] };
  /** Every project key and ticket id the commit removed. Their owners and applied-write entries go with them. */
  deletes: { projects: string[]; tickets: string[] };
  /** The id counters after the commit (a batch that made labels moves them; a refused write does not). */
  counters: IdCounters;
  /** Owners of the objects this commit created (decision: owners travel in the transaction; applyPostState restores them). */
  owners: ObjectOwner[];
  /** Applied-write entries this commit added (one per changed ticket of a PATCH, PUT or batch patch). */
  applied: AppliedWrite[];
}

/** A run reset (Store.dropRun): one principal's run, removed through the commit path. */
export interface RunReset {
  principal: string;
  run: string;
  /** The objects removed (also in post.deletes). */
  objects: ObjectRef[];
  /**
   * The key records removed: null when the journal is told (they are counted in the apply step, and replaying a
   * reset drops the same records by principal and run), a number by the time the ledger is told.
   */
  keys: number | null;
}

/** An applied write: post-state, as committed. */
export interface CommittedTransaction extends TxEvent {
  /** "write": a client request (it has an execution record, X-<seq>). "run-reset": Store.dropRun (no execution record). */
  kind: "write" | "run-reset";
  /**
   * The store's commit sequence: one per commit, from 1, never reused, never consumed by an aborted or refused write
   * or a replay. A write's execution record is X-<seq> (so X-ids skip the seq of a run reset). It is NOT a journal line
   * number: every journal line carries its own `jseq`, and a commit line carries this as `commit_seq` (JournalLine).
   * The ledger keeps its own sequence and links to this one by execution_id.
   */
  seq: number;
  /**
   * The record-clock time of the commit, ISO-8601: one Clock.now() read at the start of the section. Every time the
   * write stores (created_at, updated_at, a comment's created_at), the key record's committedAt and the execution
   * record's committed_at are this value. Journal replay reuses it and never reads the clock.
   */
  committedAt: string;
  /** The response body as committed (every server-generated value included). An execution record hashes this. */
  body: unknown;
  /** The reply headers as committed (the ETag among them); a key record stores these. */
  headers: Record<string, string>;
  /** The objects the write created, changed or deleted, from the body and the path. */
  objects: ObjectRef[];
  post: PostState;
  /** Set when kind is "run-reset". */
  reset?: RunReset;
}

/** A keyed repeat answered from its key record: nothing applied. */
export interface ReplayedTransaction extends TxEvent {
  body: unknown;
  /** The commit sequence of the write the key record answers for (its execution record is X-<originalSeq>). */
  originalSeq: number;
}

/**
 * A write refused before any effect: nothing applied, and nothing stored for its key. A journal failure is reported
 * as one too, with status 503 and code "journal_unavailable", after the store was put back.
 */
export interface RefusedTransaction extends TxEvent {
  code: string;
}

export interface CommitSink {
  /** A short name for errors and the build descriptor ("ledger", "journal"). */
  readonly name: string;
  /**
   * "journal": told first, before the write is applied; a throw aborts the write (at most one journal).
   * "ledger" and "observer": told after the write is applied; a throw stops the store. Order (frozen): every
   * "ledger" sink first, then every "observer", each group in the order added. Backend defects that watch commits
   * are observers (BackendOps.observers), added after the sinks given to startBackend.
   */
  readonly role: "journal" | "ledger" | "observer";
  onCommit(tx: CommittedTransaction): void;
  onReplay?(tx: ReplayedTransaction): void;
  onRefusal?(tx: RefusedTransaction): void;
}

/** The key record a keyed write's commit completes: derived from the transaction alone, so journal replay rebuilds it. */
export function storedReplyOf(tx: CommittedTransaction): import("./seams.js").StoredReply {
  return {
    fingerprint: tx.request!.fingerprint!, status: tx.status, body: tx.body, headers: tx.headers,
    run: tx.attribution.run, seq: tx.seq, committedAt: tx.committedAt, clockOffsetMs: tx.clockOffsetMs,
  };
}

// ---- journal-format/1 lines (written and read by stream D; the shape is frozen here) ----
//
// A journal is JSONL. Every line carries `jseq`: its own number in the file, from 0 (the header), contiguous, never
// reused. A reader checks it and never counts lines. Only a commit line carries `commit_seq` (= tx.seq = the execution
// record's seq). A pending line (0.3.0 inflight) is written before the section and holds no commit_seq: the commit
// that completes it names it by `pending_jseq`, and a pending line no commit names is ended by an `aborted` line
// (written when the write is refused or its journal append fails, or at start for an orphan found on load).
// A `fence` line (seams v2.1) records a key a run reset fenced: it ends the pending line it names (no `aborted` line),
// and at load it puts the fence back, so the key stays refused (409 key_fenced) across a restart. A `run-alloc` line records a run the fixture layer allocated, so the run registry (and the run_not_owned and
// run_not_allocated checks) survive a restart. `checksum` is lower-case hex SHA-256 of the line's RFC 8785 bytes
// without the checksum member.
//
// Torn lines (decision 0003 section 5): only a torn LAST line is tolerated at load. A failed append can leave a partial
// line; since the store carries on after a journal failure, the writer must not append after it. After a failed
// append the journal truncates the file back to the offset of the end of the last good line (ftruncate, then fsync)
// before the next append; if it cannot truncate, it fails stop (it throws on every later append and the store
// answers 503) instead of appending after a torn line.

/** The state a store starts from before any commit: the seeded projects, as created, and the id counters. */
export interface SeedState {
  projects: Project[];
  counters: IdCounters;
}

export interface JournalHeader {
  jseq: 0;
  line: "header";
  journal: "journal-format/1";
  /** The package version that created the journal. */
  writer: string;
  /** The boot id of the process that created the journal (later boots append their own commits with theirs). */
  boot_id: string;
  /** The seed: a restart restores these projects (created_at included) instead of seeding fresh ones. */
  seed: SeedState;
  checksum: string;
}

export interface JournalPendingLine {
  jseq: number;
  line: "pending";
  principal: string;
  key: string;
  fingerprint: string;
  run: string | null;
  created_at: string;
  clock_offset_ms: number;
  checksum: string;
}

export interface JournalAbortedLine {
  jseq: number;
  line: "aborted";
  /** The pending line this ends: nothing was applied for it. */
  pending_jseq: number;
  /** InflightKeyRecordSeam.abort's reason (src/backend/seams.ts AbortReason). */
  reason: import("./seams.js").AbortReason;
  checksum: string;
}

/** A key fenced by a run reset (KeyRecordSeam.dropRun): ends its pending line; restored as { state: "fenced" } at load. */
export interface JournalFenceLine {
  jseq: number;
  line: "fence";
  principal: string;
  key: string;
  /** The run whose reset fenced the key. */
  run: string;
  /** The pending line this ends. */
  pending_jseq: number;
  /** The commit_seq of the run reset that fenced it (the reset's commit line comes first). */
  reset_seq: number;
  checksum: string;
}

/** A run the fixture layer allocated (src/fixture/control.ts RunRegistry): replayed into the registry at load. */
export interface JournalRunAllocLine {
  jseq: number;
  line: "run-alloc";
  run_id: string;
  principal: string;
  /** Record clock, as the registry gave it. */
  created_at: string;
  label: string | null;
  checksum: string;
}

export interface JournalCommitLine {
  jseq: number;
  line: "commit";
  commit_seq: number;
  /** The pending line this commit completes (a keyed write under inflight), else null. */
  pending_jseq: number | null;
  tx: CommittedTransaction;
  checksum: string;
}

export type JournalLine = JournalHeader | JournalPendingLine | JournalAbortedLine | JournalCommitLine | JournalRunAllocLine | JournalFenceLine;

export class CommitSinkError extends Error {
  constructor(readonly sink: string, cause: unknown) {
    super(`commit sink ${sink} failed: ${(cause as Error)?.message ?? String(cause)}; the store has stopped`);
  }
}

/** The journal could not append: the write was not applied. The request is answered 503; the store carries on. */
export class JournalError extends Error {
  constructor(readonly sink: string, cause: unknown) {
    super(`the journal (${sink}) could not append: ${(cause as Error)?.message ?? String(cause)}; nothing was applied`);
  }
}

/** The objects a reply names, read from its body and its path. */
export function objectsOf(path: string, body: unknown): ObjectRef[] {
  const out: ObjectRef[] = [];
  const b = (body ?? {}) as Record<string, any>;
  if (b.ticket?.id) out.push({ type: "ticket", id: String(b.ticket.id) });
  if (b.project?.key) out.push({ type: "project", id: String(b.project.key) });
  if (Array.isArray(b.results)) for (const r of b.results) if (r?.id) out.push({ type: "ticket", id: String(r.id) });
  if (b.comment?.id) out.push({ type: "comment", id: String(b.comment.id) });
  if (b.label?.id) out.push({ type: "label", id: String(b.label.id) });
  if (out.length === 0) {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "tickets" && parts[1]) out.push({ type: "ticket", id: parts[1] });
    if (parts[0] === "projects" && parts[1]) out.push({ type: "project", id: parts[1] });
  }
  return out;
}
