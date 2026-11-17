// The self-test matrix: every check against the correct build (in both
// protocol eras), and every defect against every check.
//
// For each defect the test shows (1) its requirement is `violated` in the
// broken build, (2) the same check `held` in the correct build, and (3) which
// other checks the defect trips. (3) is compared with ALSO_TRIPS so that a new
// overlap is noticed; the design's goal is that the list stays empty.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFECTS } from "../src/defects/index.js";
import { REQUIREMENT_IDS, type RequirementId } from "../src/requirements.js";
import { CHECKS, runChecks, type Verdict } from "./support/checks.js";

/** Requirements a defect also trips, besides its own. Keep this empty where possible. */
// A meaning-changing conversion is also a conversion (MWS-IN-6); removing data the call did not name is also
// not additive (MWS-ANN-5); an argument dropped silently was also not rejected (MWS-IN-7). Each is the spec's own
// implication, not an overlap between defects.
const ALSO_TRIPS: Record<string, RequirementId[]> = {
  "coerce-types": ["MWS-IN-6"],
  "drop-unknown-args": ["MWS-IN-7"],
  "add-label-replaces-list": ["MWS-ANN-5"],
};

const fixed = new Map<string, Map<RequirementId, Verdict>>();

before(async () => {
  fixed.set("2026-07-28", await runChecks({ era: "2026-07-28" }));
});

describe("every requirement has a check and a defect", () => {
  it("covers all requirement IDs", () => {
    for (const id of REQUIREMENT_IDS) {
      assert.ok(CHECKS.some((c) => c.requirement === id), `no check for ${id}`);
      assert.ok(DEFECTS.some((d) => d.requirement === id), `no defect for ${id}`);
    }
  });

  it("the README's defect table lists every defect with its requirement", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    for (const d of DEFECTS) {
      // A defect that needs a feature is listed in the second table, with its features in the Requires column.
      const row = d.requires?.length ? `| \`${d.name}\` | ${d.requirement} | ${d.requires.join(", ")} |` : `| \`${d.name}\` | ${d.requirement} |`;
      assert.ok(readme.includes(row), `README row missing for ${d.name}: ${row}`);
    }
  });
});

for (const era of ["2026-07-28", "2025-11-25"] as const) {
  describe(`correct build, protocol ${era}`, () => {
    let results: Map<RequirementId, Verdict>;
    before(async () => {
      results = fixed.get(era) ?? await runChecks({ era });
    });
    for (const check of CHECKS) {
      it(`${check.requirement} held: ${check.scenario}`, () => {
        const v = results.get(check.requirement)!;
        assert.equal(v.verdict, "held", v.detail);
      });
    }
  });
}

const matrix: string[] = [];

for (const defect of DEFECTS) {
  describe(`--defect ${defect.name} (${defect.requirement})`, () => {
    let broken: Map<RequirementId, Verdict>;
    before(async () => {
      // A defect that needs features runs with them on (they change nothing for the correct build's checks).
      broken = await runChecks({ defects: [defect.name], features: [...(defect.requires ?? [])] });
    });

    it(`broken build: ${defect.requirement} violated`, () => {
      const v = broken.get(defect.requirement)!;
      assert.equal(v.verdict, "violated", `expected violated, got ${v.verdict}: ${v.detail}`);
    });

    it(`correct build: ${defect.requirement} held`, () => {
      const v = fixed.get("2026-07-28")!.get(defect.requirement)!;
      assert.equal(v.verdict, "held", v.detail);
    });

    it("trips no other requirement beyond the documented list", () => {
      const others = [...broken].filter(([id, v]) => id !== defect.requirement && v.verdict === "violated").map(([id]) => id);
      const notTested = [...broken].filter(([, v]) => v.verdict === "not tested").map(([id, v]) => `${id} (${v.detail})`);
      matrix.push(`${defect.name.padEnd(30)} ${defect.requirement.padEnd(12)} also: ${others.join(", ") || "-"}`
        + `${notTested.length ? `  not tested: ${notTested.join(", ")}` : ""}`);
      assert.deepEqual(others.sort(), [...(ALSO_TRIPS[defect.name] ?? [])].sort(),
        others.map((id) => `${id}: ${broken.get(id)!.detail}`).join("\n"));
    });
  });
}

after(() => {
  if (matrix.length) process.stdout.write(`\n# self-test matrix\n# ${matrix.join("\n# ")}\n`);
});

describe("--defect all (non-masking: no defect hides another)", () => {
  it("every requirement is violated with all defects on", async () => {
    const all = await runChecks({ defects: ["all"] });
    const hidden = REQUIREMENT_IDS.filter((id) => all.get(id)!.verdict !== "violated");
    assert.deepEqual(hidden, [], hidden.map((id) => `${id}: ${all.get(id)!.verdict}: ${all.get(id)!.detail}`).join("\n"));
  });
});
