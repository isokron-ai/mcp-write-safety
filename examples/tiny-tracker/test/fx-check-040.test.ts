// fx-check's 0.4.0 checks against real builds: FX-KEY-1 (the fixture clock),
// FX-KEY-2 (the stated retention), FX-DUR-1 (a plant, a restart, a verify) and
// FX-DUR-2 (the data dir's files). Each fixture defect is violated on its own
// property and the correct build holds it. Builds start through the known-answer
// generator's startBuild (expected/generate.mjs), on port 0.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fxCheck, statedRetentionMs, type FxCheckReport } from "../src/fx-check.js";

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
  const durable = ["--features", `${L3},durable`, "--data-dir", "{DATA_DIR}"];
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
