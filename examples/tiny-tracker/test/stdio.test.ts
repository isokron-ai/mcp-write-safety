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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEFECTS } from "../src/defects/index.js";
import { REQUIREMENT_IDS, type RequirementId } from "../src/requirements.js";
import { checkCompat } from "../src/compat.js";
import { MAX_STDIO_MESSAGE, prepareStdioServer } from "../src/stdio.js";
import { PassThrough } from "node:stream";
import { MCP_HTTP_CAPS } from "../src/mcp/server.js";
import { CHECKS, type Verdict } from "./support/checks.js";
import { startStack, type Era, type StackOptions } from "./support/stack.js";
import { startStdioPair } from "./support/stdio-pair.js";
import { ConfigError } from "../src/start.js";
import { DEFAULT_RETENTION_MS, retentionSentence } from "../src/backend/expiry.js";

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
  // The stdio golden over both protocol eras: --profile 0.1 is exactly the published 0.1.0 surface; the default profile
  // is that surface plus the two read-only lookup tools (0.2.0 default) and the retention sentence (0.3.0 default:
  // retention; from 0.4.0 the instructions state it too), as over HTTP (test/surface.test.ts).
  const RETENTION = ` ${retentionSentence(DEFAULT_RETENTION_MS)}`;
  for (const era of ["2026-07-28", "2025-11-25"] as const) {
    for (const profile of ["0.1", "default"] as const) {
      it(`--profile ${profile}: the 0.1.0 tools, instructions and capabilities over stdio${profile === "default" ? ", plus the lookup tools and the retention sentence" : ""} (${era})`, async () => {
        const expected = goldenConfig(`correct, ${era}`);
        const { client, stderr } = await connectCli(["--profile", profile], {}, era);
        try {
          assert.equal(client.getServerVersion()?.name, expected.initialize.serverName);
          // The default's retention: the instructions and every key-accepting tool's description end with the sentence;
          // taken back out, the rest is the 0.1.0 text.
          const withoutRetention = (text: string | undefined) => {
            if (profile === "0.1" || text === undefined) return text;
            assert.ok(text.endsWith(RETENTION), `states the retention: ${text}`);
            return text.slice(0, -RETENTION.length);
          };
          assert.equal(withoutRetention(client.getInstructions()), expected.initialize.instructions);
          assert.deepEqual(client.getServerCapabilities(), expected.initialize.capabilities);
          const tools = (await client.listTools()).tools as Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }>;
          const lookup = ["get_operation", "get_execution"];
          const keyed = (t: (typeof tools)[number]) => t.inputSchema?.properties?.idempotency_key !== undefined;
          assert.deepEqual(tools.filter((t) => !lookup.includes(t.name)).map((t) => (keyed(t) ? { ...t, description: withoutRetention(t.description) } : t)), expected.tools);
          assert.deepEqual(tools.filter((t) => lookup.includes(t.name)).map((t) => t.name).sort(), profile === "0.1" ? [] : [...lookup].sort());
          const r = await client.callTool({ name: "create_ticket", arguments: { title: "over stdio", idempotency_key: "k-stdio-0001" } }) as any;
          assert.equal(r.isError ?? false, false);
          assert.equal(r.structuredContent.mws.outcome, "applied");
          const again = await client.callTool({ name: "create_ticket", arguments: { title: "over stdio", idempotency_key: "k-stdio-0001" } }) as any;
          assert.equal(again.structuredContent.id, r.structuredContent.id, "a keyed repeat over stdio returns the same ticket");
          if (profile === "default") {
            const op = await client.callTool({ name: "get_operation", arguments: { idempotency_key: "k-stdio-0001" } }) as any;
            assert.equal(op.isError ?? false, false, JSON.stringify(op));
          }
        } finally {
          await client.close();
        }
        const state = JSON.parse(stderr().trim().split("\n").at(-1)!);
        assert.equal(state.transport, "stdio");
        assert.equal(state.mcp, undefined, "no MCP listener");
        assert.match(state.backend, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.deepEqual(state.defects, []);
      });
    }
  }

  it("a defect build over stdio prints the banner on stderr and lists its defects", async () => {
    const { client, stderr } = await connectCli(["--profile", "0.1", "--defect", "MWS-RETRY-2"]);
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

/** Starts `tiny-tracker stdio` as a child; resolves once its state line is on stderr. */
async function startStdioChild(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLI, "stdio", ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (/"transport":"stdio"/.test(stderr)) { clearInterval(t); resolve(); }
      if (child.exitCode !== null) { clearInterval(t); reject(new Error(`exited before its state line: ${stderr}`)); }
    }, 20);
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

// Note 27 item 1: SIGTERM or SIGINT over stdio used to exit 0 before the backend closed, leaving the lease (lock.d) and
// the pid lock (lock) behind. shutdown() is now one promise, and the closers run in reverse without reordering them.
describe("tiny-tracker stdio: a signal or stdin closing releases the data dir", () => {
  for (const how of ["SIGTERM", "SIGINT", "stdin closed"] as const) {
    // Windows cannot deliver SIGTERM or SIGINT to a handler (Node ends the process outright), so the graceful stop is promised only where signals exist.
    const skip = process.platform === "win32" && how !== "stdin closed" && `${how} cannot be handled on Windows: the process is ended outright and releases nothing`;
    it(`${how}: exit 0, and lock and lock.d are gone`, { skip }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "tt-stdio-sig-"));
      const data = join(dir, "data");
      try {
        const run = await startStdioChild(["--features", "durable,strict-input", "--data-dir", data]);
        assert.ok(existsSync(join(data, "lock")), "the pid lock is held while running");
        assert.ok(existsSync(join(data, "lock.d")), "the lease is held while running");
        if (how === "stdin closed") run.child.stdin.end();
        else run.child.kill(how);
        const { code, signal } = await run.exited;
        assert.equal(signal, null, run.stderr());
        assert.equal(code, 0, run.stderr());
        assert.ok(!existsSync(join(data, "lock")), "the pid lock is released");
        assert.ok(!existsSync(join(data, "lock.d")), "the lease is released");
        assert.equal(run.stdout(), "", "nothing but protocol messages on stdout");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("tiny-tracker stdio: refusals (exit 2, nothing served)", () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["--supervise (CMP-70)", ["--supervise"], {}, /--supervise runs over Streamable HTTP only/],
    ["--port (no listener)", ["--port", "0"], {}, /--port has no effect over stdio/],
    ["--fixture-control without a control token", ["--fixture-control"], {}, /TRACKER_CONTROL_TOKEN/],
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

  it("CMP-70 (narrowed at the 0.4.0 integration) refuses --supervise over stdio and nothing else", () => {
    const base = { layout: "all" as const, profile: "default" as const, defects: [], backendDefects: [], variants: [], faults: [] };
    const cmp70 = (c: Parameters<typeof checkCompat>[0]) => checkCompat(c).filter((m) => /Streamable HTTP only/.test(m)).length;
    assert.equal(cmp70({ ...base, features: [], fixtureControl: false, supervise: true, transport: "stdio" }), 1);
    assert.equal(cmp70({ ...base, features: [], fixtureControl: false, supervise: true, transport: "http" }), 0);
    assert.deepEqual(checkCompat({ ...base, features: ["evidence"], fixtureControl: false, transport: "stdio" }), []);
    assert.deepEqual(checkCompat({ ...base, features: ["evidence", "strict-input", "ledger", "faults"], fixtureControl: true, transport: "stdio" }), []);
  });

  it("the stdio message cap equals the HTTP body cap (X5)", () => {
    assert.equal(MAX_STDIO_MESSAGE, MCP_HTTP_CAPS.maxBodyBytes);
  });
});

describe("tiny-tracker stdio: the fixture layer over stdio (CMP-70 narrowed)", () => {
  it("evidence, the ledger, faults and the control listener work over stdio, with the descriptor mirrored in the instructions", async () => {
    const evidence = `ev-${"e".repeat(8)}-0123456789abcdef`;
    const control = `ct-${"c".repeat(8)}-0123456789abcdef`;
    const features = "evidence,strict-input,execution-records,lookup,principals,ledger,faults";
    const { client, stderr } = await connectCli(["--features", features, "--fixture-control"],
      { TRACKER_EVIDENCE_TOKEN: evidence, TRACKER_CONTROL_TOKEN: control });
    try {
      // stdin is read only after the control listener starts (note 27 item 5); the state line follows at once.
      for (let i = 0; i < 200 && !/"transport":"stdio"/.test(stderr()); i++) await new Promise((r) => setTimeout(r, 25));
      const state = JSON.parse(stderr().trim().split("\n").at(-1)!);
      assert.equal(state.transport, "stdio");
      assert.match(state.control, /^http:\/\/127\.0\.0\.1:\d+$/);
      const build = await (await fetch(`${state.backend}/build`, { headers: { authorization: `Bearer ${evidence}` } })).json() as any;
      // The named features and the default profile's inflight and retention (0.3.0 default flip).
      assert.deepEqual([...build.features].sort(), [...features.split(","), "inflight", "retention"].sort());
      assert.match(client.getInstructions() ?? "", new RegExp(build.build_hash.slice(0, 12)), "the instructions mirror the build hash");
      // A run from the control listener, a tagged write over stdio, and its ledger entry with the run and operation tags.
      const alloc = await fetch(`${state.control}/_fixture/runs`, { method: "POST", headers: { authorization: `Bearer ${control}`, "content-type": "application/json" }, body: "{}" });
      assert.ok(alloc.status === 200 || alloc.status === 201, `run allocation answered ${alloc.status}`);
      const run = ((await alloc.json()) as any).run_id as string;
      const r = await client.callTool({ name: "create_ticket", arguments: { title: "stdio ledger", idempotency_key: "k-stdio-ledger-1" },
        _meta: { "dev.writesafety.tiny-tracker/run": run, "dev.writesafety.tiny-tracker/operation": "op-stdio-1" } } as any) as any;
      assert.equal(r.structuredContent.mws.outcome, "applied", JSON.stringify(r));
      assert.ok(r._meta && JSON.stringify(r._meta).includes(build.build_hash), "result _meta mirrors the descriptor");
      const ledger = await (await fetch(`${state.backend}/ledger`, { headers: { authorization: `Bearer ${evidence}` } })).json() as any;
      const entries = (ledger.entries ?? ledger) as any[];
      const hit = entries.find((e) => e.kind === "execution" && e.request?.key === "k-stdio-ledger-1");
      assert.ok(hit, `the write is in the ledger: ${JSON.stringify(ledger).slice(0, 600)}`);
      assert.equal(hit.run, run, "attributed to the run from request _meta");
      assert.equal(hit.operation_tag, "op-stdio-1");
    } finally {
      await client.close();
    }
    const out = stderr();
    assert.ok(!out.includes(evidence) && !out.includes(control), "no token is printed");
  });
});

describe("tiny-tracker stdio: start order and the message cap (note 27 item 5)", () => {
  it("stdin is read only after the control listener is up and --fault is armed: no answer precedes the state line", async () => {
    const control = `ct-${"c".repeat(8)}-0123456789abcdef`;
    const evidence = `ev-${"e".repeat(8)}-0123456789abcdef`;
    const child = spawn(process.execPath, [CLI, "stdio", "--features", "evidence,strict-input,execution-records,lookup,principals,ledger,faults",
      "--fixture-control", "--fault", "mcp/after-backend-reply/drop:once"], { env: { PATH: process.env.PATH ?? "", TRACKER_CONTROL_TOKEN: control, TRACKER_EVIDENCE_TOKEN: evidence } });
    let stderr = "";
    let stateBeforeFirstAnswer: boolean | undefined;
    child.stderr.on("data", (d) => { stderr += d; });
    const answered = new Promise<string>((resolve) => {
      let stdout = "";
      child.stdout.on("data", (d) => {
        stateBeforeFirstAnswer ??= /"transport":"stdio"/.test(stderr);
        stdout += d;
        if (stdout.includes("\n")) resolve(stdout);
      });
    });
    // Written at once, before the process has started anything: the pipe holds it until the transport reads.
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    const exited = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    try {
      const first = await Promise.race([answered, exited.then((code) => { throw new Error(`exited ${code} before answering: ${stderr}`); })]);
      assert.equal(JSON.parse(first.split("\n")[0]).id, 1);
      assert.equal(stateBeforeFirstAnswer, true, "the state line (written after the control listener and the fault arming) came first");
      const state = JSON.parse(stderr.trim().split("\n").at(-1)!);
      const faults = await (await fetch(`${state.control}/_fixture/faults`, { headers: { authorization: `Bearer ${control}` } })).json() as any;
      assert.ok(faults.armed.some((f: any) => f.point === "mcp/after-backend-reply/drop"), JSON.stringify(faults.armed));
    } finally {
      child.stdin.end();
    }
    assert.equal(await exited, 0, stderr);
  });

  it("prepareStdioServer reads nothing from stdin until serve(), which the command line calls last", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (d) => { out += d; });
    let failure: string | undefined | null = null;
    const prepared = prepareStdioServer({ env: { TRACKER_BACKEND_URL: "http://127.0.0.1:9", TRACKER_BACKEND_TOKEN: "backend-token-0123456789" }, stdin, stdout,
      onClose: (f) => { failure = f; } });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(out, "", "nothing is answered before serve()");
    prepared.serve();
    for (let i = 0; i < 200 && !out.includes("\n"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(JSON.parse(out.split("\n")[0]).id, 1, "answered once served");
    // A message over the cap: the transport closes itself, and onClose names why.
    stdin.write(Buffer.alloc(MAX_STDIO_MESSAGE + 1, 0x78));
    for (let i = 0; i < 200 && failure === null; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(String(failure), /larger than 4194304 bytes \(4 MiB\)/);
    await prepared.close();
  });

  it("a message over 4 MiB closes the connection: the reason on stderr, exit 1", async () => {
    const run = await startStdioChild([]);
    // One line longer than the cap, never finished: the transport refuses it before any newline arrives.
    const chunk = "x".repeat(1024 * 1024);
    run.child.stdin.on("error", () => {}); // EPIPE once the server has stopped reading and exited
    run.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"');
    for (let i = 0; i < 5; i++) {
      if (run.child.exitCode !== null) break;
      await new Promise<void>((resolve) => run.child.stdin.write(chunk, () => resolve()));
    }
    const { code, signal } = await run.exited;
    assert.equal(signal, null, run.stderr());
    assert.equal(code, 1, run.stderr());
    assert.match(run.stderr(), new RegExp(`a stdio message was larger than ${MAX_STDIO_MESSAGE} bytes \\(4 MiB\\), the cap; the connection is closed\\. Stopping\\.`));
    assert.equal(run.stdout(), "");
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
