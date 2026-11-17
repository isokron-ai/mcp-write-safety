// The compatibility table (review G4): which combinations of profile,
// features, defects, variants, faults and process layout may start. Anything
// the table refuses stops the process with exit 2 and the rule's message.
//
// Profile 0.1 keeps the 0.1.0 command line exactly: a rule marked `post01`
// does not apply to it, so nothing the published 0.1.0 accepted is refused
// under --profile 0.1. Tests cover the table pairwise (test/compat.test.ts),
// not as the full product of every factor.

import { faultPoint, FAULT_DEMOS, RETIRED_FAULT_NAMES } from "./fault-points.js";
import { featureInfo, type ProfileName } from "./profile.js";

export type ProcessLayout = "all" | "backend" | "server";

/** One requested combination, as the command line and environment give it. */
export interface Combination {
  layout: ProcessLayout;
  profile: ProfileName;
  /** Features named with --features or TRACKER_FEATURES (not the profile's own). */
  features: readonly string[];
  /** MCP-layer defects as resolved (names). */
  defects: readonly string[];
  backendDefects: readonly string[];
  variants: readonly string[];
  /** Faults armed at start, as point ids or demonstration names. None can be armed in this version. */
  faults: readonly string[];
  fixtureControl: boolean;
  dataDir?: string;
}

export interface CompatRule {
  id: string;
  /** False: applies under every profile. True: not under profile 0.1, so that profile keeps the 0.1.0 command line. */
  post01: boolean;
  /** The message when the combination breaks the rule, or undefined when it does not. */
  check(c: Combination): string | undefined;
}

const has = (list: readonly string[], name: string) => list.includes(name);

export const COMPAT_RULES: readonly CompatRule[] = [
  {
    id: "CMP-1", post01: false,
    check: (c) => c.profile === "0.1" && c.features.length > 0
      ? `profile 0.1 is the 0.1.0 surface and takes no features (named: ${c.features.join(", ")})` : undefined,
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
    check: (c) => c.faults.length > 0 ? "no fault can be armed in this version (the fault controller arrives in 0.2.0)" : undefined,
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
    id: "CMP-10", post01: true,
    check: (c) => has(c.features, "strict-input") && c.layout === "server"
      ? "strict-input is a backend feature; name it where the backend runs (`all` or `backend`)" : undefined,
  },
];

/** The rules a combination breaks, as messages. Empty: it may start. */
export function checkCompat(c: Combination): string[] {
  return COMPAT_RULES.filter((r) => !(r.post01 && c.profile === "0.1")).map((r) => r.check(c)).filter((m): m is string => m !== undefined);
}
