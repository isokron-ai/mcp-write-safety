// Launch tests against the built command line: what an operator sees.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectClient } from "./support/stack.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI; if it prints its URL line, hands it to `whileUp`, then stops it. */
function run(args: string[], env: Record<string, string> = {}, whileUp?: (out: any) => Promise<void>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    let started = false;
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!started && stdout.includes("\n")) {
        started = true;
        const line = JSON.parse(stdout.split("\n")[0]);
        (whileUp ? whileUp(line) : Promise.resolve()).then(() => child.kill("SIGTERM"), (e) => { child.kill("SIGKILL"); reject(e); });
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("tiny-tracker command line", () => {
  it("all: starts backend and server on loopback, serves 18 tools (the 16 of 0.1.0 and, from 0.2.0, the two lookup tools), stops on SIGTERM", async () => {
    const r = await run(["all"], {}, async (out) => {
      assert.match(out.mcp, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.match(out.backend, /^http:\/\/127\.0\.0\.1:\d+$/);
      const mcp = await connectClient(out.mcp, "2026-07-28");
      assert.equal((await mcp.tools()).length, 18);
      await mcp.close();
    });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /BROKEN BUILD/);
  });

  it("R-TT-01: the usage text lists only commands the command line runs (0.3.0 listed a stdio mode that does not exist)", () => {
    // Output that is not the one-line JSON `run` expects, so this test reads the command's output directly.
    const cli = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 15000 });
    const help = cli(["--help"]);
    assert.equal(help.status, 0);
    const listed = [...help.stdout.matchAll(/^  tiny-tracker (\w+)/gm)].map((m) => m[1]);
    // The modes src/cli.ts accepts. Add a mode here when it is built, in the same change that adds it to the usage.
    assert.deepEqual([...listed].sort(), ["all", "backend", "server", "stdio"]);
    // Every listed mode is one the command knows: an unknown mode answers with the usage text and exit 2.
    for (const mode of listed) {
      const r = cli([mode, "--port", "not-a-port"], { TRACKER_BACKEND_TOKEN: "t".repeat(24) });
      assert.doesNotMatch(r.stdout, /^usage:/, `${mode} is listed but answered with the usage text`);
    }
    // 0.3.0 listed stdio without building it; 0.4.0 builds it, so `stdio --help` answers with its own help, not the usage text.
    const stdio = cli(["stdio", "--help"]);
    assert.doesNotMatch(stdio.stdout, /^usage:/);
  });

  it("an unrecognized read-only value stops the server (exit 2)", async () => {
    const r = await run(["all", "--read-only", "enabled"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not recognized/);
    assert.equal(r.stdout, "");
  });

  it("an unknown tool in the allow-list stops the server (exit 2)", async () => {
    const r = await run(["all", "--tools", "get_ticket,update_tikcet"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown tools: update_tikcet/);
  });

  it("an unknown defect name stops the server (exit 2)", async () => {
    const r = await run(["all", "--defect", "no-such-defect"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown defect/);
  });

  it("a build with defects prints a banner and names its defects", async () => {
    const r = await run(["all", "--defect", "read-merge-put", "--defect", "MWS-RETRY-2"], {}, async (out) => {
      assert.deepEqual(out.defects, ["read-merge-put", "idempotency-key-dropped", "retry-without-key", "key-store-in-memory", "idempotency-key-ignores-args"]);
    });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /BROKEN BUILD/);
  });

  it("a variant is named in the output; an unknown one stops the server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-variant-"));
    try {
      const honest = await run(["all"], { TRACKER_VARIANTS: "key-store-honest", TRACKER_KEY_JOURNAL: join(dir, "keys") }, async (out) => {
        assert.deepEqual(out.variants, ["key-store-honest"]);
        assert.deepEqual(out.defects, []);
        // Owner decision (CMP-5 option b): the default's lookup is off for this build, and the state line says so.
        assert.deepEqual(out.features_off, ["lookup off: key-store-honest keeps keys in the MCP server"]);
      });
      assert.equal(honest.code, 0, honest.stderr);
      assert.match(honest.stderr, /lookup off: key-store-honest keeps keys in the MCP server/);
      const bad = await run(["all"], { TRACKER_VARIANTS: "nope" });
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /unknown variant/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("key-store-honest with the default profile (CMP-5 option b): lookup off and visible; a named lookup exits 2; profile 0.1 unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-variant-"));
    const ev = "evidence-token-cli-cmp5-000000000";
    const base = { TRACKER_BACKEND_TOKEN: "backend-token-cli-cmp5-0000000000", TRACKER_EVIDENCE_TOKEN: ev, TRACKER_VARIANTS: "key-store-honest" };
    const builds: any[] = [];
    try {
      const r = await run(["all", "--features", "evidence"], { ...base, TRACKER_KEY_JOURNAL: join(dir, "k1") }, async (out) => {
        assert.deepEqual(out.features, ["execution-records", "principals", "inflight", "retention", "evidence"], "the state line lists the effective features");
        assert.deepEqual(out.features_off, ["lookup off: key-store-honest keeps keys in the MCP server"]);
        const build = await (await fetch(`${out.backend}/build`, { headers: { authorization: `Bearer ${ev}` } })).json() as any;
        assert.ok(!build.features.includes("lookup"), "the descriptor lists the features the build runs");
        builds.push(build);
        const mcp = await connectClient(out.mcp, "2026-07-28");
        try {
          const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
          assert.ok(!tools.includes("get_operation") && !tools.includes("get_execution"));
        } finally {
          await mcp.close();
        }
      });
      assert.equal(r.code, 0, r.stderr);
      // build_hash follows the effective features: the same build named explicitly without lookup has the same hash.
      const same = await run(["all", "--features", "evidence"], { ...base, TRACKER_KEY_JOURNAL: join(dir, "k2") }, async (out) => {
        builds.push(await (await fetch(`${out.backend}/build`, { headers: { authorization: `Bearer ${ev}` } })).json());
      });
      assert.equal(same.code, 0);
      assert.equal(builds[0].build_hash, builds[1].build_hash);
      const named = await run(["all", "--features", "evidence,lookup"], { ...base, TRACKER_KEY_JOURNAL: join(dir, "k3") });
      assert.equal(named.code, 2);
      assert.match(named.stderr, /key-store-honest variant keeps keys in the MCP server/);
      const named2 = await run(["all"], { ...base, TRACKER_FEATURES: "lookup", TRACKER_KEY_JOURNAL: join(dir, "k4") });
      assert.equal(named2.code, 2, "TRACKER_FEATURES names it too");
      const old = await run(["all", "--profile", "0.1"], { ...base, TRACKER_KEY_JOURNAL: join(dir, "k5") }, async (out) => {
        assert.equal(out.features_off, undefined, "profile 0.1 turns nothing on, so nothing is turned off");
        assert.equal(out.features, undefined);
      });
      assert.equal(old.code, 0, old.stderr);
      assert.doesNotMatch(old.stderr, /lookup off/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a build with defects refuses a backend that is not on loopback", async () => {
    const r = await run(["server", "--defect", "read-merge-put", "--backend-url", "http://tracker.example.com"],
      { TRACKER_BACKEND_TOKEN: "x" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /127\.0\.0\.1 or localhost/);
  });
});

it("package name: @mcp-write-safety/tiny-tracker, command tiny-tracker, published publicly; the README gives the npx command", async () => {
  const { readFileSync } = await import("node:fs");
  const pj = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; bin: Record<string, string>; private?: boolean; publishConfig?: { access?: string }; files?: string[] };
  assert.equal(pj.name, "@mcp-write-safety/tiny-tracker");
  // 0.2.0 adds fx-check, the FX- property checker (stream C).
  assert.deepEqual(pj.bin, { "tiny-tracker": "dist/src/cli.js", "fx-check": "dist/src/fx-check.js" });
  assert.equal(pj.private, undefined);
  assert.equal(pj.publishConfig?.access, "public");
  assert.ok(pj.files?.includes("dist/src") && pj.files.includes("writecheck.yaml"));
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("npx -y @mcp-write-safety/tiny-tracker") && !/not published/i.test(readme));
});
