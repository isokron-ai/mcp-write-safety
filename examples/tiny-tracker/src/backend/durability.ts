// The 0.3.0 durability features, wired into the backend in one place:
//
//   durable    the JSONL journal (src/backend/journal.ts) as the commit path's
//              journal sink, replayed at start; the data-dir lock
//   inflight   pending key records (the keyed path calls begin and abort, seams
//              v2); a same-key call meanwhile answers 409 in_progress; the fence
//              route for settle-by-lookup
//   retention  the stated key retention with the refuse (tombstone) or forget
//              policy (src/backend/expiry.ts)
//
// The keyed path in src/backend/http.ts answers each key state in the frozen
// order of seams v2.1 (completed, pending, fenced, expired, undefined); this
// module supplies the states, the journal and the fence route.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { KeyRecordSeam } from "./seams.js";
import type { Store } from "./store.js";
import type { CommittedTransaction } from "./commit.js";
import { DurableKeyRecords, fingerprintHashOf, type KeptReply } from "./keyrecords.js";
import { Journal, type CrashHook, type JournalRun } from "./journal.js";
import { keyExpiry, DEFAULT_RETENTION_MS, type ExpiryPolicy } from "./expiry.js";
import { PACKAGE_VERSION } from "../profile.js";
import { KEY_PATTERN } from "./input.js";

export const DURABILITY_FEATURES = ["durable", "inflight", "retention"] as const;

/** Backend defects acted on here (registered in src/backend/defects/; they replace the journal and keyExpiry seams). */
export const DURABILITY_DEFECTS = ["key-record-not-durable", "key-record-after-effect", "key-expires-early"] as const;

/** Under key-record-after-effect: the key records, in a second file written after each write is applied. */
export const AFTER_EFFECT_FILE = "keys-after-effect.jsonl";

export interface DurabilityOptions {
  /** Active features; only durable, inflight and retention are read. */
  features: readonly string[];
  /** The data dir (feature durable). */
  dataDir?: string;
  retentionMs?: number;
  policy?: ExpiryPolicy;
  /** Backend defects named for this backend (the ones in DURABILITY_DEFECTS act here). */
  defects?: readonly string[];
  /** Crash points on the journal's write path (tests). */
  crash?: CrashHook;
  /** The platform the journal's rules follow (default process.platform; tests). */
  platform?: string;
  log?: (message: string) => void;
  /**
   * The fixture layer's run registry (seams v2.1). Under durable its run-alloc lines go back into it at load, and its
   * onAllocate journals each new run (chained before any onAllocate already set). Hand it over before the control
   * listener can allocate.
   */
  runs?: { restore(run: JournalRun): void; onAllocate: ((run: JournalRun) => void) | undefined };
  /**
   * The point backend/after-effect-before-key (G2 fold-in 11): called with the commit sequence of a keyed write after it
   * is journalled and applied, before its key record is kept. A supervised backend child's crash check; it may exit.
   */
  afterEffect?: (seq: number) => void;
  /** Told each commit the journal replays at load (the execution records). Set by startBackend. */
  replayObservers?: Array<(tx: CommittedTransaction) => void>;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface Durability {
  keys: DurableKeyRecords;
  /** The seam the keyed path uses: the key records themselves under inflight, else a view without begin/abort. */
  seam: KeyRecordSeam;
  journal?: Journal;
  features: { durable: boolean; inflight: boolean; retention: boolean };
  retentionMs: number;
  /** Routes this module serves (POST /operations/:key/fence), or undefined. */
  route(method: string, parts: string[], principal: string, run: string | null, body: unknown): Reply | undefined;
  close(): void;
}

export function openDurability(store: Store, options: DurabilityOptions): Durability {
  const has = (f: string) => options.features.includes(f);
  const features = { durable: has("durable"), inflight: has("inflight"), retention: has("retention") };
  const defects = options.defects ?? [];
  const retentionMs = Math.max(1, Math.floor((options.retentionMs ?? DEFAULT_RETENTION_MS) / (defects.includes("key-expires-early") ? 1000 : 1)));
  const keys = new DurableKeyRecords({ clock: store.clock, expiry: features.retention ? keyExpiry(retentionMs) : undefined, policy: options.policy });
  keys.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
  if (options.afterEffect) {
    const hook = options.afterEffect;
    keys.beforeKeep = (reply) => hook(reply.seq);
  }
  let journal: Journal | undefined;
  if (features.durable) {
    if (!options.dataDir) throw new Error("the durable feature needs --data-dir");
    journal = new Journal(store, keys, { dataDir: options.dataDir, writer: PACKAGE_VERSION, crash: options.crash, log: options.log, ...(options.platform ? { platform: options.platform } : {}) });
    if (defects.includes("key-record-not-durable") || defects.includes("key-record-after-effect")) journal.keyFromCommitLine = false;
    if (features.inflight) keys.lines = journal;
    journal.replayObservers = options.replayObservers ?? [];
    if (options.runs) journal.runs = options.runs;
    journal.load();
    if (options.runs) {
      // Seams v2.1: a run allocation is journalled before it is registered or answered (run-alloc line).
      const runs = options.runs;
      const next = runs.onAllocate;
      const j = journal;
      runs.onAllocate = (run) => {
        j.recordRun(run);
        next?.(run);
      };
    }
    if (defects.includes("key-record-after-effect")) {
      // DEFECT (key-record-after-effect): key records live in a second file, written after the effect is applied.
      const file = join(options.dataDir, AFTER_EFFECT_FILE);
      if (existsSync(file)) {
        for (const text of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
          try {
            const r = JSON.parse(text) as { principal: string; key: string; reply: KeptReply };
            keys.restore({ principal: r.principal }, r.key, { state: "completed", reply: r.reply });
          } catch {
            // a torn last line
          }
        }
      }
      keys.afterPut = (scope, key, reply) => {
        options.crash?.("before-append", { jseq: -1, line: "commit", key });
        const fd = openSync(file, "a", 0o600);
        try {
          writeSync(fd, `${JSON.stringify({ principal: scope.principal, key, reply })}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      };
    }
    store.addSink(journal);
  }
  store.addSink(keys.objectsSink());

  // Without inflight there is no pending state: the keyed path sees a seam with no begin/abort (and re-checks its run
  // after an awaiting fault hook, as in 0.2.0).
  const seam: KeyRecordSeam = features.inflight ? keys : { get: (s, k) => keys.get(s, k), put: (s, k, r) => keys.put(s, k, r), dropRun: (s, r) => keys.dropRun(s, r) };
  return {
    keys, seam, journal, features, retentionMs,
    route(method, parts, principal, run, body): Reply | undefined {
      if (!features.inflight || method !== "POST" || parts.length !== 3 || parts[0] !== "operations" || parts[2] !== "fence") return undefined;
      const key = parts[1];
      if (!KEY_PATTERN.test(key)) return { status: 400, body: { error: "bad_idempotency_key", message: "the key must be 8 to 128 characters from A-Z a-z 0-9 . _ : -" } };
      // G2 fold-in 2: under the forget policy a missing record may be a forgotten applied write, so a miss is never
      // fenced (nobody can tell the two apart; the outcome stays open). CMP-55 refuses settle-by-lookup with forget
      // where it sees both; this covers a backend started apart from its MCP server.
      const forgets = features.retention && keys.policy === "forget";
      const write = (body as { fence?: unknown } | null | undefined)?.fence !== false && !forgets;
      let s;
      try {
        s = keys.fence({ principal }, key, run, write);
      } catch (e) {
        // The lookup-fence line could not be written: no fence, and the caller is not told the key is closed.
        return { status: 503, body: { error: "journal_unavailable", message: `the fence could not be recorded: ${(e as Error).message}; nothing was fenced` } };
      }
      if (!s && forgets) {
        return { status: 404, body: { error: "no_record", key, state: "unknown", fenced: false, message: "no record of this key now; under the forget key-expiry policy it may have been forgotten, so the key was not fenced and the outcome stays open" } };
      }
      if (!s) return { status: 404, body: { error: "no_record", key, state: "none", message: "no record of this key now" } };
      switch (s.state) {
        case "pending":
          return { status: 409, headers: { "retry-after": "1" }, body: { error: "in_progress", key, state: "pending", message: "a request with this key is still being applied" } };
        case "completed":
          // principal and fingerprint_hash (G2 fold-in 1): the caller compares the request the key was used for with its
          // own, so a lookup never settles another write as this one.
          return { status: 200, body: { key, state: "completed", principal, fingerprint_hash: fingerprintHashOf(principal, s.reply.fingerprint), execution_id: `X-${s.reply.seq}`, status: s.reply.status, body: s.reply.body, committed_at: s.reply.committedAt } };
        case "tombstone":
          return { status: 200, body: { key, state: "expired", principal, fingerprint_hash: s.tomb.fingerprintHash, execution_id: s.tomb.executionId, result_digest: s.tomb.resultDigest, committed_at: s.tomb.committedAt, objects: s.tomb.objects } };
        case "fenced":
          return { status: 200, body: { key, state: "fenced", fenced_at: s.at } };
      }
    },
    close() {
      journal?.close();
    },
  };
}
