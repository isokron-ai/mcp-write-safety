// The control listener (design rule 2, review X4): /_fixture/* on its own
// loopback port, only with --fixture-control, behind its own control token.
//
// Hardening: loopback Host only; any request carrying an Origin header is
// refused (no browser page can drive it); POST needs content-type
// application/json and a body under 64 KiB; the token is compared in constant
// time; at most 32 connections, and a request must arrive whole within 10 s.
// Every control action that changes something is a ledger entry (with the
// ledger feature): fault arming, run allocation and run reset.
//
//   GET  /_fixture/clock              the fixture clock (offset 0: wall time)
//   POST /_fixture/clock              move it                         (0.3.0)
//   GET  /_fixture/faults             the fault point table, what is armed, what is spent
//   POST /_fixture/faults             arm a fault                     (feature faults)
//   POST /_fixture/runs               allocate a run id
//   GET  /_fixture/runs               the runs allocated since start
//   POST /_fixture/runs/:id/reset     reset one run's data and keys   (feature ledger)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { FAULT_POINTS } from "../fault-points.js";
import { wallClock, type Clock } from "../clock.js";
import type { BuildDescriptor } from "./descriptor.js";
import { clockRoute } from "./clock.js";
import { bearerMatches } from "./tokens.js";
import { ApiError, type Store } from "../backend/store.js";
import { CommitSinkError, JournalError } from "../backend/commit.js";
import type { RunningBackend } from "../backend/http.js";
import type { EvidenceReader } from "../backend/lookup.js";
import { FaultError, type FaultController } from "./faults.js";
import type { Ledger } from "./ledger.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 64 * 1024;
/** X4/X5: connections the control listener holds at once, and how long a request may take to arrive. */
export const CONTROL_MAX_CONNECTIONS = 32;
export const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/** The run reset: RunningBackend.dropRun (Store.dropRun through the commit path, with the key-record seam in use). */
export type DropRun = RunningBackend["dropRun"];

/** The backend this process runs, once it has started (FixtureLayer.attachBackend). */
export interface AttachedBackend {
  store: Store;
  /** The run reset; absent only in tests that check the 501. */
  dropRun?: DropRun;
  /** Execution and operation records (stream A's EvidenceReader, RunningBackend.evidence), when this build keeps them. */
  evidence?: EvidenceReader;
}

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

/**
 * Run ids are `run-<boot8>-<12 random hex>` (seams v2.1): the boot id is public, so a counter suffix would let anyone
 * guess another caller's next run. The backend refuses a run tag the registry never allocated (403 run_not_allocated).
 */
export class RunRegistry {
  private readonly runs: Run[] = [];
  /**
   * Called with each new run before it is registered or answered: the 0.3.0 journal appends its `run-alloc` line here
   * (JournalSeam.recordRun). A throw refuses the allocation and registers nothing.
   */
  onAllocate: ((run: Run) => void) | undefined = undefined;
  constructor(private readonly bootId: string, private readonly clock: Clock = wallClock) {}

  allocate(label: string | null, principal = "p-default"): Run {
    if (this.runs.length >= MAX_RUNS) throw new ControlError(429, "too_many_runs", `at most ${MAX_RUNS} runs per process`);
    let run_id: string;
    do run_id = `run-${this.bootId.slice(0, 8)}-${randomBytes(6).toString("hex")}`; while (this.has(run_id));
    const run: Run = { run_id, principal, created_at: this.clock.now().toISOString(), label };
    try {
      this.onAllocate?.({ ...run });
    } catch (e) {
      // lease_lost (G3 note 26 item 1c): the run-alloc line was written, then the lease was found taken over.
      // append_failed: the write had begun when it failed, so the line may be in the file and the next start decides it.
      const code = (e as { code?: unknown } | null)?.code;
      const lost = code === "lease_lost";
      throw new ControlError(503, lost ? "lease_lost" : "journal_unavailable", `the run could not be recorded: ${(e as Error)?.message ?? String(e)}${lost || code === "append_failed" ? "; whether a restart keeps it is unknown" : ""}`);
    }
    this.runs.push(run);
    return { ...run };
  }

  /** Puts back a run read from the journal's `run-alloc` line at load (0.3.0); no callback, no new id. */
  restore(run: Run): void {
    if (!this.has(run.run_id)) this.runs.push({ ...run });
  }

  list(): Run[] {
    return this.runs.map((r) => ({ ...r }));
  }

  has(id: string): boolean {
    return this.runs.some((r) => r.run_id === id);
  }

  /** The principal a run was allocated for, or undefined when this process did not allocate it. */
  owner(id: string): string | undefined {
    return this.runs.find((r) => r.run_id === id)?.principal;
  }

  get(id: string): Run | undefined {
    const r = this.runs.find((x) => x.run_id === id);
    return r && { ...r };
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

export interface ControlOptions {
  token: string;
  port: number;
  descriptor: BuildDescriptor;
  runs: RunRegistry;
  /** The ledger (feature ledger): records arming, run allocation and reset; a reset needs it. */
  ledger?: Ledger;
  /** The fault controller (feature faults). */
  faults?: FaultController;
  /** The backend, once started. */
  backend?: () => AttachedBackend | undefined;
  /** The configured principal ids: a run is allocated only for one of them (default: p-default only). */
  principals?: readonly string[];
}

const notEnabled = (feature: string, what: string) =>
  new ControlError(501, "not_enabled", `${what} needs the ${feature} feature, which this process does not run`, { feature, available_from: "0.2.0" });

/** Runs a ledger append; a ledger that cannot append stops the store, so the control action answers 503. */
function recorded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new ControlError(503, "ledger_stopped", `the ledger could not record this action: ${(e as Error).message}`);
  }
}

export async function startControl(options: ControlOptions): Promise<RunningControl> {
  const { token, descriptor, runs, ledger, faults } = options;
  const principals = options.principals ?? ["p-default"];

  async function route(req: IncomingMessage, path: string): Promise<{ status: number; body: unknown }> {
    const method = req.method ?? "GET";
    if (path === "/_fixture/clock") {
      // ---- stream E: the fixture clock answers here when the clock feature is on (src/fixture/clock.ts) ----
      const clockAnswer = await clockRoute(descriptor.clock, method, () => readBody(req));
      if (clockAnswer) return clockAnswer;
      // ---- end stream E ----
      if (method === "GET") return { status: 200, body: { domain: descriptor.clockOffsetMs === 0 ? "wall" : "fixture", offset_ms: descriptor.clockOffsetMs } };
      // The clock is built since 0.3.0 but off in this process: not_enabled, as openapi.yaml says (note 27 item 5).
      if (method === "POST") throw new ControlError(501, "not_enabled", "moving the fixture clock needs the clock feature, which this process does not run", { feature: "clock", available_from: "0.3.0" });
    }
    if (path === "/_fixture/faults") {
      if (method === "GET") return { status: 200, body: faults ? { ...faults.list(), points: FAULT_POINTS } : { armed: [], points: FAULT_POINTS } };
      if (method === "POST") {
        if (!faults) throw notEnabled("faults", "arming a fault");
        const body = await readBody(req);
        try {
          return { status: 201, body: { fault: recordedArm(faults, body) } };
        } catch (e) {
          if (e instanceof FaultError) throw new ControlError(e.status, e.code, e.message, e.extra);
          throw e;
        }
      }
    }
    if (path === "/_fixture/runs") {
      if (method === "GET") return { status: 200, body: { runs: runs.list() } };
      if (method === "POST") {
        const body = (await readBody(req)) as { label?: unknown; principal?: unknown };
        const label = body && typeof body === "object" && typeof body.label === "string" ? body.label.slice(0, 200) : null;
        const principal = body && typeof body === "object" && body.principal !== undefined ? body.principal : "p-default";
        if (typeof principal !== "string" || !/^p-[a-z0-9-]{1,62}$/.test(principal)) throw new ControlError(400, "bad_principal", "principal must match ^p-[a-z0-9-]{1,62}$");
        if (!principals.includes(principal)) throw new ControlError(400, "unknown_principal", `principal ${principal} is not configured on this backend`);
        const run = runs.allocate(label, principal);
        if (ledger) recorded(() => ledger.runAllocated(run.principal, run.run_id));
        return { status: 201, body: run };
      }
    }
    const reset = /^\/_fixture\/runs\/([^/]+)\/reset$/.exec(path);
    if (reset && method === "POST") {
      const run = runs.get(decodeURIComponent(reset[1]));
      if (!run) throw new ControlError(404, "no_such_run", `no run ${reset[1]} was allocated by this process`);
      // The ledger records every reset (from the reset's commit event), so a reset needs it: evidence never loses
      // data without saying so.
      if (!ledger) throw notEnabled("ledger", "a run-scoped reset");
      const backend = options.backend?.();
      if (!backend?.dropRun) throw notBuilt("0.2.0", "a run-scoped reset (this backend cannot drop one run's records)");
      try {
        backend.store.checkRunning();
      } catch (e) {
        throw new ControlError(503, "stopped", (e as Error).message);
      }
      // Store.dropRun is one commit (kind run-reset) through the frozen commit path: journalled, then told to the
      // ledger with tx.reset. The ledger writes the run-reset entry from that event, never by hand here.
      let dropped: { objects: number; keys: number };
      try {
        dropped = backend.dropRun({ principal: run.principal }, run.run_id);
      } catch (e) {
        if (e instanceof ApiError) throw new ControlError(e.status, e.code, e.message);
        if (e instanceof CommitSinkError || e instanceof JournalError) throw new ControlError(503, e instanceof JournalError ? e.code : "stopped", e.message);
        throw e;
      }
      const entry = ledger.list({ kind: "run-reset", run: run.run_id, principal: run.principal }).at(-1);
      return { status: 200, body: { run_id: run.run_id, principal: run.principal, dropped: { objects: dropped.objects, keys: dropped.keys }, ledger_seq: entry?.seq ?? null } };
    }
    throw new ControlError(404, "no_route", `no control route for ${method} ${path}`);
  }

  function recordedArm(f: FaultController, body: unknown) {
    try {
      return f.arm(body);
    } catch (e) {
      if (e instanceof FaultError) throw e;
      throw new ControlError(503, "ledger_stopped", `the ledger could not record this action: ${(e as Error).message}`);
    }
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

  const server: Server = createServer({ requestTimeout: CONTROL_REQUEST_TIMEOUT_MS, headersTimeout: CONTROL_REQUEST_TIMEOUT_MS }, (req, res) => void handle(req, res));
  server.maxConnections = CONTROL_MAX_CONNECTIONS;
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
