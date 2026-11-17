// How the MCP layer is reached (0.4.0): Streamable HTTP on loopback (the
// default), Streamable HTTP in a container, or stdio (src/stdio.ts).
//
// Container mode (TRACKER_CONTAINER=1, set by the image) listens on every
// interface so a published port reaches it, and therefore refuses to start
// without a bearer token for /mcp (review X1): a Host header is not access
// control, and a defect build open to the LAN is the risk the review names.
//
// The MCP token follows the same rules as every other token (design rule 2,
// review X2): from the environment (TRACKER_MCP_TOKEN) or a file only its
// owner can read (TRACKER_MCP_TOKEN_FILE), 16 to 256 printable characters,
// different from every other token, never on the command line, never printed.
// Outside a container the token is optional; when it is set, /mcp needs it.
//
// This module is part of the teaching server: it never imports the fixture
// layer (test/import-graph.test.ts).

import { readFileSync, statSync } from "node:fs";
import { checkArgv, checkDistinct, TokenError } from "./tokens.js";
import type { McpListenOptions } from "./mcp/server.js";

export const MCP_TOKEN_ENV = { value: "TRACKER_MCP_TOKEN", file: "TRACKER_MCP_TOKEN_FILE" } as const;
export const CONTAINER_ENV = "TRACKER_CONTAINER";
/**
 * R23 (0.4.0): in container mode a build with defects serves its evidence off loopback (TRACKER_EVIDENCE_LISTEN on
 * another address) only with this opt-in. Without it a plain container never exposes a defect build's evidence on the
 * container's interfaces; /mcp is bearer-gated either way (X1).
 */
export const CONTAINER_ALLOW_DEFECTS_ENV = "TRACKER_CONTAINER_ALLOW_DEFECTS";

/** 16 to 256 printable ASCII characters, no spaces (the fixture tokens' rule). */
const TOKEN_PATTERN = /^[\x21-\x7e]{16,256}$/;

/** The transport settings cannot be used: nothing was started. The CLI exits 2 with the message. */
export class TransportError extends Error {}

export type TransportLayout = "all" | "backend" | "server" | "stdio";

/** Whether container mode is on. Only "1" or "0" (or unset): any other value stops the start (fail closed). */
export function containerMode(env: Record<string, string | undefined>): boolean {
  const raw = env[CONTAINER_ENV];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new TransportError(`${CONTAINER_ENV}="${raw}" is not recognized; use 1 or 0. Not starting.`);
}

/**
 * Whether the R23 opt-in is on. Only "1" or "0" (or unset), as TRACKER_CONTAINER; any other value stops the start, and
 * "1" outside container mode is refused (it has no effect there: a defect build keeps every listener on loopback).
 */
export function containerAllowDefects(env: Record<string, string | undefined>): boolean {
  const raw = env[CONTAINER_ALLOW_DEFECTS_ENV];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") throw new TransportError(`${CONTAINER_ALLOW_DEFECTS_ENV}="${raw}" is not recognized; use 1 or 0. Not starting.`);
  if (!containerMode(env)) throw new TransportError(`${CONTAINER_ALLOW_DEFECTS_ENV}=1 has no effect outside container mode (${CONTAINER_ENV}=1): a build with defects keeps every listener on loopback there. Not starting.`);
  return true;
}

/** The MCP bearer token from the environment or its file, or undefined when neither is set. */
export function loadMcpToken(env: Record<string, string | undefined>, platform: string = process.platform): string | undefined {
  const direct = env[MCP_TOKEN_ENV.value];
  const file = env[MCP_TOKEN_ENV.file];
  if (direct !== undefined && file !== undefined) throw new TransportError(`set ${MCP_TOKEN_ENV.value} or ${MCP_TOKEN_ENV.file}, not both. Not starting.`);
  let token: string;
  if (file !== undefined) {
    let st;
    try {
      st = statSync(file);
    } catch {
      throw new TransportError(`${MCP_TOKEN_ENV.file} names a file that cannot be read. Not starting.`);
    }
    if (!st.isFile()) throw new TransportError(`${MCP_TOKEN_ENV.file} must name a regular file. Not starting.`);
    // The mode check is POSIX-only; on Windows the file's ACL is the operator's to set.
    if (platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new TransportError(`${MCP_TOKEN_ENV.file} must not be readable or writable by group or others (chmod 600). Not starting.`);
    }
    try {
      token = readFileSync(file, "utf8").trim();
    } catch {
      throw new TransportError(`${MCP_TOKEN_ENV.file} names a file that cannot be read. Not starting.`);
    }
  } else if (direct !== undefined) {
    token = direct;
  } else {
    return undefined;
  }
  if (!TOKEN_PATTERN.test(token)) throw new TransportError("the MCP token must be 16 to 256 printable characters with no spaces. Not starting.");
  return token;
}

/**
 * Checks the transport settings for one start and returns the MCP listener options (undefined for a layout with no
 * MCP listener). Refuses:
 *   - container mode for `backend` (its listener is loopback-only inside the container: run `all` there);
 *   - container mode for an MCP listener without a bearer token (X1);
 *   - TRACKER_CONTAINER_ALLOW_DEFECTS with a value other than 1 or 0, or set to 1 outside container mode (R23);
 *   - an MCP token over stdio, where there is no listener to protect;
 *   - an MCP token equal to another token (a principal's too, given in otherTokens), or one on the command line.
 */
export function resolveTransport(layout: TransportLayout, env: Record<string, string | undefined>, argv: readonly string[] = [],
  platform: string = process.platform, otherTokens: Record<string, string | undefined> = {}): McpListenOptions | undefined {
  const container = containerMode(env);
  containerAllowDefects(env); // R23: an unrecognized value, or the opt-in outside container mode, stops the start
  const token = loadMcpToken(env, platform);
  if (container && layout === "backend") {
    throw new TransportError("container mode runs `tiny-tracker all`, `server` or `stdio`; the backend listener stays on the container's loopback. Not starting.");
  }
  if (layout === "stdio") {
    if (token !== undefined) throw new TransportError(`${MCP_TOKEN_ENV.value} protects the HTTP listener; stdio has none. Unset it. Not starting.`);
    return undefined;
  }
  if (container && token === undefined) {
    throw new TransportError(`container mode listens on every interface and needs a bearer token for /mcp: set ${MCP_TOKEN_ENV.value} or ${MCP_TOKEN_ENV.file} (never on the command line). Not starting.`);
  }
  if (token !== undefined) {
    try {
      // otherTokens: the principals' tokens from TRACKER_BACKEND_TOKENS_FILE (the command line passes them).
      checkDistinct({ ...otherTokens, mcp: token, backend: env.TRACKER_BACKEND_TOKEN, evidence: env.TRACKER_EVIDENCE_TOKEN, control: env.TRACKER_CONTROL_TOKEN });
      checkArgv(argv, { mcp: token });
    } catch (e) {
      if (e instanceof TokenError) throw new TransportError(e.message);
      throw e;
    }
  }
  if (layout === "backend") return undefined;
  return { host: container ? "0.0.0.0" : "127.0.0.1", ...(token !== undefined ? { bearerToken: token } : {}) };
}
