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
  it("the 0.2.0 build list names known features, unique labels, and no ports or tokens", () => {
    const list = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.2.0.json"), "utf8"));
    assert.equal(list.release, "0.2.0");
    const labels = list.builds.map((b: any) => b.label);
    assert.equal(new Set(labels).size, labels.length);
    assert.ok(labels.includes("correct build"));
    for (const b of list.builds) {
      const features = b.args[b.args.indexOf("--features") + 1].split(",");
      for (const f of features) assert.ok((FEATURE_NAMES as string[]).includes(f), f);
      assert.ok(!b.args.some((a: string) => /port|token/i.test(a)), b.label);
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
});
