// The 0.4.0 contract kit's files, checked as text: the container image keeps
// the X1 rules, the CI workflow covers the platforms and Node versions it
// promises (C6), the reproducibility check compares runs (T5), and the
// published documents exist and use the frozen names. No container runtime or
// workflow runner is needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { compareRuns, GENERATORS, sampleRows } from "./repro-known-answers.js";
import { COMPAT_RULES } from "../src/compat.js";
import { runCli } from "./support/cli-run.js";

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
    assert.match(df, /CI's container job builds the image/);
    assert.match(df, /TRACKER_EVIDENCE_LISTEN=0\.0\.0\.0:47312/);
    assert.match(df, /^EXPOSE 47312$/m);
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

  it("the container job checks the defect build's evidence (R23 retired) and a restart on a reused /data volume", () => {
    // R23 retired (coordinator notes 24 and 27): a defect build in container mode starts with no opt-in and answers
    // /build 404 without the evidence token, 200 with it; outside container mode it is refused; the removed variable is
    // refused by name.
    assert.match(wf, /expected exit 2 for a defect build off loopback outside container mode/);
    assert.match(wf, /expected exit 2 with the removed TRACKER_CONTAINER_ALLOW_DEFECTS/);
    assert.match(wf, /defect build, evidence without token: \$none, with: \$good/);
    assert.match(wf, /-v tt-data:\/data/);
    assert.match(wf, /--data-dir \/data/);
    assert.match(wf, /docker kill tt-dur/);
    assert.match(wf, /docker start tt-dur/);
    assert.match(wf, /replayed\\\\":true/);
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

  it("has the surface, the 0.4.0 selection and the expected/ generator registered", () => {
    for (const name of ["surface", "select-0.4.0", "expected-sample"]) assert.ok(GENERATORS.some((g) => g.name === name), name);
  });

  it("the expected/ sample takes the correct builds and every 40th row of the 0.4.0 matrix", () => {
    const list = JSON.parse(read(root("expected/builds-0.4.0.json"))) as { builds: Array<{ label: string }> };
    const rows = sampleRows(list.builds);
    assert.ok(rows.filter((r) => /correct build$/.test(r.label)).length >= 4);
    assert.ok(rows.length < 30, `${rows.length} rows`);
  });

  it("the 0.4.0 build list is the selector's output, byte for byte (expected/select-0.4.0.mjs)", async () => {
    const generator = GENERATORS.find((g) => g.name === "select-0.4.0")!;
    assert.equal((await generator.generate(0)).toString("utf8"), read(root("expected/builds-0.4.0.json")));
  });
});

/**
 * The route table: every route of src/backend/http.ts, src/backend/durability.ts (fence), src/fixture/evidence.ts and
 * src/fixture/control.ts with its methods, in openapi.yaml's order. Checked against openapi.yaml and a running build.
 */
const ROUTES: Record<string, string[]> = {
  "/projects": ["get", "post"],
  "/projects/{key}": ["get", "put", "delete"],
  "/tickets": ["get", "post"],
  "/tickets/{id}": ["get", "put", "patch", "delete"],
  "/tickets/{id}/comments": ["post"],
  "/tickets/{id}/labels": ["post"],
  "/tickets/{id}/labels/{labelId}": ["delete"],
  "/batch": ["post"],
  "/export": ["get"],
  "/build": ["get"],
  "/ledger": ["get"],
  "/executions": ["get"],
  "/executions/{id}": ["get"],
  "/operations/{key}": ["get"],
  "/operations/{key}/fence": ["post"],
  "/_fixture/runs": ["get", "post"],
  "/_fixture/runs/{run}/reset": ["post"],
  "/_fixture/faults": ["get", "post"],
  "/_fixture/clock": ["get", "post"],
};

/** openapi.yaml's paths and their operations, in file order (methods in get, post, put, patch, delete order). */
function openapiRoutes(api: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of api.split("\n")) {
    const path = /^  (\/[^:]*):\s*$/.exec(line);
    if (path) {
      current = path[1];
      out[current] = [];
      continue;
    }
    if (/^\S/.test(line)) current = undefined;
    const op = /^    (get|post|put|patch|delete|head|options|trace):/.exec(line);
    if (current && op) out[current].push(op[1]);
  }
  const order = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
  for (const k of Object.keys(out)) out[k].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return out;
}

describe("the kit's documents", () => {
  for (const p of ["CONTRIBUTING.md", "docs/patterns.md", "docs/STABILITY.md", "openapi.yaml"]) {
    it(`${p} exists and names no result as compliant, certified or passing`, () => {
      assert.ok(existsSync(root(p)), p);
      const text = read(root(p));
      assert.doesNotMatch(text, /\b(compliant|certified|badge)\b/i);
      assert.doesNotMatch(text, /\bscore[sd]?\b/i);
    });
  }

  it("the OpenAPI file declares exactly the routes of the route table below, methods included, the 501 shape and the keyed codes", () => {
    const api = read(root("openapi.yaml"));
    assert.match(api, /^openapi: 3\.1\.\d+$/m);
    assert.doesNotMatch(api, /Status: draft|Planned \(0\.[23]\.0\)/, "finalized for 0.4.0");
    assert.deepEqual(openapiRoutes(api), ROUTES);
    for (const code of ["in_progress", "key_fenced", "run_reset", "needs_supervise", "key_expired", "principal_required", "not_enabled", "no_record", "needs_feature"]) {
      assert.match(api, new RegExp(`\\b${code}\\b`), code);
    }
    assert.match(api, /"410": \{ \$ref: "#\/components\/responses\/KeyExpired" \}/);
    assert.match(api, /available_from/);
    assert.match(api, /Tiny-Tracker-Run/);
    assert.match(api, /TRACKER_EVIDENCE_LISTEN/);
  });

  // Note 27 item 5: the route table is also compared with what the source serves. The routes are dispatched in code
  // (src/backend/http.ts, src/backend/durability.ts, src/fixture/evidence.ts, src/fixture/control.ts), so a build with
  // every feature is asked every path with every method: a route is served when some token gets an answer other than
  // 404 `no_route`, 405 (the evidence namespace is GET only; the fixture clock GET or POST) or 401.
  it("the route table is what a build with every feature serves, methods included", async () => {
    const backendToken = `be-${"b".repeat(8)}-0123456789abcdef`;
    const evidence = `ev-${"e".repeat(8)}-0123456789abcdef`;
    const control = `ct-${"c".repeat(8)}-0123456789abcdef`;
    const served: Record<string, string[]> = {};
    const r = await runCli(["all", "--port", "0", "--backend-port", "0", "--fixture-control", "--control-port", "0",
      "--features", "evidence,strict-input,execution-records,lookup,principals,ledger,faults,inflight,retention,clock"],
    { TRACKER_BACKEND_TOKEN: backendToken, TRACKER_EVIDENCE_TOKEN: evidence, TRACKER_CONTROL_TOKEN: control }, async (state) => {
      for (const path of Object.keys(ROUTES)) {
        const concrete = path.replace("{key}", path.startsWith("/projects") ? "ZZPROBE" : "probe-key-0001")
          .replace("{id}", path.startsWith("/executions") ? "X-999999" : "T-999999").replace("{labelId}", "L-1").replace("{run}", "run-nope-1");
        const control_ = path.startsWith("/_fixture/");
        const base = control_ ? state.control : state.backend;
        const tokens = control_ ? [control] : [backendToken, evidence];
        for (const method of ["get", "post", "put", "patch", "delete"]) {
          for (const token of tokens) {
            const res = await fetch(`${base}${concrete}`, { method: method.toUpperCase(),
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "get" ? {} : { body: "{}" }) });
            const body = await res.json().catch(() => ({})) as { error?: string };
            const unserved = res.status === 401 || res.status === 405 || (res.status === 404 && body.error === "no_route");
            if (!unserved) {
              (served[path] ??= []).push(method);
              break;
            }
          }
        }
      }
    });
    assert.ok(r.stateLine, r.stderr);
    assert.deepEqual(served, ROUTES);
  });
  it("the OpenAPI file validates as OpenAPI 3.1 (verify/python/check_openapi.py; skipped without openapi-spec-validator)", async (t) => {
    if (process.platform === "win32") { t.skip("the Python checks run on Linux and macOS only (FIXTURE.md, Windows)"); return; }
    const { py } = await import("./support/python.js");
    const python = process.env.TT_OPENAPI_PYTHON;
    const r = python
      ? await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const { spawn } = require("node:child_process") as typeof import("node:child_process");
        const c = spawn(python, ["-I", root("verify/python/check_openapi.py")]);
        let stdout = "", stderr = "";
        c.stdout.on("data", (d) => { stdout += d; });
        c.stderr.on("data", (d) => { stderr += d; });
        c.on("exit", (code) => resolve({ code, stdout, stderr }));
        c.on("error", () => resolve({ code: 3, stdout, stderr: "no such python" }));
      })
      : await py([root("verify/python/check_openapi.py")]);
    if (r.code === 3 || (r.code !== 0 && /ENOENT|not found/.test(r.stderr))) {
      t.skip("openapi-spec-validator is not installed (CI installs it; TT_OPENAPI_PYTHON names a python that has it)");
      return;
    }
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /valid OpenAPI 3\.1/);
  });

  it("every path package.json ships exists (0.4.0: the kit's documents and the 0.4.0 known answers)", () => {
    const pj = JSON.parse(read(root("package.json"))) as { files: string[] };
    for (const f of pj.files.filter((x) => x !== "dist/src")) assert.ok(existsSync(root(f)), f);
    for (const f of ["CONTRIBUTING.md", "openapi.yaml", "docs/STABILITY.md", "docs/patterns.md", "expected/0.4.0.json"]) assert.ok(pj.files.includes(f), f);
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
