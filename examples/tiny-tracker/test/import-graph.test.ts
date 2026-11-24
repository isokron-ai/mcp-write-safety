// The fixture layer is a separate module (design rule 1, review S5): profile
// 0.1 and any build that names no fixture feature never load a module from
// src/fixture. Checked twice: statically, by walking the static import graph
// of the command line from source; and at run time, by logging every module
// the started process resolves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./support/record-imports.js", import.meta.url));

/** The static imports (import ... from, export ... from, side-effect import) of one source file, as absolute .ts paths. */
function staticImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["'](\.[^"']+)["']/gm;
  for (const m of text.matchAll(re)) out.push(resolve(dirname(file), m[1].replace(/\.js$/, ".ts")));
  return out;
}

function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...staticImports(f));
  }
  return seen;
}

function runAndLog(args: string[], env: Record<string, string>, portBase: number): Promise<{ urls: string[]; stateLine: any; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tt-imports-"));
  const log = join(dir, "imports.log");
  writeFileSync(log, "");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(PRELOAD).href, CLI, ...args, "--port", String(portBase), "--backend-port", String(portBase + 1)],
      { env: { PATH: process.env.PATH ?? "", TT_IMPORT_LOG: log, ...env } });
    let stdout = "";
    let stderr = "";
    let stateLine: any;
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stateLine === undefined && stdout.includes("\n")) {
        stateLine = JSON.parse(stdout.split("\n")[0]);
        child.kill("SIGTERM");
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", () => {
      clearTimeout(timer);
      const urls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      rmSync(dir, { recursive: true, force: true });
      if (stateLine === undefined) reject(new Error(`no state line: ${stderr}`));
      else resolvePromise({ urls, stateLine, stderr });
    });
  });
}

const isFixture = (u: string) => /\/src\/fixture\//.test(u);

describe("import graph: the teaching server never imports the fixture layer", () => {
  it("statically: nothing reachable from cli.ts or start.ts by static import is in src/fixture", () => {
    for (const entry of ["cli.ts", "start.ts"]) {
      const graph = staticGraph(join(SRC, entry));
      assert.ok(graph.size > 20, `${entry}: ${graph.size} modules`);
      const hits = [...graph].filter(isFixture);
      assert.deepEqual(hits, [], `${entry} statically imports ${hits.join(", ")}`);
    }
    // And nothing in src outside src/fixture imports it statically.
    const all = staticGraph(join(SRC, "cli.ts"));
    for (const f of all) assert.ok(!staticImports(f).some(isFixture), f);
    // The one way in: a dynamic import in cli.ts.
    assert.match(readFileSync(join(SRC, "cli.ts"), "utf8"), /await import\("\.\/fixture\/index\.js"\)/);
  });

  for (const [label, args] of [["--profile 0.1", ["all", "--profile", "0.1"]], ["the default build", ["all"]], ["a defect build", ["all", "--defect", "all"]],
    ["the strict-input feature (core, not fixture)", ["all", "--features", "strict-input"]]] as const) {
    it(`at run time: ${label} loads no module from src/fixture`, async () => {
      const r = await runAndLog([...args], {}, 4630);
      assert.ok(r.urls.some((u) => u.endsWith("/src/cli.js")), "the log works");
      assert.ok(r.urls.some((u) => u.includes("/src/mcp/server.js")));
      assert.deepEqual(r.urls.filter(isFixture), []);
    });
  }

  it("at run time: the evidence feature does load the fixture layer (the check can see it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-imports-tok-"));
    const tokenFile = join(dir, "evidence.token");
    writeFileSync(tokenFile, "evidence-token-for-import-graph-test");
    chmodSync(tokenFile, 0o600);
    try {
      const r = await runAndLog(["all", "--features", "evidence"], { TRACKER_EVIDENCE_TOKEN_FILE: tokenFile }, 4632);
      assert.ok(r.urls.some((u) => u.endsWith("/src/fixture/index.js")), r.stderr);
      assert.deepEqual(r.stateLine.features, ["execution-records", "lookup", "principals", "inflight", "retention", "evidence"], "the default's features (0.3.0) and the named one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
