// Shared state between the supervisor and its two children (0.3.0, review B7
// and G9). `tiny-tracker all --supervise` runs the backend and the MCP server
// as two child processes, so that either can crash and be restarted while the
// other stays up. Anything that has to survive a child restart lives in a
// state folder the supervisor creates (0700) and removes when it stops:
//
//   children.json   written by the supervisor only: its own boot id, and each
//                   child's boot id, restart count and pid
//   clock.json      written by the backend child only: the fixture clock offset
//   settings.json   written by the MCP child only: its settings, for the
//                   descriptor's config block that the backend child serves
//   armed/<point>   one file per armed fault point; consuming a `once` fault
//                   is a rename, which exactly one process can win
//   fired/          one file per firing, kept as evidence for the run
//
// Fault arming is therefore never on a child's command line: a `once` fault
// that crashed a child is consumed before the child exits, and the restarted
// child does not see it again (no crash loop).
//
// This module holds no fixture logic and imports nothing from src/fixture.
// Every write is a temporary file, fsync, rename, then an fsync of the folder.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The environment variable that tells a `tiny-tracker all` process it is one half of a supervised pair. */
export const CHILD_ENV = "TRACKER_SUPERVISED_CHILD";

export type ChildRole = "backend" | "mcp";
export const CHILD_ROLES: readonly ChildRole[] = ["backend", "mcp"];

export interface ChildContext {
  role: ChildRole;
  /** The supervisor's state folder. */
  stateDir: string;
  /** How many times the supervisor has restarted this child (0 on the first start). */
  restartCount: number;
  supervisorBootId: string;
}

export class SupervisionError extends Error {}

const BOOT_ID = /^[0-9a-f]{16}$/;

/** Reads the child context from the environment; null when this process is not a supervised child. */
export function childContext(env: Record<string, string | undefined>): ChildContext | null {
  const raw = env[CHILD_ENV];
  if (raw === undefined || raw === "") return null;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new SupervisionError(`${CHILD_ENV} is not valid JSON`);
  }
  if (!v || typeof v !== "object" || !CHILD_ROLES.includes(v.role) || typeof v.state_dir !== "string"
    || !Number.isInteger(v.restart_count) || v.restart_count < 0 || typeof v.supervisor_boot_id !== "string" || !BOOT_ID.test(v.supervisor_boot_id)) {
    throw new SupervisionError(`${CHILD_ENV} is malformed (it is set by tiny-tracker all --supervise, not by hand)`);
  }
  if (!existsSync(v.state_dir)) throw new SupervisionError(`${CHILD_ENV} names a state folder that does not exist`);
  return { role: v.role, stateDir: v.state_dir, restartCount: v.restart_count, supervisorBootId: v.supervisor_boot_id };
}

export function childEnvValue(c: ChildContext): string {
  return JSON.stringify({ role: c.role, state_dir: c.stateDir, restart_count: c.restartCount, supervisor_boot_id: c.supervisorBootId });
}

// ---- durable small files ----

function fsyncDir(dir: string): void {
  // A folder cannot be opened for fsync on every platform (Windows); the rename is still atomic there.
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort */ }
}

/** Writes a JSON file so that a reader sees the old or the new content, never a part, and the new content is on disk on return. */
export function writeJsonDurable(path: string, value: unknown): void {
  const dir = join(path, "..");
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// ---- children.json ----

export interface ChildInfo {
  boot_id: string | null;
  restart_count: number;
  pid: number | null;
}

export interface ChildrenFile {
  supervisor_boot_id: string;
  children: Record<ChildRole, ChildInfo>;
}

export const childrenPath = (stateDir: string) => join(stateDir, "children.json");
export const clockPath = (stateDir: string) => join(stateDir, "clock.json");
/** Written by the MCP child only: the MCP-layer settings, so the backend child's descriptor (GET /build) covers both layers. */
export const settingsPath = (stateDir: string) => join(stateDir, "settings.json");

export function readChildren(stateDir: string): ChildrenFile | undefined {
  return readJson<ChildrenFile>(childrenPath(stateDir));
}

// ---- fault arming ----

/** One armed fault point. Selectors beyond `once` belong to the fault controller (0.2.0) and ride along untouched. */
export interface ArmedFault {
  /** A point id from src/fault-points.ts, e.g. "backend/after-commit/crash". */
  point: string;
  /** Fire at most once, across child restarts. */
  once: boolean;
  /** Wall time it was armed. */
  armed_at: string;
  /** Anything else the controller keeps with the arming (selectors). */
  selector?: Record<string, unknown>;
}

/** A firing, kept as evidence. */
export interface FaultFiring {
  point: string;
  at: string;
  /** The boot id of the process the fault fired in, when it has one. */
  boot_id: string | null;
  /** The commit sequence number it fired on, when the position has one. */
  seq: number | null;
}

export class ArmingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Where armed faults live. The fault controller (stream B) arms and disarms through it; the fault points ask
 * `take` when they are reached. One implementation keeps the state in memory (one process); the other in the
 * supervisor's state folder, shared by both children and kept across their restarts.
 */
export interface ArmingStore {
  readonly shared: boolean;
  list(): ArmedFault[];
  arm(fault: Omit<ArmedFault, "armed_at"> & { armed_at?: string }): ArmedFault;
  disarm(point: string): boolean;
  /**
   * The point was reached. Returns the armed fault when it fires now, else undefined. A `once` fault is consumed
   * here, durably, before the caller acts on it: exactly one caller gets it, even across processes.
   */
  take(point: string, firing: Omit<FaultFiring, "point">): ArmedFault | undefined;
  firings(): FaultFiring[];
}

/** File names for points: "backend/after-commit/crash" becomes "backend~after-commit~crash.json". */
const fileFor = (point: string) => `${point.replace(/\//g, "~")}.json`;
const POINT_ID = /^[a-z-]+\/[a-z-]+\/[a-z-]+$/;

function checkPoint(point: unknown): string {
  if (typeof point !== "string" || !POINT_ID.test(point)) throw new ArmingError("bad_point", "a fault point is process/position/action");
  return point;
}

/**
 * Arming in memory, for one process (`tiny-tracker all` without --supervise). A crash point is refused here: in one
 * process it would stop both layers, and nothing would restart them (CMP-63 says the same at start).
 */
export function memoryArming(wallNow: () => Date = () => new Date()): ArmingStore {
  const armed = new Map<string, ArmedFault>();
  const fired: FaultFiring[] = [];
  return {
    shared: false,
    list: () => [...armed.values()].map((f) => ({ ...f })),
    arm(f) {
      const point = checkPoint(f.point);
      if (point.endsWith("/crash")) throw new ArmingError("needs_supervise", `${point} needs tiny-tracker all --supervise: in one process a crash stops both layers and nothing restarts them`);
      const entry: ArmedFault = { point, once: f.once === true, armed_at: f.armed_at ?? wallNow().toISOString(), ...(f.selector ? { selector: f.selector } : {}) };
      armed.set(point, entry);
      return { ...entry };
    },
    disarm: (point) => armed.delete(point),
    take(point, firing) {
      const f = armed.get(point);
      if (!f) return undefined;
      if (f.once) armed.delete(point);
      fired.push({ point, ...firing });
      return { ...f };
    },
    firings: () => fired.map((x) => ({ ...x })),
  };
}

/**
 * The sequence in a firing record's name. It is per process, not per store: two stores in one process (the unit
 * tests, a library caller) once each counted from 1, so two firings in the same millisecond got the same name and the
 * later write replaced the earlier firing.
 */
let firingSeq = 0;

/**
 * Claims a new name in `fired/` with an exclusive create, so no other store or process (a restarted child that got a
 * dead child's pid, say) can write a firing to the same name. The claimed file is empty until the firing is written,
 * and an empty file reads as no firing. Names stay `<ms>-<pid>-<seq>.json`, so firings sort by time, then by order
 * within a process.
 */
function claimFiringName(firedDir: string): string {
  for (;;) {
    const name = `${Date.now()}-${process.pid}-${++firingSeq}.json`;
    try {
      closeSync(openSync(join(firedDir, name), "wx", 0o600));
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/** The arming store in the supervisor's state folder. */
export function folderArming(stateDir: string, wallNow: () => Date = () => new Date()): ArmingStore {
  const armedDir = join(stateDir, "armed");
  const firedDir = join(stateDir, "fired");
  mkdirSync(armedDir, { recursive: true, mode: 0o700 });
  mkdirSync(firedDir, { recursive: true, mode: 0o700 });
  const read = (file: string) => readJson<ArmedFault>(join(armedDir, file));
  return {
    shared: true,
    list() {
      return readdirSync(armedDir).filter((f) => f.endsWith(".json")).sort().map(read).filter((f): f is ArmedFault => f !== undefined);
    },
    arm(f) {
      const point = checkPoint(f.point);
      const entry: ArmedFault = { point, once: f.once === true, armed_at: f.armed_at ?? wallNow().toISOString(), ...(f.selector ? { selector: f.selector } : {}) };
      writeJsonDurable(join(armedDir, fileFor(point)), entry);
      return entry;
    },
    disarm(point) {
      const path = join(armedDir, fileFor(checkPoint(point)));
      try {
        renameSync(path, join(firedDir, `disarmed-${process.pid}-${Date.now()}-${++firingSeq}.json`));
        fsyncDir(armedDir);
        return true;
      } catch {
        return false;
      }
    },
    take(point, firing) {
      const path = join(armedDir, fileFor(point));
      const f = read(fileFor(point));
      if (!f) return undefined;
      const record: FaultFiring = { point, ...firing };
      const name = claimFiringName(firedDir);
      if (f.once) {
        // The rename is the consumption: of two processes reaching the point at once, one wins and the other sees
        // no file. It replaces only the name this store just claimed. The firing record replaces the arming file's
        // content once the rename is done.
        try {
          renameSync(path, join(firedDir, name));
        } catch {
          try { unlinkSync(join(firedDir, name)); } catch { /* already gone */ }
          return undefined;
        }
        fsyncDir(armedDir);
      }
      writeJsonDurable(join(firedDir, name), { ...record, once: f.once });
      return f;
    },
    firings() {
      return readdirSync(firedDir).filter((n) => /^\d+-\d+-\d+\.json$/.test(n))
        .map((n) => [n, readJson<FaultFiring>(join(firedDir, n))] as const)
        .filter((x): x is readonly [string, FaultFiring] => x[1] !== undefined)
        .sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))
        .map(([, x]) => ({ point: x.point, at: x.at, boot_id: x.boot_id, seq: x.seq }));
    },
  };
}
