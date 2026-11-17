// The stdio transport (R19; the SDK exports ./stdio, review G11).
//
//   tiny-tracker stdio [the options of `all`, except --port and --supervise]   (STDIO_USAGE below)
//
// The same server factory as the HTTP transport (createMcpServer), served
// with the SDK's serveStdio, which settles the protocol era on the opening
// exchange as the HTTP handler does. The backend runs in this process on a
// loopback port unless TRACKER_BACKEND_URL or --backend-url names one.
//
// stdout carries only protocol messages. The state line, the broken-build
// banner and every refusal go to stderr. The process exits when stdin closes.
//
// The command line (src/cli.ts) runs `stdio` through the same start as `all`,
// so fixture-layer features, the evidence and control listeners and the fault
// controller work over stdio too; a held answer (mcp/after-backend-reply/drop)
// is a reply line written late or never. Refused over stdio: --supervise
// (CMP-70: its MCP child is a separate process with no stdin of the client's).

import type { Readable, Writable } from "node:stream";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createBuild } from "./mcp/build.js";
import { ConfigError, loadConfig, type ServerConfig } from "./mcp/config.js";
import { TrackerApi } from "./mcp/api.js";
import { createMcpServer, MCP_HTTP_CAPS, type ServerExtras } from "./mcp/server.js";
import type { Build, Deps } from "./mcp/types.js";
import { applyVariants } from "./variants/index.js";

/** The largest single stdio message accepted, the same as the HTTP body cap (X5). */
export const MAX_STDIO_MESSAGE = MCP_HTTP_CAPS.maxBodyBytes;

export interface StartStdioOptions {
  /** TRACKER_* settings, as the process environment would carry them. TRACKER_BACKEND_URL and _TOKEN are required. */
  env: Record<string, string | undefined>;
  defects?: string[];
  features?: readonly string[];
  extras?: ServerExtras;
  /** The configured key retention, stated with the retention feature (as StartServerOptions.retentionMs). */
  retentionMs?: number;
  /** Default: this process's stdin and stdout. */
  stdin?: Readable;
  stdout?: Writable;
  /**
   * Called once when the connection ends (stdin closed, or close()). `failure` is set when the transport closed itself
   * on an error it cannot go on from: a message over MAX_STDIO_MESSAGE, or stdout failing while stdin is open.
   */
  onClose?: (failure?: string) => void;
}

export interface StartedStdioServer {
  build: Build;
  config: ServerConfig;
  variants: string[];
  close(): Promise<void>;
}

/** A checked configuration that does not read stdin yet (the command line serves it last, after the other listeners). */
export interface PreparedStdioServer extends StartedStdioServer {
  /** Starts reading stdin. Once only. */
  serve(): void;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Serves the MCP server over stdio. Throws ConfigError (and serves nothing) when the configuration is not acceptable. */
export function startStdioServer(options: StartStdioOptions): StartedStdioServer {
  const prepared = prepareStdioServer(options);
  prepared.serve();
  return prepared;
}

/**
 * Checks the configuration and builds the server without reading stdin. Throws ConfigError when the configuration is
 * not acceptable. The command line calls serve() after the control listener has started and --fault is armed, so the
 * first message a client sends meets the whole fixture (note 27 item 5), as `all` prints its state line last over HTTP.
 */
export function prepareStdioServer(options: StartStdioOptions): PreparedStdioServer {
  let build: Build;
  try {
    build = createBuild(options.defects ?? [], options.features ?? [], options.retentionMs);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const variants = applyVariants(build, options.env);
  const config = loadConfig(options.env, build.configRules, [...build.tools.keys()]);
  if (build.defects.length > 0 && !isLoopbackUrl(config.backendUrl)) {
    throw new ConfigError("A build with defects only talks to a backend on 127.0.0.1 or localhost. Not starting.");
  }
  const extras = options.extras ?? {};
  const deps: Deps = { api: new TrackerApi(config.backendUrl, config.backendToken, extras.attribution === true), config };
  let handle: StdioServerHandle | undefined;
  let closed = false;
  /** Why the transport closed itself, when it did so on an error (set in the same turn as the close). */
  let failure: string | undefined;
  const done = () => {
    if (closed) return;
    closed = true;
    options.onClose?.(failure);
  };
  return {
    build, config, variants,
    serve() {
      if (handle || closed) return;
      const transport = new StdioServerTransport(options.stdin, options.stdout, { maxBufferSize: MAX_STDIO_MESSAGE });
      // serveStdio owns the transport; chain our notices after its own handlers.
      handle = serveStdio(() => createMcpServer(build, config, deps, extras), { transport });
      const theirError = transport.onerror;
      transport.onerror = (error) => {
        // The transport closes itself in this same turn after an error it cannot go on from (a message over the cap,
        // stdout failing); an error it goes on from (a line that is not a JSON-RPC message) is forgotten next turn.
        failure = /exceeded maximum size/.test(error.message)
          ? `a stdio message was larger than ${MAX_STDIO_MESSAGE} bytes (4 MiB), the cap; the connection is closed`
          : `the stdio transport failed: ${error.message}`;
        queueMicrotask(() => { if (!closed) failure = undefined; });
        theirError?.(error);
      };
      const theirClose = transport.onclose;
      transport.onclose = () => {
        theirClose?.();
        done();
      };
    },
    async close() {
      if (handle) await handle.close();
      done();
    },
  };
}

export const STDIO_USAGE = `usage:
  tiny-tracker stdio [--backend-port N] [--defect NAME]... [--backend-defect NAME]... [--backend-url URL]
                     [--read-only VALUE] [--tools a,b] [--default-project KEY] [--profile 0.1|default] [--features a,b]
                     [--fixture-control] [--control-port N] [--token-dir DIR] [--data-dir DIR] [--key-retention D]
                     [--key-expiry POLICY] [--fault POINT[:once]]
The MCP server over stdin and stdout, with the same features, fixture layer and evidence as \`tiny-tracker all\`.
The backend runs in this process on a loopback port unless TRACKER_BACKEND_URL or --backend-url names one (then
TRACKER_BACKEND_TOKEN is required and the options of \`tiny-tracker server\` apply). The evidence routes are on the
backend listener (and TRACKER_EVIDENCE_LISTEN), the control listener on its own port, as with \`all\`.
stdout carries only protocol messages: the state line, the banner and every refusal go to stderr.
Not over stdio: --port (there is no MCP listener), --supervise (CMP-70) and an MCP bearer token.
The process exits 0 when stdin closes. A message over 4 MiB closes the connection: the reason goes to stderr and the
process exits 1.`;
