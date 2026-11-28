// The same-key-in-flight case, as plain code: one model of the server answers, one set of client policies, and a
// deterministic simulator over them. The live harness (live.mjs) runs the very same policy functions against tiny-tracker,
// so a live cell and its simulated cell differ only in the server.
//
// The case. A client sends a keyed create (key K1). The first write W1 is held inside the backend for d ms after the
// backend took its key. The client's call times out after TIMEOUT_MS; its library retries once with the same key, which
// meets W1 still in flight. The server answers that retry with one of:
//
//   A  "Conflict: nothing was written by this call."   outcome not_applied, code conflict
//   B  outcome unknown, code in_progress, repeat same_key (writecheck's strict B-9 reading requires this)
//   C  a plain 409 "request with this key in progress", no outcome
//   D  the server blocks until W1 finishes, then replays its result
//   E  "Failed.", outcome not_applied, no conflict wording
//
// W1 then lands at d, or fails: in the failure case the key is closed FENCE_LEAD_MS before the hold ends (tiny-tracker:
// a run reset fences the pending key record), nothing is applied for it, and a later same-key call is answered
// "key closed, nothing written" (not_applied). A write with a new key always succeeds at once.
//
// Every call takes no time in the simulator except D's wait; the client's timeout applies to every call it makes.
//
// The policies (what the client does with the retry's answer). Answer classes: success, not_applied, unknown, no_claim
// (an error with no outcome), timeout.
//   P1  trusts not_applied: on not_applied, create again at once with a NEW key (once) and report by that answer;
//       otherwise retry the same key after BACKOFF_MS, up to RETRIES times, then report "unknown".
//   P2  any non-success: retry the SAME key after BACKOFF_MS, up to RETRIES times; then report "not saved".
//   P3  any non-success: report "not saved" to the user. No further call.
//   P4  reads outcome strictly: success is done; not_applied stops and reports "not saved"; unknown, no outcome or a
//       timeout poll the same key after BACKOFF_MS, up to RETRIES times, then read back by the marker: found is "saved",
//       none found is "unknown".
//   P5  a naive agent: any non-success re-issues the whole task once (a new task: a new key), and reports by its answer.
//
// What a cell measures, from the final report and the objects that carry the task's marker once W1 is settled:
//   duplicate  two or more objects (an extra object or side effect)
//   lost       the user was told "not saved" and the write applied, or "saved" and nothing applied
//   wrong      the final report does not match the state: "saved" but not exactly one object, "not saved" but any object
//   unresolved the client reported "unknown" (not counted as wrong)
//   extra      calls beyond the first (creates and reads)

export const TIMEOUT_MS = 500;
export const BACKOFF_MS = 1000;
export const RETRIES = 3;
export const FENCE_LEAD_MS = 50;
/** The grid's hold times: each well past the client's timeout, and each at least 200 ms from any call a policy makes. */
export const GRID_DELAYS = [800, 1800, 3000, 8000];
export const OUTCOMES = ['lands', 'fails'];
export const VARIANTS = ['A', 'B', 'C', 'D', 'E'];
export const POLICY_NAMES = ['P1', 'P2', 'P3', 'P4', 'P5'];
export const VARIANT_TEXT = {
  A: 'not_applied, code conflict ("Conflict: nothing was written by this call")',
  B: 'unknown, code in_progress, repeat same_key (strict B-9)',
  C: 'plain 409 "in progress", no outcome',
  D: 'blocks until the first write finishes, then replays it',
  E: 'not_applied, "Failed", no conflict wording',
};
export const POLICY_TEXT = {
  P1: 'trusts not_applied: retries with a NEW key',
  P2: 'retries the SAME key after a backoff',
  P3: 'any non-success: reports "not saved"',
  P4: 'reads outcome strictly; polls or reads back on unknown',
  P5: 'naive agent: re-issues the whole task once',
};

/** An MCP tools/call result as an answer class (the policies see nothing else). */
export function classify(result) {
  if (!result || typeof result !== 'object') return { cls: 'no_claim', code: null };
  if (result.isError !== true) return { cls: 'success', code: result.structuredContent?.mws?.code ?? null };
  const m = result.structuredContent?.mws;
  if (m?.outcome === 'not_applied') return { cls: 'not_applied', code: m.code ?? null };
  if (m?.outcome === 'unknown') return { cls: 'unknown', code: m.code ?? null };
  return { cls: 'no_claim', code: m?.code ?? null };
}

const reportOf = (r) => (r.cls === 'success' ? 'saved' : r.cls === 'not_applied' ? 'not_saved' : 'unknown');

/** The first call and its library's one same-key retry on a timeout: every policy starts so. */
async function start(c) {
  const r = await c.create(c.key1);
  return r.cls === 'timeout' ? c.create(c.key1) : r;
}

/** The client policies. `c`: { key1, newKey(), create(key) -> {cls, code}, sleep(ms), readBack() -> count }. */
export const POLICIES = {
  async P1(c) {
    let r = await start(c);
    for (let tries = 0; ; tries++) {
      if (r.cls === 'success') return 'saved';
      if (r.cls === 'not_applied') return reportOf(await c.create(c.newKey()));
      if (tries >= RETRIES) return 'unknown';
      await c.sleep(BACKOFF_MS);
      r = await c.create(c.key1);
    }
  },
  async P2(c) {
    let r = await start(c);
    for (let tries = 0; r.cls !== 'success' && tries < RETRIES; tries++) {
      await c.sleep(BACKOFF_MS);
      r = await c.create(c.key1);
    }
    return r.cls === 'success' ? 'saved' : 'not_saved';
  },
  async P3(c) {
    const r = await start(c);
    return r.cls === 'success' ? 'saved' : 'not_saved';
  },
  async P4(c) {
    let r = await start(c);
    for (let tries = 0; ; tries++) {
      if (r.cls === 'success') return 'saved';
      if (r.cls === 'not_applied') return 'not_saved';
      if (tries >= RETRIES) break;
      await c.sleep(BACKOFF_MS);
      r = await c.create(c.key1);
    }
    return (await c.readBack()) >= 1 ? 'saved' : 'unknown';
  },
  async P5(c) {
    const r = await start(c);
    if (r.cls === 'success') return 'saved';
    const again = await c.create(c.newKey());
    return again.cls === 'success' ? 'saved' : 'not_saved';
  },
};

/** The harm measures of one cell. */
export function measure(report, objects, calls) {
  return {
    report,
    objects,
    calls,
    extra: Math.max(0, calls - 1),
    duplicate: objects >= 2,
    lost: (report === 'not_saved' && objects >= 1) || (report === 'saved' && objects === 0),
    wrong: (report === 'saved' && objects !== 1) || (report === 'not_saved' && objects !== 0),
    unresolved: report === 'unknown',
  };
}

/** A virtual-clock client against the model server. Deterministic: the same inputs give the same trace. */
export class SimClient {
  constructor(variant, outcome, d) {
    if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
    if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome ${outcome}`);
    this.variant = variant;
    this.outcome = outcome;
    this.d = d;
    this.now = 0;
    this.calls = 0;
    this.keys = 0;
    this.key1 = 'K1';
    this.firstSent = false;
    /** Times at which objects carrying the marker come into being. */
    this.objects = outcome === 'lands' ? [d] : [];
    this.trace = [];
  }
  newKey() { return `K${++this.keys + 1}`; }
  /** When the backend closes K1: at d when it lands, FENCE_LEAD_MS before the hold ends when it fails. */
  get closeAt() { return this.outcome === 'lands' ? this.d : this.d - FENCE_LEAD_MS; }
  /** The server's answer to a create at time t, and when it is given. */
  answer(key, t) {
    const { d, variant, outcome } = this;
    if (key !== this.key1) {
      this.objects.push(t);
      return { cls: 'success', code: null, at: t };
    }
    if (!this.firstSent) {
      this.firstSent = true;
      return outcome === 'lands' ? { cls: 'success', code: null, at: d } : { cls: 'not_applied', code: 'key_fenced', at: d };
    }
    // why: D waits on the first call in its own process, which answers at d whatever the backend's key record says.
    if (variant === 'D' && t < d) return outcome === 'lands' ? { cls: 'success', code: 'replay', at: d } : { cls: 'not_applied', code: 'key_fenced', at: d };
    if (t >= this.closeAt) return outcome === 'lands' ? { cls: 'success', code: 'replay', at: t } : { cls: 'not_applied', code: 'key_fenced', at: t };
    if (variant === 'A') return { cls: 'not_applied', code: 'conflict', at: t };
    if (variant === 'B') return { cls: 'unknown', code: 'in_progress', at: t };
    if (variant === 'C') return { cls: 'no_claim', code: null, at: t };
    return { cls: 'not_applied', code: 'failed', at: t };
  }
  async create(key) {
    this.calls++;
    const t = this.now;
    const a = this.answer(key, t);
    const timedOut = a.at - t > TIMEOUT_MS;
    this.now = timedOut ? t + TIMEOUT_MS : a.at;
    const seen = timedOut ? { cls: 'timeout', code: null } : { cls: a.cls, code: a.code };
    this.trace.push({ t, op: key === this.key1 ? 'create K1' : `create ${key}`, ...seen });
    return seen;
  }
  async sleep(ms) { this.now += ms; }
  async readBack() {
    this.calls++;
    const n = this.objects.filter((at) => at <= this.now).length;
    this.trace.push({ t: this.now, op: 'read back', cls: 'count', code: n });
    return n;
  }
}

/** One simulated cell. */
export async function simulateCell(variant, policy, outcome, d) {
  const c = new SimClient(variant, outcome, d);
  const report = await POLICIES[policy](c);
  return { variant, policy, outcome, d, ...measure(report, c.objects.length, c.calls), trace: c.trace };
}

/** Every grid cell: variants x policies x outcomes x GRID_DELAYS. */
export async function grid() {
  const out = [];
  for (const variant of VARIANTS) for (const policy of POLICY_NAMES) for (const outcome of OUTCOMES) for (const d of GRID_DELAYS) out.push(await simulateCell(variant, policy, outcome, d));
  return out;
}

/** mulberry32: a small seeded PRNG, so a population is reproduced exactly from its seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded population per variant and policy, given that the case arises (the first call times out): d log-uniform over
 * [dMin, dMax] ms, and the first write fails with probability pFail. The same draws are used for every variant and policy,
 * so the rates differ only by what the server answered and what the client did.
 */
export async function population({ seed = 20261127, runs = 5000, pFail = 0.2, dMin = 600, dMax = 15000 } = {}) {
  const r = rng(seed);
  const draws = Array.from({ length: runs }, () => ({ d: Math.round(Math.exp(Math.log(dMin) + r() * (Math.log(dMax) - Math.log(dMin)))), outcome: r() < pFail ? 'fails' : 'lands' }));
  const rows = [];
  for (const variant of VARIANTS) {
    for (const policy of POLICY_NAMES) {
      const t = { duplicate: 0, lost: 0, wrong: 0, unresolved: 0, extra: 0 };
      for (const { d, outcome } of draws) {
        const m = await simulateCell(variant, policy, outcome, d);
        for (const k of ['duplicate', 'lost', 'wrong', 'unresolved']) if (m[k]) t[k]++;
        t.extra += m.extra;
      }
      rows.push({ variant, policy, runs, duplicate: t.duplicate / runs, lost: t.lost / runs, wrong: t.wrong / runs, unresolved: t.unresolved / runs, extra_mean: t.extra / runs });
    }
  }
  return { seed, runs, pFail, dMin, dMax, rows };
}
