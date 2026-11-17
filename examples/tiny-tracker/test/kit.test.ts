// The 0.4.0 contract kit's files, checked as text: the container image keeps
// the X1 rules, the CI workflow covers the platforms and Node versions it
// promises (C6), the reproducibility check compares runs (T5), and the
// published documents exist and use the frozen names. No container runtime or
// workflow runner is needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareRuns, GENERATORS } from "./repro-known-answers.js";
import { COMPAT_RULES } from "../src/compat.js";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(p, "utf8");

describe("the container image (Dockerfile)", () => {
  const df = read(root("Dockerfile"));
  const lines = df.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  const body = lines.join("\n");

  it("runs in container mode, as an unprivileged user, with the CLI as entry point", () => {
    assert.match(body, /^ENV [\s\S]*TRACKER_CONTAINER=1/m);
    assert.match(body, /^USER node$/m);
    assert.match(body, /^ENTRYPOINT \["tiny-tracker"\]$/m);
    assert.match(body, /^CMD \["all", "--port", "47310"\]$/m);
    assert.match(body, /^EXPOSE 47310$/m);
  });

  it("bakes in no token and puts none on the command line", () => {
    assert.doesNotMatch(body, /TRACKER_(MCP|BACKEND|EVIDENCE|CONTROL)_TOKEN\s*=/);
    assert.doesNotMatch(body, /ARG .*TOKEN/);
  });

  it("installs the npm tarball with production dependencies only, and makes 0700 data and token dirs", () => {
    assert.match(body, /npm pack/);
    assert.match(body, /npm install -g --omit=dev --ignore-scripts/);
    assert.match(body, /install -d -m 0700 -o node -g node \/data \/tokens/);
  });

  it("documents loopback publishing and its own test status", () => {
    assert.match(df, /-p 127\.0\.0\.1:47310:47310/);
    assert.match(df, /not built or run by the fixture's own test suite/);
  });

  it("the build context leaves out local installs and builds", () => {
    const ignore = read(root(".dockerignore")).split("\n");
    for (const e of ["node_modules", "dist"]) assert.ok(ignore.includes(e), e);
  });
});

describe("the CI workflow (.github/workflows/tiny-tracker.yml)", () => {
  const wf = read(repo(".github/workflows/tiny-tracker.yml"));

  it("tests Linux, macOS and Windows with Node 22 and 24", () => {
    assert.match(wf, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
    assert.match(wf, /node: \["22", "24"\]/);
    assert.match(wf, /TT_GATE: "1"/);
  });

  it("runs only for tiny-tracker, with a read-only token and pinned actions", () => {
    assert.match(wf, /paths:\n\s+- "examples\/tiny-tracker\/\*\*"/);
    assert.match(wf, /^permissions:\n\s+contents: read$/m);
    assert.doesNotMatch(wf, /secrets\./);
    assert.doesNotMatch(wf, /id-token/);
    for (const m of wf.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned by commit`);
  });

  it("checks known-answer reproducibility and the container start refusal", () => {
    assert.match(wf, /node dist\/test\/repro-known-answers\.js --runs 3/);
    assert.match(wf, /docker build/);
    assert.match(wf, /expected exit 2 without a token/);
  });
});

describe("known-answer reproducibility (test/repro-known-answers.ts)", () => {
  it("reports every run that differs from the first, and nothing when all agree", () => {
    assert.deepEqual(compareRuns([{ run: 0, sha256: "a" }, { run: 1, sha256: "a" }, { run: 2, sha256: "a" }]), []);
    const diff = compareRuns([{ run: 0, sha256: "a" }, { run: 1, sha256: "b" }, { run: 2, sha256: "a" }]);
    assert.equal(diff.length, 1);
    assert.match(diff[0], /run 1 differs from run 0/);
    assert.deepEqual(compareRuns([]), ["no runs"]);
  });

  it("has the surface generator registered", () => {
    assert.ok(GENERATORS.some((g) => g.name === "surface"));
  });
});

describe("the kit's documents", () => {
  for (const p of ["CONTRIBUTING.md", "docs/patterns.md", "docs/STABILITY.md", "openapi.yaml"]) {
    it(`${p} exists and names no result as compliant, certified or passing`, () => {
      assert.ok(existsSync(root(p)), p);
      const text = read(root(p));
      assert.doesNotMatch(text, /\b(compliant|certified|badge)\b/i);
      assert.doesNotMatch(text, /\bscore[sd]?\b/i);
    });
  }

  it("the OpenAPI file declares every evidence and control path and the 501 shape", () => {
    const api = read(root("openapi.yaml"));
    assert.match(api, /^openapi: 3\.1\.\d+$/m);
    for (const path of ["/projects:", "/tickets:", "/tickets/{id}:", "/batch:", "/export:", "/build:", "/ledger:", "/executions/{id}:",
      "/operations/{key}:", "/_fixture/runs:", "/_fixture/runs/{run}/reset:", "/_fixture/faults:", "/_fixture/clock:"]) {
      assert.ok(api.includes(`  ${path}`), path);
    }
    assert.match(api, /available_from/);
    assert.match(api, /Tiny-Tracker-Run/);
    assert.match(api, /Status: draft/);
  });

  it("the patterns page lists every MCP-layer defect", async () => {
    const { DEFECTS } = await import("../src/defects/index.js");
    const page = read(root("docs/patterns.md"));
    for (const d of DEFECTS) assert.ok(page.includes(`\`${d.name}\``), `patterns.md misses ${d.name}`);
  });

  it("CONTRIBUTING covers a defect, a fault point and a feature, and the stream F compat rule exists", () => {
    const c = read(root("CONTRIBUTING.md"));
    for (const h of ["## Add a defect", "## Add a fault point", "## Add a feature"]) assert.ok(c.includes(h), h);
    assert.ok(COMPAT_RULES.some((r) => r.id === "CMP-70"));
  });
});
