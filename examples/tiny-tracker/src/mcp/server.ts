// The MCP server: the official TypeScript SDK's McpServer, served over
// Streamable HTTP with createMcpHandler (2026-07-28, with the stateless
// 2025-era fallback), on node:http, loopback only.

import { fail, notApplied } from "./results.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { TrackerApi } from "./api.js";
import type { ServerConfig } from "./config.js";
import type { Build, Deps } from "./types.js";
import { toolInputSchema } from "./validate.js";
import { attributionFromMeta, runWithAttribution } from "../attribution.js";

export const SERVER_INFO = { name: "tiny-tracker", version: "0.3.0" };

export interface RunningMcpServer {
  url: string;
  close(): Promise<void>;
}

/**
 * What the fixture layer adds to the MCP server, without the server importing it. Absent in profile 0.1 and in
 * every build that names no fixture feature, so their instructions and results are exactly the 0.1.0 ones.
 */
export interface ServerExtras {
  /** Read run and operation tags from request _meta and stamp them on every backend request (design rule 3). */
  attribution?: boolean;
  /** The build descriptor, mirrored (design rule 6): a sentence for the instructions and a _meta member for every result. */
  mirror?: {
    instructions(): string;
    meta(): Record<string, unknown>;
  };
  /**
   * The MCP-layer fault point (frozen hook; the fault controller fills it in 0.2.0): called with every tool result after
   * the handler, before the answer. It returns the result to send, or a promise that settles later (delay) or, within its
   * cap, not at all (drop). It runs inside the attribution context, so it sees the call's run and operation tags.
   */
  onResult?(tool: string, result: unknown, ctx: unknown): Promise<unknown>;
}

/** Builds one McpServer instance with the tools this configuration enables. */
export function createMcpServer(build: Build, config: ServerConfig, deps: Deps, extras: ServerExtras = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: [
      build.defects.length > 0 ? `TEACHING BUILD WITH DELIBERATE DEFECTS (${build.defects.join(", ")}). Do not use for real data.` : "A small issue tracker.",
      config.readOnly ? "READ-ONLY MODE: every write tool refuses its calls; only list and get tools work."
        : "Read a ticket's version with get_ticket and pass it as expected_version when you write.",
      ...(extras.mirror ? [extras.mirror.instructions()] : []),
    ].join(" "),
  });
  // The wrapper every tool call goes through. With no extras it is the handler itself.
  const wrap = (toolName: string, fn: (args: unknown, ctx: unknown) => Promise<unknown>) => {
    if (!extras.attribution && !extras.mirror && !extras.onResult) return fn;
    return async (args: unknown, ctx: unknown) => {
      const meta = (ctx as { mcpReq?: { _meta?: unknown } } | undefined)?.mcpReq?._meta;
      const call = async () => {
        const r = await fn(args, ctx);
        return extras.onResult ? extras.onResult(toolName, r, ctx) : r;
      };
      const result = extras.attribution ? await runWithAttribution(attributionFromMeta(meta), call) : await call();
      if (!extras.mirror || result === null || typeof result !== "object") return result;
      const r = result as { _meta?: Record<string, unknown> };
      return { ...r, _meta: { ...(r._meta ?? {}), ...extras.mirror.meta() } };
    };
  };
  for (const tool of build.tools.values()) {
    const enabled = build.configRules.isEnabled(tool, config);
    // A write tool switched off only by read-only mode stays listed and refuses every call with a clear tool
    // error, so a caller learns why (MWS-CFG-3 is met either way: absent or refused).
    const readOnlyRefusal = !enabled && config.readOnly && build.configRules.isEnabled(tool, { ...config, readOnly: false });
    if (!enabled && !readOnlyRefusal) continue;
    server.registerTool(tool.name, {
      title: tool.title,
      description: readOnlyRefusal ? `${tool.description} (Unavailable: the server is in read-only mode.)` : tool.description,
      inputSchema: toolInputSchema(tool.input, build.validation),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }, wrap(tool.name, readOnlyRefusal
      ? async () => fail(`${tool.name} is unavailable: this server runs in read-only mode (TRACKER_READ_ONLY). Nothing was written.`, { read_only: true },
        notApplied({ operation: tool.name, type: "tool", guard: null, read: { tool: "list_projects", arguments: {} } }, "not_permitted"))
      : (args: unknown, ctx: unknown) => tool.handler(args, deps, ctx)) as never);
  }
  return server;
}

const MAX_BODY = 4 * 1024 * 1024;
class BodyTooLarge extends Error {}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostAllowed(req: IncomingMessage): boolean {
  // DNS-rebinding guard: only loopback Host and Origin values are served.
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOOPBACK_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const o = new URL(origin);
    return (o.protocol === "http:" || o.protocol === "https:")
      && (LOOPBACK_HOSTS.has(o.hostname) || LOOPBACK_HOSTS.has(`[${o.hostname}]`));
  } catch {
    return false;
  }
}

/** Minimal node:http to fetch-API bridge for the SDK's web-standard handler. */
async function toWebRequest(req: IncomingMessage, port: number): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  let body: Uint8Array | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new BodyTooLarge();
      chunks.push(chunk as Buffer);
    }
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method, headers, body });
}

async function sendWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

export async function startMcpServer(build: Build, config: ServerConfig, port = 0, extras: ServerExtras = {}): Promise<RunningMcpServer> {
  const deps: Deps = { api: new TrackerApi(config.backendUrl, config.backendToken, extras.attribution === true), config };
  const handler = createMcpHandler(() => createMcpServer(build, config, deps, extras));
  let boundPort = 0;
  const http = createServer((req, res) => {
    void (async () => {
      try {
        if (!hostAllowed(req)) {
          res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden: loopback Host and Origin only");
          return;
        }
        if (!/^\/mcp(\?|$)/.test(req.url ?? "")) {
          res.writeHead(404, { "content-type": "text/plain" }).end("Not found; the MCP endpoint is /mcp");
          return;
        }
        await sendWebResponse(await handler.fetch(await toWebRequest(req, boundPort)), res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(e instanceof BodyTooLarge ? 413 : 500, { "content-type": "text/plain" });
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  boundPort = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    async close() {
      await handler.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
