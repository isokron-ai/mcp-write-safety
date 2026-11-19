// BACKEND DEFECT: lookup-wrong-record (fixture property FX-LOOK-1)
//
// A lookup by key returns the record of exactly that key.
//
// WRONG ON PURPOSE. Correct code: correctLookup in ../lookup.ts, which asks
// the key-record seam for exactly the key it was given, in the caller's scope.
//
// What goes wrong: the lookup matches keys by prefix (their first eight
// characters, the shortest key there is) and returns the most recent record
// that matches, as an index scan that stops at the first hit does. A caller
// whose keys share a run prefix (run-1234-op-1, run-1234-op-2) recovers the
// outcome of another write, with its execution id and digest.
//
// Mirrors: no published finding; the research plan's R2 defect list.

import type { BackendDefect } from "./index.js";
import type { CommittedTransaction } from "../commit.js";

export const lookupWrongRecord: BackendDefect = {
  name: "lookup-wrong-record",
  summary: "a lookup returns the most recent key record whose key shares the first eight characters with the key asked for",
  context: "FX-LOOK-1",
  seams: ["lookup"],
  requires: ["execution-records", "lookup"],
  apply(ops) {
    // The keys this backend committed, newest last (an observer of the commit point, through BackendOps.observers; it never changes a write).
    const keys: string[] = [];
    (ops.observers ??= []).push({ name: "lookup-wrong-record-index", role: "observer", onCommit(tx: CommittedTransaction) {
      if (tx.request !== null && tx.request.key !== null && tx.request.method === "POST") keys.push(tx.request.key);
    } });
    // Scoping is left to the lookup in place, so this composes with another lookup defect.
    const inner = ops.lookup;
    ops.lookup = {
      find(scope, key) {
        // DEFECT: a prefix match, newest first.
        for (let i = keys.length - 1; i >= 0; i--) {
          if (keys[i].slice(0, 8) !== key.slice(0, 8)) continue;
          const hit = inner.find(scope, keys[i]);
          if (hit) return hit;
        }
        return undefined;
      },
    };
  },
};
