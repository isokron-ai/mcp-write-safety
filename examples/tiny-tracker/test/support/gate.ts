// A loopback gate between the MCP server and its backend: a tiny HTTP proxy
// that can hold one request until told to release it. This is the "backend
// gate" of the suite design, reduced to what the self-test needs: the MCP
// server's backend URL is pointed at the gate (base-URL rewrite), and the
// test forces one interleaving deterministically.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  method: string;
  path: string;
}

export interface Hold {
  /** Resolves when a matching request has arrived and is being held. */
  held: Promise<SeenRequest>;
  /** Lets the held request through to the backend. */
  release(): void;
}

export interface Gate {
  url: string;
  log: SeenRequest[];
  /** Holds the next request that matches, and only that one. */
  holdNext(match: (r: SeenRequest) => boolean): Hold;
  /** Lets the next matching request reach the backend, then breaks the connection before the answer: the write lands, the server hears nothing. */
  cutNext(match: (r: SeenRequest) => boolean): Promise<SeenRequest>;
  close(): Promise<void>;
}

export const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startGate(target: string): Promise<Gate> {
  const log: SeenRequest[] = [];
  let pending: { match: (r: SeenRequest) => boolean; arrived: (r: SeenRequest) => void; gate: Promise<void> } | undefined;
  let cut: { match: (r: SeenRequest) => boolean; done: (r: SeenRequest) => void } | undefined;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const seen = { method: req.method ?? "GET", path: req.url ?? "/" };
      log.push(seen);
      const body = await readBody(req);
      if (pending && pending.match(seen)) {
        const { arrived, gate } = pending;
        pending = undefined;
        arrived(seen);
        await gate;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && k !== "host" && k !== "connection" && k !== "content-length") headers[k] = String(v);
      }
      const upstream = await fetch(new URL(seen.path, target), {
        method: seen.method, headers, body: body.length ? new Uint8Array(body) : undefined,
      });
      if (cut && cut.match(seen)) {
        const { done } = cut;
        cut = undefined;
        await upstream.arrayBuffer();
        req.socket.destroy();
        done(seen);
        return;
      }
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, key) => { if (key !== "content-length" && key !== "transfer-encoding") out[key] = value; });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => { res.writeHead(502).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    log,
    cutNext(match) {
      return new Promise<SeenRequest>((done) => { cut = { match, done }; });
    },
    holdNext(match) {
      let release!: () => void;
      let arrived!: (r: SeenRequest) => void;
      const gate = new Promise<void>((r) => { release = r; });
      const held = new Promise<SeenRequest>((r) => { arrived = r; });
      pending = { match, arrived, gate };
      return { held, release };
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
