// BACKEND DEFECT: digest-not-canonical (fixture property FX-DIG-3)
//
// The served digest is SHA-256 over the domain tag and the served canonical
// bytes (RFC 8785).
//
// WRONG ON PURPOSE. Correct code: correctDigest in ../execution.ts, which
// serializes with canonicalize (src/digest.ts): members sorted by UTF-16 code
// units, RFC 8785 number and string forms.
//
// What goes wrong: the seam serializes with JSON.stringify, in the order the
// members were inserted into the committed body, and serves those bytes as
// "canonical". The digest is
// over the served bytes, so it recomputes; but the bytes are not RFC 8785, so a
// verifier that canonicalizes the parsed result (or another implementation that
// produced the same result) gets other bytes and another digest.
//
// Mirrors: no published finding; the research plan's R1 defect list, and the
// review's probe of a naive canonicalizer (G2).

import type { BackendDefect } from "./index.js";
import { DIGEST_ALG, domainDigest } from "../../digest.js";

/** `value` with its members in the order `template` has them (then any others): JSON.stringify then writes that order. */
function orderLike(value: unknown, template: unknown): unknown {
  if (Array.isArray(value)) return value.map((v, i) => orderLike(v, Array.isArray(template) ? template[i] : undefined));
  if (value === null || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const t = (template !== null && typeof template === "object" && !Array.isArray(template) ? template : {}) as Record<string, unknown>;
  const names = [...Object.keys(t).filter((k) => k in v), ...Object.keys(v).filter((k) => !(k in t))];
  return Object.fromEntries(names.map((k) => [k, orderLike(v[k], t[k])]));
}

export const digestNotCanonical: BackendDefect = {
  name: "digest-not-canonical",
  summary: "the served bytes are insertion-ordered JSON, not RFC 8785, so recomputing the canonical form gives another digest",
  context: "FX-DIG-3",
  seams: ["digest"],
  requires: ["execution-records"],
  apply(ops) {
    // It changes how the value the seam in place chose is written, so it composes with another digest defect.
    const inner = ops.digest;
    ops.digest = {
      resultDigest(body) {
        const served = inner.resultDigest(body);
        // DEFECT: member order as inserted, not sorted.
        const canonical = JSON.stringify(orderLike(JSON.parse(served.canonical), body ?? null));
        return { alg: DIGEST_ALG, domain: served.domain, canonical, digest: domainDigest(served.domain, canonical) };
      },
    };
  },
};
