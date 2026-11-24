import type { CallToolResult, InputRequiredResult, ToolAnnotations } from "@modelcontextprotocol/server";
import type { TrackerApi } from "./api.js";
import type { JsonSchema, Validation } from "./validate.js";
import type { ServerConfig, ConfigRules } from "./config.js";

export interface Deps {
  api: TrackerApi;
  config: ServerConfig;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: JsonSchema;
  /**
   * The server's own record of whether the tool changes state. Read-only mode
   * is enforced from this, never from `annotations` (MWS-CFG-3): annotations
   * are claims made to clients and are themselves under test.
   */
  mutates: boolean;
  annotations?: ToolAnnotations;
  /** ctx is the SDK's request context (for input_required: ctx.mcpReq.inputResponses). */
  handler(args: any, deps: Deps, ctx?: any): Promise<CallToolResult | InputRequiredResult>;
}

/**
 * Everything a defect may replace: the tools (handler, schema, annotations),
 * the validation steps and the configuration rules. The correct build is
 * `createBuild([])`.
 */
export interface Build {
  tools: Map<string, ToolDef>;
  validation: Validation;
  configRules: ConfigRules;
  defects: string[];
  /** The stated key retention (feature retention, FX-KEY-2), also carried in the server instructions (0.4.0). */
  retention?: string;
}
