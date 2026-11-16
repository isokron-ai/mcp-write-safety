import type { RequirementId } from "../requirements.js";
import type { Build, ToolDef } from "../mcp/types.js";

/**
 * One deliberate defect. Each lives in its own file, replaces one correct
 * piece of the build, and is off unless named with --defect.
 */
export interface Defect {
  /** The --defect flag value and the file name. */
  name: string;
  requirement: RequirementId;
  /** What goes wrong, in one sentence. */
  summary: string;
  /** The published finding(s) it imitates, by class and article anchor. */
  mirrors: string;
  /** The correct code this defect replaces. */
  replaces: string;
  /**
   * True when the defect wraps whatever handler is in place instead of
   * replacing it. Wrapping defects are applied after replacing ones, so that
   * with --defect all no defect hides another.
   */
  wraps?: boolean;
  apply(build: Build): void;
}

/** Replaces parts of one tool definition, keeping the rest. */
export function patchTool(build: Build, name: string, patch: Partial<ToolDef>): ToolDef {
  const tool = build.tools.get(name);
  if (!tool) throw new Error(`defect refers to unknown tool ${name}`);
  const next = { ...tool, ...patch };
  build.tools.set(name, next);
  return next;
}

/**
 * Rewrites the write-result shape of a result, in structuredContent and in its serialized mirror alike, so that a defect
 * lies consistently (the prose block is left as the correct code wrote it). Used by the lying-shape defects only.
 */
export function rewriteShape<T>(r: T, change: (mws: Record<string, any>) => void): T {
  const res = r as { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any> };
  const mws = res.structuredContent?.mws;
  if (!mws) return r;
  const next = JSON.parse(JSON.stringify(mws));
  change(next);
  const structuredContent = { ...res.structuredContent, mws: next };
  const content = (res.content ?? []).map((c) => {
    if (c.type !== "text" || !c.text?.trimStart().startsWith("{")) return c;
    try {
      return "mws" in JSON.parse(c.text) ? { ...c, text: JSON.stringify(structuredContent) } : c;
    } catch {
      return c;
    }
  });
  return { ...res, content, structuredContent } as T;
}
