// BACKEND DEFECT: lookup-unscoped (fixture property FX-LOOK-3)
//
// A lookup by key returns only the caller's own principal's records.
//
// WRONG ON PURPOSE. Correct code: correctLookup in ../lookup.ts, which looks
// the key up in the caller's scope only (docs/INTERFACES.md, D5).
//
// What goes wrong: the lookup ignores the principal. It returns the most
// recent record of the key whoever made it, so a caller holding (or guessing)
// another principal's key reads that principal's outcome, its objects and its
// committed result. Keyed writes stay scoped (a repeat by another principal
// still applies on its own); only the lookup crosses scopes, which is why the
// defect shows only with two principals.
//
// Mirrors: no published finding; the research plan's R2 defect list, and the
// IETF draft's section 5 (an idempotency key is no access token).

import type { BackendDefect } from "./index.js";
import type { CommittedTransaction } from "../commit.js";

export const lookupUnscoped: BackendDefect = {
  name: "lookup-unscoped",
  summary: "a lookup returns the most recent record of the key from any principal, not only the caller's",
  context: "FX-LOOK-3",
  seams: ["lookup"],
  requires: ["execution-records", "lookup", "principals"],
  apply(ops) {
    // The principals that committed each key, newest last (an observer of the commit point, through BackendOps.observers; it never changes a write).
    const keys: Array<{ principal: string; key: string }> = [];
    (ops.observers ??= []).push({ name: "lookup-unscoped-index", role: "observer", onCommit(tx: CommittedTransaction) {
      if (tx.request !== null && tx.request.key !== null && tx.request.method === "POST") keys.push({ principal: tx.principal, key: tx.request.key });
    } });
    // Matching is left to the lookup in place, so this composes with another lookup defect.
    const inner = ops.lookup;
    ops.lookup = {
      find(scope, key) {
        // DEFECT: the record of this key in the scope of whichever principal wrote last, the caller's own only if no other has one.
        const scopes = [...new Set([...keys].reverse().map((k) => k.principal))];
        for (const principal of scopes) {
          const hit = inner.find({ principal }, key);
          if (hit) return hit;
        }
        return inner.find(scope, key);
      },
    };
  },
};
