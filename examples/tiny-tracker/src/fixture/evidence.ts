// The read-only evidence namespace (design rule 2, review G3), served on the
// backend listener beside the API, behind its own evidence token.
//
//   GET /build                 the build descriptor
//   GET /export                every project and ticket, as stored
//   GET /ledger                the execution ledger              (0.2.0)
//   GET /executions/:id        one execution record              (0.2.0)
//   GET /operations/:key       the operation record of a key     (0.2.0)
//
// Only GET. A request on one of these paths that does not carry the evidence
// token is not served here: it goes on to the API, where it needs the backend
// token like any other request (so GET /export with the backend token works as
// it did in 0.1.0). The evidence token opens nothing else: on any other path it
// is just a wrong backend token.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendExtension } from "../backend/http.js";
import { HEADERS } from "../fixture-properties.js";
import type { BuildDescriptor } from "./descriptor.js";
import { bearerMatches } from "./tokens.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The not-yet-built paths and the release that serves them. */
const PLANNED: Array<{ match: RegExp; since: string; what: string }> = [
  { match: /^\/ledger$/, since: "0.2.0", what: "the execution ledger" },
  { match: /^\/executions(\/[^/]+)?$/, since: "0.2.0", what: "execution records" },
  { match: /^\/operations\/[^/]+$/, since: "0.2.0", what: "operation records by idempotency key" },
];

export function isEvidencePath(path: string): boolean {
  return path === "/build" || path === "/export" || PLANNED.some((p) => p.match.test(path));
}

export function evidenceExtension(token: string, descriptor: BuildDescriptor): BackendExtension {
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
      if (url.pathname === "/export") {
        send(200, store.export());
        return true;
      }
      const planned = PLANNED.find((p) => p.match.test(url.pathname))!;
      send(501, { error: "not_built", available_from: planned.since, message: `${planned.what} arrive in ${planned.since}; this build does not record them` });
      return true;
    },
  };
}
