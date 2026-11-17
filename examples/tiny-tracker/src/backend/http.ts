// The tracker's REST API over node:http. Loopback only, bearer token on every
// request. See the README for the route table.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, canonicalJson, Store, type TicketFields } from "./store.js";
import { CommitSinkError, JournalError, type CommitSink, type TxMeta } from "./commit.js";
import { memoryKeyRecords, type KeyRecordSeam } from "./seams.js";
import type { Clock } from "../clock.js";
import { defaultPrincipals, principalFor, type Principal } from "../principals.js";
import { HEADERS, TAG_PATTERN } from "../fixture-properties.js";
import { applyBackendDefects } from "./defects/index.js";
import { correctInputRules, type InputRules } from "./input.js";

export interface BackendOptions {
  /** Bearer token the MCP layer must send. */
  token: string;
  port?: number;
  /** Names of backend defects to switch on (see src/backend/defects). */
  defects?: string[];
  /** Active features (see src/profile.ts). The backend acts on `strict-input`; the others are the fixture layer's. */
  features?: readonly string[];
  /**
   * Routes served beside the API, with their own authorization (the fixture layer's read-only evidence namespace).
   * Asked first for every request; when it answers false the request goes to the API as usual.
   */
  extension?: BackendExtension;
  /** The clock every stored time comes from (default: the wall clock). */
  clock?: Clock;
  /** Commit sinks (the ledger, the journal): told of every commit, replay and refusal, inside the commit section. */
  sinks?: CommitSink[];
  /** Principals and their tokens (default: one, p-default, with `token`). */
  principals?: Principal[];
}

export interface BackendExtension {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, store: Store): Promise<boolean>;
}

export interface RunningBackend {
  url: string;
  store: Store;
  close(): Promise<void>;
}

/**
 * The operations the routes call: the backend's seams (src/backend/defects/index.ts, BACKEND_SEAMS). A backend
 * defect may replace one of them.
 */
export interface BackendOps {
  /**
   * The write, inside the synchronous commit section. `prepared` is what beforePatch returned, if it ran.
   */
  patchTicket(store: Store, id: string, fields: TicketFields, ifMatch?: number | "*", prepared?: unknown): ReturnType<Store["patchTicket"]>;
  /**
   * An optional step before the commit section, the only place a PATCH may await. The correct build has none; a
   * backend defect that "waits mid-write" does its read and its wait here (rule 9: the commit itself stays synchronous).
   */
  beforePatch?(store: Store, id: string, fields: TicketFields, ifMatch?: number | "*"): Promise<unknown>;
  /** Seam inputRules: used only with the strict-input feature. */
  inputRules: InputRules;
  /** Seam keyRecord: the records that answer keyed repeats, scoped by principal. */
  keyRecord: KeyRecordSeam;
}

function correctOps(): BackendOps {
  return {
    patchTicket: (store, id, fields, ifMatch) => store.patchTicket(id, fields, ifMatch),
    inputRules: correctInputRules,
    keyRecord: memoryKeyRecords(),
  };
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

/** A run or operation tag from its header; anything not in the tag format is ignored. */
function tag(value: string | string[] | undefined): string | null {
  return typeof value === "string" && TAG_PATTERN.test(value) ? value : null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
  const store = new Store(undefined, options.clock);
  for (const sink of options.sinks ?? []) store.addSink(sink);
  const principals = options.principals ?? defaultPrincipals(options.token);
  const ops: BackendOps = correctOps();
  const features = options.features ?? [];
  applyBackendDefects(options.defects ?? [], ops, features);
  const strictInput = features.includes("strict-input");
  type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

  /** Synchronous for every correct route (rule 9); a promise only where a backend defect awaits inside its write. */
  function route(method: string, url: URL, req: IncomingMessage, body: unknown, prepared?: unknown): Reply {
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
        const r = ops.patchTicket(store, id, b as TicketFields, ifMatch, prepared);
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
      if (options.extension && await options.extension.handle(req, res, new URL(req.url ?? "/", "http://backend.invalid"), store)) return;
      const principal = principalFor(req.headers.authorization, principals);
      if (principal === undefined) {
        throw new ApiError(401, "unauthorized", "missing or wrong bearer token");
      }
      store.checkRunning();
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://backend.invalid");
      const body = await readJson(req);
      const key = req.headers["idempotency-key"] as string | undefined;
      if (strictInput) {
        // Strict input (rule 10, rule 5): the key's format is checked here, not only by the MCP tool schema, because
        // other harnesses call this API directly; strings that are not well-formed are refused before anything is
        // stored, so every stored string can be encoded as UTF-8 and hashed the same way in any language.
        ops.inputRules.checkKey(key);
        ops.inputRules.checkStrings(body);
      }
      if (!MUTATING.has(method)) {
        const reply = await route(method, url, req, body);
        return send(reply.status, reply.body, reply.headers);
      }
      const keyed = key !== undefined && method === "POST";
      const fingerprint = keyed ? `${method} ${url.pathname} ${canonicalJson(body ?? null)}` : null;
      const meta: TxMeta = {
        principal,
        attribution: { run: tag(req.headers[HEADERS.run.toLowerCase()]), operation: tag(req.headers[HEADERS.operation.toLowerCase()]) },
        request: { method, path: url.pathname, key: key ?? null, fingerprint },
      };
      if (keyed) {
        // A keyed POST is applied once. The same key with a different request is refused. From this lookup to the
        // commit below nothing awaits, so no second request runs between them (rule 9).
        const scope = { principal };
        const seen = ops.keyRecord.get(scope, key);
        if (seen && seen.fingerprint !== fingerprint) {
          store.refuse(meta, 422, "idempotency_key_reused");
          throw new ApiError(422, "idempotency_key_reused",
            "this Idempotency-Key was already used for a different request");
        }
        if (seen) {
          store.replay(meta, seen.status, seen.body, seen.seq);
          return send(seen.status, seen.body, { ...seen.headers, "idempotent-replayed": "true" });
        }
        // Only a result below 300 is kept, and only once the journal has it: a refused first call stores nothing and
        // does not hold the key (decision 0004).
        const { reply } = store.commit(meta, () => route(method, url, req, body), (tx, r) => {
          ops.keyRecord.put(scope, key, { fingerprint: fingerprint!, status: tx.status, body: tx.body, headers: r.headers ?? {},
            run: meta.attribution.run, seq: tx.seq, committedAt: store.clock.now().toISOString(), clockOffsetMs: store.clock.offsetMs() });
        });
        return send(reply.status, reply.body, reply.headers);
      }
      // The one await a write may have comes before its commit section (BackendOps.beforePatch).
      const parts = url.pathname.split("/").filter(Boolean);
      let prepared: unknown;
      if (method === "PATCH" && parts[0] === "tickets" && parts.length === 2 && ops.beforePatch) {
        try {
          prepared = await ops.beforePatch(store, decodeURIComponent(parts[1]), (body ?? {}) as TicketFields, parseIfMatch(req.headers["if-match"] as string | undefined));
        } catch (e) {
          if (e instanceof ApiError) store.refuse(meta, e.status, e.code);
          throw e;
        }
      }
      const { reply } = store.commit(meta, () => route(method, url, req, body, prepared));
      send(reply.status, reply.body, reply.headers);
    } catch (error) {
      if (error instanceof JournalError) {
        send(503, { error: "journal_unavailable", message: error.message });
      } else if (error instanceof CommitSinkError) {
        send(503, { error: "stopped", message: error.message });
      } else if (error instanceof ApiError) {
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
