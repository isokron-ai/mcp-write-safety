// Stream C: the known-answer generator (expected/generate.mjs, R9) on builds that start today, and the shape of the
// 0.2.0 build list. The 0.2.0 file itself is generated once streams A and B are merged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

  it("the 0.3.0 known answers cover every 0.2.0 build and are keyed by the 0.3.0 package", () => {
    const list = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.3.0.json"), "utf8"));
    const old = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.2.0.json"), "utf8"));
    const labels = list.builds.map((b: any) => b.label);
    for (const b of old.builds) assert.ok(labels.includes(b.label), b.label);
    const doc = JSON.parse(readFileSync(join(ROOT, "expected", "0.3.0.json"), "utf8"));
    assert.equal(doc.package.version, "0.3.0");
    assert.equal(doc.package.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    assert.deepEqual(doc.builds.map((b: any) => b.label).sort(), [...labels].sort());
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
});
