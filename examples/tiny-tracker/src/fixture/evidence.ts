// The read-only evidence namespace (design rule 2, review G3), served on the
// backend listener beside the API, behind its own evidence token.
//
//   GET /build                 the build descriptor
//   GET /export                every project and ticket, as stored; with the
//                              ledger feature also every ledger entry, and with
//                              execution records every execution record
//   GET /ledger                the execution ledger (feature ledger); filters
//                              key, run, principal, operation, kind; paging
//                              after (a ledger seq) and limit; format=jsonl
//   GET /executions            every execution record (execution-records)
//   GET /executions/:id        one execution record
//   GET /operations/:key       the operation record of a key (lookup)
//
// Every route that reads records takes ?principal=<id> (docs/INTERFACES.md
// §1.4): required when more than one principal is configured, the single one
// otherwise; the answer names the principal. The ledger answer holds that
// principal's entries and the fixture's own (principal null).
//
// Only GET. A request on one of these paths that does not carry the evidence
// token is not served here: it goes on to the API, where it needs the backend
// token like any other request (so GET /export with the backend token works as
// it did in 0.1.0). The evidence token opens nothing else: on any other path it
// is just a wrong backend token. A path whose feature this process does not run
// answers 501 with the feature's name.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendExtension } from "../backend/http.js";
import { HEADERS } from "../fixture-properties.js";
import type { BuildDescriptor } from "./descriptor.js";
import { bearerMatches } from "./tokens.js";
import type { EvidenceSource } from "../backend/seams.js";
import { MAX_LEDGER_PAGE, type Ledger, type LedgerFilter } from "./ledger.js";
import type { LedgerKind } from "../records.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The record paths and the feature that serves each. */
const RECORD_PATHS: Array<{ match: RegExp; feature: string; what: string }> = [
  { match: /^\/ledger$/, feature: "ledger", what: "the execution ledger" },
  { match: /^\/executions(\/[^/]+)?$/, feature: "execution-records", what: "execution records" },
  { match: /^\/operations\/[^/]+$/, feature: "lookup", what: "operation records by idempotency key" },
];

export function isEvidencePath(path: string): boolean {
  return path === "/build" || path === "/export" || RECORD_PATHS.some((p) => p.match.test(path));
}

/** What the evidence routes read: the ledger (when on) and stream A's records (once the backend is attached). */
export interface EvidenceSources {
  ledger?: Ledger;
  /** The configured principal ids (default: p-default only). */
  principals?: readonly string[];
  records(): EvidenceSource | undefined;
}

const LEDGER_KINDS: readonly LedgerKind[] = ["start", "execution", "replay", "refusal", "fault-armed", "fault-fired", "run-allocated", "run-reset"];
const PRINCIPAL = /^p-[a-z0-9-]{1,62}$/;

class BadQuery extends Error {
  constructor(message: string, readonly code = "bad_query") {
    super(message);
  }
}

/**
 * The principal a read is for (docs/INTERFACES.md §1.4, frozen for every evidence route that reads records): given as
 * ?principal=<id>; required when more than one principal is configured (400 principal_required), and the single
 * configured principal otherwise. The evidence token may read any configured principal's records.
 */
function principalOf(q: URLSearchParams, configured: readonly string[]): string {
  const raw = q.get("principal");
  if (raw === null) {
    if (configured.length !== 1) throw new BadQuery(`${configured.length} principals are configured: name one with ?principal=<id>`, "principal_required");
    return configured[0];
  }
  if (!PRINCIPAL.test(raw)) throw new BadQuery("principal must match ^p-[a-z0-9-]{1,62}$");
  if (!configured.includes(raw)) throw new BadQuery(`principal ${raw} is not configured on this backend`, "unknown_principal");
  return raw;
}

function ledgerFilter(q: URLSearchParams): LedgerFilter & { format: "json" | "jsonl" } {
  const known = new Set(["key", "run", "principal", "operation", "kind", "after", "limit", "format"]);
  const unknown = [...q.keys()].filter((k) => !known.has(k));
  if (unknown.length) throw new BadQuery(`unknown query parameter(s): ${unknown.join(", ")}`);
  const int = (name: string, min: number, max: number) => {
    const raw = q.get(name);
    if (raw === null) return undefined;
    if (!/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new BadQuery(`${name} must be an integer from ${min} to ${max}`);
    return Number(raw);
  };
  const f: LedgerFilter & { format: "json" | "jsonl" } = { format: "json" };
  for (const name of ["key", "run", "operation"] as const) {
    const v = q.get(name);
    if (v !== null) f[name] = v;
  }
  const kind = q.get("kind");
  if (kind !== null) {
    if (!(LEDGER_KINDS as readonly string[]).includes(kind)) throw new BadQuery(`kind must be one of ${LEDGER_KINDS.join(", ")}`);
    f.kind = kind as LedgerKind;
  }
  f.after = int("after", 0, 1_000_000_000);
  f.limit = int("limit", 1, MAX_LEDGER_PAGE) ?? MAX_LEDGER_PAGE;
  const format = q.get("format");
  if (format !== null) {
    if (format !== "json" && format !== "jsonl") throw new BadQuery("format must be json or jsonl");
    f.format = format;
  }
  return f;
}

export function evidenceExtension(token: string, descriptor: BuildDescriptor, sources: EvidenceSources = { records: () => undefined }): BackendExtension {
  const configured = sources.principals ?? ["p-default"];
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, store): Promise<boolean> {
      if (!isEvidencePath(url.pathname)) return false;
      if (!bearerMatches(req.headers.authorization, token)) return false;
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
        res.end(JSON.stringify(body));
      };
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK_HOSTS.has(host)) {
        send(403, { error: "forbidden", message: "loopback Host only" });
        return true;
      }
      if (req.method !== "GET") {
        send(405, { error: "read_only", message: "the evidence namespace is read-only; only GET is served" }, { allow: "GET" });
        return true;
      }
      if (url.pathname === "/build") {
        const d = descriptor.toJSON();
        send(200, d, { [HEADERS.build.toLowerCase()]: d.build_hash });
        return true;
      }
      const records = sources.records();
      const bad = (e: unknown) => {
        if (!(e instanceof BadQuery)) throw e;
        send(400, { error: e.code, message: e.message });
        return true;
      };
      if (url.pathname === "/export") {
        try {
          // The objects are the whole store (the seed has no owner); the records are the principal's, and the ledger
          // also keeps the fixture's own entries (principal null) so its sequence has no unexplained gaps.
          const unknown = [...url.searchParams.keys()].filter((k) => k !== "principal");
          if (unknown.length) throw new BadQuery(`unknown query parameter(s): ${unknown.join(", ")}`);
          const principal = principalOf(url.searchParams, configured);
          send(200, {
            principal,
            ...store.export(),
            ...(records ? { executions: [...records.executions()].filter((x) => x.principal === principal) } : {}),
            ...(sources.ledger ? { ledger: sources.ledger.list({ principal, includeUnscoped: true }) } : {}),
          });
        } catch (e) {
          return bad(e);
        }
        return true;
      }
      const path = RECORD_PATHS.find((p) => p.match.test(url.pathname))!;
      const served = path.feature === "ledger" ? sources.ledger !== undefined : records !== undefined;
      if (!served) {
        send(501, { error: "not_enabled", feature: path.feature, available_from: "0.2.0",
          message: `${path.what} are served only with the ${path.feature} feature, which this process does not run` });
        return true;
      }
      try {
        const principal = principalOf(url.searchParams, configured);
        if (path.feature === "ledger") {
          const filter = { ...ledgerFilter(url.searchParams), principal, includeUnscoped: true };
          const entries = sources.ledger!.list(filter);
          const next = entries.length === filter.limit ? entries[entries.length - 1].seq : null;
          if (filter.format === "jsonl") {
            // One entry per line, for recounts; a page that is full continues with ?after=<the last line's seq>.
            res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
            res.end(entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
          } else {
            send(200, { principal, entries, next_after: next });
          }
          return true;
        }
        const exec = /^\/executions\/([^/]+)$/.exec(url.pathname);
        if (url.pathname === "/executions") {
          send(200, { principal, executions: [...records!.executions()].filter((x) => x.principal === principal) });
        } else if (exec) {
          const id = decodeURIComponent(exec[1]);
          const record = records!.execution(id);
          if (record && record.principal === principal) send(200, record);
          else send(404, { error: "not_found", principal, message: `no execution record ${id} for ${principal}` });
        } else {
          const key = decodeURIComponent(url.pathname.slice("/operations/".length));
          const record = records!.operation({ principal }, key);
          if (record) send(200, record);
          else send(404, { error: "not_found", principal, message: "no record of this key now" });
        }
      } catch (e) {
        return bad(e);
      }
      return true;
    },
  };
}
