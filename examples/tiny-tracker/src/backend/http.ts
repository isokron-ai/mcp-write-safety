// The tracker's REST API over node:http. Loopback only, bearer token on every
// request. See the README for the route table.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, canonicalJson, Store, type SectionReply, type TicketFields } from "./store.js";
import { CommitSinkError, JournalError, storedReplyOf, type CommitSink, type CommittedTransaction, type WriteMeta } from "./commit.js";
import { isInflight, memoryKeyRecords, type AbortReason, type DigestSeam, type KeyRecordSeam, type KeyRecordState, type KeyScope, type LookupSeam } from "./seams.js";
import { CanonicalizationError, fingerprintHash } from "../digest.js";
import { correctDigest, EXECUTION_HEADER, ExecutionLog } from "./execution.js";
import { correctLookup, evidenceSource, NO_RECORD, NO_RECORD_NOTE, type EvidenceReader } from "./lookup.js";
import { executionId } from "../records.js";
import type { Clock } from "../clock.js";
import { defaultPrincipals, principalFor, type Principal } from "../principals.js";
import { HEADERS, TAG_PATTERN } from "../fixture-properties.js";
import { applyBackendDefects } from "./defects/index.js";
import { correctInputRules, type InputRules } from "./input.js";

export interface BackendOptions {
  /** Bearer token the MCP layer must send. */
  token: string;
  port?: number;
  /** Names of backend defects to switch on (see src/backend/defects). */
  defects?: string[];
  /** Active features (see src/profile.ts). The backend acts on `strict-input`; the others are the fixture layer's. */
  features?: readonly string[];
  /**
   * Routes served beside the API, with their own authorization (the fixture layer's read-only evidence namespace).
   * Asked first for every request; when it answers false the request goes to the API as usual.
   */
  extension?: BackendExtension;
  /** The clock every stored time comes from (default: the wall clock). */
  clock?: Clock;
  /** Commit sinks (the ledger, the journal): told of every commit, replay and refusal, inside the commit section. */
  sinks?: CommitSink[];
  /** Principals and their tokens (default: one, p-default, with `token`). */
  principals?: Principal[];
  /** The boot id every event carries (the fixture layer gives its descriptor's; default: a fresh random one). */
  bootId?: string;
  /** The backend fault hooks (streams B and E arm faults through these, never by editing this file). */
  faults?: BackendFaultHooks;
  /**
   * Which principal a run tag belongs to (the fixture layer's run registry), or undefined for a run it did not
   * allocate. When given (the fixture layer's control listener allocates runs), a write tagged with another
   * principal's run is refused 403 run_not_owned, and a write tagged with a run that was never allocated is refused
   * 403 run_not_allocated (seams v2.1). Without it a run tag is a tag only.
   */
  runOwner?: (run: string) => string | undefined;
  /**
   * Container mode (owner decision, INTERFACES §1.4): a second listener that serves the evidence routes only, on the
   * address given (for example 0.0.0.0 inside a container), behind the evidence token. The API stays on 127.0.0.1.
   * Needs an `extension` (the evidence namespace); every other path answers 404 there.
   */
  evidenceListen?: { host: string; port: number };
}

/** What a backend fault hook is told about the write. */
export interface FaultContext {
  meta: WriteMeta;
}

/**
 * The backend fault positions (src/fault-points.ts), as hooks. Both may await; neither runs inside the section.
 * - beforeCommit (backend/before-commit): after the pending key record (keyed writes under inflight) and before the
 *   synchronous section, so nothing is validated or written yet. Throw an ApiError to answer with it (reported to the
 *   ledger as a refusal, the pending record aborted); await to delay; exit the process to crash.
 * - afterCommit (backend/after-commit): after the section (journal, apply, ledger) and before the reply, only for a
 *   write that committed. Return undefined to send the reply, "drop" to close the connection with no answer, or
 *   { status, body } to answer that instead (the error action). Await to hold; exit the process to crash.
 * On a keyed write the key record is looked up again after beforeCommit, so a same-key request that committed while
 * the hook waited is answered as a replay, not applied twice.
 */
export interface BackendFaultHooks {
  beforeCommit?(ctx: FaultContext): Promise<void>;
  afterCommit?(ctx: FaultContext & { tx: CommittedTransaction }): Promise<undefined | "drop" | { status: number; body: unknown }>;
}

/** Which listener a request reached: the loopback API listener, or the container-mode evidence listener. */
export interface ExtensionContext {
  listener: "api" | "evidence";
}

export interface BackendExtension {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, store: Store, context?: ExtensionContext): Promise<boolean>;
}

export interface RunningBackend {
  url: string;
  store: Store;
  bootId: string;
  /** The read side of the evidence (also store.evidence); undefined without the execution-records feature. */
  evidence: EvidenceReader | undefined;
  /** The container-mode evidence listener's URL, when `evidenceListen` was given. */
  evidenceUrl?: string;
  /** The run reset (Store.dropRun through the commit path, with the key-record seam in use). */
  dropRun(scope: KeyScope, run: string): ReturnType<Store["dropRun"]>;
  close(): Promise<void>;
}

/**
 * The operations the routes call: the backend's seams (src/backend/defects/index.ts, BACKEND_SEAMS). A backend
 * defect may replace one of them.
 */
export interface BackendOps {
  /**
   * The write, inside the synchronous commit section. `prepared` is what beforePatch returned, if it ran.
   */
  patchTicket(store: Store, id: string, fields: TicketFields, ifMatch?: number | "*", prepared?: unknown): ReturnType<Store["patchTicket"]>;
  /**
   * An optional step before the commit section, the only place a PATCH may await. The correct build has none; a
   * backend defect that "waits mid-write" does its read and its wait here (rule 9: the commit itself stays synchronous).
   */
  beforePatch?(store: Store, id: string, fields: TicketFields, ifMatch?: number | "*"): Promise<unknown>;
  /** Seam inputRules: used only with the strict-input feature. */
  inputRules: InputRules;
  /** Seam keyRecord: the records that answer keyed repeats, scoped by principal. */
  keyRecord: KeyRecordSeam;
  /**
   * Commit observers a backend defect adds (a defect that watches commits). They are added as role "observer" after
   * the sinks given to startBackend, so they are told after every ledger sink.
   */
  observers?: CommitSink[];
  /** Seam digest (execution-records): the served canonical bytes and digest of a committed response body. */
  digest: DigestSeam;
  /** Seam lookup (lookup): a key's stored reply within the caller's scope. */
  lookup: LookupSeam;
  /** The store the seams work on (a backend defect may read it; the correct seams do not). */
  readonly store: Store;
}

function correctOps(store: Store): BackendOps {
  const ops: BackendOps = {
    patchTicket: (s, id, fields, ifMatch) => s.patchTicket(id, fields, ifMatch),
    inputRules: correctInputRules,
    keyRecord: memoryKeyRecords(),
    digest: correctDigest,
    // Reads ops.keyRecord on every call, so a key-record seam put in later (0.3.0) is the one looked up.
    lookup: correctLookup(() => ops.keyRecord),
    store,
  };
  return ops;
}

function parseIfMatch(header: string | undefined): number | "*" | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (value === "*") return "*";
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "bad_if_match", `If-Match must be a quoted version, got ${header}`);
  return n;
}

const etag = (version: number) => `"${version}"`;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new ApiError(413, "too_large", "request body over 1 MB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "request body is not valid JSON");
  }
}

/** A run or operation tag from its header; anything not in the tag format is ignored. */
function tag(value: string | string[] | undefined): string | null {
  return typeof value === "string" && TAG_PATTERN.test(value) ? value : null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * TxRequest.fingerprintHash for a write. A body holding a string that is not well-formed Unicode has no canonical bytes;
 * with execution-records (or strict-input) such a body is refused before this point. Without them the backend keeps
 * 0.1.0's behaviour (it accepts the write), and the hash, which no record serves, is left empty.
 */
function requestHash(principal: string, method: string, path: string, body: unknown): string {
  try {
    return fingerprintHash(principal, method, path, body ?? null);
  } catch (e) {
    if (e instanceof CanonicalizationError) return "";
    throw e;
  }
}

export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
  const store = new Store(undefined, options.clock, options.bootId);
  for (const sink of options.sinks ?? []) store.addSink(sink);
  const principals = options.principals ?? defaultPrincipals(options.token);
  const ops: BackendOps = correctOps(store);
  const features = options.features ?? [];
  const executionRecords = features.includes("execution-records");
  const lookupOn = features.includes("lookup");
  if (lookupOn && !executionRecords) throw new Error("the lookup feature needs the execution-records feature (an operation record names its execution record)");
  applyBackendDefects(options.defects ?? [], ops, features);
  if (executionRecords) {
    // An observer: told after the ledger, before any observer a backend defect adds.
    const executions = new ExecutionLog(() => ops.digest);
    store.addSink(executions);
    store.evidence = evidenceSource({ executions, lookup: () => ops.lookup, digest: () => ops.digest, lookupOn, principals: principals.map((p) => p.id) });
  }
  for (const o of ops.observers ?? []) {
    if (o.role !== "observer") throw new Error(`a backend defect's commit sink must have role "observer" (${o.name})`);
    store.addSink(o);
  }
  store.keyRecords = ops.keyRecord;
  store.runOwner = options.runOwner;
  const faults = options.faults ?? {};
  /** abort must not throw (it decides nothing): a seam that throws anyway is logged, and the answer already decided stands. */
  const safeAbort = (scope: KeyScope, key: string, reason: AbortReason) => {
    const seam = ops.keyRecord;
    if (!isInflight(seam)) return;
    try {
      seam.abort(scope, key, reason);
    } catch (e) {
      console.error(`tiny-tracker: abort of a pending key record failed (${reason}): ${(e as Error)?.message ?? String(e)}`);
    }
  };
  const strictInput = features.includes("strict-input");
  type Reply = SectionReply;

  /** Synchronous for every correct route (rule 9); a promise only where a backend defect awaits inside its write. */
  function route(method: string, url: URL, req: IncomingMessage, body: unknown, prepared?: unknown, principal?: string): Reply {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const ifMatch = parseIfMatch(req.headers["if-match"] as string | undefined);
    const b = (body ?? {}) as Record<string, unknown>;
    const ticketReply = (status: number, value: { ticket: { version: number } } & Record<string, unknown>) =>
      ({ status, body: value, headers: { etag: etag(value.ticket.version) } });

    // /projects
    if (parts[0] === "projects") {
      if (parts.length === 1 && method === "GET") return { status: 200, body: { projects: store.export().projects } };
      if (parts.length === 1 && method === "POST") {
        return { status: 201, body: { project: store.createProject(b.key as string, b.name as string) } };
      }
      if (parts.length === 2 && method === "GET") return { status: 200, body: { project: store.getProject(parts[1]) } };
      if (parts.length === 2 && method === "PUT") {
        const r = store.upsertProject(parts[1], b.name as string);
        return { status: r.created ? 201 : 200, body: { project: r.project, created: r.created } };
      }
      if (parts.length === 2 && method === "DELETE") {
        store.deleteProject(parts[1]);
        return { status: 204 };
      }
    }

    // /tickets
    if (parts[0] === "tickets") {
      const id = parts[1];
      if (parts.length === 1 && method === "GET") {
        const q = url.searchParams;
        const tickets = store.listTickets({
          project: q.get("project") ?? undefined,
          status: q.get("status") ?? undefined,
          title_prefix: q.get("title_prefix") ?? undefined,
        });
        return { status: 200, body: { tickets } };
      }
      if (parts.length === 1 && method === "POST") {
        const ticket = store.createTicket(b as never);
        return ticketReply(201, { ticket });
      }
      if (parts.length === 2 && method === "GET") return ticketReply(200, { ticket: store.getTicket(id) });
      if (parts.length === 2 && method === "PATCH") {
        const r = ops.patchTicket(store, id, b as TicketFields, ifMatch, prepared);
        return { ...ticketReply(200, { ticket: r.ticket, changed: r.changed }),
          headers: { etag: etag(r.ticket.version), ...(r.replayed ? { "idempotent-replayed": "true" } : {}) },
          replayOf: r.replayed ? r.originalSeq : undefined };
      }
      if (parts.length === 2 && method === "PUT") {
        const r = store.putTicket(id, b as TicketFields, ifMatch, url.searchParams.get("force") === "true");
        return { ...ticketReply(200, { ticket: r.ticket, changed: r.changed }),
          headers: { etag: etag(r.ticket.version), ...(r.replayed ? { "idempotent-replayed": "true" } : {}) },
          replayOf: r.replayed ? r.originalSeq : undefined };
      }
      if (parts.length === 2 && method === "DELETE") {
        store.deleteTicket(id, ifMatch);
        return { status: 204 };
      }
      if (parts.length === 3 && parts[2] === "comments" && method === "POST") {
        const r = store.addComment(id, b.body as string);
        return ticketReply(201, r);
      }
      if (parts.length === 3 && parts[2] === "labels" && method === "POST") {
        const r = store.addLabel(id, b.name as string);
        return ticketReply(r.created ? 201 : 200, r);
      }
      if (parts.length === 4 && parts[2] === "labels" && method === "DELETE") {
        return ticketReply(200, { ticket: store.removeLabel(id, parts[3]) });
      }
    }

    if (parts[0] === "batch" && parts.length === 1 && method === "POST") {
      return { status: 200, body: store.batch(b.ops as never) };
    }
    if (parts[0] === "export" && parts.length === 1 && method === "GET") {
      return { status: 200, body: store.export() };
    }

    // Execution records and lookup by key on the API (0.2.0), with the caller's own token: a principal sees its own
    // records only. The evidence namespace serves the same records to the evidence token (EvidenceReader.serve).
    if (parts[0] === "executions" && parts.length === 2 && method === "GET" && store.evidence && principal !== undefined) {
      const record = store.evidence.execution(parts[1]);
      if (!record || record.principal !== principal) throw new ApiError(404, "not_found", `no execution record ${parts[1]}`);
      return { status: 200, body: record };
    }
    if (parts[0] === "operations" && parts.length === 2 && method === "GET" && lookupOn && principal !== undefined) {
      // The key is in the path here, so with strict-input its format is checked as a header key would be.
      if (strictInput) ops.inputRules.checkKey(parts[1]);
      const record = store.evidence!.operation({ principal }, parts[1]);
      if (!record) throw new ApiError(404, "no_record", `${NO_RECORD}; ${NO_RECORD_NOTE}`, { key: parts[1] });
      return { status: 200, body: record };
    }
    throw new ApiError(404, "no_route", `no route for ${method} ${url.pathname}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, body === undefined ? headers : { "content-type": "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      if (options.extension && await options.extension.handle(req, res, new URL(req.url ?? "/", "http://backend.invalid"), store, { listener: "api" })) return;
      const principal = principalFor(req.headers.authorization, principals);
      if (principal === undefined) {
        throw new ApiError(401, "unauthorized", "missing or wrong bearer token");
      }
      store.checkRunning();
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://backend.invalid");
      const body = await readJson(req);
      const key = req.headers["idempotency-key"] as string | undefined;
      if (strictInput) {
        // Strict input (rule 10, rule 5): the key's format is checked here, not only by the MCP tool schema, because
        // other harnesses call this API directly; strings that are not well-formed are refused before anything is
        // stored, so every stored string can be encoded as UTF-8 and hashed the same way in any language.
        ops.inputRules.checkKey(key);
        ops.inputRules.checkStrings(body);
      } else if (executionRecords) {
        // An execution record serves canonical bytes of the request and the result: every string in them must encode.
        ops.inputRules.checkStrings(body);
      }
      if (!MUTATING.has(method)) {
        const reply = await route(method, url, req, body, undefined, principal);
        return send(reply.status, reply.body, reply.headers);
      }
      const keyed = key !== undefined && method === "POST";
      const fingerprint = keyed ? `${method} ${url.pathname} ${canonicalJson(body ?? null)}` : null;
      const meta: WriteMeta = {
        principal,
        attribution: { run: tag(req.headers[HEADERS.run.toLowerCase()]), operation: tag(req.headers[HEADERS.operation.toLowerCase()]) },
        // Only a keyed POST records its key: a key header on another write is ignored (no key record is made for it).
        request: { method, path: url.pathname, key: keyed ? key : null, fingerprint, fingerprintHash: requestHash(principal, method, url.pathname, body), body: body ?? null },
      };
      // The execution record a reply answers for: a commit's own, or on a replay the first write's.
      const executionHeader = (seq: number | undefined): Record<string, string> =>
        (executionRecords && seq !== undefined ? { [EXECUTION_HEADER.toLowerCase()]: executionId(seq) } : {});
      // A run tag the fixture layer gave another principal is refused: run tags are scoped per principal. With a run
      // registry wired, a tag it never allocated is refused too (run ids are random; a guessed or stale tag is not a run).
      const runTag = meta.attribution.run;
      if (runTag !== null && options.runOwner) {
        const owner = options.runOwner(runTag);
        if (owner === undefined) {
          store.refuse(meta, 403, "run_not_allocated");
          throw new ApiError(403, "run_not_allocated", `run ${runTag} was not allocated by this fixture`);
        }
        if (owner !== principal) {
          store.refuse(meta, 403, "run_not_owned");
          throw new ApiError(403, "run_not_owned", `run ${runTag} belongs to another principal`);
        }
      }
      /**
       * Every answer reaches the ledger (INTERFACES §1.1). A throw that is not an ApiError (recorded where it is
       * thrown), a JournalError (recorded as journal_unavailable) or a CommitSinkError (the store has stopped) would
       * otherwise answer 500 with nothing recorded: it is recorded here as a refusal, 500 internal.
       */
      const recordInternal = (e: unknown) => {
        if (e instanceof ApiError || e instanceof JournalError || e instanceof CommitSinkError) return;
        try {
          store.refuse(meta, 500, "internal");
        } catch {
          // A ledger that cannot record stops the store; the answer is the 500 either way.
        }
      };
      /**
       * Run reset during the awaits before the commit section (coordinator note 11, item 2). Without a pending-record
       * seam nothing fences a write that is held at BackendOps.beforePatch or the before-commit hook while its run is
       * reset, so the store counts the resets of each (principal, run): the count is read before the awaits and compared
       * after them, and a write whose run was reset meanwhile is refused 409 run_reset (recorded, nothing applied).
       */
      const resetsBefore = runTag === null ? 0 : store.resetCount(principal, runTag);
      const checkNotReset = () => {
        if (runTag === null || store.resetCount(principal, runTag) === resetsBefore) return;
        store.refuse(meta, 409, "run_reset");
        throw new ApiError(409, "run_reset", `run ${runTag} was reset while this request was waiting to commit; nothing was applied`);
      };
      /** Sends a committed reply, after the backend/after-commit fault hook. */
      const sendCommitted = async (reply: Reply, tx: CommittedTransaction | undefined) => {
        const outcome = tx && faults.afterCommit ? await faults.afterCommit({ meta, tx }) : undefined;
        if (outcome === "drop") return void res.destroy();
        if (outcome) return send(outcome.status, outcome.body);
        send(reply.status, reply.body, { ...reply.headers, ...executionHeader(tx?.kind === "write" ? tx.seq : reply.replayOf) });
      };
      if (keyed) {
        // A keyed POST is applied once. The same key with a different request is refused. From the last lookup to the
        // commit below nothing awaits, so no second request runs between them (rule 9).
        const scope = { principal };
        /**
         * The frozen branch order (seams v2.1; docs/INTERFACES.md 1.1), every branch told to the ledger:
         *   completed → replay (same fingerprint) or 422 idempotency_key_reused;
         *   pending   → 409 in_progress (outcome unknown, rule 4), a refusal in the ledger;
         *   fenced    → 409 key_fenced (its run was reset while it was pending), a refusal; nothing begins;
         *   expired   → the B10 answer: same fingerprint_hash → 410 key_expired as a replay of the tombstone's commit
         *               (idempotent-replayed: true, the execution id, no stored body); else 422 idempotency_key_reused;
         *   undefined → false: the caller begins the write.
         * Returns true when it answered.
         */
        const answerFromRecord = (found: KeyRecordState | undefined): boolean => {
          if (found === undefined) return false;
          if (found.state === "completed") {
            const seen = found.reply;
            if (seen.fingerprint !== fingerprint) {
              store.refuse(meta, 422, "idempotency_key_reused");
              throw new ApiError(422, "idempotency_key_reused", "this Idempotency-Key was already used for a different request");
            }
            store.replay(meta, seen.status, seen.body, seen.seq);
            send(seen.status, seen.body, { ...seen.headers, ...executionHeader(seen.seq), "idempotent-replayed": "true" });
            return true;
          }
          if (found.state === "pending") {
            store.refuse(meta, 409, "in_progress");
            throw new ApiError(409, "in_progress", "a request with this Idempotency-Key is still in progress; repeat it later with the same key", { since: found.since });
          }
          if (found.state === "fenced") throw fenced(found.run);
          const t = found.tombstone;
          if (t.fingerprintHash !== meta.request.fingerprintHash) {
            store.refuse(meta, 422, "idempotency_key_reused");
            throw new ApiError(422, "idempotency_key_reused", "this Idempotency-Key was already used for a different request (its record has expired)");
          }
          const expired = {
            error: "key_expired", message: "this key's write was applied; its stored answer has expired: read the object",
            execution_id: t.executionId, result_digest: t.resultDigest, committed_at: t.committedAt,
          };
          store.replay(meta, 410, expired, Number(t.executionId.slice(2)));
          send(410, expired, { ...executionHeader(Number(t.executionId.slice(2))), "idempotent-replayed": "true" });
          return true;
        };
        const fenced = (run: string) => {
          store.refuse(meta, 409, "key_fenced");
          return new ApiError(409, "key_fenced", `run ${run} was reset while a request with this Idempotency-Key was in progress; nothing was applied, and the key cannot be used again`);
        };
        const inflight = isInflight(ops.keyRecord) ? ops.keyRecord : undefined;
        let began = false;
        let committed = false;
        let hookFault = false;
        let result: { reply: Reply; tx?: CommittedTransaction };
        try {
          if (answerFromRecord(ops.keyRecord.get(scope, key))) return;
          // 0.3.0 (inflight): the pending record goes first; every way out that commits nothing aborts it.
          if (inflight) {
            try {
              inflight.begin(scope, key, fingerprint!, meta.attribution.run);
              // Only once begin returned: a begin that throws left no pending record of its own, and abort must not end
              // another request's record (coordinator note 11, item 3).
              began = true;
            } catch (e) {
              if (e instanceof ApiError) store.refuse(meta, e.status, e.code);
              else if (e instanceof JournalError) store.refuse(meta, 503, "journal_unavailable");
              throw e;
            }
          }
          if (faults.beforeCommit) {
            try {
              await faults.beforeCommit({ meta });
            } catch (e) {
              if (e instanceof ApiError) store.refuse(meta, e.status, e.code);
              hookFault = true;
              throw e;
            }
            // The hook awaited: a same-key request may have committed meanwhile (without a pending record).
            if (!inflight && answerFromRecord(ops.keyRecord.get(scope, key))) return;
          }
          // Re-check our own pending record after the await: the run reset fences its run's pending records, and a write
          // held while its run was reset never lands after it. The fence already ended the record: no abort for it.
          if (inflight) {
            const own = inflight.get(scope, key);
            if (own?.state === "fenced") {
              began = false;
              throw fenced(own.run);
            }
            if (own?.state !== "pending") throw new Error(`the pending record of this key ended without a commit (${own?.state ?? "none"})`);
          }
          // Without a pending record nothing fenced this write: refuse it if its run was reset during the awaits.
          checkNotReset();
          // Only a result below 300 is kept, and only once the journal has it: a refused first call stores nothing and
          // does not hold the key (decision 0004). A journal failure aborts the pending record too.
          result = store.commit(meta, () => route(method, url, req, body), (tx) => {
            committed = true;
            ops.keyRecord.put(scope, key, storedReplyOf(tx));
          });
        } catch (e) {
          recordInternal(e);
          if (began && !committed) {
            const reason: AbortReason = hookFault ? "fault" : e instanceof ApiError ? "refused" : e instanceof JournalError ? "journal_unavailable" : "internal_error";
            safeAbort(scope, key, reason);
            began = false;
          }
          throw e;
        }
        // Reached without a throw and without a commit: the section's reply was 300 or above (a refusal).
        if (began && !committed) safeAbort(scope, key, "refused");
        return await sendCommitted(result.reply, result.tx);
      }
      // The awaits a write may have come before its commit section: BackendOps.beforePatch, then the fault hook.
      const parts = url.pathname.split("/").filter(Boolean);
      let prepared: unknown;
      try {
        if (method === "PATCH" && parts[0] === "tickets" && parts.length === 2 && ops.beforePatch) {
          prepared = await ops.beforePatch(store, decodeURIComponent(parts[1]), (body ?? {}) as TicketFields, parseIfMatch(req.headers["if-match"] as string | undefined));
        }
        if (faults.beforeCommit) await faults.beforeCommit({ meta });
        checkNotReset();
      } catch (e) {
        if (e instanceof ApiError && e.code !== "run_reset") store.refuse(meta, e.status, e.code);
        recordInternal(e);
        throw e;
      }
      let committedWrite: { reply: Reply; tx?: CommittedTransaction };
      try {
        committedWrite = store.commit(meta, () => route(method, url, req, body, prepared));
      } catch (e) {
        recordInternal(e);
        throw e;
      }
      await sendCommitted(committedWrite.reply, committedWrite.tx);
    } catch (error) {
      if (error instanceof JournalError) {
        send(503, { error: "journal_unavailable", message: error.message });
      } else if (error instanceof CommitSinkError) {
        send(503, { error: "stopped", message: error.message });
      } else if (error instanceof ApiError) {
        send(error.status, { error: error.code, message: error.message, ...error.extra });
      } else {
        send(500, { error: "internal", message: "internal error" });
      }
    }
  }

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // Container mode: the evidence routes only, on the address given, behind the evidence token (the extension checks it).
  let evidenceServer: Server | undefined;
  let evidenceUrl: string | undefined;
  if (options.evidenceListen) {
    const extension = options.extension;
    if (!extension) throw new Error("an evidence listener needs the evidence namespace (feature evidence)");
    evidenceServer = createServer((req, res) => void (async () => {
      const notHere = () => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", message: "this listener serves the read-only evidence routes only, with the evidence token" }));
      };
      try {
        // The evidence namespace's loopback Host check guards a loopback listener against DNS rebinding. This listener
        // is reached through the container's published port, so it is guarded by the evidence token alone (owner
        // decision): the namespace is told the request came in here (listener "evidence"), and nothing but an
        // evidence route is served. The Host header is left as sent.
        if (!(await extension.handle(req, res, new URL(req.url ?? "/", "http://evidence.invalid"), store, { listener: "evidence" }))) notHere();
      } catch {
        if (!res.headersSent) notHere();
      }
    })());
    await new Promise<void>((resolve, reject) => {
      evidenceServer!.once("error", reject);
      evidenceServer!.listen(options.evidenceListen!.port, options.evidenceListen!.host, resolve);
    });
    const a = evidenceServer.address() as AddressInfo;
    evidenceUrl = `http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    evidence: store.evidence,
    ...(evidenceUrl ? { evidenceUrl } : {}),
    bootId: store.bootId,
    dropRun: (scope, run) => store.dropRun(scope, run),
    close: async () => {
      if (evidenceServer) {
        evidenceServer.closeAllConnections();
        await new Promise<void>((resolve) => evidenceServer!.close(() => resolve()));
      }
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
