// The 0.1 surface (design rule 1, reviews B11 and T4): a recorded scenario set
// run against a tiny-tracker command line, giving a transcript of everything a
// client sees except serverInfo.version and result _meta:
//
//   - the first stdout line (the state line), with ports masked;
//   - initialize: serverInfo.name, capabilities, instructions;
//   - tools/list, in full;
//   - every tools/call result (content, structuredContent, isError and any
//     other member but _meta), in order.
//
// The same recorder captured test/golden/surface-0.1.0.json from the
// published 0.1.0 tarball (test/capture-surface.ts); test/surface.test.ts runs
// it against this tree with --profile 0.1, and against the default build.
//
// Masking, and only this: ISO-8601 timestamps become "<time>" and loopback
// ports become "<port>". Everything else, ids and versions included, must be
// identical: the scenarios are sequential, in a fresh process each, with a
// fixed backend token, so the 0.1.0 package gives the same bytes every time
// (the capture tool records twice and refuses to write if the two differ).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export type Era = "2026-07-28" | "2025-11-25";

/** The backend token every scenario runs with. A fixed, obviously fake value: token-in-error shows it. */
export const SURFACE_TOKEN = "tt-surface-fixed-token-0000000000000000";

export interface SurfaceCall {
  tool: string;
  args: Record<string, unknown>;
  /** "raw": one tools/call over 2026-07-28 sent as JSON-RPC by hand, so input_required and its retry are visible. */
  via: "client" | "raw";
  result: unknown;
}

export interface SurfaceConfig {
  name: string;
  args: string[];
  env?: Record<string, string>;
  era: Era;
  script: "full" | "short" | "readonly" | "keyed";
}

export interface ConfigTranscript {
  name: string;
  args: string[];
  env: Record<string, string>;
  era: Era;
  start: { stateLine: unknown };
  initialize: { serverName: string | undefined; capabilities: unknown; instructions: string | undefined };
  tools: unknown[];
  calls: SurfaceCall[];
}

export interface Transcript {
  surface: "tiny-tracker-surface/1";
  excluded: string[];
  masked: string[];
  configs: ConfigTranscript[];
}

/** The recorded scenario set. A journal path in env is filled in per run ({JOURNAL}). */
export const SURFACE_CONFIGS: SurfaceConfig[] = [
  { name: "correct, 2026-07-28", args: ["all"], era: "2026-07-28", script: "full" },
  { name: "correct, 2025-11-25", args: ["all"], era: "2025-11-25", script: "full" },
  { name: "every defect, 2026-07-28", args: ["all", "--defect", "all"], era: "2026-07-28", script: "full" },
  { name: "every defect, 2025-11-25", args: ["all", "--defect", "all"], era: "2025-11-25", script: "short" },
  { name: "MWS-RETRY-2 defects", args: ["all", "--defect", "MWS-RETRY-2"], era: "2026-07-28", script: "keyed" },
  { name: "read-only", args: ["all", "--read-only", "true"], era: "2026-07-28", script: "readonly" },
  { name: "allow-list", args: ["all", "--tools", "list_tickets,get_ticket,create_ticket"], era: "2026-07-28", script: "short" },
  { name: "deny-list", args: ["all"], env: { TRACKER_DENY_TOOLS: "delete_tickets,delete_project" }, era: "2026-07-28", script: "short" },
  { name: "variant key-store-honest", args: ["all"], env: { TRACKER_VARIANTS: "key-store-honest", TRACKER_KEY_JOURNAL: "{JOURNAL}" }, era: "2026-07-28", script: "keyed" },
  { name: "backend defect lost-update", args: ["all", "--backend-defect", "lost-update"], era: "2026-07-28", script: "short" },
];

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const LOOPBACK_PORT = /(127\.0\.0\.1|localhost|\[::1\]):\d+/g;

export function mask<T>(value: T): T {
  if (typeof value === "string") return value.replace(ISO_TIME, "<time>").replace(LOOPBACK_PORT, "$1:<port>") as T;
  if (Array.isArray(value)) return value.map(mask) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mask(v)])) as T;
  }
  return value;
}

/** A tool result as recorded: every member but _meta (outside the surface; the build descriptor mirror lives there). */
function surfaceOf(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const { _meta, ...rest } = result as Record<string, unknown>;
  void _meta;
  return rest;
}

async function rawCall(url: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<any> {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } }, "io.modelcontextprotocol/clientInfo": { name: "tiny-tracker-surface", version: "1" } };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { ...extra, name, arguments: args, _meta: meta } }),
  });
  const text = await res.text();
  const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}";
  const parsed = JSON.parse(line);
  return parsed.result ?? { jsonrpcError: parsed.error };
}

type Rec = (tool: string, args: Record<string, unknown>) => Promise<void>;

/** Everything a scenario can do: call through the client, or raw over 2026-07-28. */
interface Driver {
  rec: Rec;
  close: (id: string) => Promise<void>;
}

async function fullScript({ rec, close }: Driver): Promise<void> {
  await rec("list_projects", {});
  await rec("create_project", { key: "golden", name: "Golden" });
  await rec("create_project", { key: "golden", name: "Again" });
  await rec("create_project", { key: "Bad Key", name: "x" });
  await rec("create_project", { key: "keyed", name: "Keyed", idempotency_key: "golden-project-0001" });
  await rec("create_project", { key: "keyed", name: "Keyed", idempotency_key: "golden-project-0001" });
  await rec("create_ticket", { project: "golden", title: "First", priority: 2, labels: ["a", "b"], idempotency_key: "golden-ticket-0001" });
  await rec("create_ticket", { project: "golden", title: "First", priority: 2, labels: ["a", "b"], idempotency_key: "golden-ticket-0001" });
  await rec("create_ticket", { project: "golden", title: "First, changed", priority: 2, labels: ["a", "b"], idempotency_key: "golden-ticket-0001" });
  await rec("create_ticket", { title: "Default project ticket", assignee: "ann", description: "", details: { component: "api", severity: "low" } });
  await rec("create_ticket", { project: "nope", title: "x" });
  await rec("create_ticket", { title: 5 });
  await rec("create_ticket", { title: "x", bogus: true });
  await rec("create_ticket", { title: "x", priority: 9 });
  await rec("create_ticket", { title: "x", priority: "3" });
  await rec("create_ticket", { project: "golden", title: "Second", status: "in_progress" });
  await rec("get_ticket", { id: "T-1" });
  await rec("get_ticket", { id: "T-999" });
  await rec("list_tickets", { project: "golden" });
  await rec("list_tickets", { title_prefix: "Default" });
  await rec("list_tickets", { status: "closed" });
  await rec("update_ticket", { id: "T-1", title: "Renamed", expected_version: 1 });
  await rec("update_ticket", { id: "T-1", title: "Stale", expected_version: 1 });
  await rec("update_ticket", { id: "T-1", title: "No version" });
  await rec("update_ticket", { id: "T-1", assignee: null, force: true });
  await rec("update_ticket", { id: "T-1", expected_version: 3 });
  await rec("update_ticket", { id: "T-1", details: { severity: "high" }, expected_version: 3 });
  await rec("update_ticket", { id: "T-1", asignee: "bob", expected_version: 4 });
  await rec("replace_ticket", { id: "T-2", expected_version: 1, title: "Replaced", status: "open", assignee: null, priority: 4 });
  await rec("replace_ticket", { id: "T-2", expected_version: 1, title: "Stale", status: "open", assignee: null, priority: 4 });
  await rec("add_label", { id: "T-1", name: "c" });
  await rec("add_label", { id: "T-1", name: "c" });
  await rec("remove_label", { id: "T-1", label_id: "L-1" });
  await rec("remove_label", { id: "T-1", label_id: "L-99" });
  await rec("get_ticket", { id: "T-1" });
  await rec("set_labels", { id: "T-1", labels: ["x", "c"], expected_version: 1 });
  await rec("set_labels", { id: "T-1", labels: ["x", "c"], force: true });
  await rec("add_comment", { id: "T-1", body: "hello", idempotency_key: "golden-comment-0001" });
  await rec("add_comment", { id: "T-1", body: "hello", idempotency_key: "golden-comment-0001" });
  await rec("add_comment", { id: "T-999", body: "x" });
  await rec("bulk_update_tickets", { project: "golden", ids: ["T-1", "T-3"], status: "in_progress" });
  await rec("bulk_update_tickets", { project: "golden", ids: ["T-1", "T-999"], assignee: "cy" });
  await close("T-2");
  await rec("get_ticket", { id: "T-2" });
  await rec("delete_ticket", { id: "T-3", expected_version: 1 });
  await rec("delete_ticket", { id: "T-3", force: true });
  await rec("delete_ticket", { id: "T-3", force: true });
  await rec("delete_tickets", { project: "golden" });
  await rec("delete_tickets", { project: "golden", status: "in_progress" });
  await rec("delete_tickets", { project: "golden", all: true });
  await rec("delete_project", { key: "golden" });
  await rec("delete_project", { key: "inbox" });
  await rec("list_projects", {});
}

async function shortScript({ rec }: Driver): Promise<void> {
  await rec("list_projects", {});
  await rec("create_ticket", { title: "Short", priority: 3, idempotency_key: "short-ticket-0001" });
  await rec("get_ticket", { id: "T-1" });
  await rec("update_ticket", { id: "T-1", status: "in_progress", expected_version: 1 });
  await rec("update_ticket", { id: "T-1", status: "open", expected_version: 1 });
  await rec("list_tickets", {});
  await rec("delete_tickets", { project: "inbox" });
  await rec("delete_project", { key: "inbox" });
}

async function readonlyScript({ rec, close }: Driver): Promise<void> {
  await rec("list_projects", {});
  await rec("list_tickets", {});
  await rec("create_ticket", { title: "Refused" });
  await rec("create_project", { key: "nope", name: "Nope" });
  await rec("update_ticket", { id: "T-1", title: "x", force: true });
  await rec("delete_tickets", { project: "inbox", all: true });
  await close("T-1");
}

async function keyedScript({ rec }: Driver): Promise<void> {
  await rec("create_ticket", { title: "Keyed", priority: 2, idempotency_key: "keyed-ticket-0001" });
  await rec("create_ticket", { title: "Keyed", priority: 2, idempotency_key: "keyed-ticket-0001" });
  await rec("create_ticket", { title: "Keyed", priority: 5, idempotency_key: "keyed-ticket-0001" });
  await rec("create_ticket", { title: "Unkeyed", priority: 2 });
  await rec("add_comment", { id: "T-1", body: "c", idempotency_key: "keyed-comment-0001" });
  await rec("add_comment", { id: "T-1", body: "c", idempotency_key: "keyed-comment-0001" });
  await rec("list_tickets", {});
}

const SCRIPTS = { full: fullScript, short: shortScript, readonly: readonlyScript, keyed: keyedScript };

interface Started {
  child: ChildProcess;
  stateLine: any;
  stderr: () => string;
}

function startCli(cli: string, args: string[], env: Record<string, string>): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no state line from ${args.join(" ")}: ${stderr}`)); }, 15000);
    child.stderr!.on("data", (d) => { stderr += d; });
    child.stdout!.on("data", (d) => {
      stdout += d;
      if (stdout.includes("\n")) {
        clearTimeout(timer);
        try {
          resolve({ child, stateLine: JSON.parse(stdout.split("\n")[0]), stderr: () => stderr });
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code} before its state line: ${stderr}`)); });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.removeAllListeners("exit");
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}

export interface RecordOptions {
  /** Path to the command line to run (dist/src/cli.js of a package). */
  cli: string;
  /** Appended to every configuration's arguments (e.g. ["--profile", "0.1"]). */
  extraArgs?: string[];
  /** MCP port; the backend gets portBase + 1. */
  portBase: number;
  configs?: SurfaceConfig[];
}

export async function recordSurface(options: RecordOptions): Promise<Transcript> {
  const out: ConfigTranscript[] = [];
  for (const config of options.configs ?? SURFACE_CONFIGS) {
    const dir = mkdtempSync(join(tmpdir(), "tt-surface-"));
    try {
      const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, v.replace("{JOURNAL}", join(dir, "keys"))]));
      const args = [...config.args, "--port", String(options.portBase), "--backend-port", String(options.portBase + 1), ...(options.extraArgs ?? [])];
      const started = await startCli(options.cli, args, { TRACKER_BACKEND_TOKEN: SURFACE_TOKEN, ...env });
      try {
        out.push(await recordOne(config, started.stateLine));
      } finally {
        await stop(started.child);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    surface: "tiny-tracker-surface/1",
    excluded: ["initialize serverInfo.version", "tool result _meta"],
    masked: ["ISO-8601 timestamps as <time>", "loopback ports as <port>"],
    configs: mask(out),
  };
}

async function recordOne(config: SurfaceConfig, stateLine: any): Promise<ConfigTranscript> {
  const url = stateLine.mcp as string;
  const client = new Client({ name: "tiny-tracker-surface", version: "1" },
    config.era === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const calls: SurfaceCall[] = [];
    const rec: Rec = async (tool, args) => {
      let result: unknown;
      try {
        result = await client.callTool({ name: tool, arguments: args });
      } catch (e) {
        result = { protocolError: (e as Error).message };
      }
      calls.push({ tool, args, via: "client", result: surfaceOf(result) });
    };
    const close = async (id: string) => {
      if (config.era !== "2026-07-28") return rec("close_ticket", { id });
      const first = await rawCall(url, "close_ticket", { id });
      calls.push({ tool: "close_ticket", args: { id }, via: "raw", result: surfaceOf(first) });
      if (first?.resultType !== "input_required") return;
      const second = await rawCall(url, "close_ticket", { id }, {
        inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, ...(first.requestState ? { requestState: first.requestState } : {}),
      });
      calls.push({ tool: "close_ticket", args: { id, confirmed: true }, via: "raw", result: surfaceOf(second) });
    };
    await SCRIPTS[config.script]({ rec, close });
    return {
      name: config.name,
      args: config.args,
      env: config.env ?? {},
      era: config.era,
      start: { stateLine },
      initialize: { serverName: client.getServerVersion()?.name, capabilities: client.getServerCapabilities(), instructions: client.getInstructions() },
      tools: (await client.listTools()).tools,
      calls,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
