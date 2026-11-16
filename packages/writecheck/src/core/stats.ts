/**
 * The two numbers a `not observed` result carries: the Wilson upper bound and the rule-of-three
 * bound on the per-pair loss rate, given 0 losses in n overlapped pairs.
 */

/** z for a two-sided 95 % interval, the inverse normal CDF at 0.975. */
export const Z95 = 1.959963984540054;

export interface Proportion {
  k: number;
  n: number;
  p: number;
  lo: number;
  hi: number;
}

/**
 * Wilson score interval for k successes in n trials (Wilson 1927; method 3 in Newcombe 1998), with no
 * continuity correction, at 95 %. Null when n = 0: there is no rate to bound.
 *
 *   centre = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = z·√(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
 */
export function wilson(k: number, n: number): Proportion | null {
  if (!Number.isInteger(n) || n < 0) throw new Error(`wilson: n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`wilson: k must be an integer in [0, n], got k=${k}, n=${n}`);
  if (n === 0) return null;
  const z = Z95;
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  // why: at k = 0 or k = n the bound is exactly 0 or 1; rounding must not put it a hair inside.
  return { k, n, p, lo: k === 0 ? 0 : Math.max(0, c - h), hi: k === n ? 1 : Math.min(1, c + h) };
}

/**
 * Rule of three: with 0 events in n independent trials, the one-sided 95 % upper bound on the
 * per-trial rate is about 3/n (exact: 1 − 0.05^(1/n)). Null when n = 0.
 */
export function ruleOfThree(n: number): { approx: number; exact: number } | null {
  if (!Number.isInteger(n) || n < 0) throw new Error(`ruleOfThree: n must be a non-negative integer, got ${n}`);
  if (n === 0) return null;
  return { approx: Math.min(1, 3 / n), exact: 1 - Math.pow(0.05, 1 / n) };
}
