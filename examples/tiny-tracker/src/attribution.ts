// Attribution outside the handlers (design rule 3, review B5).
//
// A harness tags a tools/call with a run id and its own operation tag in the
// request _meta. The server.ts wrapper reads them before any handler runs and
// holds them in AsyncLocalStorage; TrackerApi.request stamps them on every
// backend request as Tiny-Tracker-Run and Tiny-Tracker-Operation. No handler
// and no defect sits on that path, so every backend request a call makes is
// tagged, whatever the handler does with the key: the ledger (0.2.0) counts
// effects by these tags, never by what the code under test chose to send.
//
// Off unless the fixture asks for it (feature evidence in this version), so
// the 0.1 surface sends exactly the requests it always sent.

import { AsyncLocalStorage } from "node:async_hooks";
import { HEADERS, META_KEYS, TAG_PATTERN } from "./fixture-properties.js";

export interface Attribution {
  run?: string;
  operation?: string;
}

const storage = new AsyncLocalStorage<Attribution>();

/** Reads the tags from a request's _meta. A tag that is not a string in the tag format is left out, never forwarded. */
export function attributionFromMeta(meta: unknown): Attribution {
  const m = (meta ?? {}) as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && TAG_PATTERN.test(v) ? v : undefined);
  const out: Attribution = {};
  const run = pick(m[META_KEYS.run]);
  const operation = pick(m[META_KEYS.operation]);
  if (run !== undefined) out.run = run;
  if (operation !== undefined) out.operation = operation;
  return out;
}

export function runWithAttribution<T>(a: Attribution, fn: () => T): T {
  return storage.run(a, fn);
}

/** The headers for the current call's tags (empty outside a tagged call). Lower-case, as node:http delivers them. */
export function attributionHeaders(): Record<string, string> {
  const a = storage.getStore();
  if (!a) return {};
  const out: Record<string, string> = {};
  if (a.run !== undefined) out[HEADERS.run.toLowerCase()] = a.run;
  if (a.operation !== undefined) out[HEADERS.operation.toLowerCase()] = a.operation;
  return out;
}
