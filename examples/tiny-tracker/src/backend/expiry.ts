// Key retention and expiry (0.3.0, feature retention; decision 0004).
//
// A key is remembered for the stated retention (7 days by default), measured in
// the injected clock's domain: committed_at and expires_at are both clock times,
// and every record carries clock_offset_ms. After that the policy decides:
//
//   refuse  (default) the record becomes a tombstone, kept for the life of the
//           data dir: key, fingerprint hash, execution record id, result digest,
//           committed time and the objects. A repeat with the same fingerprint is
//           answered "applied earlier, the stored answer is gone, read the
//           object"; a different fingerprint is refused.
//   forget  the key is treated as new (the IETF draft's and most APIs' style).
//
// Both are correct builds with their own known answers.

import type { KeyExpirySeam, StoredReply } from "./seams.js";

export const DAY_MS = 86_400_000;
/** The stated retention: longer than the 24-hour delayed-recovery window. */
export const DEFAULT_RETENTION_MS = 7 * DAY_MS;

export const EXPIRY_POLICIES = ["refuse", "forget"] as const;
export type ExpiryPolicy = (typeof EXPIRY_POLICIES)[number];

export class ExpirySettingError extends Error {}

/** The retention seam: committed_at + retentionMs, in the clock's domain. */
export function keyExpiry(retentionMs: number = DEFAULT_RETENTION_MS): KeyExpirySeam {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new ExpirySettingError(`key retention must be a positive number of milliseconds, got ${retentionMs}`);
  return {
    retentionMs,
    expiresAt: (committedAt) => new Date(committedAt.getTime() + retentionMs),
    isExpired: (reply: StoredReply, now: Date) => now.getTime() >= Date.parse(reply.committedAt) + retentionMs,
  };
}

/** Parses a retention setting: a number of milliseconds, or a number with a unit (ms, s, m, h, d), e.g. "7d". */
export function parseRetention(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_MS;
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) throw new ExpirySettingError(`key retention "${raw}" is not a duration (use e.g. 7d, 24h, 90m or a number of milliseconds)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[(m[2] ?? "ms") as "ms"];
  const ms = Number(m[1]) * unit;
  if (!Number.isSafeInteger(ms) || ms < 1) throw new ExpirySettingError(`key retention "${raw}" is out of range`);
  return ms;
}

export function parseExpiryPolicy(raw: string | undefined): ExpiryPolicy {
  if (raw === undefined || raw.trim() === "") return "refuse";
  const v = raw.trim();
  if ((EXPIRY_POLICIES as readonly string[]).includes(v)) return v as ExpiryPolicy;
  throw new ExpirySettingError(`key expiry policy "${raw}" is not one of ${EXPIRY_POLICIES.join(", ")}`);
}

/** The sentence every key-accepting tool and the instructions carry (FX-KEY-2). */
export function retentionSentence(retentionMs: number = DEFAULT_RETENTION_MS): string {
  return `A key is remembered for ${describeRetention(retentionMs)}; repeat the same intended write with the same key.`;
}

/**
 * The sentence instead, when the retention is not known (follow-up F2): a `tiny-tracker server` whose backend states
 * none and that was given none. It names no duration, so no reader takes a default for the backend's.
 */
export const UNKNOWN_RETENTION_SENTENCE = "This server does not know how long its backend remembers a key (the backend did not state its key retention); repeat the same intended write with the same key.";

/** "7 days", "1 day", "90 seconds", "250 ms". */
export function describeRetention(ms: number): string {
  const units: Array<[number, string]> = [[DAY_MS, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]];
  for (const [size, name] of units) if (ms % size === 0) return `${ms / size} ${name}${ms / size === 1 ? "" : "s"}`;
  return `${ms} ms`;
}
