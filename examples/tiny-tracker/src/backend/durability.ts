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
// The keyed path in src/backend/http.ts asks `screen` before it looks for a
// stored answer; the commit section itself is unchanged.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { KeyRecordSeam, KeyScope } from "./seams.js";
import type { Store } from "./store.js";
import type { TxMeta } from "./commit.js";
import { DurableKeyRecords, type KeptReply, type Tombstone } from "./keyrecords.js";
import { Journal, type CrashHook } from "./journal.js";
import { describeRetention, keyExpiry, DEFAULT_RETENTION_MS, type ExpiryPolicy } from "./expiry.js";
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
  log?: (message: string) => void;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface Durability {
  keys: DurableKeyRecords;
  /** The seam the keyed path uses: the key records themselves under inflight, else a view without begin/abort. */
  seam: KeyRecordSeam;
  journal?: Journal;
  features: { durable: boolean; inflight: boolean; retention: boolean };
  retentionMs: number;
  /** A keyed request's early answer from its key's state, or undefined to go on (decision 0004's table). */
  screen(store: Store, meta: TxMeta, scope: KeyScope, key: string, fingerprint: string): Reply | undefined;
  /** Routes this module serves (POST /operations/:key/fence), or undefined. */
  route(method: string, parts: string[], principal: string, run: string | null, body: unknown): Reply | undefined;
  close(): void;
}

function expiredBody(tomb: Tombstone, retentionMs: number) {
  return {
    error: "key_expired",
    outcome: "applied",
    message: `the write with this Idempotency-Key was applied (${tomb.executionId}), but its stored answer is gone: keys are remembered for ${describeRetention(retentionMs)}. Nothing new was written; read the object.`,
    execution_id: tomb.executionId,
    result_digest: tomb.resultDigest,
    committed_at: tomb.committedAt,
    objects: tomb.objects,
  };
}

export function openDurability(store: Store, options: DurabilityOptions): Durability {
  const has = (f: string) => options.features.includes(f);
  const features = { durable: has("durable"), inflight: has("inflight"), retention: has("retention") };
  const defects = options.defects ?? [];
  const retentionMs = Math.max(1, Math.floor((options.retentionMs ?? DEFAULT_RETENTION_MS) / (defects.includes("key-expires-early") ? 1000 : 1)));
  const keys = new DurableKeyRecords({ clock: store.clock, expiry: features.retention ? keyExpiry(retentionMs) : undefined, policy: options.policy });
  let journal: Journal | undefined;
  if (features.durable) {
    if (!options.dataDir) throw new Error("the durable feature needs --data-dir");
    journal = new Journal(store, keys, { dataDir: options.dataDir, writer: PACKAGE_VERSION, crash: options.crash, log: options.log });
    if (defects.includes("key-record-not-durable") || defects.includes("key-record-after-effect")) journal.keyFromCommitLine = false;
    if (features.inflight) keys.lines = journal;
    journal.load();
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

  // Without inflight there is no pending state: the keyed path sees a seam with no begin/abort (and looks the key up
  // again after an awaiting fault hook, as in 0.2.0).
  const seam: KeyRecordSeam = features.inflight ? keys : { get: (s, k) => keys.get(s, k), put: (s, k, r) => keys.put(s, k, r), dropRun: (s, r) => keys.dropRun(s, r) };
  return {
    keys, seam, journal, features, retentionMs,
    screen(store, meta, scope, key, fingerprint): Reply | undefined {
      const s = keys.screen(scope, key, fingerprint);
      switch (s.kind) {
        case "proceed":
          return undefined;
        case "in_progress":
          store.refuse(meta, 409, "in_progress");
          return { status: 409, headers: { "retry-after": "1" }, body: { error: "in_progress", message: "a request with this Idempotency-Key is still being applied; repeat it later with the same key to get its result" } };
        case "reused":
          store.refuse(meta, 422, "idempotency_key_reused");
          return { status: 422, body: { error: "idempotency_key_reused", message: "this Idempotency-Key was already used for a different request" } };
        case "fenced":
          store.refuse(meta, 409, "key_fenced");
          return { status: 409, body: { error: "key_fenced", message: "this Idempotency-Key was closed by a lookup that found no write with it; nothing was written. Use a new key.", fenced_at: s.at } };
        case "expired": {
          const body = expiredBody(s.tomb, retentionMs);
          store.replay(meta, 409, body, s.tomb.seq);
          return { status: 409, body, headers: { "idempotent-replayed": "true" } };
        }
      }
    },
    route(method, parts, principal, run, body): Reply | undefined {
      if (!features.inflight || method !== "POST" || parts.length !== 3 || parts[0] !== "operations" || parts[2] !== "fence") return undefined;
      const key = parts[1];
      if (!KEY_PATTERN.test(key)) return { status: 400, body: { error: "bad_idempotency_key", message: "the key must be 8 to 128 characters from A-Z a-z 0-9 . _ : -" } };
      const write = (body as { fence?: unknown } | null | undefined)?.fence !== false;
      const s = keys.fence({ principal }, key, run, write);
      if (!s) return { status: 404, body: { error: "no_record", key, state: "none", message: "no record of this key now" } };
      switch (s.state) {
        case "pending":
          return { status: 409, headers: { "retry-after": "1" }, body: { error: "in_progress", key, state: "pending", message: "a request with this key is still being applied" } };
        case "completed":
          return { status: 200, body: { key, state: "completed", execution_id: `X-${s.reply.seq}`, status: s.reply.status, body: s.reply.body, committed_at: s.reply.committedAt } };
        case "tombstone":
          return { status: 200, body: { key, state: "expired", execution_id: s.tomb.executionId, result_digest: s.tomb.resultDigest, committed_at: s.tomb.committedAt, objects: s.tomb.objects } };
        case "fenced":
          return { status: 200, body: { key, state: "fenced", fenced_at: s.at } };
      }
    },
    close() {
      journal?.close();
    },
  };
}
