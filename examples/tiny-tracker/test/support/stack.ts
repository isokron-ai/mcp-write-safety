// Starts one tiny-tracker stack in this process: backend, gate, MCP server.
// The MCP server reaches the backend only through the gate.

import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startBackend, startServer, type RunningBackend, type StartedServer } from "../../src/start.js";
import { startGate, type Gate } from "./gate.js";

export type Era = "2026-07-28" | "2025-11-25";

/** A tool call's outcome as a tester sees it. */
export interface Outcome {
  isError: boolean;
  /** Set when the call failed at the protocol level (no tool result at all). */
  protocolError?: string;
  text: string;
  structured: any;
  /** The text blocks that carry the serialized structuredContent (the write-result mirror), parsed. */
  mirror?: any[];
  raw: unknown;
}

/** Direct REST access to the backend: the control arm and the oracle. */
export class Rest {
  constructor(readonly url: string, readonly token: string) {}

  async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(new URL(path, this.url), {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  async ticket(id: string) {
    const r = await this.send("GET", `/tickets/${id}`);
    return r.status === 200 ? r.body.ticket : undefined;
  }

  async project(key: string) {
    const r = await this.send("GET", `/projects/${key}`);
    return r.status === 200 ? r.body.project : undefined;
  }

  async tickets(query: Record<string, string>) {
    return (await this.send("GET", `/tickets?${new URLSearchParams(query)}`)).body.tickets as any[];
  }

  async export() {
    return (await this.send("GET", "/export")).body as { projects: any[]; tickets: any[] };
  }

  async createProject(key: string) {
    const r = await this.send("POST", "/projects", { key, name: key });
    if (r.status !== 201) throw new Error(`setup: create project ${key}: ${r.status}`);
    return r.body.project;
  }

  async createTicket(fields: Record<string, unknown>) {
    const r = await this.send("POST", "/tickets", fields);
    if (r.status !== 201) throw new Error(`setup: create ticket: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.ticket;
  }

  async patch(id: string, fields: Record<string, unknown>) {
    const r = await this.send("PATCH", `/tickets/${id}`, fields);
    if (r.status !== 200) throw new Error(`setup: patch ${id}: ${r.status}`);
    return r.body.ticket;
  }
}

/** A text block that is the serialized structuredContent carrying the write-result shape. */
function isMirror(t: string | undefined): boolean {
  if (!t || !t.trimStart().startsWith("{")) return false;
  try {
    const o = JSON.parse(t);
    return typeof o === "object" && o !== null && "mws" in o;
  } catch {
    return false;
  }
}

export class Mcp {
  constructor(readonly client: Client) {}

  async call(name: string, args: Record<string, unknown>): Promise<Outcome> {
    try {
      const raw = await this.client.callTool({ name, arguments: args });
      const r = raw as { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
      return {
        isError: r.isError === true,
        // The prose: the text blocks other than the serialized structuredContent (the write-result mirror).
        text: (r.content ?? []).filter((c) => c.type === "text" && !isMirror(c.text)).map((c) => c.text).join("\n"),
        mirror: (r.content ?? []).filter((c) => c.type === "text" && isMirror(c.text)).map((c) => JSON.parse(c.text!)),
        structured: r.structuredContent ?? {},
        raw,
      };
    } catch (e) {
      const message = (e as Error).message;
      return { isError: true, protocolError: message, text: message, structured: {}, raw: e };
    }
  }

  async tools() {
    return (await this.client.listTools()).tools;
  }

  close() {
    return this.client.close();
  }
}

export interface Stack {
  token: string;
  backend: RunningBackend;
  gate: Gate;
  server: StartedServer;
  rest: Rest;
  era: Era;
  /** A fresh run prefix for one check, e.g. mwsc-3f9a01-tgt1. */
  prefix(tag: string): string;
  connect(): Promise<Mcp>;
  /** Stops the MCP server and starts it again with the same settings and build (the backend and the gate stay); returns a new client. */
  restart(): Promise<Mcp>;
  close(): Promise<void>;
}

export interface StackOptions {
  defects?: string[];
  backendDefects?: string[];
  env?: Record<string, string>;
  era?: Era;
}

export async function connectClient(url: string, era: Era): Promise<Mcp> {
  const client = new Client({ name: "tiny-tracker-selftest", version: "0.1.0" },
    era === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return new Mcp(client);
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  // An obviously fake canary as the backend credential: MWS-SEC-1 looks for it in every result.
  const token = `mwscanary-${randomBytes(12).toString("hex")}`;
  const run = randomBytes(3).toString("hex");
  const era = options.era ?? "2026-07-28";
  const backend = await startBackend({ token, defects: options.backendDefects });
  const gate = await startGate(backend.url);
  let server: StartedServer;
  try {
    server = await startServer({
      env: { TRACKER_BACKEND_URL: gate.url, TRACKER_BACKEND_TOKEN: token, ...options.env },
      defects: options.defects,
    });
  } catch (e) {
    await gate.close();
    await backend.close();
    throw e;
  }
  const clients: Mcp[] = [];
  const stack: Stack = {
    token, backend, gate, server, era,
    rest: new Rest(backend.url, token),
    prefix: (tag) => `mwsc-${run}-${tag}`,
    async connect() {
      const c = await connectClient(stack.server.url, era);
      clients.push(c);
      return c;
    },
    async restart() {
      for (const c of clients.splice(0)) await c.close().catch(() => {});
      await stack.server.close();
      stack.server = await startServer({
        env: { TRACKER_BACKEND_URL: gate.url, TRACKER_BACKEND_TOKEN: token, ...options.env },
        defects: options.defects,
      });
      return stack.connect();
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await stack.server.close();
      await gate.close();
      await backend.close();
    },
  };
  return stack;
}
