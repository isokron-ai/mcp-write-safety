// The tracker's REST API over node:http. Loopback only, bearer token on every
// request. See the README for the route table.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { ApiError, canonicalJson, Store, type TicketFields } from "./store.js";
import { applyBackendDefects } from "./defects/index.js";

export interface BackendOptions {
  /** Bearer token the MCP layer must send. */
  token: string;
  port?: number;
  /** Names of backend defects to switch on (see src/backend/defects). */
  defects?: string[];
}

export interface RunningBackend {
  url: string;
  store: Store;
  close(): Promise<void>;
}

/** The operations the routes call. A backend defect may replace one of them. */
export interface BackendOps {
  patchTicket(store: Store, id: string, fields: TicketFields, ifMatch?: number | "*"):
    ReturnType<Store["patchTicket"]> | Promise<ReturnType<Store["patchTicket"]>>;
}

const correctOps: BackendOps = {
  patchTicket: (store, id, fields, ifMatch) => store.patchTicket(id, fields, ifMatch),
};

interface Stored {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function parseIfMatch(header: string | undefined): number | "*" | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (value === "*") return "*";
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "bad_if_match", `If-Match must be a quoted version, got ${header}`);
  return n;
}

const etag = (version: number) => `"${version}"`;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new ApiError(413, "too_large", "request body over 1 MB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad_json", "request body is not valid JSON");
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
  const store = new Store();
  const ops: BackendOps = { ...correctOps };
  applyBackendDefects(options.defects ?? [], ops);
  const idempotency = new Map<string, Stored>();

  type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

  async function route(method: string, url: URL, req: IncomingMessage, body: unknown): Promise<Reply> {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const ifMatch = parseIfMatch(req.headers["if-match"] as string | undefined);
    const b = (body ?? {}) as Record<string, unknown>;
    const ticketReply = (status: number, value: { ticket: { version: number } } & Record<string, unknown>) =>
      ({ status, body: value, headers: { etag: etag(value.ticket.version) } });

    // /projects
    if (parts[0] === "projects") {
      if (parts.length === 1 && method === "GET") return { status: 200, body: { projects: store.export().projects } };
      if (parts.length === 1 && method === "POST") {
        return { status: 201, body: { project: store.createProject(b.key as string, b.name as string) } };
      }
      if (parts.length === 2 && method === "GET") return { status: 200, body: { project: store.getProject(parts[1]) } };
      if (parts.length === 2 && method === "PUT") {
        const r = store.upsertProject(parts[1], b.name as string);
        return { status: r.created ? 201 : 200, body: { project: r.project, created: r.created } };
      }
      if (parts.length === 2 && method === "DELETE") {
        store.deleteProject(parts[1]);
        return { status: 204 };
      }
    }

    // /tickets
    if (parts[0] === "tickets") {
      const id = parts[1];
      if (parts.length === 1 && method === "GET") {
        const q = url.searchParams;
        const tickets = store.listTickets({
          project: q.get("project") ?? undefined,
          status: q.get("status") ?? undefined,
          title_prefix: q.get("title_prefix") ?? undefined,
        });
        return { status: 200, body: { tickets } };
      }
      if (parts.length === 1 && method === "POST") {
        const ticket = store.createTicket(b as never);
        return ticketReply(201, { ticket });
      }
      if (parts.length === 2 && method === "GET") return ticketReply(200, { ticket: store.getTicket(id) });
      if (parts.length === 2 && method === "PATCH") {
        const r = await ops.patchTicket(store, id, b as TicketFields, ifMatch);
        return { ...ticketReply(200, { ticket: r.ticket, changed: r.changed }),
          headers: { etag: etag(r.ticket.version), ...(r.replayed ? { "idempotent-replayed": "true" } : {}) } };
      }
      if (parts.length === 2 && method === "PUT") {
        const r = store.putTicket(id, b as TicketFields, ifMatch, url.searchParams.get("force") === "true");
        return { ...ticketReply(200, { ticket: r.ticket, changed: r.changed }),
          headers: { etag: etag(r.ticket.version), ...(r.replayed ? { "idempotent-replayed": "true" } : {}) } };
      }
      if (parts.length === 2 && method === "DELETE") {
        store.deleteTicket(id, ifMatch);
        return { status: 204 };
      }
      if (parts.length === 3 && parts[2] === "comments" && method === "POST") {
        const r = store.addComment(id, b.body as string);
        return ticketReply(201, r);
      }
      if (parts.length === 3 && parts[2] === "labels" && method === "POST") {
        const r = store.addLabel(id, b.name as string);
        return ticketReply(r.created ? 201 : 200, r);
      }
      if (parts.length === 4 && parts[2] === "labels" && method === "DELETE") {
        return ticketReply(200, { ticket: store.removeLabel(id, parts[3]) });
      }
    }

    if (parts[0] === "batch" && parts.length === 1 && method === "POST") {
      return { status: 200, body: store.batch(b.ops as never) };
    }
    if (parts[0] === "export" && parts.length === 1 && method === "GET") {
      return { status: 200, body: store.export() };
    }
    throw new ApiError(404, "no_route", `no route for ${method} ${url.pathname}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, body === undefined ? headers : { "content-type": "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      if (!tokenMatches(req.headers.authorization, options.token)) {
        throw new ApiError(401, "unauthorized", "missing or wrong bearer token");
      }
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://backend.invalid");
      const body = await readJson(req);
      const key = req.headers["idempotency-key"] as string | undefined;
      if (key !== undefined && method === "POST") {
        // A keyed POST is applied once. The same key with a different request is refused.
        // Store operations for POST are synchronous, so no second request can run between
        // this lookup and the set below.
        const fingerprint = `${method} ${url.pathname} ${canonicalJson(body ?? null)}`;
        const seen = idempotency.get(key);
        if (seen && seen.fingerprint !== fingerprint) {
          throw new ApiError(422, "idempotency_key_reused",
            "this Idempotency-Key was already used for a different request");
        }
        if (seen) return send(seen.status, seen.body, { ...seen.headers, "idempotent-replayed": "true" });
        const reply = await route(method, url, req, body);
        if (reply.status < 300) {
          idempotency.set(key, { fingerprint, status: reply.status, body: reply.body, headers: reply.headers ?? {} });
        }
        return send(reply.status, reply.body, reply.headers);
      }
      const reply = await route(method, url, req, body);
      send(reply.status, reply.body, reply.headers);
    } catch (error) {
      if (error instanceof ApiError) {
        send(error.status, { error: error.code, message: error.message, ...error.extra });
      } else {
        send(500, { error: "internal", message: "internal error" });
      }
    }
  }

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
