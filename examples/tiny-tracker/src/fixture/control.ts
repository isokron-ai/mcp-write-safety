// The control listener (design rule 2, review X4): /_fixture/* on its own
// loopback port, only with --fixture-control, behind its own control token.
//
// Hardening: loopback Host only; any request carrying an Origin header is
// refused (no browser page can drive it); POST needs content-type
// application/json and a body under 64 KiB; the token is compared in constant
// time. Every control action will also be a ledger event (0.2.0).
//
//   GET  /_fixture/clock              the fixture clock (offset 0: wall time)
//   POST /_fixture/clock              move it                         (0.3.0)
//   GET  /_fixture/faults             the fault point table and what is armed
//   POST /_fixture/faults             arm a fault                     (0.2.0)
//   POST /_fixture/runs               allocate a run id
//   GET  /_fixture/runs               the runs allocated since start
//   POST /_fixture/runs/:id/reset     reset one run's data and keys   (0.2.0)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FAULT_POINTS } from "../fault-points.js";
import { wallClock, type Clock } from "../clock.js";
import type { BuildDescriptor } from "./descriptor.js";
import { bearerMatches } from "./tokens.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 64 * 1024;

export interface Run {
  run_id: string;
  /** The principal the run belongs to: run tags are scoped per principal, and a reset touches only its records. */
  principal: string;
  created_at: string;
  label: string | null;
}

/** At most this many runs per process (X5): POST /_fixture/runs answers 429 beyond it. */
export const MAX_RUNS = 1000;

/**
 * Fixture-allocated run ids. A harness allocates one per run and sends it as the run tag in request _meta
 * (dev.writesafety.tiny-tracker/run) and as Tiny-Tracker-Run on direct backend calls. From 0.2.0 objects, key
 * records and execution records are tagged with their run (lookups stay scoped to the principal only), and a
 * reset removes one run's data and keys; the ledger keeps
 * every entry, and records the reset itself.
 */
class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export class RunRegistry {
  private readonly runs: Run[] = [];
  constructor(private readonly bootId: string, private readonly clock: Clock = wallClock) {}

  allocate(label: string | null, principal = "p-default"): Run {
    if (this.runs.length >= MAX_RUNS) throw new ControlError(429, "too_many_runs", `at most ${MAX_RUNS} runs per process`);
    const run: Run = { run_id: `run-${this.bootId.slice(0, 8)}-${this.runs.length + 1}`, principal, created_at: this.clock.now().toISOString(), label };
    this.runs.push(run);
    return run;
  }

  list(): Run[] {
    return this.runs.map((r) => ({ ...r }));
  }

  has(id: string): boolean {
    return this.runs.some((r) => r.run_id === id);
  }
}

export interface RunningControl {
  url: string;
  close(): Promise<void>;
}


async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ControlError(413, "too_large", "request body over 64 KiB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ControlError(400, "bad_json", "request body is not valid JSON");
  }
}

const notBuilt = (since: string, what: string) => new ControlError(501, "not_built", `${what} arrives in ${since}; this build cannot do it`, { available_from: since });

export async function startControl(options: { token: string; port: number; descriptor: BuildDescriptor; runs: RunRegistry }): Promise<RunningControl> {
  const { token, descriptor, runs } = options;

  async function route(req: IncomingMessage, path: string): Promise<{ status: number; body: unknown }> {
    const method = req.method ?? "GET";
    if (path === "/_fixture/clock") {
      if (method === "GET") return { status: 200, body: { domain: descriptor.clockOffsetMs === 0 ? "wall" : "fixture", offset_ms: descriptor.clockOffsetMs } };
      if (method === "POST") throw notBuilt("0.3.0", "moving the fixture clock");
    }
    if (path === "/_fixture/faults") {
      if (method === "GET") return { status: 200, body: { armed: [...descriptor.armedFaults], points: FAULT_POINTS } };
      if (method === "POST") throw notBuilt("0.2.0", "arming a fault");
    }
    if (path === "/_fixture/runs") {
      if (method === "GET") return { status: 200, body: { runs: runs.list() } };
      if (method === "POST") {
        const body = (await readBody(req)) as { label?: unknown; principal?: unknown };
        const label = body && typeof body === "object" && typeof body.label === "string" ? body.label.slice(0, 200) : null;
        const principal = body && typeof body === "object" && body.principal !== undefined ? body.principal : "p-default";
        if (typeof principal !== "string" || !/^p-[a-z0-9-]{1,62}$/.test(principal)) throw new ControlError(400, "bad_principal", "principal must match ^p-[a-z0-9-]{1,62}$");
        return { status: 201, body: runs.allocate(label, principal) };
      }
    }
    const reset = /^\/_fixture\/runs\/([^/]+)\/reset$/.exec(path);
    if (reset && method === "POST") {
      if (!runs.has(decodeURIComponent(reset[1]))) throw new ControlError(404, "no_such_run", `no run ${reset[1]} was allocated by this process`);
      throw notBuilt("0.2.0", "a run-scoped reset (objects and key records are tagged by run from 0.2.0)");
    }
    throw new ControlError(404, "no_route", `no control route for ${method} ${path}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK_HOSTS.has(host)) throw new ControlError(403, "forbidden", "loopback Host only");
      if (req.headers.origin !== undefined) throw new ControlError(403, "forbidden", "requests carrying an Origin header are refused");
      if (!bearerMatches(req.headers.authorization, token)) throw new ControlError(401, "unauthorized", "missing or wrong control token");
      if (req.method === "POST" && !/^application\/json(\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        throw new ControlError(415, "unsupported_media_type", "POST needs content-type: application/json");
      }
      const url = new URL(req.url ?? "/", "http://control.invalid");
      const out = await route(req, url.pathname);
      send(out.status, out.body);
    } catch (e) {
      if (e instanceof ControlError) send(e.status, { error: e.code, message: e.message, ...e.extra });
      else send(500, { error: "internal", message: "internal error" });
    }
  }

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
