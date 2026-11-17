// The compatibility table (review G4): which combinations of profile,
// features, defects, variants, faults and process layout may start. Anything
// the table refuses stops the process with exit 2 and the rule's message.
//
// Profile 0.1 keeps the 0.1.0 command line exactly: a rule marked `post01`
// does not apply to it, so nothing the published 0.1.0 accepted is refused
// under --profile 0.1. Tests cover the table pairwise (test/compat.test.ts),
// not as the full product of every factor.

import { BUILT_FAULT_POINTS, faultPoint, FAULT_DEMOS, RETIRED_FAULT_NAMES } from "./fault-points.js";
import { effectiveFeatures, featureInfo, type FeatureName, type ProfileName } from "./profile.js";

export type ProcessLayout = "all" | "backend" | "server";

/** One requested combination, as the command line and environment give it. */
export interface Combination {
  layout: ProcessLayout;
  profile: ProfileName;
  /** Features named with --features or TRACKER_FEATURES (not the profile's own; checkCompat adds those). */
  features: readonly string[];
  /** MCP-layer defects as resolved (names). */
  defects: readonly string[];
  backendDefects: readonly string[];
  variants: readonly string[];
  /** Faults armed at start, as point ids or demonstration names. None can be armed in this version. */
  faults: readonly string[];
  fixtureControl: boolean;
  dataDir?: string;
  /** `tiny-tracker all --supervise` (0.3.0): the backend and the MCP server as two restartable children. */
  supervise?: boolean;
  /** --key-expiry or TRACKER_KEY_EXPIRY as given (0.3.0, feature retention): refuse (the default) or forget. */
  keyExpiry?: string;
}

/**
 * What a rule sees: `features` is the effective set (the profile's own features plus the named ones), so a rule
 * still refuses after a release flips a feature into the default profile; `named` is the set as named.
 */
export interface EffectiveCombination extends Combination {
  named: readonly string[];
}

export interface CompatRule {
  id: string;
  /** False: applies under every profile. True: not under profile 0.1, so that profile keeps the 0.1.0 command line. */
  post01: boolean;
  /** The message when the combination breaks the rule, or undefined when it does not. */
  check(c: EffectiveCombination): string | undefined;
}

const has = (list: readonly string[], name: string) => list.includes(name);

export const COMPAT_RULES: readonly CompatRule[] = [
  {
    id: "CMP-1", post01: false,
    check: (c) => c.profile === "0.1" && c.named.length > 0
      ? `profile 0.1 is the 0.1.0 surface and takes no features (named: ${c.named.join(", ")})` : undefined,
  },
  {
    id: "CMP-2", post01: false,
    check: (c) => c.profile === "0.1" && c.fixtureControl ? "profile 0.1 takes no --fixture-control" : undefined,
  },
  {
    id: "CMP-3", post01: false,
    check: (c) => {
      const unbuilt = c.features.filter((f) => featureInfo(f) && !featureInfo(f)!.built);
      return unbuilt.length ? `not built in this version: ${unbuilt.map((f) => `${f} (arrives in ${featureInfo(f)!.since})`).join(", ")}` : undefined;
    },
  },
  {
    id: "CMP-4", post01: false,
    check: (c) => has(c.features, "durable") && !c.dataDir ? "the durable feature needs --data-dir (an empty directory, or one this server created)" : undefined,
  },
  {
    id: "CMP-5", post01: false,
    check: (c) => has(c.variants, "key-store-honest") && has(c.features, "lookup")
      ? "the key-store-honest variant keeps keys in the MCP server, so a backend lookup by key cannot see them; do not combine it with the lookup feature"
      : undefined,
  },
  {
    id: "CMP-6", post01: false,
    check: (c) => {
      for (const f of c.faults) {
        if (RETIRED_FAULT_NAMES[f]) return `fault "${f}" is named by point now: ${RETIRED_FAULT_NAMES[f]}`;
        const demo = FAULT_DEMOS[f];
        if (demo) {
          const active = [...c.defects.map((d) => `defect:${d}`), ...c.variants.map((v) => `variant:${v}`), ...c.features.map((x) => `feature:${x}`)];
          if (!demo.needsOneOf.some((n) => active.includes(n))) return `fault "${f}" is meaningful only with one of ${demo.needsOneOf.join(", ")}: ${demo.note}`;
          continue;
        }
        if (!faultPoint(f)) return `unknown fault point "${f}"`;
      }
      return undefined;
    },
  },
  {
    id: "CMP-7", post01: false,
    // Narrowed by stream B (0.2.0): a fault armed at start needs the faults feature and a point this build can arm.
    check: (c) => {
      if (c.faults.length === 0) return undefined;
      if (!has(c.features, "faults")) return "a fault armed at start needs the faults feature";
      for (const f of c.faults) {
        const p = faultPoint(f);
        if (p && !BUILT_FAULT_POINTS.includes(p.id)) return p.since === null ? `fault point ${p.id} is not planned for any release` : `fault point ${p.id} arrives in ${p.since}; this build cannot arm it`;
        const demo = FAULT_DEMOS[f];
        if (demo) return `fault demonstration "${f}" arrives in ${demo.since}; this build cannot arm it`;
      }
      return undefined;
    },
  },
  {
    id: "CMP-8", post01: true,
    check: (c) => c.fixtureControl && c.layout !== "all"
      ? "--fixture-control runs with `tiny-tracker all` only in this version (one process holds both layers)" : undefined,
  },
  {
    id: "CMP-9", post01: true,
    check: (c) => c.backendDefects.length > 0 && c.layout === "server"
      ? "--backend-defect has no effect in `tiny-tracker server` (the backend is another process); start the backend with it" : undefined,
  },
  {
    id: "CMP-11", post01: true,
    check: (c) => has(c.features, "evidence") && c.layout !== "all"
      ? "the evidence feature runs with `tiny-tracker all` only in this version (the build descriptor must cover both layers)" : undefined,
  },
  {
    id: "CMP-10", post01: true,
    check: (c) => has(c.features, "strict-input") && c.layout === "server"
      ? "strict-input is a backend feature; name it where the backend runs (`all` or `backend`)" : undefined,
  },
  // ---- stream A (CMP-20 to CMP-29) ----
  {
    id: "CMP-20", post01: false,
    check: (c) => has(c.features, "lookup") && !has(c.features, "execution-records")
      ? "the lookup feature needs execution-records (an operation record names the execution record of its write); name both" : undefined,
  },
  {
    // The named set: from 0.2.0 the default profile has principals, and a `server` start must not be refused for it.
    id: "CMP-21", post01: true,
    check: (c) => has(c.named, "principals") && c.layout === "server"
      ? "principals is a backend feature; name it where the backend runs (`all` or `backend`)" : undefined,
  },
  // ---- stream B (CMP-30 to CMP-39) ----
  {
    id: "CMP-30", post01: true,
    check: (c) => has(c.features, "ledger") && !has(c.features, "evidence")
      ? "the ledger feature needs the evidence feature (the ledger is read at GET /ledger in the evidence namespace)" : undefined,
  },
  {
    id: "CMP-31", post01: true,
    check: (c) => has(c.features, "ledger") && !has(c.features, "strict-input")
      ? "the ledger feature needs strict-input (the ledger hashes every request; strict-input refuses keys and strings that cannot be hashed the same way in every language)"
      : undefined,
  },
  {
    id: "CMP-32", post01: true,
    check: (c) => has(c.features, "faults") && !has(c.features, "ledger")
      ? "the faults feature needs the ledger feature (every fault arming and firing is a ledger entry)" : undefined,
  },
  {
    id: "CMP-33", post01: true,
    check: (c) => has(c.features, "faults") && !c.fixtureControl
      ? "the faults feature needs --fixture-control (faults are armed on the control listener only, never on the command line)" : undefined,
  },
  // ---- stream E (CMP-60 to CMP-69): the fixture clock and the supervisor ----
  {
    id: "CMP-60", post01: false,
    check: (c) => has(c.features, "clock") && !c.fixtureControl
      ? "the clock feature needs --fixture-control: the fixture clock moves only through the control listener (without both, the clock is wall time)" : undefined,
  },
  {
    id: "CMP-61", post01: false,
    check: (c) => c.profile === "0.1" && c.supervise ? "profile 0.1 takes no --supervise" : undefined,
  },
  {
    id: "CMP-62", post01: true,
    check: (c) => c.supervise && c.layout !== "all"
      ? "--supervise runs with `tiny-tracker all` only: it starts the backend and the MCP server as two children" : undefined,
  },
  {
    id: "CMP-63", post01: false,
    check: (c) => {
      const crash = c.faults.filter((f) => faultPoint(f)?.action === "crash");
      return crash.length && !c.supervise
        ? `crash fault point(s) ${crash.join(", ")} need tiny-tracker all --supervise: in one process a crash stops both layers and nothing restarts them` : undefined;
    },
  },
  {
    // 0.3.0 integration: under --supervise the supervisor arms --fault points in its state folder, which only the crash
    // checks read; the other points are armed on the control listener in the child that runs them.
    id: "CMP-64", post01: false,
    check: (c) => {
      const other = c.supervise ? c.faults.filter((f) => faultPoint(f)?.action !== "crash") : [];
      return other.length ? `under --supervise, --fault names crash points only; arm ${other.join(", ")} on the control listener` : undefined;
    },
  },
];

/** The rules a combination breaks, as messages. Empty: it may start. */
export function checkCompat(c: Combination): string[] {
  const known = c.features.filter((f): f is FeatureName => featureInfo(f) !== undefined);
  // The effective set less the profile features a variant turns off (owner decision, CMP-5 option b): a lookup that
  // comes only from the default profile is off with key-store-honest, so CMP-5 refuses only a lookup that was named.
  const { features } = effectiveFeatures(c.profile, known, c.variants);
  const e: EffectiveCombination = { ...c, named: c.features, features: [...new Set([...features, ...c.features])] };
  return COMPAT_RULES.filter((r) => !(r.post01 && e.profile === "0.1")).map((r) => r.check(e)).filter((m): m is string => m !== undefined);
}

// ---- stream D: CMP-50 to CMP-59 (0.3.0 durability; CMP-50 is seams v2.1's durable-needs-strict-input) ----
const KEY_VARIANTS = ["key-store-honest", "key-store-durable", "settle-by-lookup", "settle-by-client-reference"];

(COMPAT_RULES as CompatRule[]).push(
  {
    // Seams v2.1 (INTERFACES section 3, decision 0003 section 7): every journal line is checksummed over RFC 8785 bytes,
    // which a string with a lone surrogate does not have. Refused at start, not a 503 at the first such write.
    id: "CMP-50", post01: true,
    check: (c) => has(c.features, "durable") && !has(c.features, "strict-input")
      ? "the durable feature needs strict-input: every journal line is checksummed over RFC 8785 bytes, so the backend must refuse keys and strings that have none at the door (name it: --features durable,strict-input)" : undefined,
  },
  {
    id: "CMP-54", post01: true,
    check: (c) => c.layout === "server" && c.features.some((f) => ["durable", "inflight", "retention"].includes(f))
      ? "durable, inflight and retention are backend features; name them where the backend runs (`all` or `backend`)" : undefined,
  },
  {
    id: "CMP-51", post01: false,
    check: (c) => has(c.variants, "settle-by-lookup") && !has(c.features, "inflight")
      ? "the settle-by-lookup variant fences keys through the backend's key states; it needs the inflight feature" : undefined,
  },
  {
    id: "CMP-52", post01: false,
    check: (c) => {
      const on = c.variants.filter((v) => KEY_VARIANTS.includes(v));
      return on.length > 1 ? `the variants ${on.join(", ")} each replace create_ticket's key handling; name one` : undefined;
    },
  },
  {
    id: "CMP-53", post01: false,
    check: (c) => (has(c.variants, "key-store-durable") || has(c.variants, "settle-by-client-reference")) && (has(c.features, "lookup") || has(c.features, "inflight"))
      ? "the key-store-durable and settle-by-client-reference variants stand for a backend with no idempotency key; do not combine them with the backend key features (lookup, inflight)" : undefined,
  },
  {
    // G2 fold-in 2: settle-by-lookup reads a miss behind the fence as "never applied". Under the forget policy, or with a
    // retention cut short by the key-expires-early defect, a miss may be a forgotten record of an applied write: the
    // fence would close a key whose write exists, and the variant would say not_applied. No defect names that pair.
    id: "CMP-55", post01: false,
    check: (c) => {
      if (!has(c.variants, "settle-by-lookup")) return undefined;
      if (c.keyExpiry === "forget") return "the settle-by-lookup variant needs the refuse key-expiry policy: under forget a missing record may be a forgotten applied write, and the lookup would report it not applied (drop --key-expiry forget)";
      if (has(c.backendDefects, "key-expires-early")) return "the settle-by-lookup variant does not run with the key-expires-early backend defect: a record that expired early would be settled as a miss";
      return undefined;
    },
  },
);
// ---- end stream D ----
