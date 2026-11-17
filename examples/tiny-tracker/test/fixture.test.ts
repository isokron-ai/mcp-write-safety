// The fixture layer (Phase 0): the evidence namespace and its token, the
// control listener and its token, the build descriptor and its mirror in the
// MCP instructions and result _meta, run ids, and attribution outside the
// handlers (rule 3) with every create-path defect on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, domainDigest, DOMAINS } from "../src/digest.js";
import { META_KEYS } from "../src/fixture-properties.js";
import { startBackend, startServer } from "../src/start.js";
import { placementMap } from "../src/defect-placement.js";
import { createFixtureLayer, BuildDescriptor } from "../src/fixture/index.js";
import { connectClient } from "./support/stack.js";
import { runCli } from "./support/cli-run.js";

const BACKEND = "backend-token-fixture-test-000000";
const EVIDENCE = "evidence-token-fixture-test-00000";
const CONTROL = "control-token-fixture-test-000000";
const TOKENS = { TRACKER_BACKEND_TOKEN: BACKEND, TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: CONTROL };

async function get(url: string, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : undefined };
}

async function post(url: string, token: string | undefined, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const res = await fetch(url, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
}

/** A raw request with a chosen Host header (fetch does not let a caller set Host). */
function rawGet(url: string, host: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { host, authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

const allTokensAbsent = (text: string) => ![BACKEND, EVIDENCE, CONTROL].some((t) => text.includes(t));

describe("the evidence namespace (rule 2, G3)", () => {
  it("serves /build and /export to the evidence token only; the token opens nothing else", async () => {
    const r = await runCli(["all", "--features", "evidence", "--port", "4660", "--backend-port", "4661"], TOKENS, async (state) => {
      assert.equal(state.evidence, `${state.backend}/build`);
      const build = await get(`${state.backend}/build`, EVIDENCE);
      assert.equal(build.status, 200);
      assert.equal(build.headers.get("tiny-tracker-build"), build.body.build_hash);
      assert.ok(allTokensAbsent(build.text), "no token in the descriptor");
      assert.equal((await get(`${state.backend}/build`)).status, 401, "no token");
      assert.equal((await get(`${state.backend}/build`, BACKEND)).status, 404, "the backend token is not the evidence token");
      assert.equal((await get(`${state.backend}/export`, EVIDENCE)).status, 200);
      assert.equal((await get(`${state.backend}/export`, BACKEND)).status, 200, "GET /export with the backend token works as in 0.1.0");
      assert.equal((await post(`${state.backend}/build`, EVIDENCE, {})).status, 405, "read-only");
      assert.equal((await post(`${state.backend}/tickets`, EVIDENCE, { project: "inbox", title: "x" })).status, 401, "the evidence token cannot write");
      assert.equal((await get(`${state.backend}/projects`, EVIDENCE)).status, 401, "nor read the API");
      for (const path of ["/ledger", "/executions/X-1", "/operations/some-key-0001"]) {
        const planned = await get(`${state.backend}${path}`, EVIDENCE);
        assert.equal(planned.status, 501, path);
        assert.equal(planned.body.available_from, "0.2.0");
      }
      assert.equal(await rawGet(`${state.backend}/build`, "evil.example:80", EVIDENCE), 403, "loopback Host only");
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(allTokensAbsent(r.stdout) && allTokensAbsent(r.stderr), "no token on stdout or stderr");
  });

  it("the descriptor: both hashes recompute from the served JSON; build_hash is stable across starts, descriptor_hash is not", async () => {
    const seen: any[] = [];
    for (const port of [4662, 4664]) {
      await runCli(["all", "--features", "evidence", "--port", String(port), "--backend-port", String(port + 1)], TOKENS, async (state) => {
        seen.push((await get(`${state.backend}/build`, EVIDENCE)).body);
      });
    }
    for (const d of seen) {
      const { descriptor_hash, ...body } = d;
      assert.equal(descriptor_hash, domainDigest(DOMAINS.buildDescriptor, canonicalize(body)));
      const config = { descriptor: d.descriptor, package: d.package, fixture_api: d.fixture_api, profile: d.profile, features: d.features, defects: d.defects,
        variants: d.variants, control: d.control, durability: d.durability, contract: d.contract, layout: d.process.layout };
      assert.equal(d.build_hash, domainDigest(DOMAINS.build, canonicalize(config)));
      assert.equal(d.descriptor, "build-descriptor/1");
      assert.deepEqual(d.clock, { domain: "wall", offset_ms: 0 });
      assert.deepEqual(d.faults, { armed: [] });
      assert.equal(d.process.restart_count, 0);
      assert.deepEqual(d.contract, { repo: "zambodotdev/lost-response-test-contract", commit: "92bf1ba" });
    }
    assert.equal(seen[0].build_hash, seen[1].build_hash);
    assert.notEqual(seen[0].process.boot_id, seen[1].process.boot_id);
    assert.notEqual(seen[0].descriptor_hash, seen[1].descriptor_hash);
    const other = new BuildDescriptor({ layout: "all", profile: "default", features: ["evidence"], mcpDefects: ["read-merge-put"], backendDefects: ["lost-update"], variants: [], control: false });
    assert.notEqual(other.buildHash, seen[0].build_hash, "a defect changes build_hash");
    assert.match(other.instructions(), /TEACHING BACKEND WITH DELIBERATE DEFECTS \(backend:lost-update\)/);
  });

  it("the mirror: the instructions carry the facts and every tool result carries the hashes in _meta; tools/list is unchanged", async () => {
    await runCli(["all", "--features", "evidence", "--defect", "read-merge-put", "--backend-defect", "lost-update", "--port", "4666", "--backend-port", "4667"], TOKENS, async (state) => {
      const d = (await get(`${state.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.defects, { mcp: ["read-merge-put"], backend: ["lost-update"] });
      const mcp = await connectClient(state.mcp, "2026-07-28");
      try {
        const instructions = mcp.client.getInstructions()!;
        assert.match(instructions, new RegExp(d.build_hash));
        assert.match(instructions, /backend:lost-update/);
        assert.ok(allTokensAbsent(instructions));
        assert.equal((await mcp.tools()).length, 16);
        const res = await mcp.client.callTool({ name: "list_projects", arguments: {} }) as { _meta?: Record<string, any> };
        assert.equal(res._meta?.[META_KEYS.build]?.build_hash, d.build_hash);
        assert.equal(res._meta?.[META_KEYS.build]?.boot_id, d.process.boot_id);
        const failed = await mcp.client.callTool({ name: "get_ticket", arguments: { id: "T-404" } }) as { isError?: boolean; _meta?: Record<string, any> };
        assert.equal(failed.isError, true);
        assert.equal(failed._meta?.[META_KEYS.build]?.build_hash, d.build_hash, "errors carry it too");
      } finally {
        await mcp.close();
      }
    });
  });
});

describe("tokens (X2): environment or a 0600 file, never argv, never printed, never shared", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-tokens-"));
  const file = (name: string, content: string, mode: number) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  };

  it("refuses to start without the token, with a readable token file, with a token on argv, or with a shared token", async () => {
    try {
      const missing = await runCli(["all", "--features", "evidence"], { TRACKER_BACKEND_TOKEN: BACKEND });
      assert.equal(missing.code, 2);
      assert.match(missing.stderr, /needs a token: set TRACKER_EVIDENCE_TOKEN or TRACKER_EVIDENCE_TOKEN_FILE/);
      const loose = await runCli(["all", "--features", "evidence"], { TRACKER_EVIDENCE_TOKEN_FILE: file("loose", EVIDENCE, 0o644) });
      assert.equal(loose.code, 2);
      assert.match(loose.stderr, /chmod 600/);
      const both = await runCli(["all", "--features", "evidence"], { TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_EVIDENCE_TOKEN_FILE: file("both", EVIDENCE, 0o600) });
      assert.equal(both.code, 2);
      const argv = await runCli(["all", "--features", "evidence", "--default-project", EVIDENCE], { TRACKER_EVIDENCE_TOKEN: EVIDENCE });
      assert.equal(argv.code, 2);
      assert.match(argv.stderr, /appeared on the command line/);
      assert.ok(!argv.stderr.includes(EVIDENCE));
      const shared = await runCli(["all", "--features", "evidence"], { TRACKER_BACKEND_TOKEN: EVIDENCE, TRACKER_EVIDENCE_TOKEN: EVIDENCE });
      assert.equal(shared.code, 2);
      assert.match(shared.stderr, /must differ/);
      const short = await runCli(["all", "--features", "evidence"], { TRACKER_EVIDENCE_TOKEN: "short" });
      assert.equal(short.code, 2);
      const fromFile = await runCli(["all", "--features", "evidence", "--port", "4668", "--backend-port", "4669"],
        { TRACKER_BACKEND_TOKEN: BACKEND, TRACKER_EVIDENCE_TOKEN_FILE: file("good", `${EVIDENCE}\n`, 0o600) }, async (state) => {
          assert.equal((await get(`${state.backend}/build`, EVIDENCE)).status, 200);
        });
      assert.equal(fromFile.code, 0, fromFile.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createFixtureLayer applies the same rules in code", () => {
    assert.throws(() => createFixtureLayer({ layout: "all", profile: "default", features: ["evidence"], mcpDefects: [], backendDefects: [], variants: [], control: true,
      env: { TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: EVIDENCE }, argv: [] }), /must differ/);
  });
});

describe("the control listener (rule 2, X4)", () => {
  it("only with --fixture-control and its token, on its own loopback port, hardened", async () => {
    const noToken = await runCli(["all", "--fixture-control"], { TRACKER_BACKEND_TOKEN: BACKEND });
    assert.equal(noToken.code, 2);
    assert.match(noToken.stderr, /control listener needs a token/);
    const split = await runCli(["server", "--fixture-control"], { ...TOKENS, TRACKER_BACKEND_URL: "http://127.0.0.1:4671" });
    assert.equal(split.code, 2);
    assert.match(split.stderr, /--fixture-control runs with `tiny-tracker all` only/);

    const r = await runCli(["all", "--fixture-control", "--control-port", "4672", "--port", "4670", "--backend-port", "4671"], TOKENS, async (state) => {
      assert.equal(state.control, "http://127.0.0.1:4672");
      assert.equal(state.evidence, undefined, "control without the evidence feature serves no evidence");
      const c = state.control as string;
      assert.deepEqual((await get(`${c}/_fixture/clock`, CONTROL)).body, { domain: "wall", offset_ms: 0 });
      assert.equal((await get(`${c}/_fixture/clock`)).status, 401);
      assert.equal((await get(`${c}/_fixture/clock`, BACKEND)).status, 401, "the backend token is not the control token");
      assert.equal((await get(`${c}/_fixture/clock`, CONTROL, { origin: "http://127.0.0.1" })).status, 403, "any Origin is refused");
      assert.equal(await rawGet(`${c}/_fixture/clock`, "attacker.example", CONTROL), 403);
      assert.equal((await post(`${c}/_fixture/runs`, CONTROL, {}, { "content-type": "text/plain" })).status, 415);
      const run1 = await post(`${c}/_fixture/runs`, CONTROL, { label: "first" });
      assert.equal(run1.status, 201);
      assert.match(run1.body.run_id, /^run-[0-9a-f]{8}-1$/);
      const run2 = await post(`${c}/_fixture/runs`, CONTROL, {});
      assert.match(run2.body.run_id, /-2$/);
      assert.deepEqual((await get(`${c}/_fixture/runs`, CONTROL)).body.runs.map((x: any) => x.label), ["first", null]);
      assert.equal((await post(`${c}/_fixture/runs/run-nope-9/reset`, CONTROL, {})).status, 404);
      const reset = await post(`${c}/_fixture/runs/${run1.body.run_id}/reset`, CONTROL, {});
      assert.equal(reset.status, 501);
      assert.equal(reset.body.available_from, "0.2.0");
      const faults = await get(`${c}/_fixture/faults`, CONTROL);
      assert.deepEqual(faults.body.armed, []);
      assert.ok(faults.body.points.some((p: any) => p.id === "mcp/after-backend-reply/drop" && p.since === "0.2.0"));
      assert.equal((await post(`${c}/_fixture/faults`, CONTROL, { point: "mcp/after-backend-reply/drop" })).status, 501);
      assert.equal((await post(`${c}/_fixture/clock`, CONTROL, { advance_ms: 1000 })).status, 501);
      assert.equal((await get(`${state.backend}/projects`, CONTROL)).status, 401, "the control token opens nothing on the backend");
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(allTokensAbsent(r.stdout) && allTokensAbsent(r.stderr));
  });
});

/** A spy between the MCP server and the backend: records every request's headers, forwards it unchanged. */
async function startSpy(target: string, port: number) {
  const seen: Array<{ method: string; path: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
    const u = new URL(target);
    const fwd = httpRequest({ host: u.hostname, port: u.port, method: req.method, path: req.url, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    req.pipe(fwd);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

describe("attribution outside the handlers (rule 3, B5)", () => {
  const map = placementMap();
  const createPath = Object.entries(map.byDefect)
    .filter(([name, places]) => !name.startsWith("backend:") && places.some((p) => /^tool:(create_ticket|create_project|add_comment)\.handler$/.test(p)))
    .map(([name]) => name);

  it(`every backend request a tagged call makes carries the run and operation tags, with each create-path defect on and with all of them (${createPath.length} defects)`, async () => {
    assert.ok(createPath.length >= 6, createPath.join(", "));
    const builds = [[], ...createPath.map((d) => [d]), createPath];
    let port = 4680;
    for (const defects of builds) {
      const backend = await startBackend({ token: BACKEND, port: port++ });
      const spy = await startSpy(backend.url, port++);
      const server = await startServer({
        env: { TRACKER_BACKEND_URL: spy.url, TRACKER_BACKEND_TOKEN: BACKEND }, defects, port: port++, features: ["evidence"], extras: { attribution: true },
      });
      const mcp = await connectClient(server.url, "2026-07-28");
      try {
        let n = 0;
        for (const [tool, args] of [
          ["create_project", { key: "attr", name: "Attr", idempotency_key: "attr-project-0001" }],
          ["create_ticket", { project: "attr", title: "tagged", idempotency_key: "attr-ticket-0001" }],
          ["create_ticket", { project: "attr", title: "tagged", idempotency_key: "attr-ticket-0001" }],
          ["add_comment", { id: "T-1", body: "c", idempotency_key: "attr-comment-0001" }],
        ] as const) {
          const op = `op-${++n}`;
          const before = spy.seen.length;
          await mcp.client.callTool({ name: tool, arguments: args, _meta: { [META_KEYS.run]: "run-test-1", [META_KEYS.operation]: op } });
          for (const r of spy.seen.slice(before)) {
            assert.equal(r.headers["tiny-tracker-run"], "run-test-1", `[${defects.join(",")}] ${tool}: ${r.method} ${r.path}`);
            assert.equal(r.headers["tiny-tracker-operation"], op, `[${defects.join(",")}] ${tool}: ${r.method} ${r.path}`);
          }
        }
        assert.ok(spy.seen.length >= 3, `[${defects.join(",")}] the spy saw ${spy.seen.length} backend requests`);
        // An untagged call sends no tags; a malformed tag is dropped, never passed on.
        const before = spy.seen.length;
        await mcp.client.callTool({ name: "list_projects", arguments: {} });
        await mcp.client.callTool({ name: "list_projects", arguments: {}, _meta: { [META_KEYS.run]: "bad tag\r\nx: y", [META_KEYS.operation]: 5 } });
        for (const r of spy.seen.slice(before)) assert.equal(r.headers["tiny-tracker-run"] ?? r.headers["tiny-tracker-operation"], undefined);
      } finally {
        await mcp.close();
        await server.close();
        await spy.close();
        await backend.close();
      }
    }
  });

  it("without attribution (profile 0.1 and the default build) no tag is sent", async () => {
    const backend = await startBackend({ token: BACKEND, port: 4678 });
    const spy = await startSpy(backend.url, 4679);
    const server = await startServer({ env: { TRACKER_BACKEND_URL: spy.url, TRACKER_BACKEND_TOKEN: BACKEND }, port: 4677 });
    const mcp = await connectClient(server.url, "2026-07-28");
    try {
      await mcp.client.callTool({ name: "create_ticket", arguments: { title: "x" }, _meta: { [META_KEYS.run]: "run-test-1" } });
      assert.ok(spy.seen.length > 0);
      for (const r of spy.seen) assert.equal(r.headers["tiny-tracker-run"], undefined);
    } finally {
      await mcp.close();
      await server.close();
      await spy.close();
      await backend.close();
    }
  });
});
