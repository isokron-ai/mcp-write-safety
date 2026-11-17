// Helpers for the 0.3.0 durability tests (stream D): a movable clock, a backend
// on a data dir that can be "killed" in-process and started again, and a
// crash hook that fires once at a named point.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, type RunningBackend } from "../../src/start.js";
import { SimulatedCrash, type CrashHook, type JournalPoint } from "../../src/backend/journal.js";
import type { Clock } from "../../src/clock.js";
import type { CommitSink } from "../../src/backend/commit.js";
import type { BackendFaultHooks } from "../../src/backend/http.js";
import type { ExpiryPolicy } from "../../src/backend/expiry.js";
import { Rest } from "./stack.js";

export const TOKEN = "backend-token-durable-000000000";

/** A record clock the test moves by hand (domain fixture); wall time stays the process clock. */
export function movableClock(start = Date.UTC(2030, 0, 1)): Clock & { advance(ms: number): void; offset: number } {
  const c = {
    domain: "fixture" as const,
    offset: 0,
    now: () => new Date(start + c.offset),
    wallNow: () => new Date(),
    offsetMs: () => 0,
    advance(ms: number) { c.offset += ms; },
  };
  return c;
}

export function tempDir(tag: string): { dir: string; dataDir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), `tt-d-${tag}-`));
  return { dir, dataDir: join(dir, "data"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Where a test wants the next crash: a journal point on the next line of a kind (optionally for one key). */
export interface Arm {
  point: JournalPoint;
  line: "commit" | "pending" | "aborted" | "fence";
  key?: string;
}

export interface DurableBackendOptions {
  dataDir: string;
  clock?: Clock;
  features?: string[];
  defects?: string[];
  retentionMs?: number;
  policy?: ExpiryPolicy;
  sinks?: CommitSink[];
  faults?: BackendFaultHooks;
  bootId?: string;
}

/** A durable backend with a crash switch. `crash()` kills it in-process: the journal is abandoned, the lock file stays. */
export async function durableBackend(o: DurableBackendOptions) {
  const crashes: string[] = [];
  const state: { arm?: Arm } = {};
  const hook: CrashHook = (point, at) => {
    const a = state.arm;
    if (!a) return;
    const wanted = a.point === "torn-write" ? "before-append" : a.point;
    if (point !== wanted || at.line !== a.line || (a.key !== undefined && at.key !== a.key)) return;
    state.arm = undefined;
    crashes.push(`${a.point}:${a.line}`);
    if (a.point === "torn-write") return "tear";
    throw new SimulatedCrash(point);
  };
  const features = o.features ?? ["durable", "inflight", "retention"];
  const backend: RunningBackend = await startBackend({
    token: TOKEN, port: 0, clock: o.clock, features, defects: o.defects, sinks: o.sinks, faults: o.faults, bootId: o.bootId ?? "d0d0d0d0d0d0d0d0",
    durability: { features, dataDir: o.dataDir, retentionMs: o.retentionMs, policy: o.policy, crash: hook, log: () => {} },
  });
  const api = new Rest(backend.url, TOKEN);
  return {
    backend, api, crashes,
    arm(a: Arm) { state.arm = a; },
    /** Kills it in-process: nothing more reaches the journal; the lock file stays as a killed process leaves it. */
    async crash() {
      backend.durability?.journal?.abandon();
      await backend.close();
    },
    close: () => backend.close(),
  };
}

/** The store's state as compared across a restart: projects and tickets, plus the key records. */
export async function snapshotOf(b: { backend: RunningBackend; api: Rest }) {
  const exp = await b.api.export();
  return { projects: exp.projects, tickets: exp.tickets, head: b.backend.store.lastSeq, keys: b.backend.durability?.keys.counts() };
}

/** A small deterministic PRNG (mulberry32): T2 prints the seed on failure. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
