// Stream C: the lost-response contract adapter (harness/), its config printer and self-check, against the 0.2.0
// test double (test/support/fake-fixture.ts) and against today's real build. With TT_CONTRACT_DIR pointing at a
// checkout of the contract at the pinned commit, the contract driver itself runs too.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeFixture, type FakeFixture, type FakeOptions } from "./support/fake-fixture.js";
import { runCli } from "./support/cli-run.js";
import { py } from "./support/python.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS = join(ROOT, "harness");
const GATE = process.env.TT_GATE === "1";
const python = spawnSync("python3", ["--version"]).status === 0;
const needPython = python || GATE ? false : "python3 is not on PATH";
const jsonschema = spawnSync("python3", ["-I", "-c", "import jsonschema, referencing"]).status === 0;
const needJsonschema = jsonschema || GATE ? false : "the Python jsonschema package is not installed";
const CONTRACT_DIR = process.env.TT_CONTRACT_DIR;

const fakeEnv = (f: FakeFixture) => ({ TRACKER_EVIDENCE_TOKEN: f.tokens.evidence, TRACKER_CONTROL_TOKEN: f.tokens.control, TRACKER_BACKEND_TOKEN: f.tokens.backend });

async function configFor(state: unknown, env: Record<string, string>, extra: string[] = []): Promise<any> {
  const r = await py([join(HARNESS, "adapter_config.py"), ...extra], env, JSON.stringify(state));
  assert.equal(r.code, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  c.adapter_config.drop_timeout_s = 1;
  return c;
}

async function selfcheck(config: unknown, env: Record<string, string>, extra: string[] = []): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "tt-harness-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    const r = await py([join(HARNESS, "selfcheck.py"), "--config", path, ...extra], env);
    assert.equal(r.code, 0, r.stderr);
    for (const t of Object.values(env)) if (t.length >= 16) assert.ok(!r.stdout.includes(t), "no token in the output");
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFake<T>(options: FakeOptions, body: (f: FakeFixture, env: Record<string, string>) => Promise<T>): Promise<T> {
  const f = await startFakeFixture(options);
  try {
    return await body(f, fakeEnv(f));
  } finally {
    await f.close();
  }
}

describe("contract adapter (harness/)", { skip: needPython }, () => {
  it("Python unit tests: the adapter's digests agree with the vectors; the recount (python3 -I)", () => {
    assert.ok(python, "TT_GATE=1 needs python3 on PATH");
    for (const file of [join(HARNESS, "test_adapter.py"), join(ROOT, "verify", "python", "test_tt_recount.py")]) {
      const r = spawnSync("python3", ["-I", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `${file}: ${r.stderr}`);
    }
  });

  it("the config printer pins the build and writes variable names, never a token", async () => {
    await withFake({}, async (f, env) => {
      const r = await py([join(HARNESS, "adapter_config.py"), "--start", "tiny-tracker all --features ..."], env, `${JSON.stringify(f.stateLine)}\n`);
      assert.equal(r.code, 0, r.stderr);
      for (const t of Object.values(f.tokens)) assert.ok(!r.stdout.includes(t));
      const c = JSON.parse(r.stdout);
      assert.equal(c.adapter, "tiny_tracker");
      assert.equal(c.adapter_config.expected_build_hash, f.descriptor.buildHash);
      assert.equal(c.adapter_config.fault, "server");
      assert.equal(c.adapter_config.control_url, f.control);
      const none = await py([join(HARNESS, "adapter_config.py")], {}, JSON.stringify(f.stateLine));
      assert.notEqual(none.code, 0, "no evidence token: refused unless --no-build");
    });
  });

  it("correct 0.2.0 build: ledger counter, server-side drop, one digest, recomputation with the domain tag, K-only recovery", async () => {
    await withFake({}, async (f, env) => {
      const out = await selfcheck(await configFor(f.stateLine, env), env);
      assert.equal(out.initialize.build_matches, true);
      assert.equal(out.initialize.contract_commit_matches_adapter, true);
      assert.match(out.initialize.lrt_a3_k_only, /^self-attested/);
      for (const a of [out.A1, out.A2]) {
        assert.equal(a.counter, "ledger");
        assert.equal(a.attempt1.dropped, true);
        assert.equal(a.attempt1.fault.mode, "server", "the lost response is server-side");
        assert.deepEqual(a.attempt1.leaked_members, [], "nothing from the dropped attempt");
        assert.equal(a.count_after_attempt1, 1);
        assert.equal(a.count_final, 1);
      }
      assert.equal(out.A1.retry_response_class, "success");
      assert.equal(out.A1.retry_replayed, true);
      assert.equal(out.A2.retry_response_class, "tool_error:idempotency_key_reused");
      assert.equal(out.A2.refusal_records, 1);
      assert.match(out.A1.execution_record_ids[0], /^X-\d+$/);
      assert.deepEqual(out.A3_run_id_leg.digest_keys, ["result_digest"], "exactly one digest (the driver's delayed leg takes the first)");
      assert.equal(out.A3_run_id_leg.recomputation, "matched");
      const konly = out.A3_k_only_leg;
      assert.equal(konly.attempts[0].response_class, "found");
      assert.equal(konly.attempts[0].self_attested, true);
      assert.equal(konly.cross_check.digest_equal, true, "the recovered digest equals the committed one");
      assert.equal(out.A5_k_lookup_now.http_status, 200, "the record is addressable by K");
      assert.equal(out.A5_k_lookup_now.digest_equals_committed, true);
    });
  });

  it("defect builds: a dropped key makes two effects; a lookup of the wrong record is not found", async () => {
    await withFake({ defects: { keyDropped: true } }, async (f, env) => {
      const out = await selfcheck(await configFor(f.stateLine, env), env);
      assert.equal(out.A1.count_final, 2);
      assert.equal(out.A2.count_final, 2);
      assert.notEqual(out.A3_k_only_leg.attempts[0].response_class, "found");
    });
    await withFake({ defects: { lookupWrongRecord: true } }, async (f, env) => {
      const out = await selfcheck(await configFor(f.stateLine, env), env);
      assert.equal(out.A3_k_only_leg.attempts[0].response_class, "wrong_record");
    });
    await withFake({ defects: { digestWithoutDomain: true } }, async (f, env) => {
      const out = await selfcheck(await configFor(f.stateLine, env), env);
      assert.equal(out.A3_run_id_leg.recomputation, "mismatched", "a digest without the domain tag does not recompute");
      assert.equal(out.A3_k_only_leg.attempts[0].response_class, "found_digest_inconsistent");
    });
  });

  it("client-side fault on request, and the 0.1 fallbacks when the ledger and get_operation are missing", async () => {
    await withFake({ notBuilt: ["/ledger", "/operations", "/executions"], withoutTools: ["get_operation", "get_execution"] }, async (f, env) => {
      const config = await configFor(f.stateLine, env, ["--fault", "client"]);
      const out = await selfcheck(config, env);
      assert.equal(out.A1.attempt1.fault.mode, "client");
      assert.equal(out.A1.counter, "title-prefix (0.1.0 fallback)");
      assert.equal(out.A1.count_final, 1);
      assert.equal(out.A3_k_only_leg.attempts[0].response_class, "not_available");
      assert.equal(out.A3_k_only_leg.attempts[1].response_class, "found_by_caller_convention", "never classed found");
      assert.equal(out.A5_k_lookup_now.http_status, 501);
    });
  });

  it("today's build (evidence only): the adapter falls back and reports what it could not do", async () => {
    const env = { TRACKER_BACKEND_TOKEN: "backend-token-harness-000000000000", TRACKER_EVIDENCE_TOKEN: "evidence-token-harness-00000000000", TRACKER_CONTROL_TOKEN: "control-token-harness-000000000000" };
    let out: any;
    const r = await runCli(["all", "--features", "evidence", "--fixture-control"], env, async (state) => {
      out = await selfcheck(await configFor(state, env), env);
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(out.initialize.get_operation_listed, false);
    assert.equal(out.A1.attempt1.fault.fallback_used, true, "arming answers 501, so the drop is client-side");
    assert.equal(out.A1.counter, "title-prefix (0.1.0 fallback)");
    assert.equal(out.A1.count_final, 1);
    assert.equal(out.A3_k_only_leg.cross_check.found_attempts, 0);
  });

  it("the fake's records validate against the frozen schemas (what streams A and B must serve)", { skip: needJsonschema }, async () => {
    assert.ok(jsonschema, "TT_GATE=1 needs python3 with jsonschema and referencing");
    await withFake({}, async (f, env) => {
      await selfcheck(await configFor(f.stateLine, env), env);
      const get = async (path: string) => (await fetch(`${f.backend}${path}`, { headers: { authorization: `Bearer ${f.tokens.evidence}` } })).json() as any;
      const check = join(ROOT, "verify", "python", "check_schemas.py");
      const items: Array<[string, unknown]> = [["build-descriptor", await get("/build")]];
      for (const e of (await get("/ledger")).entries) items.push(["ledger-entry", e]);
      for (const x of (await get("/executions")).executions) items.push(["execution-record", x]);
      const k = (await get("/ledger")).entries.find((e: any) => e.request?.key).request.key;
      items.push(["operation-record", await get(`/operations/${k}`)]);
      for (const [name, doc] of items) {
        const r = await py([check, "--instance", name], {}, JSON.stringify(doc));
        assert.equal(r.code, 0, `${name}: ${r.stdout}${r.stderr}`);
      }
    });
  });

  it("the contract driver at the pinned commit (TT_CONTRACT_DIR)", { skip: CONTRACT_DIR ? false : "set TT_CONTRACT_DIR to a checkout of the contract at the pinned commit" }, async () => {
    for (const [defects, expected] of [[{}, { A1: "pass", A2: "pass", A3: "pass", A4: "pass", A5: "unproven" }], [{ keyDropped: true }, { A1: "fail", A2: "fail" }]] as const) {
      await withFake({ defects }, async (f, env) => {
        const out = await selfcheck(await configFor(f.stateLine, env), env, ["--driver", CONTRACT_DIR!]);
        assert.equal(out.driver.commit_matches_pin, true);
        for (const [a, v] of Object.entries(expected)) assert.equal(out.verdicts[a], v, `${a} on ${JSON.stringify(defects)}`);
        assert.deepEqual(out.self_attested, ["A3"]);
      });
    }
  });

  it("copy rules: the new harness, verifier and generator files name no AI vendor and use no grading words for results", () => {
    const files = [...readdirSync(HARNESS).filter((f) => f.endsWith(".py") || f.endsWith(".json")).map((f) => join(HARNESS, f)),
      join(HARNESS, "adapters", "tiny_tracker.py"), join(ROOT, "src", "fx-check.ts"), join(ROOT, "expected", "generate.mjs"),
      join(ROOT, "verify", "python", "tt_recount.py"), join(ROOT, "verify", "python", "test_tt_recount.py")];
    for (const file of files) {
      const text = readFileSync(file, "utf8").replace(/get\("score"\)/g, "");
      assert.doesNotMatch(text, /\b(compliant|certified|badge|scored?|scores)\b/i, file);
      assert.doesNotMatch(text, /\b(openai|anthropic|claude|gpt-?\d|gemini|grok|chatgpt|fable)\b/i, file);
    }
  });
});
