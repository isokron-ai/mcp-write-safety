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

export const SERVER_INFO = { name: "tiny-tracker", version: "0.1.0" };

export interface RunningMcpServer {
  url: string;
  close(): Promise<void>;
}

/** Builds one McpServer instance with the tools this configuration enables. */
export function createMcpServer(build: Build, config: ServerConfig, deps: Deps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: [
      build.defects.length > 0 ? `TEACHING BUILD WITH DELIBERATE DEFECTS (${build.defects.join(", ")}). Do not use for real data.` : "A small issue tracker.",
      config.readOnly ? "READ-ONLY MODE: every write tool refuses its calls; only list and get tools work."
        : "Read a ticket's version with get_ticket and pass it as expected_version when you write.",
    ].join(" "),
  });
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
    }, (readOnlyRefusal
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

export async function startMcpServer(build: Build, config: ServerConfig, port = 0): Promise<RunningMcpServer> {
  const deps: Deps = { api: new TrackerApi(config.backendUrl, config.backendToken), config };
  const handler = createMcpHandler(() => createMcpServer(build, config, deps));
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
