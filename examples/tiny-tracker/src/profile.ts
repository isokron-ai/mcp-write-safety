// Profiles and feature switches.
//
// A profile names a fixed surface. `0.1` is the surface of the published
// 0.1.0 package: its tools, texts and structured results, checked against a
// transcript captured from the 0.1.0 tarball (test/surface.test.ts). It never
// gains a feature. `default` is what runs when no profile is named; from 0.2.0
// it turns on the features each release ships once they meet that release's
// gate. In 0.2.0 that is execution-records, lookup and principals: the 0.1
// surface plus the two read-only lookup tools (test/surface.test.ts).
//
// A feature is named with --features or TRACKER_FEATURES (comma-separated).
// An unknown name, or a name for a feature this version does not build yet,
// stops the process with exit 2, like every other setting.

export const PACKAGE_VERSION = "0.1.0";

export const PROFILES = ["0.1", "default"] as const;
export type ProfileName = (typeof PROFILES)[number];

/** Where a feature's code lives: the teaching server itself, or the fixture layer in src/fixture (never imported by profile 0.1). */
export type FeatureLayer = "core" | "fixture";

export interface FeatureInfo {
  name: string;
  /** The release that ships it. */
  since: string;
  /** Built in this version and switchable now. A feature that is not built is refused at start. */
  built: boolean;
  layer: FeatureLayer;
  summary: string;
}

export const FEATURES = [
  { name: "evidence", since: "0.2.0", built: true, layer: "fixture",
    summary: "Read-only evidence namespace on the backend listener (/build and /export; /ledger, /executions and /operations with their features) behind its own evidence token; the build descriptor mirrored in the MCP instructions and in every tool result's _meta; run and operation tags carried from request _meta to every backend request." },
  { name: "strict-input", since: "0.2.0", built: true, layer: "core",
    summary: "The backend validates idempotency keys (length and characters) and refuses request bodies that hold strings that are not well-formed Unicode." },
  { name: "execution-records", since: "0.2.0", built: true, layer: "core",
    summary: "One execution record per applied write (X-<n>), with the principal, the run and operation tags, the request fingerprint hash, and the committed result's canonical bytes and digest; GET /executions/:id with the caller's token." },
  { name: "lookup", since: "0.2.0", built: true, layer: "core",
    summary: "Look a write up by its idempotency key, in the caller's own scope: GET /operations/:key and the get_operation and get_execution tools. Needs execution-records." },
  { name: "principals", since: "0.2.0", built: true, layer: "core",
    summary: "Two or more backend tokens, each a principal (TRACKER_BACKEND_TOKENS_FILE); key records and lookups are scoped to the principal." },
  { name: "ledger", since: "0.2.0", built: true, layer: "fixture",
    summary: "An append-only execution ledger below every MCP-layer defect, with attribution from request _meta: every write attempt, fault arming and firing, run allocation and run reset; GET /ledger and the export (evidence token). Needs evidence and strict-input." },
  { name: "faults", since: "0.2.0", built: true, layer: "fixture",
    summary: "Server-side fault points, armed through the control listener; this version arms mcp/after-backend-reply/drop. Needs the ledger and --fixture-control." },
  { name: "durable", since: "0.3.0", built: true, layer: "core",
    summary: "A JSONL journal of committed post-state in --data-dir, so data and key records survive a restart." },
  { name: "inflight", since: "0.3.0", built: true, layer: "core",
    summary: "A pending key record before the effect; a same-key call meanwhile answers in_progress." },
  { name: "retention", since: "0.3.0", built: true, layer: "core",
    summary: "A stated key retention (7 days), with tombstones for expired keys." },
  { name: "clock", since: "0.3.0", built: false, layer: "fixture",
    summary: "A fixture clock for retention rehearsals, moved only through the control listener." },
] as const satisfies readonly FeatureInfo[];

export type FeatureName = (typeof FEATURES)[number]["name"];

export const FEATURE_NAMES = FEATURES.map((f) => f.name) as FeatureName[];

/** The features each profile turns on when none are named. */
export const PROFILE_FEATURES: Record<ProfileName, readonly FeatureName[]> = {
  "0.1": [],
  // 0.2.0 (owner decision 1): the core features 0.2.0 ships. The fixture-layer features (evidence, ledger, faults) stay
  // named, since they need tokens the operator gives, and strict-input stays named so the backend keeps accepting what
  // 0.1.0 accepted unless asked.
  default: ["execution-records", "lookup", "principals"],
};

export function featureInfo(name: string): FeatureInfo | undefined {
  return (FEATURES as readonly FeatureInfo[]).find((f) => f.name === name);
}

export class SettingError extends Error {}

export function parseProfile(raw: string | undefined): ProfileName {
  if (raw === undefined || raw.trim() === "") return "default";
  const value = raw.trim();
  if ((PROFILES as readonly string[]).includes(value)) return value as ProfileName;
  throw new SettingError(`profile "${raw}" is not recognized; use one of ${PROFILES.join(", ")}. Not starting.`);
}

/** Parses a comma-separated feature list. Unknown names stop the process; whether a known name may be used is the compatibility table's call. */
export function parseFeatures(raw: string | undefined): FeatureName[] {
  if (raw === undefined || raw.trim() === "") return [];
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new SettingError(`features "${raw}" names no feature. Not starting.`);
  const unknown = names.filter((n) => !featureInfo(n));
  if (unknown.length > 0) {
    throw new SettingError(`unknown feature(s): ${unknown.join(", ")}; known: ${FEATURE_NAMES.join(", ")}. Not starting.`);
  }
  return [...new Set(names)] as FeatureName[];
}

/**
 * A profile feature a variant turns off for one build, when the feature comes only from the profile (owner decision,
 * 16 Nov 2026, CMP-5 option b). A feature named with --features or TRACKER_FEATURES is never turned off: with the
 * variant the compatibility table refuses it (CMP-5, exit 2).
 */
export const VARIANT_TURNS_OFF: ReadonlyArray<{ variant: string; feature: FeatureName; reason: string }> = [
  { variant: "key-store-honest", feature: "lookup", reason: "key-store-honest keeps keys in the MCP server" },
  // 0.3.0 (stream D): these variants stand for a backend with no idempotency key (CMP-53), so the default lookup is off.
  { variant: "key-store-durable", feature: "lookup", reason: "key-store-durable keeps keys in the MCP server's own journal" },
  { variant: "settle-by-client-reference", feature: "lookup", reason: "settle-by-client-reference stands for a backend with no idempotency key" },
];

export interface FeatureOff {
  feature: FeatureName;
  variant: string;
  reason: string;
}

/** The profile features the variants turn off for this build (none under profile 0.1, which turns nothing on). */
export function featuresTurnedOff(profile: ProfileName, named: readonly string[], variants: readonly string[]): FeatureOff[] {
  return VARIANT_TURNS_OFF
    .filter((t) => variants.includes(t.variant) && PROFILE_FEATURES[profile].includes(t.feature) && !named.includes(t.feature))
    .map((t) => ({ feature: t.feature, variant: t.variant, reason: t.reason }));
}

/** The features a build runs: the active set less what the variants turn off (featuresTurnedOff). */
export function effectiveFeatures(profile: ProfileName, named: readonly FeatureName[], variants: readonly string[]): { features: FeatureName[]; off: FeatureOff[] } {
  const off = featuresTurnedOff(profile, named, variants);
  return { features: activeFeatures(profile, named).filter((f) => !off.some((o) => o.feature === f)), off };
}

/** The state-line and notice text for a feature turned off: "lookup off: key-store-honest keeps keys in the MCP server". */
export const featureOffText = (o: FeatureOff) => `${o.feature} off: ${o.reason}`;

/** The active feature set: the profile's own features plus the named ones. */
export function activeFeatures(profile: ProfileName, named: readonly FeatureName[]): FeatureName[] {
  return [...new Set([...PROFILE_FEATURES[profile], ...named])];
}

/** True when the fixture layer (src/fixture) has to be loaded for this setting. */
export function needsFixtureLayer(features: readonly string[], fixtureControl: boolean): boolean {
  return fixtureControl || features.some((f) => featureInfo(f)?.layer === "fixture");
}
