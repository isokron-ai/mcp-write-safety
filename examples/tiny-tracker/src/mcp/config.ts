// Server configuration. Safety settings fail closed: a value the server does
// not recognize stops it at start (MWS-CFG-1, MWS-CFG-2).

import type { ToolDef } from "./types.js";

export interface ServerConfig {
  backendUrl: string;
  backendToken: string;
  readOnly: boolean;
  /** Allow-list of tool names, or null for all tools. */
  tools: string[] | null;
  /** Deny-list of tool names (TRACKER_DENY_TOOLS), or null. */
  deny: string[] | null;
  defaultProject: string;
}

export class ConfigError extends Error {}

/** The rules a configuration defect may replace. */
export interface ConfigRules {
  parseReadOnly(raw: string | undefined): boolean;
  resolveToolList(raw: string | undefined, known: string[]): string[] | null;
  resolveDenyList(raw: string | undefined, known: string[]): string[] | null;
  /** Whether a tool is offered and callable under this configuration. */
  isEnabled(tool: ToolDef, config: ServerConfig): boolean;
}

const TRUE = ["true", "1", "yes", "on"];
const FALSE = ["false", "0", "no", "off", ""];

export const correctConfigRules: ConfigRules = {
  parseReadOnly(raw) {
    if (raw === undefined) return false;
    const value = raw.trim().toLowerCase();
    if (TRUE.includes(value)) return true;
    if (FALSE.includes(value)) return false;
    throw new ConfigError(`TRACKER_READ_ONLY="${raw}" is not recognized; use one of ${[...TRUE, ...FALSE.filter(Boolean)].join(", ")}. Not starting.`);
  },

  resolveToolList(raw, known) {
    if (raw === undefined || raw.trim() === "") return null;
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) throw new ConfigError(`TRACKER_TOOLS="${raw}" names no tools. Not starting.`);
    const unknown = names.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      throw new ConfigError(`TRACKER_TOOLS names unknown tools: ${unknown.join(", ")}. Not starting.`);
    }
    return names;
  },

  resolveDenyList(raw, known) {
    if (raw === undefined || raw.trim() === "") return null;
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    // A misspelled deny-list entry would leave the tool it meant switched on (MWS-CFG-2): fail closed.
    const unknown = names.filter((n) => !known.includes(n));
    if (unknown.length > 0) throw new ConfigError(`TRACKER_DENY_TOOLS names unknown tools: ${unknown.join(", ")}. Not starting.`);
    return names;
  },

  isEnabled(tool, config) {
    if (config.tools && !config.tools.includes(tool.name)) return false;
    if (config.deny && config.deny.includes(tool.name)) return false;
    if (config.readOnly && tool.mutates) return false;
    return true;
  },
};

export function loadConfig(env: Record<string, string | undefined>, rules: ConfigRules, knownTools: string[]): ServerConfig {
  const backendUrl = env.TRACKER_BACKEND_URL;
  const backendToken = env.TRACKER_BACKEND_TOKEN;
  if (!backendUrl) throw new ConfigError("TRACKER_BACKEND_URL is required. Not starting.");
  if (!backendToken) throw new ConfigError("TRACKER_BACKEND_TOKEN is required. Not starting.");
  return {
    backendUrl,
    backendToken,
    readOnly: rules.parseReadOnly(env.TRACKER_READ_ONLY),
    tools: rules.resolveToolList(env.TRACKER_TOOLS, knownTools),
    deny: rules.resolveDenyList(env.TRACKER_DENY_TOOLS, knownTools),
    defaultProject: env.TRACKER_DEFAULT_PROJECT ?? "inbox",
  };
}
