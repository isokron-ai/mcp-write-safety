// Listener security and resource caps for the MCP layer (0.4.0):
//   - X1: container mode listens on every interface and refuses to start
//     without a bearer token for /mcp; with one, /mcp needs it.
//   - X5: caps on the listener (body, requests in flight, unanswered POSTs)
//     and a data dir only its owner can use.
// No container runtime is needed: the start refusal is the same code path the
// image runs (TRACKER_CONTAINER=1), tested here in Node.
//
// Ports: every listener takes an OS-assigned port (port 0).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { resolveTransport, TransportError, loadMcpToken, containerMode } from "../src/transport.js";
import { ensurePrivateDir, PrivateDirError } from "../src/private-dir.js";
import { ListenError, MCP_HTTP_CAPS, startMcpServer } from "../src/mcp/server.js";
import { createBuild } from "../src/mcp/build.js";
import { correctConfigRules, type ServerConfig } from "../src/mcp/config.js";
import { ConfigError, startBackend, startServer } from "../src/start.js";
import { runCli } from "./support/cli-run.js";

const posix = process.platform !== "win32";
const TOKEN = `mcp-${randomBytes(12).toString("hex")}`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tt-transport-"));
}

async function connect(url: string, token?: string) {
  const client = new Client({ name: "tiny-tracker-transport-test", version: "0.1.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
  return client;
}

const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const post = (url: string, headers: Record<string, string> = {}, body = initBody) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });

describe("transport settings (src/transport.ts)", () => {
  it("container mode without an MCP token is refused (X1)", () => {
    assert.throws(() => resolveTransport("all", { TRACKER_CONTAINER: "1" }), (e) => e instanceof TransportError && /needs a bearer token for \/mcp/.test(e.message));
    assert.throws(() => resolveTransport("server", { TRACKER_CONTAINER: "1" }), TransportError);
  });

  it("container mode with a token listens on every interface and needs the token", () => {
    assert.deepEqual(resolveTransport("all", { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: TOKEN }), { host: "0.0.0.0", bearerToken: TOKEN });
  });

  it("outside a container: loopback, and the token is optional but enforced when set", () => {
    assert.deepEqual(resolveTransport("all", {}), { host: "127.0.0.1" });
    assert.deepEqual(resolveTransport("server", { TRACKER_MCP_TOKEN: TOKEN }), { host: "127.0.0.1", bearerToken: TOKEN });
    assert.equal(resolveTransport("backend", {}), undefined);
  });

  it("container mode refuses the backend layout and takes stdio without a token", () => {
    assert.throws(() => resolveTransport("backend", { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: TOKEN }), /container mode runs/);
    assert.equal(resolveTransport("stdio", { TRACKER_CONTAINER: "1" }), undefined);
    assert.throws(() => resolveTransport("stdio", { TRACKER_MCP_TOKEN: TOKEN }), /stdio has none/);
  });

  it("TRACKER_CONTAINER takes only 1 or 0 (fail closed)", () => {
    assert.equal(containerMode({}), false);
    assert.equal(containerMode({ TRACKER_CONTAINER: "0" }), false);
    assert.equal(containerMode({ TRACKER_CONTAINER: "1" }), true);
    for (const v of ["true", "yes", "on", "2"]) assert.throws(() => containerMode({ TRACKER_CONTAINER: v }), TransportError);
  });

  it("the token follows the token rules: length, distinct, not on argv, not both sources", () => {
    assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN: "short" }), /16 to 256/);
    assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN: "has a space in it ok" }), /16 to 256/);
    assert.throws(() => resolveTransport("all", { TRACKER_MCP_TOKEN: TOKEN, TRACKER_BACKEND_TOKEN: TOKEN }), /must differ/);
    assert.throws(() => resolveTransport("all", { TRACKER_MCP_TOKEN: TOKEN, TRACKER_EVIDENCE_TOKEN: TOKEN }), /must differ/);
    assert.throws(() => resolveTransport("all", { TRACKER_MCP_TOKEN: TOKEN }, ["--default-project", TOKEN]), /command line/);
    const dir = tempDir();
    try {
      const file = join(dir, "mcp.token");
      writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
      assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN: TOKEN, TRACKER_MCP_TOKEN_FILE: file }), /not both/);
      assert.equal(loadMcpToken({ TRACKER_MCP_TOKEN_FILE: file }), TOKEN);
      if (posix) {
        chmodSync(file, 0o644);
        assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN_FILE: file }), /chmod 600/);
      }
      assert.equal(loadMcpToken({ TRACKER_MCP_TOKEN_FILE: file }, "win32"), TOKEN, "the mode check is POSIX-only");
      assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN_FILE: join(dir, "missing") }), /cannot be read/);
      assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN_FILE: dir }), /regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the MCP listener (src/mcp/server.ts)", () => {
  const config: ServerConfig = { backendUrl: "http://127.0.0.1:9", backendToken: "unused-backend-token", readOnly: false, tools: null, deny: null, defaultProject: "inbox" };

  it("refuses to listen beyond loopback without a bearer token, whoever calls it", async () => {
    const build = createBuild([], []);
    await assert.rejects(startMcpServer(build, config, 0, {}, { host: "0.0.0.0" }), ListenError);
    await assert.rejects(startMcpServer(build, config, 0, {}, { host: "0.0.0.0", bearerToken: "" }), ListenError);
  });

  it("with a bearer token: 401 without it or with a wrong one, served with it; Host and Origin still loopback only", async () => {
    const backendToken = `be-${randomBytes(12).toString("hex")}`;
    const backend = await startBackend({ token: backendToken });
    const server = await startServer({ env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: backendToken, TRACKER_MCP_TOKEN: TOKEN } });
    try {
      const none = await post(server.url);
      assert.equal(none.status, 401);
      assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
      assert.equal((await post(server.url, { authorization: `Bearer ${TOKEN}x` })).status, 401);
      assert.equal((await post(server.url, { authorization: `Bearer ${backendToken}` })).status, 401, "the backend token opens nothing here");
      assert.equal((await post(server.url, { authorization: TOKEN })).status, 401, "the Bearer scheme is required");
      const client = await connect(server.url, TOKEN);
      try {
        const tools = (await client.listTools()).tools;
        assert.equal(tools.length, 16);
      } finally {
        await client.close();
      }
      // The Host check is not access control, but it stays: a token does not open a non-loopback Host.
      const port = new URL(server.url).port;
      const { request } = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } },
          (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject);
        req.end(initBody);
      });
      assert.equal(status, 403);
    } finally {
      await server.close();
      await backend.close();
    }
  });

  it("startServer turns a container start without a token into a ConfigError", async () => {
    await assert.rejects(startServer({ env: { TRACKER_BACKEND_URL: "http://127.0.0.1:9", TRACKER_BACKEND_TOKEN: "unused-backend-token", TRACKER_CONTAINER: "1" } }),
      (e) => e instanceof ConfigError && /bearer token/.test(e.message));
  });

  it("caps: body size, requests in flight, and an unanswered POST is cut off (X5)", async () => {
    const backendToken = `be-${randomBytes(12).toString("hex")}`;
    const backend = await startBackend({ token: backendToken });
    const build = createBuild([], []);
    const cfg: ServerConfig = { ...config, backendUrl: backend.url, backendToken };
    let release: (() => void) | undefined;
    // A held answer: onResult never settles until released (what a drop fault does, below its own cap).
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = await startMcpServer(build, cfg, 0, { onResult: async (_tool, r) => { await held; return r; } },
      { caps: { maxBodyBytes: 2048, maxInFlight: 1, responseCapMs: 400 } });
    try {
      const big = await post(server.url, {}, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(4096) } }));
      assert.equal(big.status, 413);
      // A tools/call whose answer is held: the connection closes at the cap with no reply.
      const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_projects", arguments: {} } });
      const headers = { "mcp-protocol-version": "2025-11-25" };
      const started = Date.now();
      const first = post(server.url, headers, call).then(async (r) => { await r.text(); return "answered"; }, () => "cut off");
      // While it is held, a second request finds the in-flight cap full.
      await new Promise((r) => setTimeout(r, 100));
      const busy = await post(server.url, headers, initBody);
      assert.equal(busy.status, 503);
      assert.equal(busy.headers.get("retry-after"), "1");
      assert.equal(await first, "cut off");
      assert.ok(Date.now() - started >= 350, "not before the cap");
      // After the cut, the slot is free again.
      release!();
      const after = await post(server.url, headers, initBody);
      assert.notEqual(after.status, 503);
      await after.text();
    } finally {
      release?.();
      await server.close();
      await backend.close();
    }
  });

  it("the shipped caps are finite and the CLI uses them", () => {
    for (const [k, v] of Object.entries(MCP_HTTP_CAPS)) assert.ok(Number.isFinite(v) && v > 0, k);
    assert.ok(Object.isFrozen(MCP_HTTP_CAPS));
  });
});

describe("container mode through the command line (the image's start path, without a container runtime)", () => {
  it("TRACKER_CONTAINER=1 without a token exits 2 before anything listens", async () => {
    const r = await runCli(["all", "--port", "0"], { TRACKER_CONTAINER: "1" });
    assert.equal(r.code, 2);
    assert.equal(r.stateLine, undefined, "no state line: nothing was started");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /container mode listens on every interface and needs a bearer token/);
  });

  it("TRACKER_CONTAINER=1 refuses the backend layout and an invalid value", async () => {
    const a = await runCli(["backend", "--port", "0"], { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: TOKEN, TRACKER_BACKEND_TOKEN: `be-${randomBytes(12).toString("hex")}` });
    assert.equal(a.code, 2);
    assert.match(a.stderr, /container mode runs/);
    const b = await runCli(["all", "--port", "0"], { TRACKER_CONTAINER: "yes", TRACKER_MCP_TOKEN: TOKEN });
    assert.equal(b.code, 2);
    assert.match(b.stderr, /TRACKER_CONTAINER="yes" is not recognized/);
  });

  it("a token on the command line, or equal to another token, stops the start", async () => {
    const a = await runCli(["all", "--port", "0", "--default-project", TOKEN], { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: TOKEN });
    assert.equal(a.code, 2);
    assert.match(a.stderr, /command line/);
    const b = await runCli(["all", "--port", "0"], { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN: TOKEN, TRACKER_BACKEND_TOKEN: TOKEN });
    assert.equal(b.code, 2);
    assert.match(b.stderr, /must differ/);
  });

  it("with a 0600 token file it listens on every interface, needs the token, and never prints it", async () => {
    const dir = tempDir();
    const file = join(dir, "mcp.token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    try {
      const r = await runCli(["all", "--port", "0"], { TRACKER_CONTAINER: "1", TRACKER_MCP_TOKEN_FILE: file }, async (state) => {
        assert.match(state.mcp, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        const port = Number(new URL(state.mcp).port);
        assert.equal((await post(state.mcp)).status, 401);
        const client = await connect(state.mcp, TOKEN);
        try {
          assert.equal((await client.listTools()).tools.length, 16);
        } finally {
          await client.close();
        }
        // Bound on every interface: the port is taken on 0.0.0.0 too.
        const probe = (await import("node:net")).createServer();
        const err = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
          probe.once("error", (e) => resolve(e as NodeJS.ErrnoException));
          probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(undefined)));
        });
        assert.equal(err?.code, "EADDRINUSE");
      });
      assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), "the token is never printed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a data dir only its owner can use (src/private-dir.ts, X5)", () => {
  it("creates a missing directory 0700, nested too", { skip: !posix && "POSIX modes" }, () => {
    const dir = tempDir();
    try {
      const data = join(dir, "a", "data");
      ensurePrivateDir(data);
      assert.equal(statSync(data).mode & 0o777, 0o700);
      ensurePrivateDir(data); // an existing private dir is fine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an existing directory open to others, a file and a symlink", { skip: !posix && "POSIX modes" }, () => {
    const dir = tempDir();
    try {
      const open = join(dir, "open");
      mkdirSync(open, { mode: 0o755 });
      chmodSync(open, 0o755);
      assert.throws(() => ensurePrivateDir(open), (e) => e instanceof PrivateDirError && /chmod 700/.test(e.message));
      assert.equal(statSync(open).mode & 0o777, 0o755, "the mode is not changed behind the operator's back");
      ensurePrivateDir(open, "the data dir", "win32");
      const file = join(dir, "file");
      writeFileSync(file, "");
      assert.throws(() => ensurePrivateDir(file), /must name a directory/);
      const priv = join(dir, "priv");
      mkdirSync(priv, { mode: 0o700 });
      const link = join(dir, "link");
      symlinkSync(priv, link);
      assert.throws(() => ensurePrivateDir(link), /symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
