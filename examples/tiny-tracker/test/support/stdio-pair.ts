// An in-process stdio connection: the server's StdioServerTransport reads one
// PassThrough and writes another, and a minimal client transport speaks the
// same newline-delimited JSON-RPC on the other ends. Used by the reduced
// self-test matrix over stdio (test/stdio.test.ts); the CLI tests spawn the
// real process instead.

import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import { startStdioServer, type StartedStdioServer } from "../../src/stdio.js";
import { Mcp, type Era } from "./stack.js";

type Message = Record<string, unknown>;

/** The client half: one JSON message per line, as the stdio binding says. */
class LineClientTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: Message) => void;
  private buffer = "";
  private closed = false;

  constructor(private readonly toServer: PassThrough, private readonly fromServer: PassThrough) {}

  async start(): Promise<void> {
    this.fromServer.setEncoding("utf8");
    this.fromServer.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        try {
          this.onmessage?.(JSON.parse(line));
        } catch (e) {
          this.onerror?.(e as Error);
        }
      }
    });
  }

  async send(message: Message): Promise<void> {
    if (this.closed) throw new Error("closed");
    this.toServer.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.toServer.end();
    this.onclose?.();
  }
}

export interface StdioPair {
  server: StartedStdioServer;
  mcp: Mcp;
  /** Every line the server wrote, for checking that stdout carries only protocol messages. */
  lines: string[];
  close(): Promise<void>;
}

export async function startStdioPair(options: { env: Record<string, string | undefined>; defects?: string[]; era?: Era }): Promise<StdioPair> {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const lines: string[] = [];
  const tap = new PassThrough();
  fromServer.on("data", (d: Buffer) => { lines.push(...d.toString("utf8").split("\n").filter(Boolean)); tap.write(d); });
  const server = startStdioServer({ env: options.env, defects: options.defects, stdin: toServer, stdout: fromServer });
  const era = options.era ?? "2026-07-28";
  const client = new Client({ name: "tiny-tracker-selftest-stdio", version: "0.1.0" },
    era === "2026-07-28" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  await client.connect(new LineClientTransport(toServer, tap) as never);
  const mcp = new Mcp(client);
  return {
    server, mcp, lines,
    async close() {
      await mcp.close().catch(() => {});
      await server.close();
    },
  };
}
