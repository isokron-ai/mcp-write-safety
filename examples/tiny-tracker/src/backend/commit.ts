// The single commit point of the backend (frozen interface; design rule 9).
//
// Every write the backend applies goes through Store.commit(meta, mutate),
// in a frozen order: validate, journal append, apply, ledger, reply. A journal
// error aborts the write with nothing applied (503); an error in the ledger or
// another sink stops the store (fail-stop).
// A write that has to wait (only a backend defect does) waits in a before step
// outside the section (BackendOps.beforePatch). `mutate` runs synchronously; the store changes it makes, the key record it
// completes and every sink's onCommit all happen in that one synchronous
// section, so no other request can run between the effect and its records.
// The ledger (0.2.0) and the journal (0.3.0) are CommitSinks. A replay and a
// refusal are events too, so the ledger sees every attempt.
//
// Sinks are synchronous. A sink that has to reach the disk does it with
// synchronous calls (writeSync, fsyncSync) inside onCommit. A sink that
// throws leaves memory and its record apart, so the store stops: every later
// request is answered 503 (fail-stop), and the error names the sink.

/** The tags a call carried (rule 3), from Tiny-Tracker-Run and Tiny-Tracker-Operation. */
export interface TxAttribution {
  run: string | null;
  operation: string | null;
}

export interface TxRequest {
  method: string;
  path: string;
  /** The Idempotency-Key, when the request carried one. */
  key: string | null;
  /** `METHOD path canonicalJson(body)` for a keyed POST, else null. Its SHA-256 is the records' fingerprint_hash. */
  fingerprint: string | null;
}

/** What the HTTP layer knows about a write before it runs. */
export interface TxMeta {
  /** The principal whose token authorized the request (src/principals.ts). */
  principal: string;
  attribution: TxAttribution;
  request: TxRequest;
}

export interface ObjectRef {
  type: "ticket" | "project" | "comment" | "label";
  id: string;
}

interface TxEvent extends TxMeta {
  /** Wall time, ISO-8601. */
  at: string;
  /** The injected clock's offset at the event (0 on the wall clock). */
  clockOffsetMs: number;
  status: number;
}

/** An applied write: post-state, as committed. */
export interface CommittedTransaction extends TxEvent {
  /**
   * The store's commit sequence: one per applied write, from 1, never reused. The execution record is X-<seq>, and from
   * 0.3.0 it is the journal line number. The ledger keeps its own sequence and links to this one by execution_id.
   */
  seq: number;
  /** The response body as committed (every server-generated value included). An execution record hashes this. */
  body: unknown;
  /** The objects the write created, changed or deleted, from the body and the path. */
  objects: ObjectRef[];
}

/** A keyed repeat answered from its key record: nothing applied. */
export interface ReplayedTransaction extends TxEvent {
  body: unknown;
  /** The commit sequence of the write the key record answers for (its execution record is X-<originalSeq>). */
  originalSeq: number;
}

/** A write refused before any effect: nothing applied, and nothing stored for its key. */
export interface RefusedTransaction extends TxEvent {
  code: string;
}

export interface CommitSink {
  /** A short name for errors and the build descriptor ("ledger", "journal"). */
  readonly name: string;
  /**
   * "journal": told first, before the write is applied; a throw aborts the write (at most one journal).
   * "ledger" and "observer": told after the write is applied; a throw stops the store.
   */
  readonly role: "journal" | "ledger" | "observer";
  onCommit(tx: CommittedTransaction): void;
  onReplay?(tx: ReplayedTransaction): void;
  onRefusal?(tx: RefusedTransaction): void;
}

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
