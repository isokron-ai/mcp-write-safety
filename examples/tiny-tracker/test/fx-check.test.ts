// Stream C: fx-check (src/fx-check.ts) against the 0.2.0 test double, correct and with each modelled FX defect, and
// against today's real build; plus the Python recount over what the double serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fxCheck, main, recomputeDescriptorHashes, type FxCheckReport } from "../src/fx-check.js";
import { startFakeFixture, type FakeDefects, type FakeFixture } from "./support/fake-fixture.js";
import { runCli } from "./support/cli-run.js";
import { py } from "./support/python.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GATE = process.env.TT_GATE === "1";
const needPython = spawnSync("python3", ["--version"]).status === 0 || GATE ? false : "python3 is not on PATH";

const verdicts = (r: FxCheckReport) => Object.fromEntries(r.findings.map((f) => [f.id, f.verdict]));
const run = (f: FakeFixture, extra: { passive?: boolean; second?: boolean } = {}) => fxCheck({
  backend: f.backend, mcp: f.mcp, control: f.control, passive: extra.passive, dropWaitMs: 800,
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
    [{ digestNotCanonical: true }, ["FX-DIG-1", "FX-DIG-2", "FX-DIG-3"]],
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

  it("--passive writes nothing; without a second principal FX-LOOK-3 is not checked; missing routes are named", async () => {
    const f = await startFakeFixture({ notBuilt: ["/operations"] });
    try {
      const before = f.executions();
      const passive = verdicts(await run(f, { passive: true }));
      assert.equal(f.executions(), before, "no write");
      assert.equal(passive["FX-DIG-1"], "not checked");
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
      assert.equal(await main(["--backend", f.backend, "--mcp", f.mcp, "--control", f.control], env, out.stream, sink().stream), 1, "a violated property exits 1");
      assert.match(out.text(), /^FX-LOOK-3 +violated/m);
      assert.match(out.text(), /fx-check: \d+ held, 1 violated/);
      for (const t of Object.values(f.tokens)) assert.ok(!out.text().includes(t));
      const json = sink();
      assert.equal(await main(["--backend", f.backend, "--passive", "--json"], env, json.stream, sink().stream), 0);
      assert.equal(JSON.parse(json.text()).fx_check, "fx-check/1");
      const err = sink();
      assert.equal(await main(["--backend", `${f.backend}/?t=${f.tokens.evidence}`], env, sink().stream, err.stream), 2);
      assert.match(err.text(), /token is on the command line/);
      assert.equal(await main(["--backend", f.backend], {}, sink().stream, sink().stream), 2, "no evidence token");
      assert.equal(await main(["--backend", f.backend], { TRACKER_EVIDENCE_TOKEN: "wrong-token-0000000000000000" }, sink().stream, sink().stream), 2, "a token /build refuses");
      const dir = mkdtempSync(join(tmpdir(), "fxc-"));
      try {
        writeFileSync(join(dir, "evidence.token"), f.tokens.evidence, { mode: 0o600 });
        assert.equal(await main(["--backend", f.backend, "--passive", "--token-dir", dir], {}, sink().stream, sink().stream), 0, "the token folder is read");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await f.close();
    }
  });

  it("today's build (evidence only): the descriptor and its MCP mirror held, nothing else applicable", async () => {
    const env = { TRACKER_BACKEND_TOKEN: "backend-token-fxcheck-00000000000", TRACKER_EVIDENCE_TOKEN: "evidence-token-fxcheck-0000000000", TRACKER_CONTROL_TOKEN: "control-token-fxcheck-00000000000" };
    let r: FxCheckReport | undefined;
    const cli = await runCli(["all", "--features", "evidence", "--fixture-control"], env, async (state) => {
      r = await fxCheck({ backend: state.backend, mcp: state.mcp, control: state.control, tokens: { evidence: env.TRACKER_EVIDENCE_TOKEN, backend: env.TRACKER_BACKEND_TOKEN, control: env.TRACKER_CONTROL_TOKEN } });
    });
    assert.equal(cli.code, 0, cli.stderr);
    const v = verdicts(r!);
    assert.equal(v["FX-BLD-1"], "held", r!.findings[0].reason);
    assert.deepEqual(Object.entries(v).filter(([id]) => id !== "FX-BLD-1").map(([, x]) => x).filter((x) => x !== "not applicable"), []);
  });
});

describe("Python recount over what the evidence API serves (three-way recount readiness)", { skip: needPython }, () => {
  it("export, ledger and execution records agree after fx-check's probes; a lost ticket is named", async () => {
    const f = await startFakeFixture();
    const dir = mkdtempSync(join(tmpdir(), "tt-recount-"));
    try {
      await run(f);
      const get = async (p: string) => (await fetch(`${f.backend}${p}`, { headers: { authorization: `Bearer ${f.tokens.evidence}` } })).json();
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
