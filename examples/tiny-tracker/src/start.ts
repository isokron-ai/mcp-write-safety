// Starting tiny-tracker from code (the CLI and the tests both use this).

import { createBuild } from "./mcp/build.js";
import { ConfigError, loadConfig, type ServerConfig } from "./mcp/config.js";
import { startMcpServer, type RunningMcpServer, type ServerExtras } from "./mcp/server.js";
import type { Build } from "./mcp/types.js";
import { applyVariants } from "./variants/index.js";

export { startBackend, type RunningBackend } from "./backend/http.js";
export { ConfigError } from "./mcp/config.js";
export { DEFECTS } from "./defects/index.js";
export { BACKEND_DEFECTS } from "./backend/defects/index.js";
export { REQUIREMENTS, REQUIREMENT_IDS, type RequirementId } from "./requirements.js";
export { VARIANTS } from "./variants/index.js";

export interface StartServerOptions {
  /** TRACKER_* settings, as the process environment would carry them. */
  env: Record<string, string | undefined>;
  /** Defect names, requirement IDs or "all". Empty for the correct build. */
  defects?: string[];
  port?: number;
  /** Active features; "all" and a requirement ID take only the defects valid for them. */
  features?: readonly string[];
  /** What the fixture layer adds (attribution, the build descriptor mirror). */
  extras?: ServerExtras;
}

export interface StartedServer extends RunningMcpServer {
  build: Build;
  /** The variants switched on (TRACKER_VARIANTS). */
  variants: string[];
  config: ServerConfig;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Starts the MCP server. Throws ConfigError (and starts nothing) when the
 * configuration is not acceptable.
 */
export async function startServer(options: StartServerOptions): Promise<StartedServer> {
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
  const running = await startMcpServer(build, config, options.port ?? 0, options.extras ?? {});
  return { ...running, build, config, variants };
}
