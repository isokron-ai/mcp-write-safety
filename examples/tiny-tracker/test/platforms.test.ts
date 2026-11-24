// The platform-specific paths, unit-tested on this machine with the platform
// passed in (CI runs the whole suite on Linux, macOS and Windows too):
//   - POSIX mode checks (token files, the token folder, the data dir) apply on
//     Linux and macOS ("darwin") and are skipped on Windows, where the folder's
//     ACL is the operator's to set;
//   - the owner (uid) check is skipped on Windows;
//   - a stdio client that ends its lines with CRLF (Windows) is understood;
//   - paths in the known-answer files carry placeholders, never a machine path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpToken, resolveTransport, TransportError } from "../src/transport.js";
import { ensurePrivateDir, PrivateDirError } from "../src/private-dir.js";
import { ensureTokenDir, loadToken, TokenError } from "../src/fixture/tokens.js";

const posixHost = process.platform !== "win32";
const TOKEN = "platform-test-token-0123456789";
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tt-platforms-"));
}

describe("POSIX mode checks by platform (linux, darwin: checked; win32: the ACL is the operator's)", { skip: !posixHost && "needs POSIX modes on the host" }, () => {
  it("an MCP token file open to others", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "mcp.token");
      writeFileSync(file, TOKEN);
      chmodSync(file, 0o644);
      for (const platform of ["linux", "darwin"]) {
        assert.throws(() => loadMcpToken({ TRACKER_MCP_TOKEN_FILE: file }, platform), (e) => e instanceof TransportError && /chmod 600/.test((e as Error).message), platform);
        assert.throws(() => resolveTransport("all", { TRACKER_MCP_TOKEN_FILE: file }, [], platform), TransportError, platform);
      }
      assert.equal(loadMcpToken({ TRACKER_MCP_TOKEN_FILE: file }, "win32"), TOKEN);
      assert.equal(resolveTransport("all", { TRACKER_MCP_TOKEN_FILE: file }, [], "win32")?.bearerToken, TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an evidence token file open to others", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "evidence.token");
      writeFileSync(file, TOKEN);
      chmodSync(file, 0o640);
      for (const platform of ["linux", "darwin"]) {
        assert.throws(() => loadToken("evidence", { TRACKER_EVIDENCE_TOKEN_FILE: file }, platform), (e) => e instanceof TokenError && /chmod 600/.test((e as Error).message), platform);
      }
      assert.equal(loadToken("evidence", { TRACKER_EVIDENCE_TOKEN_FILE: file }, "win32"), TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a token folder and a data dir open to others", () => {
    const dir = tempDir();
    try {
      const open = join(dir, "open");
      mkdirSync(open);
      chmodSync(open, 0o755);
      for (const platform of ["linux", "darwin"]) {
        assert.throws(() => ensureTokenDir(open, platform), (e) => e instanceof TokenError && /chmod 700/.test((e as Error).message), platform);
        assert.throws(() => ensurePrivateDir(open, "the data dir", platform), (e) => e instanceof PrivateDirError && /chmod 700/.test((e as Error).message), platform);
      }
      ensureTokenDir(open, "win32");
      ensurePrivateDir(open, "the data dir", "win32");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a token folder made on any platform is created 0700 and a generated token 0600 (the host's modes)", () => {
    const dir = tempDir();
    try {
      const tokens = join(dir, "tokens");
      const token = loadToken("control", {}, process.platform, tokens);
      assert.match(token, /^[0-9a-f]{48}$/);
      assert.equal(statSync(tokens).mode & 0o777, 0o700);
      assert.equal(statSync(join(tokens, "control.token")).mode & 0o777, 0o600);
      assert.equal(loadToken("control", {}, process.platform, tokens), token, "kept across starts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stdio line endings", () => {
  it("a client that ends its lines with CRLF (Windows) gets its answer", async () => {
    const child = spawn(process.execPath, [CLI, "stdio", "--profile", "0.1"], { env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setInterval(() => { if (stderr.includes("\n")) { clearInterval(t); resolve(); } }, 20);
        setTimeout(() => { clearInterval(t); reject(new Error(`no state line: ${stderr}`)); }, 15000);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "crlf", version: "1" } } })}\r\n`);
      await new Promise<void>((resolve, reject) => {
        const t = setInterval(() => { if (stdout.includes("\n")) { clearInterval(t); resolve(); } }, 20);
        setTimeout(() => { clearInterval(t); reject(new Error(`no answer: ${stdout} ${stderr}`)); }, 15000);
      });
      const answer = JSON.parse(stdout.split("\n")[0]);
      assert.equal(answer.id, 7);
      assert.equal(answer.result.serverInfo.name, "tiny-tracker");
    } finally {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    }
  });
});

describe("known-answer files carry no machine path", () => {
  it("the 0.4.0 build list and its answers use {DATA_DIR} and {WORK}, never a temporary path", () => {
    for (const name of ["builds-0.4.0.json", "0.4.0.json"]) {
      let text: string;
      try {
        text = readFileSync(fileURLToPath(new URL(`../../expected/${name}`, import.meta.url)), "utf8");
      } catch {
        continue; // 0.4.0.json is generated at release
      }
      assert.doesNotMatch(text, /\/tmp\/|\\\\Temp\\\\|\/var\/folders\/|C:\\\\/i, name);
      if (name.startsWith("builds")) assert.match(text, /\{DATA_DIR\}/);
    }
  });
});
