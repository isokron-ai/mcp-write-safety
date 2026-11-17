// Stream C: fx-check (src/fx-check.ts) against the 0.2.0 test double, correct and with each modelled FX defect, and
// against today's real build; plus the Python recount over what the double serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fxCheck, main, recomputeDescriptorHashes, type FxCheckReport } from "../src/fx-check.js";
import { startFakeFixture, type FakeDefects, type FakeFixture } from "./support/fake-fixture.js";
import { py } from "./support/python.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GATE = process.env.TT_GATE === "1";
const needPython = spawnSync("python3", ["--version"]).status === 0 || GATE ? false : "python3 is not on PATH";

const verdicts = (r: FxCheckReport) => Object.fromEntries(r.findings.map((f) => [f.id, f.verdict]));
const run = (f: FakeFixture, extra: { probe?: boolean; second?: boolean } = {}) => fxCheck({
  backend: f.backend, mcp: f.mcp, control: f.control, probe: extra.probe ?? true, dropWaitMs: 800,
  tokens: { evidence: f.tokens.evidence, backend: f.tokens.backend, control: f.tokens.control, ...(extra.second === false ? {} : { second: f.tokens.second }) },
});

function sink() {
  let text = "";
  return { stream: new Writable({ write(chunk, _e, cb) { text += chunk; cb(); } }), text: () => text };
}

describe("fx-check", () => {
  it("a correct 0.2.0 build: every 0.2.0 property held, the 0.3.0 ones not applicable, the probe run reset", async () => {
    const f = await startFakeFixture();
    try {
      const r = await run(f);
      const v = verdicts(r);
      for (const id of ["FX-BLD-1", "FX-DIG-1", "FX-DIG-2", "FX-DIG-3", "FX-LOOK-1", "FX-LOOK-2", "FX-LOOK-3", "FX-FLT-1"]) assert.equal(v[id], "held", `${id}: ${r.findings.find((x) => x.id === id)?.reason}`);
      for (const id of ["FX-LOOK-4", "FX-DUR-1", "FX-DUR-2", "FX-DUR-3", "FX-KEY-1", "FX-KEY-2", "FX-KEY-3"]) assert.equal(v[id], "not applicable", id);
      assert.equal(r.build?.build_hash, f.descriptor.buildHash);
      assert.equal(r.probes.reset, "reset");
      assert.deepEqual(recomputeDescriptorHashes(f.descriptor.toJSON()), { build_hash: f.descriptor.buildHash, descriptor_hash: f.descriptor.toJSON().descriptor_hash });
    } finally {
      await f.close();
    }
  });

  const cases: Array<[Partial<FakeDefects>, string[]]> = [
    [{ digestOfCurrentState: true }, ["FX-DIG-1"]],
    [{ replayDigestMismatch: true }, ["FX-DIG-2"]],
    // FX-DIG-1 and FX-DIG-2 compare values; the form of the bytes is FX-DIG-3's alone (as the real defect trips).
    [{ digestNotCanonical: true }, ["FX-DIG-3"]],
    [{ digestWithoutDomain: true }, ["FX-DIG-3"]],
    [{ lookupWrongRecord: true }, ["FX-LOOK-1", "FX-LOOK-3"]],
    [{ lookupExecutes: true }, ["FX-LOOK-2"]],
    [{ lookupUnscoped: true }, ["FX-LOOK-3"]],
    [{ descriptorHashWrong: true }, ["FX-BLD-1"]],
    [{ keyDropped: true }, []],
  ];
  for (const [defects, expected] of cases) {
    it(`a build with ${Object.keys(defects).join(", ")}: violated exactly ${expected.join(", ") || "nothing (an MCP-layer key defect is not an FX defect)"}`, async () => {
      const f = await startFakeFixture({ defects });
      try {
        const r = await run(f);
        assert.deepEqual(r.findings.filter((x) => x.verdict === "violated").map((x) => x.id).sort(), [...expected].sort(), JSON.stringify(r.findings.filter((x) => x.verdict === "violated")));
      } finally {
        await f.close();
      }
    });
  }

  it("read-only by default (no --probe) writes nothing; without a second principal FX-LOOK-3 is not checked; missing routes are named", async () => {
    const f = await startFakeFixture({ notBuilt: ["/operations"] });
    try {
      const before = f.executions();
      const passive = verdicts(await run(f, { probe: false }));
      assert.equal(f.executions(), before, "no write");
      assert.equal(passive["FX-DIG-1"], "not checked");
      assert.equal(passive["FX-LOOK-1"], "not checked");
      assert.equal(passive["FX-FLT-1"], "not checked");
      assert.equal(passive["FX-BLD-1"], "held");
      const r = await run(f, { second: false });
      const v = verdicts(r);
      assert.equal(v["FX-LOOK-3"], "not checked");
      assert.match(r.findings.find((x) => x.id === "FX-LOOK-1")!.reason, /operations.*501/);
      assert.equal(v["FX-DIG-3"], "held");
    } finally {
      await f.close();
    }
  });

  it("the command line: exit codes, no token on argv, text and JSON output", async () => {
    const f = await startFakeFixture({ defects: { lookupUnscoped: true } });
    try {
      const env = { TRACKER_EVIDENCE_TOKEN: f.tokens.evidence, TRACKER_BACKEND_TOKEN: f.tokens.backend, TRACKER_CONTROL_TOKEN: f.tokens.control, FX_CHECK_SECOND_TOKEN: f.tokens.second };
      const out = sink();
      assert.equal(await main(["--backend", f.backend, "--mcp", f.mcp, "--control", f.control, "--probe"], env, out.stream, sink().stream), 1, "a violated property exits 1");
      assert.match(out.text(), /^FX-LOOK-3 +violated/m);
      assert.match(out.text(), /fx-check: \d+ held, 1 violated/);
      for (const t of Object.values(f.tokens)) assert.ok(!out.text().includes(t));
      const json = sink();
      const writesBefore = f.executions();
      assert.equal(await main(["--backend", f.backend, "--mcp", f.mcp, "--control", f.control, "--json"], env, json.stream, sink().stream), 0, "read-only by default: the unscoped lookup is not probed");
      assert.equal(f.executions(), writesBefore, "the command line writes nothing without --probe");
      assert.equal(JSON.parse(json.text()).probes.run, null, "no probe run allocated");
      assert.equal(JSON.parse(json.text()).fx_check, "fx-check/1");
      const err = sink();
      assert.equal(await main(["--backend", `${f.backend}/?t=${f.tokens.evidence}`], env, sink().stream, err.stream), 2);
      assert.match(err.text(), /token is on the command line/);
      assert.equal(await main(["--backend", f.backend], {}, sink().stream, sink().stream), 2, "no evidence token");
      assert.equal(await main(["--backend", f.backend], { TRACKER_EVIDENCE_TOKEN: "wrong-token-0000000000000000" }, sink().stream, sink().stream), 2, "a token /build refuses");
      const dir = mkdtempSync(join(tmpdir(), "fxc-"));
      try {
        writeFileSync(join(dir, "evidence.token"), f.tokens.evidence, { mode: 0o600 });
        assert.equal(await main(["--backend", f.backend, "--token-dir", dir], {}, sink().stream, sink().stream), 0, "the token folder is read");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await f.close();
    }
  });

  it("the real 0.2.0 correct build with two principals: every 0.2.0 property held (--probe)", async () => {
    const { startBuild } = await import(pathToFileURL(join(ROOT, "expected", "generate.mjs")).href);
    const run = await startBuild(["--features", "evidence,strict-input,execution-records,lookup,principals,ledger,faults"]);
    let r: FxCheckReport | undefined;
    try {
      r = await fxCheck({ backend: run.state.backend, mcp: run.state.mcp, control: run.state.control, tokens: run.tokens, probe: true });
    } finally {
      await run.stop();
    }
    const v = verdicts(r!);
    for (const id of ["FX-BLD-1", "FX-DIG-1", "FX-DIG-2", "FX-DIG-3", "FX-LOOK-1", "FX-LOOK-2", "FX-LOOK-3", "FX-FLT-1"]) assert.equal(v[id], "held", `${id}: ${r!.findings.find((f) => f.id === id)?.reason}`);
    assert.equal(r!.probes.principal, "p-default");
    assert.equal(r!.probes.reset, "reset");
  });
});

describe("Python recount over what the evidence API serves (three-way recount readiness)", { skip: needPython }, () => {
  it("export, ledger and execution records agree after fx-check's probes; a lost ticket is named", async () => {
    const f = await startFakeFixture();
    const dir = mkdtempSync(join(tmpdir(), "tt-recount-"));
    try {
      await run(f);
      const get = async (p: string) => (await fetch(`${f.backend}${p}?principal=p-default`, { headers: { authorization: `Bearer ${f.tokens.evidence}` } })).json();
      const files: Record<string, string> = {};
      for (const name of ["export", "ledger", "executions"]) { files[name] = join(dir, `${name}.json`); writeFileSync(files[name], JSON.stringify(await get(`/${name}`))); }
      const script = join(ROOT, "verify", "python", "tt_recount.py");
      const ok = await py([script, "--export", files.export, "--ledger", files.ledger, "--executions", files.executions]);
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /3 sources, 0 disagreements/);
      const exported = JSON.parse((await import("node:fs")).readFileSync(files.export, "utf8"));
      exported.tickets.push({ id: "T-999" });
      writeFileSync(files.export, JSON.stringify(exported));
      const bad = await py([script, "--export", files.export, "--ledger", files.ledger]);
      assert.equal(bad.code, 1);
      assert.match(bad.stdout, /T-999/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await f.close();
    }
  });
});
