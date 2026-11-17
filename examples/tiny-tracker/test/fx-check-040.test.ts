// fx-check's 0.4.0 checks against real builds: FX-KEY-1 (the fixture clock),
// FX-KEY-2 (the stated retention), FX-DUR-1 (a plant, a restart, a verify) and
// FX-DUR-2 (the data dir's files). Each fixture defect is violated on its own
// property and the correct build holds it. Builds start through the known-answer
// generator's startBuild (expected/generate.mjs), on port 0.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR_LEFTOVER_PREFIXES, fxCheck, isDataDirFile, statedRetentionMs, type FxCheckReport } from "../src/fx-check.js";

const GENERATE = pathToFileURL(fileURLToPath(new URL("../../expected/generate.mjs", import.meta.url))).href;
const L3 = "evidence,strict-input,execution-records,lookup,principals,ledger,faults,inflight,retention,clock";

type Run = { state: any; tokens: any; dataDir: string; stop(keep?: boolean): Promise<void> };
async function start(args: string[], reuse?: Run): Promise<Run> {
  const { startBuild } = await import(GENERATE);
  return startBuild(args, {}, reuse);
}
const verdict = (r: FxCheckReport, id: string) => r.findings.find((f) => f.id === id)!;
const check = (run: Run, extra: Record<string, unknown> = {}) =>
  fxCheck({ backend: run.state.backend, mcp: run.state.mcp, control: run.state.control, tokens: run.tokens, probe: true, dropWaitMs: 500, ...extra });

describe("fx-check 0.4.0: the stated retention (FX-KEY-2) and keys kept that long (FX-KEY-1)", () => {
  it("reads the retention sentence", () => {
    assert.equal(statedRetentionMs("x. A key is remembered for 7 days; repeat ..."), 7 * 86_400_000);
    assert.equal(statedRetentionMs("A key is remembered for 36 hours; ..."), 36 * 3_600_000);
    assert.equal(statedRetentionMs("A key is remembered for 1 day; ..."), 86_400_000);
    assert.equal(statedRetentionMs("no sentence"), undefined);
  });

  for (const [label, extra, key1] of [["correct build", [], "held"], ["key-expires-early", ["--backend-defect", "key-expires-early"], "violated"]] as const) {
    it(`${label}: FX-KEY-2 held, FX-KEY-1 ${key1}`, async () => {
      const run = await start(["--features", L3, ...extra]);
      try {
        const r = await check(run);
        assert.equal(verdict(r, "FX-KEY-2").verdict, "held", verdict(r, "FX-KEY-2").reason);
        assert.equal(verdict(r, "FX-KEY-1").verdict, key1, verdict(r, "FX-KEY-1").reason);
        assert.equal(verdict(r, "FX-KEY-3").verdict, "not checked");
        assert.equal(verdict(r, "FX-DUR-1").verdict, "not applicable");
      } finally {
        await run.stop();
      }
    });
  }

  it("without the clock feature FX-KEY-1 is not checked, and says why", async () => {
    const run = await start(["--features", "evidence,strict-input,execution-records,lookup,principals,ledger,faults,retention"]);
    try {
      const r = await check(run);
      assert.equal(verdict(r, "FX-KEY-1").verdict, "not checked");
      assert.match(verdict(r, "FX-KEY-1").reason, /fixture clock/);
      assert.equal(verdict(r, "FX-KEY-2").verdict, "held");
    } finally {
      await run.stop();
    }
  });
});

describe("fx-check 0.4.0: durability across a restart (FX-DUR-1) and one journal line (FX-DUR-2)", () => {
  const durable = ["--features", `${L3.replace(",clock", "")},durable`, "--data-dir", "{DATA_DIR}"];
  for (const [label, extra, dur1, dur2] of [
    ["correct build", [], "held", "held"],
    ["key-record-not-durable", ["--backend-defect", "key-record-not-durable"], "violated", "held"],
    ["key-record-after-effect", ["--backend-defect", "key-record-after-effect"], "held", "violated"],
  ] as const) {
    it(`${label}: FX-DUR-1 ${dur1}, FX-DUR-2 ${dur2}`, async () => {
      const run = await start([...durable, ...extra]);
      let kept = false;
      try {
        const first = await check(run, { dataDir: run.dataDir, durability: { plant: true } });
        assert.equal(verdict(first, "FX-DUR-2").verdict, dur2, verdict(first, "FX-DUR-2").reason);
        assert.equal(verdict(first, "FX-DUR-1").verdict, "not checked");
        assert.ok(first.plant, "a plant is returned");
        assert.ok(!JSON.stringify(first.plant).includes(run.tokens.backend), "the plant holds no token");
        // Verify before a restart: not checked, the boot is the same.
        const same = await check(run, { durability: { verify: first.plant } });
        assert.match(verdict(same, "FX-DUR-1").reason, /not restarted/);
        await run.stop(true);
        kept = true;
        const again = await start([...durable, ...extra], run);
        try {
          const after = await check(again, { durability: { verify: first.plant } });
          assert.equal(verdict(after, "FX-DUR-1").verdict, dur1, verdict(after, "FX-DUR-1").reason);
        } finally {
          await again.stop();
        }
      } finally {
        if (!kept) await run.stop();
      }
    });
  }
});

// Note 26 item 2: the pid lock's and the lease's leftovers can live through a whole run; they are not key records.
describe("fx-check 0.4.0: FX-DUR-2 ignores the lock and lease leftovers", () => {
  it("knows every leftover name the journal makes (src/backend/journal.ts), and nothing else beside the format's files", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/backend/journal.ts", import.meta.url)), "utf8");
    // The names a lock or lease path gets when it is made, moved aside or released: `${path}.new-…`, `${held.path}.released-…`.
    const suffixes = new Set([...source.matchAll(/`\$\{(?:path|held\.path|LOCK_FILE|LEASE_DIR)\}(\.[a-z]+-)/g)].map((m) => m[1]));
    assert.ok(suffixes.size >= 3, [...suffixes].join(" "));
    for (const suffix of suffixes) {
      assert.ok(DATA_DIR_LEFTOVER_PREFIXES.some((p) => p.endsWith(suffix)), `${suffix} is a leftover fx-check does not know`);
    }
    for (const name of ["lock.new-12-a1b2c3", "lock.stale-12-a1b2c3", "lock.d.new-12-a1b2c3", "lock.d.stale-12-a1b2c3", "lock.d.released-12-a1b2c3",
      "journal.jsonl", "lock", "lock.d", "tiny-tracker.data"]) assert.equal(isDataDirFile(name), true, name);
    for (const name of ["keys.jsonl", "after-effect.jsonl", "lock.old", "journal.jsonl.bak", "lockfile"]) assert.equal(isDataDirFile(name), false, name);
  });

  it("a correct durable build with leftovers in its data dir: FX-DUR-2 held; another file beside them: violated", async () => {
    const run = await start(["--features", `${L3.replace(",clock", "")},durable`, "--data-dir", "{DATA_DIR}"]);
    try {
      for (const d of ["lock.d.stale-999999-a1b2c3", "lock.d.released-999999-a1b2c3", "lock.d.new-999999-a1b2c3"]) mkdirSync(join(run.dataDir, d), { mode: 0o700 });
      for (const f of ["lock.new-999999-a1b2c3", "lock.stale-999999-a1b2c3"]) writeFileSync(join(run.dataDir, f), "999999\n", { mode: 0o600 });
      const held = await check(run, { dataDir: run.dataDir });
      assert.equal(verdict(held, "FX-DUR-2").verdict, "held", verdict(held, "FX-DUR-2").reason);
      writeFileSync(join(run.dataDir, "keys.jsonl"), "", { mode: 0o600 });
      const violated = await check(run, { dataDir: run.dataDir });
      assert.equal(verdict(violated, "FX-DUR-2").verdict, "violated");
      assert.match(verdict(violated, "FX-DUR-2").reason, /the data dir holds keys\.jsonl beside the journal/);
    } finally {
      await run.stop();
    }
  });
});

describe("fx-check 0.4.0: durable with the fixture clock (the journal keeps its offset, note 19 item 7)", () => {
  // FX-KEY-1 moves the clock by almost the whole retention, and the offset survives the restart: the FX-DUR-1 plant is
  // made after that move, so key-expires-early shows on FX-KEY-1 only and the correct build's plant is fresh.
  const durable = ["--features", `${L3},durable`, "--data-dir", "{DATA_DIR}"];
  for (const [label, extra, key1] of [["correct build", [], "held"], ["key-expires-early", ["--backend-defect", "key-expires-early"], "violated"]] as const) {
    it(`${label}: FX-KEY-1 ${key1}, FX-DUR-1 held across the restart, the clock offset kept`, async () => {
      const run = await start([...durable, ...extra]);
      let kept = false;
      try {
        const first = await check(run, { dataDir: run.dataDir, durability: { plant: true } });
        assert.equal(verdict(first, "FX-KEY-1").verdict, key1, verdict(first, "FX-KEY-1").reason);
        assert.equal(verdict(first, "FX-DUR-2").verdict, "held", verdict(first, "FX-DUR-2").reason);
        const offset = (await (await fetch(`${run.state.backend}/build`, { headers: { authorization: `Bearer ${run.tokens.evidence}` } })).json() as any).clock.offset_ms;
        assert.ok(offset > 0, "FX-KEY-1 moved the clock");
        await run.stop(true);
        kept = true;
        const again = await start([...durable, ...extra], run);
        try {
          const build = await (await fetch(`${again.state.backend}/build`, { headers: { authorization: `Bearer ${again.tokens.evidence}` } })).json() as any;
          assert.equal(build.clock.offset_ms, offset, "the restart starts at the journalled offset");
          const after = await check(again, { durability: { verify: first.plant } });
          assert.equal(verdict(after, "FX-DUR-1").verdict, "held", verdict(after, "FX-DUR-1").reason);
        } finally {
          await again.stop();
        }
      } finally {
        if (!kept) await run.stop();
      }
    });
  }
});

describe("replay-digest-mismatch under the 0.3.0 key records (found by the 0.4.0 matrix)", () => {
  for (const features of [L3, `${L3.replace(",clock", "")},durable`]) {
    it(`FX-DIG-2 is violated with ${features.endsWith("durable") ? "durable" : "inflight and retention"} too, and keyed repeats still answer`, async () => {
      const run = await start(["--features", features, ...(features.endsWith("durable") ? ["--data-dir", "{DATA_DIR}"] : []), "--backend-defect", "replay-digest-mismatch"]);
      try {
        const r = await check(run);
        assert.equal(verdict(r, "FX-DIG-2").verdict, "violated", verdict(r, "FX-DIG-2").reason);
        if (!features.endsWith("durable")) assert.equal(verdict(r, "FX-KEY-1").verdict, "held", verdict(r, "FX-KEY-1").reason);
      } finally {
        await run.stop();
      }
    });
  }
});
