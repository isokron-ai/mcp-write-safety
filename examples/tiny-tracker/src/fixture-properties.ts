// Fixture properties and the names on the wire.
//
// This is the only file that spells FX- IDs (fixture properties) and LRT-
// references (the shared lost-response test contract). MWS requirement IDs
// stay in src/requirements.ts. FX- properties are claims about this fixture,
// not requirements of the MCP Write-Safety Requirements: a fixture defect trips
// an FX- property and, where listed, an MWS requirement as well.

export interface FixtureProperty {
  title: string;
  /** The release whose correct build first holds it. */
  since: string;
}

export const FIXTURE_PROPERTIES = {
  "FX-DIG-1": { since: "0.2.0", title: "An execution record's digest is over the result as committed, not the object's current state" },
  "FX-DIG-2": { since: "0.2.0", title: "A replay serves the same execution record id, canonical bytes and digest as the first answer" },
  "FX-DIG-3": { since: "0.2.0", title: "The served digest is SHA-256 over the domain tag and the served canonical bytes (RFC 8785)" },
  "FX-LOOK-1": { since: "0.2.0", title: "A lookup by key returns the record of exactly that key" },
  "FX-LOOK-2": { since: "0.2.0", title: "A lookup never executes or repeats a write" },
  "FX-LOOK-3": { since: "0.2.0", title: "A lookup by key returns only the caller's own principal's records" },
  "FX-LOOK-4": { since: "0.3.0", title: "An outcome settled by lookup is reported settled, not unknown" },
  "FX-DUR-1": { since: "0.3.0", title: "Key records survive a whole-stack restart" },
  "FX-DUR-2": { since: "0.3.0", title: "The effect and its key record are committed in one journal line" },
  "FX-DUR-3": { since: "0.3.0", title: "No answer is sent before its journal line is flushed" },
  "FX-KEY-1": { since: "0.3.0", title: "A key is remembered for at least the stated retention" },
  "FX-KEY-2": { since: "0.3.0", title: "Every key-accepting tool states the key retention" },
  "FX-KEY-3": { since: "0.3.0", title: "A same-key call during a pending one never answers success without a committed record" },
  "FX-FLT-1": { since: "0.2.0", title: "A fault fires only at its named point, and the ledger records its arming and firing" },
  "FX-BLD-1": { since: "0.2.0", title: "The build descriptor names every active feature, defect (both layers), variant and armed fault" },
} as const satisfies Record<string, FixtureProperty>;

export type FixturePropertyId = keyof typeof FIXTURE_PROPERTIES;

/** The shared lost-response test contract: the commit its references are pinned to. A draft under joint review. */
export const CONTRACT = {
  repo: "zambodotdev/lost-response-test-contract",
  commit: "92bf1ba",
  status: "draft, under joint review; runs before it freezes are historical baselines and are repeated after the freeze",
} as const;

export const LRT_ASSERTIONS = {
  "LRT-A1": "An identical retry (K, A) after a lost response gives an external effect count of exactly 1",
  "LRT-A2": "A retry (K, A') with one changed parameter makes no new effect and is refused as a binding mismatch",
  "LRT-A3": "Recovery holding only K returns the original outcome, with a digest equal to the committed result's digest",
  "LRT-A4": "Every retry resolves to an explicit response class, never a silent or generic success",
  "LRT-A5": "A3 repeated after the agreed delay",
} as const;

export type LrtAssertionId = keyof typeof LRT_ASSERTIONS;

/** Namespaced names on the wire (owner decision 11). */
export const META_PREFIX = "dev.writesafety.tiny-tracker";

export const META_KEYS = {
  /** The idempotency key carried in request _meta (the _meta key carrier; teaching roadmap R18). */
  idempotencyKey: `${META_PREFIX}/idempotency-key`,
  /** A fixture-allocated run id, carried in request _meta (rule 3). */
  run: `${META_PREFIX}/run`,
  /** The caller's own operation tag, carried in request _meta (rule 3). */
  operation: `${META_PREFIX}/operation`,
  /** The build descriptor's hashes, in every tool result's _meta when the descriptor is mirrored (rule 6). */
  build: `${META_PREFIX}/build`,
} as const;

/** HTTP header names, all `Tiny-Tracker-*`. Node lower-cases header names on receipt. */
export const HEADERS = {
  run: "Tiny-Tracker-Run",
  operation: "Tiny-Tracker-Operation",
  build: "Tiny-Tracker-Build",
  readOnly: "Tiny-Tracker-Read-Only",
  tools: "Tiny-Tracker-Tools",
  denyTools: "Tiny-Tracker-Deny-Tools",
} as const;

/** A run or operation tag: the same characters as an idempotency key, 1 to 128 of them. */
export const TAG_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
