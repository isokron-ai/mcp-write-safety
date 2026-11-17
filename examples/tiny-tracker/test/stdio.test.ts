// The stdio transport (R19). Three parts:
//
//   1. The command line: `tiny-tracker stdio` speaks MCP on stdin and stdout,
//      writes its state line to stderr, serves the same tools and instructions
//      as the published 0.1.0 surface, and exits when stdin closes.
//   2. Refusals: what stdio does not take exits 2 before anything is served.
//   3. A reduced self-test matrix over stdio (PLAN R19): every check against
//      the correct build, and one defect per requirement, with the client
//      connected over stdio. The MWS-CFG checks start servers of their own
//      over HTTP, so they are not part of this matrix; the full matrix
//      (test/selftest.test.ts) covers them.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEFECTS } from "../src/defects/index.js";
import { REQUIREMENT_IDS, type RequirementId } from "../src/requirements.js";
import { checkCompat } from "../src/compat.js";
import { MAX_STDIO_MESSAGE } from "../src/stdio.js";
import { MCP_HTTP_CAPS } from "../src/mcp/server.js";
import { CHECKS, type Verdict } from "./support/checks.js";
import { startStack, type Era, type StackOptions } from "./support/stack.js";
import { startStdioPair } from "./support/stdio-pair.js";
import { ConfigError } from "../src/start.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const golden = JSON.parse(readFileSync(new URL("../../test/golden/surface-0.1.0.json", import.meta.url), "utf8")) as {
  configs: Array<{ name: string; era: Era; tools: unknown[]; initialize: { serverName: string; capabilities: unknown; instructions: string } }>;
};

function goldenConfig(name: string) {
  const c = golden.configs.find((x) => x.name === name);
  assert.ok(c, `golden configuration ${name}`);
  return c!;
}

async function connectCli(args: string[], env: Record<string, string> = {}, era: Era = "2026-07-28") {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI, "stdio", ...args], stderr: "pipe", env: { PATH: process.env.PATH ?? "", ...env },
  });
  let stderr = "";
  transport.stderr!.on("data", (d) => { stderr += d; });
  const client = new Client({ name: "tiny-tracker-stdio-test", version: "0.1.0" },
    era === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

/** Runs `tiny-tracker stdio` with stdin closed at once; returns its exit code and output. */
function runRefused(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "stdio", ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("tiny-tracker stdio: the command line", () => {
  for (const era of ["2026-07-28", "2025-11-25"] as const) {
    it(`serves the 0.1.0 tools, instructions and capabilities over stdio (${era})`, async () => {
      const expected = goldenConfig(`correct, ${era}`);
      const { client, stderr } = await connectCli([], {}, era);
      try {
        assert.equal(client.getServerVersion()?.name, expected.initialize.serverName);
        assert.equal(client.getInstructions(), expected.initialize.instructions);
        assert.deepEqual(client.getServerCapabilities(), expected.initialize.capabilities);
        assert.deepEqual((await client.listTools()).tools, expected.tools);
        const r = await client.callTool({ name: "create_ticket", arguments: { title: "over stdio", idempotency_key: "k-stdio-0001" } }) as any;
        assert.equal(r.isError ?? false, false);
        assert.equal(r.structuredContent.mws.outcome, "applied");
        const again = await client.callTool({ name: "create_ticket", arguments: { title: "over stdio", idempotency_key: "k-stdio-0001" } }) as any;
        assert.equal(again.structuredContent.id, r.structuredContent.id, "a keyed repeat over stdio returns the same ticket");
      } finally {
        await client.close();
      }
      const state = JSON.parse(stderr().trim().split("\n").at(-1)!);
      assert.equal(state.transport, "stdio");
      assert.match(state.backend, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(state.defects, []);
    });
  }

  it("a defect build over stdio prints the banner on stderr and lists its defects", async () => {
    const { client, stderr } = await connectCli(["--defect", "MWS-RETRY-2"]);
    try {
      assert.deepEqual((await client.listTools()).tools, goldenConfig("MWS-RETRY-2 defects").tools);
    } finally {
      await client.close();
    }
    assert.match(stderr(), /BROKEN BUILD/);
  });

  it("stdout carries only protocol messages, and the process exits 0 when stdin closes", async () => {
    const child = spawn(process.execPath, [CLI, "stdio"], { env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    // Wait for the state line, so the backend is up, then send one request and close stdin.
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (stderr.includes("\n")) { clearInterval(t); resolve(); } }, 20); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (stdout.includes("\n")) { clearInterval(t); resolve(); } }, 20); });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0);
    for (const line of stdout.split("\n").filter(Boolean)) {
      const m = JSON.parse(line);
      assert.equal(m.jsonrpc, "2.0", `not a protocol message: ${line}`);
    }
    assert.match(JSON.parse(stdout.split("\n")[0]).result.serverInfo.name, /^tiny-tracker$/);
  });

  it("--help prints the stdio usage on stderr", async () => {
    const r = await runRefused(["--help"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /tiny-tracker stdio/);
  });
});

describe("tiny-tracker stdio: refusals (exit 2, nothing served)", () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["a fixture-layer feature (CMP-70)", ["--features", "evidence"], {}, /CMP-70|Streamable HTTP only/],
    ["--port (no listener)", ["--port", "0"], {}, /--port has no effect over stdio/],
    ["--fixture-control", ["--fixture-control"], {}, /--fixture-control has no effect over stdio/],
    ["an MCP token (nothing to protect)", [], { TRACKER_MCP_TOKEN: "mcp-token-0123456789abcdef" }, /stdio has none/],
    ["--backend-url without a backend token", ["--backend-url", "http://127.0.0.1:9"], {}, /TRACKER_BACKEND_TOKEN is required/],
    ["--backend-port with --backend-url", ["--backend-url", "http://127.0.0.1:9", "--backend-port", "0"], { TRACKER_BACKEND_TOKEN: "tok-0123456789abcdef" }, /--backend-port has no effect/],
    ["an unknown defect", ["--defect", "no-such-defect"], {}, /no-such-defect/],
    ["a backend token on the command line", ["--default-project", "tok-0123456789abcdef"], { TRACKER_BACKEND_TOKEN: "tok-0123456789abcdef" }, /appeared on the command line/],
    ["a positional argument", ["extra"], {}, /no positional arguments/],
  ];
  for (const [label, args, env, message] of cases) {
    it(label, async () => {
      const r = await runRefused(args, env);
      assert.equal(r.code, 2, r.stderr);
      assert.equal(r.stdout, "", "nothing on the protocol channel");
      assert.match(r.stderr, message);
    });
  }

  it("CMP-70 is in the compatibility table and applies to stdio only", () => {
    const base = { layout: "all" as const, profile: "default" as const, defects: [], backendDefects: [], variants: [], faults: [] };
    assert.equal(checkCompat({ ...base, features: ["evidence"], fixtureControl: false, transport: "stdio" }).length, 1);
    assert.equal(checkCompat({ ...base, features: [], fixtureControl: true, transport: "stdio" }).filter((m) => /Streamable HTTP only/.test(m)).length, 1);
    assert.deepEqual(checkCompat({ ...base, features: ["strict-input"], fixtureControl: false, transport: "stdio" }), []);
    assert.deepEqual(checkCompat({ ...base, features: ["evidence"], fixtureControl: false, transport: "http" }), []);
    assert.deepEqual(checkCompat({ ...base, features: ["evidence"], fixtureControl: false }), []);
  });

  it("the stdio message cap equals the HTTP body cap (X5)", () => {
    assert.equal(MAX_STDIO_MESSAGE, MCP_HTTP_CAPS.maxBodyBytes);
  });
});

/** runChecks (test/support/checks.ts) with the main client connected over stdio instead of HTTP. */
async function runChecksOverStdio(options: StackOptions, only: RequirementId[]): Promise<Map<RequirementId, Verdict>> {
  const stack = await startStack(options);
  const results = new Map<RequirementId, Verdict>();
  const pair = await startStdioPair({
    env: { TRACKER_BACKEND_URL: stack.gate.url, TRACKER_BACKEND_TOKEN: stack.token, ...options.env }, defects: options.defects, era: options.era,
  });
  try {
    const launch = async (env: Record<string, string>) => {
      try {
        return { stack: await startStack({ ...options, env: { ...options.env, ...env } }) };
      } catch (e) {
        if (e instanceof ConfigError) return { refused: e.message };
        throw e;
      }
    };
    for (const check of CHECKS) {
      if (!only.includes(check.requirement)) continue;
      try {
        results.set(check.requirement, await check.run({ stack, mcp: pair.mcp, launch }));
      } catch (e) {
        results.set(check.requirement, { verdict: "not tested", detail: `the check could not complete: ${(e as Error).message}` });
      }
    }
    // Everything the server wrote was a protocol message.
    for (const line of pair.lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  } finally {
    await pair.close();
    await stack.close();
  }
  return results;
}

const STDIO_MATRIX = REQUIREMENT_IDS.filter((id) => !id.startsWith("MWS-CFG"));

describe("reduced self-test matrix over stdio: the correct build", () => {
  let results: Map<RequirementId, Verdict>;
  before(async () => { results = await runChecksOverStdio({ era: "2026-07-28" }, STDIO_MATRIX); });
  for (const id of STDIO_MATRIX) {
    it(`${id} held over stdio`, () => {
      const v = results.get(id)!;
      assert.equal(v.verdict, "held", v.detail);
    });
  }
});

describe("reduced self-test matrix over stdio: one defect per requirement", () => {
  for (const id of STDIO_MATRIX) {
    const defect = DEFECTS.find((d) => d.requirement === id);
    if (!defect) continue;
    it(`--defect ${defect.name}: ${id} violated over stdio`, async () => {
      const r = await runChecksOverStdio({ defects: [defect.name] }, [id]);
      const v = r.get(id)!;
      assert.equal(v.verdict, "violated", `expected violated, got ${v.verdict}: ${v.detail}`);
    });
  }
});

after(() => { /* each test closes its own processes and stacks */ });
