// Phase 0 foundations that need no fixture layer: profiles and features, the
// compatibility table (pairwise through the command line), defects'
// `requires`, the backend defect registry, the defect placement map, the
// fixture property names and the strict-input backend rules.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeFeatures, FEATURES, parseFeatures, parseProfile, PROFILE_FEATURES, SettingError } from "../src/profile.js";
import { checkCompat, COMPAT_RULES, type Combination } from "../src/compat.js";
import { DEFECTS, resolveDefects } from "../src/defects/index.js";
import type { Defect } from "../src/defects/types.js";
import { BACKEND_DEFECTS, BACKEND_SEAMS, backendBanner, backendDefectRefusals, type BackendDefect } from "../src/backend/defects/index.js";
import { placementMap, PLANNED_DEFECTS, PLANNED_VARIANTS, plannedSeams } from "../src/defect-placement.js";
import { FIXTURE_PROPERTIES, HEADERS, LRT_ASSERTIONS, META_KEYS } from "../src/fixture-properties.js";
import { REQUIREMENTS } from "../src/requirements.js";
import { FAULT_POINTS } from "../src/fault-points.js";
import { VARIANTS } from "../src/variants/index.js";
import { startBackend } from "../src/start.js";
import { Rest } from "./support/stack.js";
import { runCli } from "./support/cli-run.js";

describe("profiles and features", () => {
  it("PACKAGE_VERSION is the package.json version", async () => {
    const { PACKAGE_VERSION } = await import("../src/profile.js");
    const { readFileSync } = await import("node:fs");
    assert.equal(PACKAGE_VERSION, JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  });

  it("profile 0.1 and the Phase 0 default turn on no feature", () => {
    assert.deepEqual(PROFILE_FEATURES["0.1"], []);
    assert.deepEqual(PROFILE_FEATURES.default, []);
    assert.equal(parseProfile(undefined), "default");
    assert.equal(parseProfile("0.1"), "0.1");
    assert.throws(() => parseProfile("0.2"), SettingError);
  });

  it("feature lists are strict: unknown names stop, duplicates collapse", () => {
    assert.deepEqual(parseFeatures(" evidence , strict-input,evidence"), ["evidence", "strict-input"]);
    assert.throws(() => parseFeatures("evidense"), /unknown feature/);
    assert.throws(() => parseFeatures(","), SettingError);
    assert.deepEqual(activeFeatures("default", ["evidence"]), ["evidence"]);
    for (const f of FEATURES) assert.match(f.since, /^0\.[2-4]\.0$/, f.name);
  });

  it("a feature not built yet, an unknown feature or a feature under profile 0.1 stops the command line (exit 2)", async () => {
    const unbuilt = await runCli(["all", "--features", "lookup"]);
    assert.equal(unbuilt.code, 2);
    assert.match(unbuilt.stderr, /not built in this version: lookup \(arrives in 0\.2\.0\)/);
    assert.equal(unbuilt.stdout, "");
    const unknown = await runCli(["all"], { TRACKER_FEATURES: "nope" });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown feature/);
    const frozen = await runCli(["all", "--profile", "0.1", "--features", "strict-input"]);
    assert.equal(frozen.code, 2);
    assert.match(frozen.stderr, /profile 0\.1 is the 0\.1\.0 surface and takes no features/);
    const badProfile = await runCli(["all", "--profile", "latest"]);
    assert.equal(badProfile.code, 2);
    const dataDir = await runCli(["all", "--data-dir", tmpdir()]);
    assert.equal(dataDir.code, 2);
    assert.match(dataDir.stderr, /--data-dir has no effect without the durable feature/);
  });
});

/** All pairs of factor levels covered by a small set of combinations (greedy, deterministic). */
function pairwise<T extends Record<string, readonly unknown[]>>(factors: T): Array<{ [K in keyof T]: T[K][number] }> {
  const names = Object.keys(factors);
  const key = (a: string, i: number, b: string, j: number) => `${a}=${i}|${b}=${j}`;
  const uncovered = new Set<string>();
  for (let x = 0; x < names.length; x++) for (let y = x + 1; y < names.length; y++) {
    for (let i = 0; i < factors[names[x]].length; i++) for (let j = 0; j < factors[names[y]].length; j++) uncovered.add(key(names[x], i, names[y], j));
  }
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows: number[][] = [];
  while (uncovered.size > 0) {
    let best: number[] = [];
    let bestGain = -1;
    for (let c = 0; c < 60; c++) {
      const row = names.map((n) => Math.floor(rand() * factors[n].length));
      let gain = 0;
      for (let x = 0; x < names.length; x++) for (let y = x + 1; y < names.length; y++) if (uncovered.has(key(names[x], row[x], names[y], row[y]))) gain++;
      if (gain > bestGain) { best = row; bestGain = gain; }
    }
    for (let x = 0; x < names.length; x++) for (let y = x + 1; y < names.length; y++) uncovered.delete(key(names[x], best[x], names[y], best[y]));
    rows.push(best);
  }
  return rows.map((row) => Object.fromEntries(names.map((n, i) => [n, factors[n][row[i]]]))) as never;
}

describe("the compatibility table (src/compat.ts)", () => {
  it("rule ids are unique; profile 0.1 is exempt only from post-0.1 rules", () => {
    assert.equal(new Set(COMPAT_RULES.map((r) => r.id)).size, COMPAT_RULES.length);
    const c: Combination = { layout: "server", profile: "0.1", features: [], defects: [], backendDefects: ["lost-update"], variants: [], faults: [], fixtureControl: false };
    assert.deepEqual(checkCompat(c), [], "0.1.0 started `server --backend-defect`; profile 0.1 still does");
    assert.equal(checkCompat({ ...c, profile: "default" }).length, 1);
  });

  it("knows the illegal pairs the review names", () => {
    const base: Combination = { layout: "all", profile: "default", features: [], defects: [], backendDefects: [], variants: [], faults: [], fixtureControl: false };
    assert.match(checkCompat({ ...base, features: ["durable"] }).join(), /durable feature needs --data-dir/);
    assert.match(checkCompat({ ...base, features: ["lookup"], variants: ["key-store-honest"] }).join(), /key-store-honest/);
    assert.match(checkCompat({ ...base, faults: ["crash-between-effect-and-record"] }).join(), /meaningful only with one of/);
    assert.deepEqual(checkCompat({ ...base, faults: ["crash-between-effect-and-record"], variants: ["key-store-honest"] }).filter((m) => /meaningful/.test(m)), []);
    assert.match(checkCompat({ ...base, faults: ["crash-after-commit"] }).join(), /named by point now/);
    assert.match(checkCompat({ ...base, faults: ["mcp/after-backend-reply/drop"] }).join(), /no fault can be armed in this version/);
    assert.match(checkCompat({ ...base, faults: ["backend/after-backend-reply/drop"] }).join(), /unknown fault point/);
  });

  const factors = {
    layout: ["all", "server", "backend"],
    profile: ["0.1", "default"],
    features: [[], ["strict-input"], ["evidence"], ["evidence", "strict-input"], ["lookup"]],
    control: [false, true],
    defects: [[], ["read-merge-put"], ["all"]],
    variant: [false, true],
    backendDefect: [false, true],
  } as const;
  const combos = pairwise(factors);

  it(`the command line agrees with the table on a pairwise set (${combos.length} combinations)`, { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-compat-"));
    try {
      let started = 0;
      let refused = 0;
      for (const c of combos) {
        const args: string[] = [c.layout, "--profile", c.profile];
        if (c.features.length) args.push("--features", c.features.join(","));
        if (c.control) args.push("--fixture-control", "--control-port", "4652");
        for (const d of c.defects) args.push("--defect", d);
        if (c.backendDefect) args.push("--backend-defect", "lost-update");
        args.push("--port", "4650");
        if (c.layout === "all") args.push("--backend-port", "4651");
        const env: Record<string, string> = {
          TRACKER_BACKEND_TOKEN: "backend-token-compat-0000000000",
          TRACKER_EVIDENCE_TOKEN: "evidence-token-compat-000000000",
          TRACKER_CONTROL_TOKEN: "control-token-compat-0000000000",
        };
        if (c.layout === "server") env.TRACKER_BACKEND_URL = "http://127.0.0.1:4651";
        if (c.variant) Object.assign(env, { TRACKER_VARIANTS: "key-store-honest", TRACKER_KEY_JOURNAL: join(dir, `keys-${started + refused}`) });
        const defects = c.layout === "backend" ? [] : resolveDefects([...c.defects]).map((d) => d.name);
        const expected = checkCompat({
          layout: c.layout, profile: c.profile, features: [...c.features], defects, backendDefects: c.backendDefect ? ["lost-update"] : [],
          variants: c.variant ? ["key-store-honest"] : [], faults: [], fixtureControl: c.control,
        });
        const r = await runCli(args, env);
        const label = `${args.join(" ")} (expected: ${expected.join("; ") || "starts"})`;
        if (expected.length) {
          refused++;
          assert.equal(r.code, 2, `${label}: ${r.stderr}`);
          assert.equal(r.stdout, "", label);
          assert.ok(r.stderr.includes(expected[0]), `${label}: ${r.stderr}`);
        } else {
          started++;
          assert.ok(r.stateLine, `${label}: ${r.stderr}`);
          assert.equal(r.code, 0, label);
          if (c.profile === "0.1") assert.equal(r.stateLine.profile, undefined, "profile 0.1 keeps the 0.1.0 state line");
        }
        for (const t of Object.values(env)) if (/token/.test(t)) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t), `${label}: a token was printed`);
      }
      assert.ok(started > 3 && refused > 3, `started ${started}, refused ${refused}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defects: requires and --defect all", () => {
  it("no existing defect needs a feature, so --defect all is unchanged", () => {
    assert.equal(DEFECTS.filter((d) => d.requires?.length).length, 0);
    assert.equal(resolveDefects(["all"]).length, DEFECTS.length);
    assert.equal(DEFECTS.length, 47);
  });

  it("all and a requirement ID take only defects valid for the active features; a named one with missing features stops", () => {
    const fake: Defect = { name: "fake-needs-lookup", requirement: "MWS-RETRY-2", summary: "", mirrors: "", replaces: "", requires: ["lookup"], apply() {} };
    DEFECTS.push(fake);
    try {
      assert.ok(!resolveDefects(["all"]).includes(fake));
      assert.ok(!resolveDefects(["MWS-RETRY-2"]).includes(fake));
      assert.ok(resolveDefects(["all"], ["lookup"]).includes(fake));
      assert.throws(() => resolveDefects(["fake-needs-lookup"]), /needs the feature\(s\) lookup/);
      assert.deepEqual(resolveDefects(["fake-needs-lookup"], ["lookup"]), [fake]);
    } finally {
      DEFECTS.pop();
    }
  });
});

describe("the backend defect registry (G5)", () => {
  it("every registered backend defect replaces wired seams only and names its context", () => {
    for (const d of BACKEND_DEFECTS) {
      assert.ok(d.seams.length > 0 && d.seams.every((s) => BACKEND_SEAMS[s].wired), d.name);
      assert.ok(d.context in REQUIREMENTS || d.context in FIXTURE_PROPERTIES, d.name);
    }
    assert.equal(backendBanner(["lost-update"]), "backend defects on: backend:lost-update");
  });

  it("refusal rules: unknown name, a seam not built, missing features, a non-loopback bind", () => {
    assert.match(backendDefectRefusals(["nope"], { features: [] }).join(), /unknown backend defect "nope"; known: lost-update/);
    const fake: BackendDefect = { name: "fake-digest", summary: "", context: "FX-DIG-1", seams: ["digest"], requires: ["execution-records"], apply() {} };
    BACKEND_DEFECTS.push(fake);
    try {
      const r = backendDefectRefusals(["fake-digest"], { features: [] }).join("\n");
      assert.match(r, /seam\(s\) not built in this version: digest/);
      assert.match(r, /needs the feature\(s\) execution-records/);
    } finally {
      BACKEND_DEFECTS.pop();
    }
    assert.match(backendDefectRefusals(["lost-update"], { features: [], host: "0.0.0.0" }).join(), /binds 127\.0\.0\.1 only/);
    assert.deepEqual(backendDefectRefusals(["lost-update"], { features: [], host: "127.0.0.1" }), []);
  });

  it("a backend defect build prints its banner in the backend process too", async () => {
    const r = await runCli(["backend", "--backend-defect", "lost-update", "--port", "4653"], { TRACKER_BACKEND_TOKEN: "backend-token-banner-0000000000" });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /BROKEN BUILD.*backend:lost-update/);
  });
});

describe("the defect placement map (B11)", () => {
  const map = placementMap();

  it("every MCP-layer defect lands somewhere, and every placement names a real piece", () => {
    for (const d of DEFECTS) assert.ok(map.byDefect[d.name].length > 0, `${d.name} changes nothing`);
    for (const p of Object.keys(map.byPlacement)) assert.match(p, /^(tool:[a-z_]+\.(handler|description|input|annotations|mutates)|validation:\w+|config:\w+|backend:\w+)$/);
  });

  it("finds the overlaps the README describes: the MWS-RETRY-2 defects share create_ticket, two defects share bulk_update_tickets", () => {
    const create = map.byPlacement["tool:create_ticket.handler"];
    for (const d of ["idempotency-key-dropped", "retry-without-key", "key-store-in-memory", "idempotency-key-ignores-args"]) assert.ok(create.includes(d), d);
    const bulk = map.byPlacement["tool:bulk_update_tickets.handler"];
    assert.ok(bulk.includes("shape-missing-failed") && bulk.includes("bulk-misreports-partial"));
    assert.ok(map.byDefect["no-idempotency-key"].some((p) => p.startsWith("tool:add_comment")));
    assert.deepEqual(map.byDefect["backend:lost-update"], ["backend:patchTicket"]);
  });

  it("planned defects: known features, known variants, known seams, known IDs, unique names", () => {
    const featureNames = FEATURES.map((f) => f.name) as string[];
    const variantNames = [...VARIANTS, ...PLANNED_VARIANTS.map((v) => v.name)] as string[];
    const names = new Set<string>();
    for (const d of PLANNED_DEFECTS) {
      assert.ok(!names.has(d.name) && !DEFECTS.some((x) => x.name === d.name), d.name);
      names.add(d.name);
      for (const r of d.requires) {
        if (r.startsWith("variant:")) assert.ok(variantNames.includes(r.slice(8)), `${d.name}: ${r}`);
        else assert.ok(featureNames.includes(r), `${d.name}: ${r}`);
      }
      assert.ok(d.requires.length > 0, `${d.name} needs at least one feature`);
      for (const t of d.trips) assert.ok(t in FIXTURE_PROPERTIES || t in REQUIREMENTS, `${d.name}: ${t}`);
      for (const p of d.placement) assert.match(p, /^(tool:[a-z_]+|backend:\w+)$/);
    }
    for (const s of plannedSeams()) assert.ok(s in BACKEND_SEAMS, s);
    // Several planned defects land on create_ticket: the overlap list for --defect all must be kept when they arrive.
    assert.ok(PLANNED_DEFECTS.filter((d) => d.placement.includes("tool:create_ticket")).length >= 3);
  });

  it("names on the wire follow decision 11; every FX- property is claimed by a planned defect or is an oracle property", () => {
    assert.equal(META_KEYS.idempotencyKey, "dev.writesafety.tiny-tracker/idempotency-key");
    for (const h of Object.values(HEADERS)) assert.match(h, /^Tiny-Tracker-[A-Z][A-Za-z-]+$/);
    assert.deepEqual(Object.keys(LRT_ASSERTIONS), ["LRT-A1", "LRT-A2", "LRT-A3", "LRT-A4", "LRT-A5"]);
    const claimed = new Set(PLANNED_DEFECTS.flatMap((d) => d.trips));
    const oracle = ["FX-FLT-1", "FX-BLD-1"];
    for (const id of Object.keys(FIXTURE_PROPERTIES)) assert.ok(claimed.has(id as never) || oracle.includes(id), id);
    for (const p of FAULT_POINTS) assert.equal(p.id, `${p.process}/${p.position}/${p.action}`);
  });
});

describe("strict-input (rules 5 and 10): the backend checks keys and strings itself", () => {
  it("with the feature: a malformed key and a lone surrogate are refused, nothing is written", async () => {
    const backend = await startBackend({ token: "backend-token-strict-000000000", port: 4654, features: ["strict-input"] });
    try {
      const api = new Rest(backend.url, "backend-token-strict-000000000");
      const shortKey = await api.send("POST", "/tickets", { title: "a" }, { "idempotency-key": "short" });
      assert.equal(shortKey.status, 400);
      assert.equal(shortKey.body.error, "bad_idempotency_key");
      const badChar = await api.send("POST", "/tickets", { title: "a" }, { "idempotency-key": "has space in it" });
      assert.equal(badChar.status, 400);
      const lone = await fetch(`${backend.url}/tickets`, {
        method: "POST", headers: { authorization: "Bearer backend-token-strict-000000000", "content-type": "application/json" },
        body: '{"title":"bad \\ud800 title"}',
      });
      assert.equal(lone.status, 400);
      assert.deepEqual(await lone.json(), { error: "not_well_formed", message: "the string at /title is not well-formed Unicode (a lone surrogate); nothing was written", field: "/title" });
      assert.equal((await api.export()).tickets.length, 0);
      const ok = await api.send("POST", "/tickets", { project: "inbox", title: "ok 😀" }, { "idempotency-key": "good-key-0001" });
      assert.equal(ok.status, 201);
    } finally {
      await backend.close();
    }
  });

  it("without it (profile 0.1, and the Phase 0 default) the backend accepts what 0.1.0 accepted", async () => {
    const backend = await startBackend({ token: "backend-token-lenient-00000000", port: 4655 });
    try {
      const api = new Rest(backend.url, "backend-token-lenient-00000000");
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "short" })).status, 201);
    } finally {
      await backend.close();
    }
  });
});
