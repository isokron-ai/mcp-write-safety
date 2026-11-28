// The fault controller (feature `faults`, R7 as corrected by review B7): faults
// named by point, armed at run time through the control listener
// (POST /_fixture/faults), never on the command line.
//
// Two places fire them, both frozen hooks, so no stream edits another's file:
//   - mcp/* points: ServerExtras.onResult (src/mcp/server.ts), called with every
//     tool result after the handler, inside the call's attribution context;
//   - backend/* points: BackendOptions.faults (src/backend/http.ts),
//     beforeCommit (before the commit section) and afterCommit (after it,
//     before the reply).
// What a point does is its action (FaultActions). 0.2.0 defines one:
// mcp/after-backend-reply/drop. The backend committed and answered; the MCP
// server holds its answer to the client: the lost response, server-side. The
// crash, close, delay and error points add their actions in 0.3.0 (stream E),
// and a point is armable only once it is in BUILT_FAULT_POINTS
// (src/fault-points.ts) and has an action here.
//
// Every arming and every firing is a ledger entry (G9, FX-FLT-1). A firing
// names the ledger entry it fired on: at backend/after-commit the execution
// itself (exact); at an mcp point the latest write attempt carrying the call's
// run and operation tags (a harness that tags each call gets an exact link; an
// untagged call fires with fired_on_seq null); at backend/before-commit none,
// since nothing is written yet.
//
// Selectors: tool (mcp points only), run, operation, nth, count (or once) and
// hold_ms. The first armed fault at a position whose selector matches decides
// for that call. There is no key selector: where the key travels depends on
// the code under test (review B5), so calls are picked by the tags the server
// wrapper reads instead.
//
// Caps (X5): at most 32 faults armed at once; at most 1000 firings per arming;
// a held answer is held at most hold_ms (default 60 s, at most 10 min), and at
// most 16 answers are held at once. When a hold ends, the true answer is sent:
// late, never altered. A matching call that would go over 16 is answered at
// once, the fault does not fire, and the skip is counted (GET /_fixture/faults).

import { attributionHeaders } from "../attribution.js";
import { canonicalize } from "../digest.js";
import { BUILT_FAULT_POINTS, faultPoint, FAULT_POINTS, type FaultPoint } from "../fault-points.js";
import type { BackendFaultHooks, FaultContext } from "../backend/http.js";
import type { CommittedTransaction } from "../backend/commit.js";
import { executionId } from "../records.js";
import { HEADERS, TAG_PATTERN } from "../fixture-properties.js";
import type { Clock } from "../clock.js";
import type { BuildDescriptor } from "./descriptor.js";
import type { Ledger } from "./ledger.js";
import type { LedgerEntry } from "../records.js";

export { BUILT_FAULT_POINTS };

export const FAULT_CAPS = {
  maxArmed: 32,
  maxCount: 1000,
  maxHeld: 16,
  defaultHoldMs: 60_000,
  maxHoldMs: 600_000,
} as const;

export class FaultError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Which calls a fault fires on. All given members must match; `count` firings, from the `nth` matching call on. */
export interface FaultSelector {
  /** Only calls of this tool. */
  tool?: string;
  /** Only calls tagged with this run (request _meta dev.writesafety.tiny-tracker/run). */
  run?: string;
  /** Only calls tagged with this operation tag. */
  operation?: string;
  /** Fire from the nth matching call on (1 = the first). Default 1. */
  nth: number;
  /** How many times it fires before it is spent. Default 1 (once). */
  count: number;
  /** How long an answer is held, in ms. */
  hold_ms: number;
}

export interface ArmedFault {
  id: string;
  point: string;
  selector: FaultSelector;
  armed_at: string;
  /** The ledger entry that records the arming. */
  ledger_seq: number;
  state: "armed" | "spent";
  /** Matching calls seen. */
  matched: number;
  fired: number;
  /** Matching calls answered at once because MAX_HELD answers were already held. */
  skipped_at_cap: number;
  /** Held answers sent when their hold ended. */
  released: number;
}

const SELECTOR_MEMBERS = new Set(["tool", "run", "operation", "nth", "count", "hold_ms", "once"]);

function intIn(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new FaultError(400, "bad_selector", `selector.${name} must be an integer from ${min} to ${max}`);
  return v;
}

function tagIn(v: unknown, name: string): string {
  if (typeof v !== "string" || !TAG_PATTERN.test(v)) throw new FaultError(400, "bad_selector", `selector.${name} must match ${TAG_PATTERN.source}`);
  return v;
}

/** What an armed point does when it fires. `hold` holds a value within the caps and gives it back when the hold ends. */
export interface FaultActionKit {
  hold<T>(value: T): Promise<T>;
}
export type FaultAction =
  | { position: "after-backend-reply"; fire(result: unknown, arm: ArmedFault, kit: FaultActionKit): Promise<unknown> }
  | { position: "before-commit"; fire(ctx: FaultContext, arm: ArmedFault, kit: FaultActionKit): Promise<void> }
  | { position: "after-commit"; fire(ctx: FaultContext & { tx: CommittedTransaction }, arm: ArmedFault, kit: FaultActionKit): Promise<undefined | "drop" | { status: number; body: unknown }> };

/**
 * A crash point (0.3.0, stream E, src/fixture/process.ts). The controller does not fire it: arming one writes it to the
 * descriptor's arming store (the supervisor's state folder, shared by both children), and the crash check in front of
 * these hooks takes it there and stops the process. The entry exists so the point can be armed on this listener.
 */
const CRASH_ACTION = { crash: true } as const;
export const isCrashPoint = (point: string): boolean => point.endsWith("/crash");

/** The actions this version defines, by point id. */
export const FAULT_ACTIONS: Record<string, FaultAction> = {
  "mcp/after-backend-reply/drop": { position: "after-backend-reply", fire: (result, _arm, kit) => kit.hold(result) },
  // ---- 0.3.0 integration: crash points fire in src/fixture/process.ts, never here ----
  "backend/before-commit/crash": { position: "before-commit", fire: async () => undefined, ...CRASH_ACTION },
  "backend/after-commit/crash": { position: "after-commit", fire: async () => undefined, ...CRASH_ACTION },
  "mcp/after-backend-reply/crash": { position: "after-backend-reply", fire: async (result) => result, ...CRASH_ACTION },
  // G2 fold-in 11: fires inside the commit section (DurabilityOptions.afterEffect), never through the controller's hooks.
  "backend/after-effect-before-key/crash": { position: "after-commit", fire: async () => undefined, ...CRASH_ACTION },
  // R-TT-10: the in-flight window. Fires after the pending key record and before the commit section; the write waits for
  // hold_ms (capped like every hold), then goes on as it would have. Nothing is altered: the commit is the true one, late.
  "backend/before-commit/delay": { position: "before-commit", fire: async (_ctx, _arm, kit) => { await kit.hold(undefined); } },
};

/** Validates an arming request. Unknown members are refused, never ignored. */
/** Points that need a feature on top of faults (CMP-66 at start; the same rule on the control listener). */
export const POINT_NEEDS_FEATURE: Record<string, string> = { "backend/after-effect-before-key/crash": "durable" };

/**
 * Validates an arming request. Unknown members are refused, never ignored. `features`, when given, are the build's: a
 * point that needs a feature the build lacks is refused 400 needs_feature (G2 round 2, item 6).
 */
export function parseArming(body: unknown, actions: Record<string, FaultAction> = FAULT_ACTIONS, features?: readonly string[]): { point: string; selector: FaultSelector } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FaultError(400, "bad_request", "the body must be an object: {\"point\": \"process/position/action\", \"selector\": {...}}");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "point" && k !== "selector");
  if (extra.length) throw new FaultError(400, "bad_request", `unknown member(s): ${extra.join(", ")}`);
  if (typeof b.point !== "string") throw new FaultError(400, "bad_request", "point is required");
  const p = faultPoint(b.point);
  if (!p) throw new FaultError(400, "unknown_point", `no fault point "${b.point}"; GET /_fixture/faults lists them`);
  if (!(BUILT_FAULT_POINTS as readonly string[]).includes(p.id) || !actions[p.id]) {
    if (p.since === null) throw new FaultError(400, "not_planned", `fault point ${p.id} is legal but not planned for any release`);
    throw new FaultError(501, "not_built", `fault point ${p.id} arrives in ${p.since}; this build cannot arm it`, { available_from: p.since });
  }
  const needs = POINT_NEEDS_FEATURE[p.id];
  if (needs !== undefined && features !== undefined && !features.includes(needs)) {
    throw new FaultError(400, "needs_feature", `fault point ${p.id} needs the ${needs} feature (CMP-66): without a journal there is no key record to keep after the effect`, { feature: needs });
  }
  const raw = b.selector ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FaultError(400, "bad_selector", "selector must be an object");
  const s = raw as Record<string, unknown>;
  const unknown = Object.keys(s).filter((k) => !SELECTOR_MEMBERS.has(k));
  if (unknown.length) throw new FaultError(400, "bad_selector", `unknown selector member(s): ${unknown.join(", ")}; known: tool, run, operation, nth, count, once, hold_ms`);
  if (s.once !== undefined && typeof s.once !== "boolean") throw new FaultError(400, "bad_selector", "selector.once must be a boolean");
  if (s.once === true && s.count !== undefined && s.count !== 1) throw new FaultError(400, "bad_selector", "selector.once and selector.count disagree");
  const selector: FaultSelector = {
    nth: s.nth === undefined ? 1 : intIn(s.nth, "nth", 1, FAULT_CAPS.maxCount),
    count: s.count === undefined ? 1 : intIn(s.count, "count", 1, FAULT_CAPS.maxCount),
    hold_ms: s.hold_ms === undefined ? FAULT_CAPS.defaultHoldMs : intIn(s.hold_ms, "hold_ms", 1, FAULT_CAPS.maxHoldMs),
  };
  if (isCrashPoint(p.id)) {
    // The crash check reads the arming store, which keeps `once` and nothing else: refuse what it would ignore.
    const ignored = ["tool", "run", "operation", "nth", "hold_ms"].filter((k) => s[k] !== undefined);
    if (ignored.length || (s.count !== undefined && s.count !== 1) || s.once === false) {
      throw new FaultError(400, "bad_selector", `a crash point fires once on the next call that reaches it; it takes no selector${ignored.length ? ` (got ${ignored.join(", ")})` : ""}`);
    }
  }
  if (s.tool !== undefined) {
    if (p.process !== "mcp") throw new FaultError(400, "bad_selector", "selector.tool applies to mcp points only (the backend does not know the tool)");
    if (typeof s.tool !== "string" || !/^[a-z_]{1,64}$/.test(s.tool)) throw new FaultError(400, "bad_selector", "selector.tool must be a tool name");
    selector.tool = s.tool;
  }
  if (s.run !== undefined) selector.run = tagIn(s.run, "run");
  if (s.operation !== undefined) selector.operation = tagIn(s.operation, "operation");
  return { point: p.id, selector };
}

/** The selector as recorded: members in a fixed order, only the ones that are set. */
function selectorRecord(s: FaultSelector): Record<string, unknown> {
  return JSON.parse(canonicalize(s)) as Record<string, unknown>;
}

export class FaultController {
  private readonly arms: ArmedFault[] = [];
  private readonly held = new Map<number, { timer: NodeJS.Timeout; release: () => void }>();
  private heldSeq = 0;
  private closed = false;

  constructor(private readonly ledger: Ledger, private readonly descriptor: BuildDescriptor, private readonly clock: Clock,
    private readonly actions: Record<string, FaultAction> = FAULT_ACTIONS, private readonly features?: readonly string[]) {}

  private active(): ArmedFault[] {
    return this.arms.filter((a) => a.state === "armed");
  }

  /** What the descriptor names (FX-BLD-1): each armed fault as `id point selector`, so descriptor_hash changes with them. */
  private publish(): void {
    // Crash points are listed by the descriptor from its arming store (they may fire in the other child).
    this.descriptor.armedFaults = this.active().filter((a) => !isCrashPoint(a.point)).map((a) => `${a.id} ${a.point} ${canonicalize(a.selector)}`);
  }

  arm(body: unknown): ArmedFault {
    const { point, selector } = parseArming(body, this.actions, this.features);
    if (this.active().length >= FAULT_CAPS.maxArmed) throw new FaultError(429, "too_many_faults", `at most ${FAULT_CAPS.maxArmed} faults armed at once`);
    if (isCrashPoint(point)) {
      // In memory (one process) the store refuses a crash point (needs --supervise); in a supervised child it is the
      // supervisor's folder, so the point fires in whichever child reaches it, and a fired point stays spent.
      try {
        this.descriptor.arming.arm({ point, once: true, selector: { once: true } });
      } catch (e) {
        throw new FaultError(409, "needs_supervise", (e as Error).message);
      }
    }
    const entry = this.ledger.faultArmed({ point, selector: selectorRecord(selector) });
    const arm: ArmedFault = {
      id: `F-${this.arms.length + 1}`, point, selector, armed_at: this.clock.wallNow().toISOString(), ledger_seq: entry.seq,
      state: "armed", matched: 0, fired: 0, skipped_at_cap: 0, released: 0,
    };
    this.arms.push(arm);
    this.publish();
    return { ...arm, selector: { ...selector } };
  }

  list(): { armed: ArmedFault[]; spent: ArmedFault[]; held: number; caps: typeof FAULT_CAPS } {
    // A crash arming is spent once the arming store no longer holds it (it fired, perhaps in the other child).
    const inStore = new Set(this.descriptor.arming.list().map((f) => f.point));
    for (const a of this.arms) if (a.state === "armed" && isCrashPoint(a.point) && !inStore.has(a.point)) { a.state = "spent"; a.fired = 1; }
    const copy = (a: ArmedFault) => ({ ...a, selector: { ...a.selector } });
    return { armed: this.active().map(copy), spent: this.arms.filter((a) => a.state === "spent").map(copy), held: this.held.size, caps: FAULT_CAPS };
  }

  /**
   * Picks the arm that fires for one call at one position, or undefined. Counts the match, applies nth and the held
   * cap, and records the firing in the ledger first: a firing the ledger cannot record does not happen.
   */
  private pick(process: FaultPoint["process"], position: FaultPoint["position"], call: { tool?: string; run: string | null; operation: string | null },
    on: () => LedgerEntry | undefined, holds: boolean): ArmedFault | undefined {
    if (this.closed) return undefined;
    const arm = this.active().find((a) => {
      if (isCrashPoint(a.point)) return false; // fired by the crash check (src/fixture/process.ts)
      const p = faultPoint(a.point)!;
      return p.process === process && p.position === position
        && (a.selector.tool === undefined || a.selector.tool === call.tool)
        && (a.selector.run === undefined || a.selector.run === call.run)
        && (a.selector.operation === undefined || a.selector.operation === call.operation);
    });
    if (!arm) return undefined;
    arm.matched++;
    if (arm.matched < arm.selector.nth) return undefined;
    if (holds && this.held.size >= FAULT_CAPS.maxHeld) {
      arm.skipped_at_cap++;
      return undefined;
    }
    try {
      this.ledger.faultFired({ point: arm.point, selector: selectorRecord(arm.selector) }, { run: call.run, operation: call.operation }, on());
    } catch {
      return undefined;
    }
    arm.fired++;
    if (arm.fired >= arm.selector.count) {
      arm.state = "spent";
      this.publish();
    }
    return arm;
  }

  private kit(arm: ArmedFault): FaultActionKit {
    return {
      hold: <T>(value: T) => {
        const id = ++this.heldSeq;
        return new Promise<T>((resolve) => {
          const release = () => {
            if (!this.held.delete(id)) return;
            clearTimeout(timer);
            arm.released++;
            resolve(value);
          };
          const timer = setTimeout(release, arm.selector.hold_ms);
          timer.unref();
          this.held.set(id, { timer, release });
        });
      },
    };
  }

  /** The frozen MCP hook (ServerExtras.onResult): runs after the handler, inside the call's attribution context. */
  readonly onResult = async (tool: string, result: unknown): Promise<unknown> => {
    const h = attributionHeaders();
    const call = { tool, run: h[HEADERS.run.toLowerCase()] ?? null, operation: h[HEADERS.operation.toLowerCase()] ?? null };
    const arm = this.pick("mcp", "after-backend-reply", call, () => this.ledger.latestTagged(call.run, call.operation), true);
    const action = arm && this.actions[arm.point];
    return action && action.position === "after-backend-reply" ? action.fire(result, arm!, this.kit(arm!)) : result;
  };

  /** The frozen backend hooks (BackendOptions.faults): backend/before-commit and backend/after-commit. */
  readonly backendHooks: Required<BackendFaultHooks> = {
    beforeCommit: async (ctx) => {
      const call = { run: ctx.meta.attribution.run, operation: ctx.meta.attribution.operation };
      // why: a before-commit action that holds (the delay) counts against the cap of held answers, as an mcp hold does.
      const arm = this.pick("backend", "before-commit", call, () => undefined, true);
      const action = arm && this.actions[arm.point];
      if (action && action.position === "before-commit") await action.fire(ctx, arm!, this.kit(arm!));
    },
    afterCommit: async (ctx) => {
      const call = { run: ctx.meta.attribution.run, operation: ctx.meta.attribution.operation };
      const id = ctx.tx.kind === "write" ? executionId(ctx.tx.seq) : null;
      const arm = this.pick("backend", "after-commit", call, () => (id ? this.ledger.list({ kind: "execution" }).findLast((e) => e.execution_id === id) : undefined), false);
      const action = arm && this.actions[arm.point];
      return action && action.position === "after-commit" ? action.fire(ctx, arm!, this.kit(arm!)) : undefined;
    },
  };

  /** Sends every held answer now (shutdown), and fires nothing more. */
  close(): void {
    this.closed = true;
    for (const h of [...this.held.values()]) h.release();
  }
}

export { FAULT_POINTS };
