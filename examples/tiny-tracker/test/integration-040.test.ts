// The 0.4.0 integration of stream F with the 0.2.0 and 0.3.0 features:
//   - the MCP bearer token must differ from every principal's token and from
//     the evidence and control tokens, however they are given (env, file or
//     the token folder);
//   - container mode: the evidence routes on TRACKER_EVIDENCE_LISTEN behind the
//     evidence token, for a defect build too (owner decision) with the R23 opt-in
//     TRACKER_CONTAINER_ALLOW_DEFECTS=1, the bearer token
//     on /mcp, and the refusal without it;
//   - the configured key retention is stated in the tool descriptions and the
//     server instructions (D's note, FX-KEY-2).
//
// Ports: every listener takes an OS-assigned port (port 0).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { runCli } from "./support/cli-run.js";
import { containerAllowDefects, resolveTransport, TransportError } from "../src/transport.js";
import { createBuild } from "../src/mcp/build.js";

const tok = (p: string) => `${p}-${randomBytes(12).toString("hex")}`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tt-int040-"));
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "tt-int040", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
  return client;
}

describe("the MCP token differs from every other token (0.4.0 integration)", () => {
  it("resolveTransport compares the MCP token with the principals' tokens it is given", () => {
    const mcp = tok("mcp");
    const env = { TRACKER_MCP_TOKEN: mcp, TRACKER_BACKEND_TOKEN: tok("be") };
    assert.ok(resolveTransport("all", env, [], "linux", { "principal p-second": tok("p2") }));
    assert.throws(() => resolveTransport("all", env, [], "linux", { "principal p-second": mcp }),
      (e) => e instanceof TransportError && /principal p-second token must differ/.test((e as Error).message));
  });

  it("the command line refuses an MCP token equal to a principal's token from TRACKER_BACKEND_TOKENS_FILE", async () => {
    const dir = tempDir();
    try {
      const alice = tok("alice");
      const bob = tok("bob");
      const file = join(dir, "principals.json");
      writeFileSync(file, JSON.stringify({ principals: [{ id: "p-default", token: alice }, { id: "p-second", token: bob }] }), { mode: 0o600 });
      const r = await runCli(["all", "--features", "principals", "--port", "0", "--backend-port", "0"],
        { TRACKER_BACKEND_TOKENS_FILE: file, TRACKER_MCP_TOKEN: bob });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /principal p-second token must differ/);
      assert.ok(!r.stderr.includes(bob), "the token is not printed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the command line refuses an MCP token equal to the evidence token from the token folder", async () => {
    const dir = tempDir();
    try {
      const tokens = join(dir, "tokens");
      // First start: the folder gets a generated evidence token.
      const first = await runCli(["all", "--features", "evidence", "--token-dir", tokens, "--port", "0", "--backend-port", "0"], {});
      assert.equal(first.code, 0, first.stderr); // stopped by SIGTERM after the state line
      const { readFileSync } = await import("node:fs");
      const evidence = readFileSync(join(tokens, "evidence.token"), "utf8").trim();
      const r = await runCli(["all", "--features", "evidence", "--token-dir", tokens, "--port", "0", "--backend-port", "0"], { TRACKER_MCP_TOKEN: evidence });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /must differ/);
      assert.ok(!r.stderr.includes(evidence));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("container mode with the evidence listener (owner decision: evidence reachable behind its token)", () => {
  const features = "evidence,strict-input,execution-records,lookup,principals,ledger";
  for (const defect of [undefined, "read-merge-put"]) {
    it(`TRACKER_CONTAINER=1 serves /mcp behind the bearer token and the evidence routes on 0.0.0.0 behind the evidence token${defect ? ` (defect build ${defect}, with TRACKER_CONTAINER_ALLOW_DEFECTS=1)` : ""}`, async () => {
      const mcp = tok("mcp");
      const evidence = tok("ev");
      const args = ["all", "--features", features, "--port", "0", "--backend-port", "0", ...(defect ? ["--defect", defect] : [])];
      // R23: a defect build serves its evidence off loopback only with TRACKER_CONTAINER_ALLOW_DEFECTS=1.
      const r = await runCli(args, { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: mcp, TRACKER_EVIDENCE_TOKEN: evidence, TRACKER_EVIDENCE_LISTEN: "0.0.0.0:0",
        ...(defect ? { TRACKER_CONTAINER_ALLOW_DEFECTS: "1" } : {}) }, async (state) => {
        assert.match(state.evidence_listener, /^http:\/\/0\.0\.0\.0:\d+$/);
        const ev = state.evidence_listener.replace("0.0.0.0", "127.0.0.1");
        // A harness outside the container reaches it with another Host header (a published port).
        const get = (path: string, token: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
          const u = new URL(`${ev}${path}`);
          const q = httpRequest({ host: u.hostname, port: u.port, path: u.pathname,
            headers: { host: `tiny-tracker.example:${u.port}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
            let body = "";
            res.on("data", (d) => { body += d; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          q.on("error", reject);
          q.end();
        });
        assert.equal((await get("/build", "")).status, 404, "no token, no evidence (the evidence listener answers 404, as in test/fx.test.ts)");
        assert.equal((await get("/build", mcp)).status, 404, "the MCP token opens nothing there");
        const build = await get("/build", evidence);
        assert.equal(build.status, 200);
        assert.deepEqual(JSON.parse(build.body).defects.mcp, defect ? [defect] : []);
        // The evidence listener serves evidence only.
        assert.equal((await get("/tickets", evidence)).status, 404);
        // /mcp: 401 without the token, tools with it.
        assert.equal((await fetch(state.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status, 401);
        const client = await connect(state.mcp, mcp);
        try {
          assert.ok((await client.listTools()).tools.length >= 16);
        } finally {
          await client.close();
        }
      });
      assert.ok(r.stateLine, r.stderr);
      for (const t of [mcp, evidence]) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t), "no token is printed");
    });
  }

  it("outside container mode a defect build keeps the evidence listener on loopback (stream A's rule stands)", async () => {
    const r = await runCli(["all", "--features", "evidence", "--defect", "read-merge-put", "--port", "0", "--backend-port", "0"],
      { TRACKER_EVIDENCE_TOKEN: tok("ev"), TRACKER_EVIDENCE_LISTEN: "0.0.0.0:0" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /keeps every listener on loopback outside container mode/);
  });

  // R23 (note 19, items 1 and 3): without the opt-in a plain container never serves a defect build's evidence off loopback.
  for (const [what, args] of [["an MCP-layer defect", ["--defect", "read-merge-put"]], ["a backend defect", ["--backend-defect", "lost-update"]]] as const) {
    it(`in container mode ${what} serves evidence off loopback only with TRACKER_CONTAINER_ALLOW_DEFECTS=1 (R23)`, async () => {
      const mcp = tok("mcp");
      const base = { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: mcp, TRACKER_EVIDENCE_TOKEN: tok("ev"), TRACKER_EVIDENCE_LISTEN: "0.0.0.0:0" };
      const cmd = ["all", "--features", features, "--port", "0", "--backend-port", "0", ...args];
      for (const allow of [undefined, "0", ""]) {
        const r = await runCli(cmd, { ...base, ...(allow !== undefined ? { TRACKER_CONTAINER_ALLOW_DEFECTS: allow } : {}) });
        assert.equal(r.code, 2, `allow=${allow}: ${r.stderr}`);
        assert.equal(r.stateLine, undefined);
        assert.match(r.stderr, /serves its evidence off loopback only with TRACKER_CONTAINER_ALLOW_DEFECTS=1/);
        assert.ok(!r.stderr.includes(mcp));
      }
      // Loopback needs no opt-in.
      const lo = await runCli(cmd, { ...base, TRACKER_EVIDENCE_LISTEN: "127.0.0.1:0" });
      assert.ok(lo.stateLine, lo.stderr);
      // Nor does a defect build without the evidence listener: /mcp is bearer-gated (owner decision).
      const { TRACKER_EVIDENCE_LISTEN: _l, ...noListen } = base;
      const plain = await runCli(cmd, noListen);
      assert.ok(plain.stateLine, plain.stderr);
      // With it, the start goes ahead.
      const ok = await runCli(cmd, { ...base, TRACKER_CONTAINER_ALLOW_DEFECTS: "1" });
      assert.ok(ok.stateLine, ok.stderr);
      assert.match(ok.stateLine!.evidence_listener, /^http:\/\/0\.0\.0\.0:\d+$/);
    });
  }

  it("TRACKER_CONTAINER_ALLOW_DEFECTS takes only 1 or 0, and 1 is refused outside container mode (R23)", async () => {
    assert.equal(containerAllowDefects({}), false);
    assert.equal(containerAllowDefects({ TRACKER_CONTAINER_ALLOW_DEFECTS: "0" }), false);
    assert.equal(containerAllowDefects({ TRACKER_CONTAINER: "1", TRACKER_CONTAINER_ALLOW_DEFECTS: "1" }), true);
    for (const bad of ["yes", "true", "2", " 1"]) {
      assert.throws(() => containerAllowDefects({ TRACKER_CONTAINER: "1", TRACKER_CONTAINER_ALLOW_DEFECTS: bad }), /is not recognized; use 1 or 0/);
    }
    assert.throws(() => containerAllowDefects({ TRACKER_CONTAINER_ALLOW_DEFECTS: "1" }), /has no effect outside container mode/);
    // resolveTransport checks it on every start, evidence listener or not.
    assert.throws(() => resolveTransport("all", { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: tok("mcp"), TRACKER_CONTAINER_ALLOW_DEFECTS: "on" }), TransportError);
    const r = await runCli(["all", "--port", "0", "--backend-port", "0"], { TRACKER_CONTAINER_ALLOW_DEFECTS: "1" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /has no effect outside container mode/);
    const bad = await runCli(["all", "--port", "0", "--backend-port", "0"], { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: tok("mcp"), TRACKER_CONTAINER_ALLOW_DEFECTS: "yes" });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /is not recognized; use 1 or 0/);
  });

  it("container mode without the MCP token refuses before anything listens, evidence listener or not", async () => {
    const r = await runCli(["all", "--features", features, "--port", "0", "--backend-port", "0"],
      { TRACKER_CONTAINER: "1", TRACKER_EVIDENCE_TOKEN: tok("ev"), TRACKER_EVIDENCE_LISTEN: "0.0.0.0:0" });
    assert.equal(r.code, 2);
    assert.equal(r.stateLine, undefined);
    assert.match(r.stderr, /needs a bearer token for \/mcp/);
  });
});

describe("the configured key retention is stated (D's note, FX-KEY-2)", () => {
  it("createBuild states the retention it is given, in every key-accepting tool and for the instructions", () => {
    const b = createBuild([], ["retention"], 3 * 86_400_000);
    assert.match(b.retention ?? "", /remembered for 3 days/);
    assert.match(b.tools.get("create_ticket")!.description, /remembered for 3 days/);
    assert.equal(createBuild([], []).retention, undefined, "without the feature nothing is stated");
    assert.match(createBuild([], ["retention"]).retention ?? "", /remembered for 7 days/);
  });

  it("`all --key-retention 36h` states 36 hours in the instructions and the tool descriptions", async () => {
    const r = await runCli(["all", "--features", "retention", "--key-retention", "36h", "--port", "0", "--backend-port", "0"], {}, async (state) => {
      const client = await connect(state.mcp);
      try {
        assert.match(client.getInstructions() ?? "", /A key is remembered for 36 hours/);
        const create = (await client.listTools()).tools.find((t) => t.name === "create_ticket")!;
        assert.match(create.description ?? "", /A key is remembered for 36 hours/);
      } finally {
        await client.close();
      }
    });
    assert.ok(r.stateLine, r.stderr);
  });
});
