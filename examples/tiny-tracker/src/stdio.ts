// The stdio transport (R19; the SDK exports ./stdio, review G11).
//
//   tiny-tracker stdio [--defect NAME]... [--backend-defect NAME]... [--backend-url URL]
//                      [--backend-port N] [--read-only VALUE] [--tools a,b] [--default-project KEY]
//                      [--profile 0.1|default] [--features a,b]
//
// The same server factory as the HTTP transport (createMcpServer), served
// with the SDK's serveStdio, which settles the protocol era on the opening
// exchange as the HTTP handler does. The backend runs in this process on a
// loopback port unless TRACKER_BACKEND_URL or --backend-url names one.
//
// stdout carries only protocol messages. The state line, the broken-build
// banner and every refusal go to stderr. The process exits when stdin closes.
//
// Not in this version: fixture-layer features and --fixture-control over
// stdio (CMP-70). A held answer over stdio (a dropped reply line) arrives with
// the fault controller.

import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createBuild } from "./mcp/build.js";
import { ConfigError, loadConfig, type ServerConfig } from "./mcp/config.js";
import { TrackerApi } from "./mcp/api.js";
import { createMcpServer, MCP_HTTP_CAPS, type ServerExtras } from "./mcp/server.js";
import type { Build, Deps } from "./mcp/types.js";
import { applyVariants } from "./variants/index.js";
import { startBackend, type RunningBackend } from "./backend/http.js";
import { resolveDefects } from "./defects/index.js";
import { activeFeatures, parseFeatures, parseProfile, SettingError } from "./profile.js";
import { checkCompat } from "./compat.js";
import { checkArgv, checkDistinct, TokenError } from "./tokens.js";
import { resolveTransport, TransportError } from "./transport.js";

/** The largest single stdio message accepted, the same as the HTTP body cap (X5). */
export const MAX_STDIO_MESSAGE = MCP_HTTP_CAPS.maxBodyBytes;

export interface StartStdioOptions {
  /** TRACKER_* settings, as the process environment would carry them. TRACKER_BACKEND_URL and _TOKEN are required. */
  env: Record<string, string | undefined>;
  defects?: string[];
  features?: readonly string[];
  extras?: ServerExtras;
  /** Default: this process's stdin and stdout. */
  stdin?: Readable;
  stdout?: Writable;
  /** Called once when the connection ends (stdin closed, or close()). */
  onClose?: () => void;
}

export interface StartedStdioServer {
  build: Build;
  config: ServerConfig;
  variants: string[];
  close(): Promise<void>;
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
  let build: Build;
  try {
    build = createBuild(options.defects ?? [], options.features ?? []);
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
  const transport = new StdioServerTransport(options.stdin, options.stdout, { maxBufferSize: MAX_STDIO_MESSAGE });
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    options.onClose?.();
  };
  // serveStdio owns the transport; chain our close notice after its own handler.
  const handle: StdioServerHandle = serveStdio(() => createMcpServer(build, config, deps, extras), { transport });
  const theirs = transport.onclose;
  transport.onclose = () => {
    theirs?.();
    done();
  };
  return {
    build, config, variants,
    async close() {
      await handle.close();
      done();
    },
  };
}

const STDIO_USAGE = `usage:
  tiny-tracker stdio [--defect NAME]... [--backend-defect NAME]... [--backend-url URL] [--backend-port N]
                     [--read-only VALUE] [--tools a,b] [--default-project KEY] [--profile 0.1|default] [--features a,b]
The MCP server over stdin and stdout. The backend runs in this process unless TRACKER_BACKEND_URL or --backend-url
names one (then TRACKER_BACKEND_TOKEN is required). The state line goes to stderr; stdout carries only protocol messages.`;

/** The parsed command line, as cli.ts gives it (the same options as the HTTP layouts). */
export interface StdioCliValues {
  [name: string]: string | boolean | string[] | undefined;
}

/** Runs `tiny-tracker stdio`. Exits 2 with a message on stderr for any refused setting, as the other layouts do. */
export async function runStdioCli(values: StdioCliValues, positionals: readonly string[], argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const fail = (message: string): never => {
    process.stderr.write(`tiny-tracker: ${message}\n`);
    process.exit(2);
  };
  if (values.help) {
    process.stderr.write(`${STDIO_USAGE}\n`);
    process.exit(0);
  }
  if (positionals.length > 1) fail(`stdio takes no positional arguments (got ${positionals.slice(1).join(" ")}). Not starting.`);
  const noListener = ["port", "control-port", "fixture-control", "token-dir"].filter((k) => values[k] !== undefined);
  if (noListener.length > 0) fail(`${noListener.map((k) => `--${k}`).join(", ")} has no effect over stdio. Not starting.`);

  const env: Record<string, string | undefined> = { ...process.env };
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  if (str("read-only") !== undefined) env.TRACKER_READ_ONLY = str("read-only");
  if (str("tools") !== undefined) env.TRACKER_TOOLS = str("tools");
  if (str("default-project") !== undefined) env.TRACKER_DEFAULT_PROJECT = str("default-project");
  if (str("backend-url") !== undefined) env.TRACKER_BACKEND_URL = str("backend-url");
  const defects = [
    ...((values.defect as string[] | undefined) ?? []),
    ...(str("defects") ?? env.TRACKER_DEFECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ];
  const backendDefects = (values["backend-defect"] as string[] | undefined) ?? [];
  const inProcessBackend = env.TRACKER_BACKEND_URL === undefined;

  let profile: ReturnType<typeof parseProfile>, named: ReturnType<typeof parseFeatures>, features: string[];
  try {
    profile = parseProfile(str("profile") ?? env.TRACKER_PROFILE);
    named = parseFeatures(str("features") ?? env.TRACKER_FEATURES);
    features = activeFeatures(profile, named);
  } catch (e) {
    if (e instanceof SettingError) fail(e.message);
    throw e;
  }
  let mcpDefects: string[] = [];
  try {
    mcpDefects = resolveDefects(defects, features).map((d) => d.name);
  } catch (e) {
    fail((e as Error).message);
  }
  const variantNames = (env.TRACKER_VARIANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const refusals = checkCompat({
    layout: inProcessBackend ? "all" : "server", transport: "stdio", profile, features: named, defects: mcpDefects, backendDefects,
    variants: variantNames, faults: [], fixtureControl: false, dataDir: str("data-dir"),
  });
  if (str("data-dir") !== undefined && !features.includes("durable")) refusals.push("--data-dir has no effect without the durable feature");
  if (!inProcessBackend && str("backend-port") !== undefined) refusals.push("--backend-port has no effect with --backend-url (the backend is another process)");
  if (refusals.length > 0) fail(`${refusals.join("; ")}. Not starting.`);

  try {
    resolveTransport("stdio", env, argv);
  } catch (e) {
    if (e instanceof TransportError) fail(e.message);
    throw e;
  }
  if (inProcessBackend && !env.TRACKER_BACKEND_TOKEN) env.TRACKER_BACKEND_TOKEN = `tt-local-${randomBytes(16).toString("hex")}`;
  if (!env.TRACKER_BACKEND_TOKEN) fail("TRACKER_BACKEND_TOKEN is required with --backend-url. Not starting.");
  try {
    const tokens = { backend: env.TRACKER_BACKEND_TOKEN, evidence: env.TRACKER_EVIDENCE_TOKEN, control: env.TRACKER_CONTROL_TOKEN };
    checkDistinct(tokens);
    checkArgv(argv, tokens);
  } catch (e) {
    if (e instanceof TokenError) fail(e.message);
    throw e;
  }

  const out: Record<string, unknown> = { transport: "stdio" };
  let backend: RunningBackend | undefined;
  if (inProcessBackend) {
    const port = str("backend-port") === undefined ? 0 : Number(str("backend-port"));
    try {
      backend = await startBackend({ token: env.TRACKER_BACKEND_TOKEN!, port, defects: backendDefects, features });
    } catch (e) {
      fail((e as Error).message);
    }
    env.TRACKER_BACKEND_URL = backend!.url;
    out.backend = backend!.url;
    if (backendDefects.length) out.backend_defects = backendDefects;
  }
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await backend?.close().catch(() => {});
    process.exit(0);
  };
  let server: StartedStdioServer;
  try {
    server = startStdioServer({ env, defects, features, onClose: () => void finish() });
  } catch (e) {
    await backend?.close().catch(() => {});
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
  process.on("SIGINT", () => void server.close().then(finish));
  process.on("SIGTERM", () => void server.close().then(finish));
  out.defects = server.build.defects;
  out.read_only = server.config.readOnly;
  if (server.variants.length) out.variants = server.variants;
  if (server.build.defects.length || backendDefects.length) {
    process.stderr.write("\n*** tiny-tracker BROKEN BUILD (teaching fixture): "
      + `${[...server.build.defects, ...backendDefects.map((d) => `backend:${d}`)].join(", ")}.\n`
      + "*** Deliberately unsafe. Never point it at data you care about. ***\n\n");
  }
  process.stderr.write(`${JSON.stringify(out)}\n`);
}
