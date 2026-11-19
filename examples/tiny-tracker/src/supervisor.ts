// `tiny-tracker all --supervise` (0.3.0, review B7, G9; PLAN R7).
//
// One process cannot crash half of itself: `tiny-tracker all` runs the backend
// and the MCP server in one process, so a crash point would stop both.
// Supervised, the command runs two children, each a `tiny-tracker all` that
// starts only its half:
//   backend  the backend, the evidence routes and the control listener
//   mcp      the MCP server, pointed at the backend child
// and restarts either one when it exits, on the same port, so that the URLs a
// harness holds stay valid. The other child stays up: an MCP crash after the
// backend replied leaves the backend's state in place (MWS-RETRY-2 step e).
//
// Arming, the fixture clock offset and the children's boot ids and restart
// counts live in the supervisor's state folder (src/supervision.ts), never on
// a child's command line: --fault is read by the supervisor once, armed into
// the folder, and not passed on, so a `once` fault does not re-arm when the
// child restarts.
//
// stdout: one state line when both children are up, the shape `all` prints
// plus a `supervise` member; then one more line after every restart, with
// `restarted` naming the child, so a harness can wait for it. A child that
// stops more than MAX_RESTARTS times stops the supervisor (exit 1).
//
// This module imports nothing from src/fixture.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILD_ENV, CHILD_ROLES, childEnvValue, childrenPath, folderArming, writeJsonDurable,
  type ArmingStore, type ChildRole, type ChildrenFile,
} from "./supervision.js";

/** Restarts per child per supervisor lifetime (X5); one more stops the supervisor. */
export const MAX_RESTARTS = 100;
const RESTART_DELAY_MS = 50;
const START_TIMEOUT_MS = 15_000;

/** Flags the supervisor consumes and does not pass to its children; ports are passed per child. */
const OWN_FLAGS = new Set(["--supervise", "--fault"]);
const PORT_FLAGS = new Set(["--port", "--backend-port", "--control-port"]);
const VALUE_FLAGS = new Set(["--fault", "--port", "--backend-port", "--control-port"]);

export interface SupervisorOptions {
  /** The command line script (dist/src/cli.js). */
  cli: string;
  /** The command line after `all`, as given. */
  args: readonly string[];
  /** The children's environment (tokens included; never put on argv). */
  env: Record<string, string | undefined>;
  /** Faults from --fault, armed once into the state folder before the children start. */
  faults?: ReadonlyArray<{ point: string; once: boolean }>;
  /** Every state line, as printed. */
  onLine?(line: Record<string, unknown>): void;
  /** The children's stderr. Default: this process's stderr. */
  onStderr?(text: string): void;
  /** Called once if the supervisor gives up (a child stopped too often). */
  onFatal?(message: string): void;
  maxRestarts?: number;
}

export interface Supervisor {
  bootId: string;
  stateDir: string;
  /** The latest state line. */
  readonly state: Record<string, unknown>;
  readonly restarts: Readonly<Record<ChildRole, number>>;
  readonly pids: Readonly<Record<ChildRole, number | undefined>>;
  /** The arming store both children read. The fault controller arms here; so may a test. */
  arming: ArmingStore;
  /** Resolves with the state line printed after `role` has been restarted `count` times in all. */
  restarted(role: ChildRole, count: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Removes the supervisor's own flags and the port flags from a command line, keeping everything else in order. */
export function childArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (OWN_FLAGS.has(flag) || PORT_FLAGS.has(flag)) {
      if (VALUE_FLAGS.has(flag) && !a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** The value of a port flag on the command line (last one wins, as parseArgs does), or "0". */
function portArg(args: readonly string[], name: string): string {
  let v = "0";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) v = args[++i];
    else if (args[i].startsWith(`${name}=`)) v = args[i].slice(name.length + 1);
  }
  return v;
}

const STATE_ORDER = ["backend", "backend_defects", "mcp", "defects", "read_only", "variants", "profile", "features", "evidence", "tokens", "control"];

interface Running {
  proc: ChildProcess;
  line: Record<string, unknown>;
}

export async function startSupervisor(options: SupervisorOptions): Promise<Supervisor> {
  const bootId = randomBytes(8).toString("hex");
  const stateDir = mkdtempSync(join(tmpdir(), "tt-supervise-"));
  const arming = folderArming(stateDir);
  for (const f of options.faults ?? []) arming.arm({ point: f.point, once: f.once });
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
  const passArgs = childArgs(options.args);
  const ports: Record<string, string> = {
    "--port": portArg(options.args, "--port"),
    "--backend-port": portArg(options.args, "--backend-port"),
    "--control-port": portArg(options.args, "--control-port"),
  };
  const restarts: Record<ChildRole, number> = { backend: 0, mcp: 0 };
  const running: Partial<Record<ChildRole, Running>> = {};
  const waiters: Array<{ role: ChildRole; count: number; resolve(line: Record<string, unknown>): void }> = [];
  let state: Record<string, unknown> = {};
  let closing = false;
  let fatal = false;
  const stderr = options.onStderr ?? ((t: string) => void process.stderr.write(t));

  function writeChildren(): void {
    const info = (role: ChildRole) => ({
      boot_id: (running[role]?.line.boot_id as string | undefined) ?? null,
      restart_count: restarts[role],
      pid: running[role]?.proc.pid ?? null,
    });
    const file: ChildrenFile = { supervisor_boot_id: bootId, children: { backend: info("backend"), mcp: info("mcp") } };
    writeJsonDurable(childrenPath(stateDir), file);
  }

  function composeLine(restarted?: ChildRole): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(running.backend?.line ?? {}), ...(running.mcp?.line ?? {}) };
    const out: Record<string, unknown> = {};
    for (const k of STATE_ORDER) if (merged[k] !== undefined) out[k] = merged[k];
    out.supervise = {
      boot_id: bootId,
      restarts: { ...restarts },
      boot_ids: { backend: running.backend?.line.boot_id ?? null, mcp: running.mcp?.line.boot_id ?? null },
    };
    if (restarted) out.restarted = restarted;
    return out;
  }

  function argsFor(role: ChildRole): string[] {
    const own = role === "backend"
      ? ["--backend-port", ports["--backend-port"], "--control-port", ports["--control-port"]]
      : ["--port", ports["--port"]];
    return ["all", ...passArgs, ...own];
  }

  /** Starts one child and resolves with its state line; rejects if it exits first. */
  function spawnChild(role: ChildRole): Promise<Running> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) if (v !== undefined) env[k] = v;
    env[CHILD_ENV] = childEnvValue({ role, stateDir, restartCount: restarts[role], supervisorBootId: bootId });
    if (role === "mcp") env.TRACKER_BACKEND_URL = String(running.backend?.line.backend ?? "");
    const proc = spawn(process.execPath, [options.cli, ...argsFor(role)], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    return new Promise((resolve, reject) => {
      let out = "";
      let ready = false;
      const timer = setTimeout(() => { if (!ready) proc.kill("SIGKILL"); }, START_TIMEOUT_MS);
      proc.stderr!.on("data", (d) => stderr(String(d)));
      proc.stdout!.on("data", (d) => {
        if (ready) return;
        out += d;
        const nl = out.indexOf("\n");
        if (nl < 0) return;
        ready = true;
        clearTimeout(timer);
        try {
          resolve({ proc, line: JSON.parse(out.slice(0, nl)) });
        } catch {
          proc.kill("SIGKILL");
          reject(new Error(`the ${role} child printed a state line that is not JSON`));
        }
      });
      proc.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (!ready) reject(Object.assign(new Error(`the ${role} child stopped before it was ready (${signal ?? `exit ${code}`})`), { exitCode: code }));
        else onExit(role, proc, code, signal);
      });
    });
  }

  function remember(role: ChildRole, r: Running): void {
    running[role] = r;
    // The other child's port stays fixed from now on, so a restart comes back on the same URL.
    if (role === "backend") {
      ports["--backend-port"] = new URL(String(r.line.backend)).port;
      if (typeof r.line.control === "string") ports["--control-port"] = new URL(r.line.control).port;
    } else {
      ports["--port"] = new URL(String(r.line.mcp)).port;
    }
    writeChildren();
  }

  function emit(line: Record<string, unknown>): void {
    state = line;
    options.onLine?.(line);
    for (const w of [...waiters]) {
      if (restarts[w.role] >= w.count) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  }

  function giveUp(message: string): void {
    if (fatal) return;
    fatal = true;
    void close().then(() => options.onFatal?.(message));
  }

  async function restart(role: ChildRole): Promise<void> {
    while (!closing) {
      if (restarts[role] >= maxRestarts) return giveUp(`the ${role} child stopped ${restarts[role] + 1} times; at most ${maxRestarts} restarts. Stopping.`);
      restarts[role]++;
      await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
      if (closing) return;
      try {
        const r = await spawnChild(role);
        if (closing) { r.proc.kill("SIGTERM"); return; }
        remember(role, r);
        stderr(`tiny-tracker supervisor: ${role} restarted (restart ${restarts[role]})\n`);
        emit(composeLine(role));
        return;
      } catch (e) {
        stderr(`tiny-tracker supervisor: ${(e as Error).message}\n`);
      }
    }
  }

  function onExit(role: ChildRole, proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (running[role]?.proc !== proc) return;
    running[role] = undefined;
    if (closing) return;
    writeChildren();
    stderr(`tiny-tracker supervisor: ${role} child stopped (${signal ?? `exit ${code}`})\n`);
    void restart(role);
  }

  async function stopChild(proc: ChildProcess | undefined): Promise<void> {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
      proc.kill("SIGTERM");
    });
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await stopChild(running.mcp?.proc);
    await stopChild(running.backend?.proc);
    rmSync(stateDir, { recursive: true, force: true });
  }

  writeChildren();
  try {
    remember("backend", await spawnChild("backend"));
    remember("mcp", await spawnChild("mcp"));
  } catch (e) {
    await close();
    throw e;
  }
  emit(composeLine());

  return {
    bootId,
    stateDir,
    get state() { return state; },
    restarts,
    get pids() { return { backend: running.backend?.proc.pid, mcp: running.mcp?.proc.pid }; },
    arming,
    restarted(role, count) {
      if (restarts[role] >= count && running[role]) return Promise.resolve(state);
      return new Promise((resolve) => waiters.push({ role, count, resolve }));
    },
    close,
  };
}

/** The command line's `--supervise`: prints state lines, stops on SIGINT or SIGTERM. */
export async function runSupervisor(options: Omit<SupervisorOptions, "onLine" | "onFatal">): Promise<void> {
  let sup: Supervisor;
  try {
    sup = await startSupervisor({
      ...options,
      onLine: (line) => void process.stdout.write(`${JSON.stringify(line)}\n`),
      onFatal: (message) => {
        process.stderr.write(`tiny-tracker supervisor: ${message}\n`);
        process.exit(1);
      },
    });
  } catch (e) {
    process.stderr.write(`tiny-tracker supervisor: ${(e as Error).message}. Not starting.\n`);
    const code = (e as { exitCode?: number | null }).exitCode;
    process.exit(typeof code === "number" && code !== 0 ? code : 1);
  }
  const stop = () => void sup.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export { CHILD_ROLES };
