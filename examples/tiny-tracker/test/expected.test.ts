// Stream C: the known-answer generator (expected/generate.mjs, R9) on builds that start today, and the shape of the
// 0.2.0 build list. The 0.2.0 file itself is generated once streams A and B are merged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FEATURE_NAMES } from "../src/profile.js";
import { py } from "./support/python.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GATE = process.env.TT_GATE === "1";
const jsonschema = spawnSync("python3", ["-I", "-c", "import jsonschema, referencing"]).status === 0;
const needJsonschema = jsonschema || GATE ? false : "the Python jsonschema package is not installed";

describe("known-answer generator (expected/)", () => {
  for (const release of ["0.2.0", "0.3.0"]) {
    it(`the ${release} build list names known features, unique labels, and no ports or tokens`, () => {
      const list = JSON.parse(readFileSync(join(ROOT, "expected", `builds-${release}.json`), "utf8"));
      assert.equal(list.release, release);
      const labels = list.builds.map((b: any) => b.label);
      assert.equal(new Set(labels).size, labels.length);
      assert.ok(labels.includes("correct build"));
      for (const b of list.builds) {
        const features = b.args[b.args.indexOf("--features") + 1].split(",");
        for (const f of features) assert.ok((FEATURE_NAMES as string[]).includes(f), f);
        // A port or token setting, or a port number (a defect name may hold "port", as in-progress-reported-not-applied does).
        assert.ok(!b.args.some((a: string) => /^--[\w-]*(port|token)/i.test(a) || /^\d{2,5}$/.test(a)), b.label);
      }
    });
  }

  it("the 0.3.0 known answers cover every 0.2.0 build", () => {
    const list = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.3.0.json"), "utf8"));
    const old = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.2.0.json"), "utf8"));
    const labels = list.builds.map((b: any) => b.label);
    for (const b of old.builds) assert.ok(labels.includes(b.label), b.label);
    const doc = JSON.parse(readFileSync(join(ROOT, "expected", "0.3.0.json"), "utf8"));
    assert.deepEqual(doc.builds.map((b: any) => b.label).sort(), [...labels].sort());
  });

  // A release's known answers reproduce at its own tag (CONTRIBUTING, docs/STABILITY.md): expected/0.3.0.json at
  // tiny-tracker-v0.3.0, and so on. Only the newest file is this tree's to regenerate and check; an older one is the
  // record of what its release answered, so nothing here compares it with this tree (its build_hash covers an older
  // package version).
  it("each expected/<v>.json names version <v>, and the newest is this package's version (the own-tag rule)", () => {
    const semver = (a: string, b: string) => {
      const [x, y] = [a, b].map((v) => v.split(".").map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    };
    assert.deepEqual(["0.10.0", "1.0.0", "0.9.0"].sort(semver), ["0.9.0", "0.10.0", "1.0.0"]);
    const versions = readdirSync(join(ROOT, "expected")).filter((f) => /^\d+\.\d+\.\d+\.json$/.test(f)).map((f) => f.slice(0, -".json".length)).sort(semver);
    for (const v of ["0.2.0", "0.3.0"]) assert.ok(versions.includes(v), `expected/${v}.json is kept`);
    for (const v of versions) {
      assert.equal(JSON.parse(readFileSync(join(ROOT, "expected", `${v}.json`), "utf8")).package.version, v, `expected/${v}.json`);
      assert.equal(JSON.parse(readFileSync(join(ROOT, "expected", `builds-${v}.json`), "utf8")).release, v, `expected/builds-${v}.json`);
      assert.ok(readFileSync(join(ROOT, "expected", `${v}.md`), "utf8").startsWith(`# Known answers for tiny-tracker ${v}\n`), `expected/${v}.md`);
    }
    assert.equal(versions.at(-1), JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, "the newest known answers are this release's");
  });

  it("the 0.3.0 known answers name the defects they cannot tell from the correct build (follow-up F1)", () => {
    const list = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.3.0.json"), "utf8"));
    const doc = JSON.parse(readFileSync(join(ROOT, "expected", "0.3.0.json"), "utf8"));
    const md = readFileSync(join(ROOT, "expected", "0.3.0.md"), "utf8");
    const undetected = ["backend defect key-expires-early", "defect in-progress-reported-not-applied", "defect settle-miss-reported-not-applied"];
    assert.equal(doc.not_detected, list.not_detected, "the generator carries the build list's statement");
    assert.ok(md.split("\n## ")[0].includes(list.not_detected), "the table states it in its header");
    for (const name of ["key-expires-early", "in-progress-reported-not-applied", "settle-miss-reported-not-applied", "FX-KEY-1", "MWS-RES-1", "MWS-RES-2"]) {
      assert.ok(list.not_detected.includes(name), name);
    }
    // The statement is true of the file: these rows are exactly the correct build's answers.
    const row = (label: string) => doc.builds.find((b: any) => b.label === label);
    const answers = (b: any) => ({ fixture: b.fixture, contract: b.contract?.answers });
    for (const label of undetected) assert.deepEqual(answers(row(label)), answers(row("correct build")), label);
    // The 0.2.0 list has no such statement, so its file is unchanged.
    assert.equal(JSON.parse(readFileSync(join(ROOT, "expected", "0.2.0.json"), "utf8")).not_detected, undefined);
  });

  // 0.4.0: the same statement as 0.3.0's follow-up F1, written by the selector from one entry per defect, each with its
  // reason (NOT_DETECTED in expected/select-0.4.0.mjs).
  it("the 0.4.0 known answers name the two MCP-layer defects they cannot tell from the build without them", async () => {
    const select = await import(pathToFileURL(join(ROOT, "expected", "select-0.4.0.mjs")).href);
    const list = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.4.0.json"), "utf8"));
    const doc = JSON.parse(readFileSync(join(ROOT, "expected", "0.4.0.json"), "utf8"));
    const md = readFileSync(join(ROOT, "expected", "0.4.0.md"), "utf8");
    const undetected = ["in-progress-reported-not-applied", "settle-miss-reported-not-applied"];
    assert.deepEqual(select.NOT_DETECTED.map((e: any) => e.defect), undetected);
    assert.equal(list.not_detected, select.notDetectedStatement(select.NOT_DETECTED), "the selector writes the statement");
    assert.match(list.note, /see not_detected/, "the note points to it");
    assert.equal(doc.not_detected, list.not_detected, "the generator carries the build list's statement");
    assert.ok(md.split("\n## ")[0].includes(list.not_detected), "the table states it in its header");
    for (const name of [...undetected, "MWS-RES-1", "MWS-RES-2", "FX-KEY-3"]) assert.ok(list.not_detected.includes(name), name);
    for (const e of select.NOT_DETECTED) assert.ok(list.not_detected.includes(`${e.defect}: ${e.reason}`), `${e.defect} has its reason`);
    // The statement is true of the file: no row with either defect is run by the contract driver, and each has the
    // fixture answers of its twin (same level, backend defect and variant, no MCP-layer defect) where the matrix has one.
    const rows = new Map(doc.builds.map((b: any) => [b.label, b]));
    const twinKey = (f: any) => `${f.level}/${f.backend}/${f.variant}`;
    const twins = new Map(list.builds.filter((b: any) => b.factors.mcp === "-").map((b: any) => [twinKey(b.factors), b.label]));
    for (const defect of undetected) {
      const withIt = list.builds.filter((b: any) => b.factors.mcp === defect);
      assert.ok(withIt.length > 0, defect);
      let compared = 0;
      for (const b of withIt) {
        assert.equal(b.contract, false, b.label);
        assert.equal((rows.get(b.label) as any).contract, undefined, b.label);
        const twin = twins.get(twinKey(b.factors));
        if (twin === undefined) continue;
        assert.deepEqual((rows.get(b.label) as any).fixture, (rows.get(twin) as any).fixture, `${b.label} answers as ${twin}`);
        compared++;
      }
      assert.ok(compared > 0, `${defect}: at least one row has a twin to compare with`);
    }
  });

  it("a not_detected entry without a reason is refused: by the selector, and by the generator before any build runs", async () => {
    const select = await import(pathToFileURL(join(ROOT, "expected", "select-0.4.0.mjs")).href);
    for (const e of select.NOT_DETECTED) assert.ok(typeof e.reason === "string" && e.reason.trim() !== "", e.defect);
    assert.throws(() => select.notDetectedStatement([{ defect: "in-progress-reported-not-applied" }]), /in-progress-reported-not-applied has no reason/);
    assert.throws(() => select.notDetectedStatement([{ defect: "settle-miss-reported-not-applied", reason: "  " }]), /settle-miss-reported-not-applied has no reason/);
    assert.throws(() => select.notDetectedStatement([{ reason: "a reason for no defect" }]), /names no defect/);
    assert.throws(() => select.notDetectedStatement([]), /no entries/);
    const one = select.notDetectedStatement([{ defect: "a-defect", reason: "it needs a call nothing makes" }], "9.9.9");
    assert.ok(one.startsWith("Not detected in 9.9.9: a-defect."), one);
    assert.ok(one.includes("a-defect: it needs a call nothing makes."), one);
    // The generator takes the statement as the build list holds it (a string, as 0.3.0's F1 does) and refuses any other
    // shape, an entry without its reason included, before it starts a build.
    const gen = await import(pathToFileURL(join(ROOT, "expected", "generate.mjs")).href);
    const dir = mkdtempSync(join(tmpdir(), "tt-not-detected-"));
    try {
      for (const bad of ["", "   ", [{ defect: "in-progress-reported-not-applied" }], { defect: "x", reason: "y" }, 7]) {
        const builds = join(dir, "builds.json");
        writeFileSync(builds, JSON.stringify({ release: "9.9.9", note: "test", not_detected: bad, builds: [] }));
        await assert.rejects(gen.generate({ builds }), /not_detected/, JSON.stringify(bad));
      }
      const builds = join(dir, "builds.json");
      writeFileSync(builds, JSON.stringify({ release: "9.9.9", note: "test", not_detected: "Not detected in 9.9.9: a-defect.", builds: [] }));
      assert.equal((await gen.generate({ builds })).not_detected, "Not detected in 9.9.9: a-defect.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates schema-valid, time-free answers keyed by build_hash, the same on every run", { skip: needJsonschema }, async () => {
    assert.ok(jsonschema, "TT_GATE=1 needs python3 with jsonschema and referencing");
    const gen = await import(pathToFileURL(join(ROOT, "expected", "generate.mjs")).href);
    const builds = join(ROOT, "expected", "builds-test.json");
    const a = await gen.generate({ builds, repeat: 2 });
    const b = await gen.generate({ builds, only: ["evidence only"] });
    assert.equal(a.builds.length, 2);
    assert.deepEqual(a.builds.find((x: any) => x.label === "evidence only"), b.builds[0], "a second generation gives the same row");
    for (const row of a.builds) {
      assert.match(row.build_hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(row.fixture["FX-BLD-1"], ["held"]);
      assert.equal(row.contract, undefined, "no contract answers without --contract-dir");
    }
    assert.notEqual(a.builds[0].build_hash, a.builds[1].build_hash, "each build has its own key");
    const text = JSON.stringify(a);
    assert.doesNotMatch(text, /20\d\d-\d\d-\d\dT|127\.0\.0\.1/, "nothing depends on the time or the ports");
    const check = await py([join(ROOT, "verify", "python", "check_schemas.py"), "--instance", "expected"], {}, text);
    assert.equal(check.code, 0, check.stdout + check.stderr);
    assert.match(gen.table(a), /^# Known answers for tiny-tracker 0\.1\.0/);
  });

  it("writes the two-principal file whenever principals are in effect, so FX-LOOK-3 is checked on the Lv rows (note 19 item 6)", async () => {
    const gen = await import(pathToFileURL(join(ROOT, "expected", "generate.mjs")).href);
    // Named, or from the default profile (the Lv level), yes; profile 0.1 or a list that leaves it out, no.
    assert.equal(gen.principalsInEffect(["--features", "evidence,principals"]), true);
    assert.equal(gen.principalsInEffect(["--features", "evidence,strict-input,ledger,faults"]), true);
    assert.equal(gen.principalsInEffect(["--profile", "0.1"]), false);
    assert.equal(gen.principalsInEffect(["--profile=0.1"]), false);
    const run = await gen.startBuild(["--features", "evidence,strict-input,ledger,faults"]);
    try {
      assert.ok(run.env.TRACKER_BACKEND_TOKENS_FILE, "the Lv build gets the principals file");
      const { fxCheck } = await import("../src/fx-check.js");
      const r = await fxCheck({ backend: run.state.backend, mcp: run.state.mcp, control: run.state.control, tokens: run.tokens, probe: true });
      const look3 = r.findings.find((f) => f.id === "FX-LOOK-3")!;
      assert.equal(look3.verdict, "held", look3.reason);
    } finally {
      await run.stop();
    }
  });
});
