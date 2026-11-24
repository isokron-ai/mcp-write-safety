// The durable store: a JSONL journal of committed post-state (0.3.0, feature
// durable; decision 0003, review B8 and G13; line shapes in docs/INTERFACES.md
// 1.9, types in src/backend/commit.ts).
//
// Files in the data dir (created 0700; an existing one must be private, owned by
// this user, not a symlink, and either empty or made by tiny-tracker):
//   tiny-tracker.data   marker: this directory was created by tiny-tracker
//   lock.d              the lease (0.4.0): a directory holding `owner` {"pid", "host", "nonce", ...}, whose mtime
//                       the holder refreshes (heartbeat); the holder checks it still owns it before every append
//   lock                the pid lock {"pid": N, "started_at": ..., "nonce": ...}: kept as a second check for 0.4.0
//   journal.jsonl       one JSON object per line, each with `jseq` (its own number, 0 for
//                       the header, contiguous) and `checksum` (SHA-256 of the line's
//                       RFC 8785 bytes without the checksum member)
//
// Lines: the header (with the seed), commit lines (commit_seq = tx.seq, the
// complete CommittedTransaction, pending_jseq), pending lines (inflight),
// aborted lines, fence lines (a run reset ended a pending line; seams v2.1),
// run-alloc lines (the fixture layer's run registry; seams v2.1),
// lookup-fence lines (settle-by-lookup; additive), clock lines (the fixture
// clock's moves; additive, 0.4.0) and lease lines (a start took the lease, with
// its epoch; additive, 0.4.0, G3 note 26). Every line after a lease line carries
// its writer's `epoch`. The effect and its key record are one line: replay rebuilds the
// key record from the commit line with storedReplyOf(tx).
//
// The journal is the commit path's step 2 (src/backend/commit.ts): the line is
// written and flushed (writeSync + fsyncSync) before the write is applied. The
// file is open O_APPEND and written with no position, so a holder that was paused
// past a takeover appends after the new holder's lines, never over them, and the
// file is never cut back after a write that may have raced (G3 note 26 item 1a):
// an append that fails once it has begun marks the journal broken (every later
// write answers 503; restart it). After the flush the holder checks the lease
// again; if it was taken over meanwhile the answer is 503 lease_lost (outcome
// unknown), never a success. Replay applies post-state only: no
// operation is re-run and no clock is read, so a restart cannot change a digest.
//
// Epochs (G3 note 26 item 1b): each start writes a lease line with an epoch one
// more than the highest in the file, before it replays. A line whose epoch is
// lower than a lease line before it is a superseded writer's: not applied,
// counted in the load report and logged.
//
// Recovery: nothing is cut from the file once the lease is taken (G3a: a start
// paused between a check and a cut could cut a newer holder's lines). A torn write
// (bytes of a write cut short: an unterminated last line that does not decode)
// stays in the file and is left out; the next write joins it on its physical line,
// and every later start leaves that fragment out again (scanJournal, splitJoined).
// A physical line that holds no whole line, other than the unterminated last one,
// or any other bad line (an unknown kind, a sequence gap) stops the start with an
// error and the file is not touched. A pending line that no commit or aborted line
// names is ended at start by an aborted line (reason orphan_at_start), written
// before the backend serves.

import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { createHash, randomBytes } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { join, resolve } from "node:path";
import { canonicalize } from "../digest.js";
import { ensurePrivateDir, PrivateDirError } from "../private-dir.js";
import { JournalError, storedReplyOf, type CommittedTransaction, type JournalAbortedLine, type JournalClockLine, type JournalCommitLine, type JournalFenceLine, type JournalHeader, type JournalLeaseLine, type JournalLine, type JournalLookupFenceLine, type JournalPendingLine, type JournalRunAllocLine } from "./commit.js";
import type { AbortReason, JournalSeam, KeyScope } from "./seams.js";
import type { Store } from "./store.js";
import type { DurableKeyRecords, KeyLineWriter } from "./keyrecords.js";

/** A run as the fixture layer's registry keeps it (src/fixture/control.ts Run); the journal's run-alloc line. */
export interface JournalRun {
  run_id: string;
  principal: string;
  created_at: string;
  label: string | null;
}

/** A fixture clock move (src/fixture/clock.ts ClockMove); the journal's clock line. */
export interface JournalClockMove {
  from_ms: number;
  to_ms: number;
  at: string;
}

/** Where clock lines go back at load (the fixture clock: its offset is set to the last line's to_ms, forward only). */
export interface ClockRestorer {
  restore(offsetMs: number): void;
}

/** Where run-alloc lines go back at load (the fixture layer's RunRegistry). */
export interface RunRestorer {
  restore(run: JournalRun): void;
}

export const JOURNAL_FORMAT = "journal-format/1";
export const JOURNAL_FILE = "journal.jsonl";
export const LOCK_FILE = "lock";
/** The lease directory (0.4.0, coordinator note 19 item 11) and the owner file inside it. */
export const LEASE_DIR = "lock.d";
export const LEASE_OWNER = "owner";
export const MARKER_FILE = "tiny-tracker.data";

export class JournalCorruptError extends Error {}
export class DataDirError extends Error {}

/** Thrown by a crash hook (tests only): the process is taken as dead at that point; nothing is cleaned up. */
export class SimulatedCrash extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
  }
}

/**
 * Named points on the journal's write path, for the crash suite (T1):
 *   before-append  nothing of the line is written
 *   torn-write     half of the line is written (return "tear" from the hook at before-append)
 *   after-write    the whole line is written, not yet flushed (a power cut would lose it; a process crash does not)
 *   after-fsync    the line is flushed
 */
export const JOURNAL_POINTS = ["before-append", "torn-write", "after-write", "after-fsync"] as const;
export type JournalPoint = (typeof JOURNAL_POINTS)[number];

/** Called at each point with the line about to be (or just) written. Throw to die there; return "tear" at before-append to die after half the line. */
export type CrashHook = (point: JournalPoint, line: { jseq: number; line: JournalLine["line"]; key?: string | null }) => void | "tear";

export interface JournalOptions {
  dataDir: string;
  /** The package version, for the header. */
  writer: string;
  crash?: CrashHook;
  /** Where the journal reports a dropped torn line, a stale lock and the aborted orphans (default: stderr). */
  log?: (message: string) => void;
  /** Wall-clock time for the lock file only. */
  wallNow?: () => Date;
  platform?: string;
}

/**
 * What "flushed" means on this platform (G2 fold-in 13). Node's fsyncSync is fsync(2). On macOS that hands the data to
 * the drive but does not flush the drive's own cache (that takes fcntl F_FULLFSYNC, which Node does not expose), so a
 * flushed line survives a process crash, not a power cut. Returned for darwin and logged at start; undefined elsewhere.
 */
export function flushLimit(platform: string): string | undefined {
  return platform === "darwin"
    ? "tiny-tracker: on macOS the journal's fsync is not F_FULLFSYNC (Node does not expose it): a flushed line survives a process crash, not a power cut"
    : undefined;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The checksum of a line: SHA-256 (hex) of its RFC 8785 bytes without the checksum member. */
export function lineChecksum(line: Record<string, unknown>): string {
  const { checksum: _c, ...rest } = line;
  return sha256(canonicalize(rest));
}

/** One line's text (without the newline), checksum added. */
export function encodeLine(line: Omit<JournalLine, "checksum">): string {
  return JSON.stringify({ ...line, checksum: lineChecksum(line as Record<string, unknown>) });
}

/** Parses one line; undefined when it does not parse or its checksum does not match. */
export function decodeLine(text: string): JournalLine | undefined {
  try {
    const l = JSON.parse(text) as Record<string, unknown>;
    if (typeof l !== "object" || l === null || typeof l.checksum !== "string" || !Number.isSafeInteger(l.jseq)) return undefined;
    return lineChecksum(l) === l.checksum ? (l as unknown as JournalLine) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The data dir: created 0700, or an existing one checked. The private-directory rules (created 0700; a symlink, a
 * non-directory or one open to group or others refused) are stream F's src/private-dir.ts, brought in at the 0.3.0
 * integration; F integrates fully at 0.4.0. Here also: one owned by another user, or one that is not empty and was not
 * made by tiny-tracker, is refused.
 */
export function prepareDataDir(dir: string, platform: string = process.platform): void {
  const existed = existsSync(dir);
  try {
    ensurePrivateDir(dir, `--data-dir ${dir}`, platform);
  } catch (e) {
    if (e instanceof PrivateDirError) throw new DataDirError(e.message);
    throw e;
  }
  if (!existed) {
    writeFileSync(join(dir, MARKER_FILE), `${JOURNAL_FORMAT}\n`, { mode: 0o600 });
    return;
  }
  if (platform !== "win32" && typeof process.getuid === "function" && statSync(dir).uid !== process.getuid()) {
    throw new DataDirError(`--data-dir ${dir} belongs to another user`);
  }
  if (!existsSync(join(dir, MARKER_FILE))) {
    if (readdirSync(dir).length > 0) throw new DataDirError(`--data-dir ${dir} is not empty and was not created by tiny-tracker; use an empty or new directory`);
    writeFileSync(join(dir, MARKER_FILE), `${JOURNAL_FORMAT}\n`, { mode: 0o600 });
  }
}

/**
 * Data dirs held by a live Journal in this process (a second writer in the same process is refused too), keyed by the
 * directory's real path (G2 fold-in 7): on macOS /tmp is /private/tmp and tmpdir() lies under /var, so two spellings of
 * one directory must not count as two.
 */
const HELD = new Set<string>();
/**
 * The lock texts this process wrote and still holds (G2 round 3, F4). A lock that names this pid is this process's only
 * if its text is here; any other lock naming this pid was written by an earlier process that had the same pid (a
 * container's pid 1 after an unclean stop) and is stale. No clock is read, so a clock step cannot refuse a restart.
 * Module state is per thread: acquireLock runs on the main thread only.
 */
const WRITTEN = new Set<string>();
/** The lock this process created in each data dir it holds: its inode and text (G2 round 3, F5: release checks both). */
const CREATED = new Map<string, { ino: number; text: string }>();

/** The key a data dir is held under: its real path (the dir exists once prepareDataDir ran), else the resolved path. */
function heldKey(dir: string): string {
  try {
    // native: the canonical spelling, the case included on a case-insensitive filesystem (APFS: "aa" and "AA" are one dir).
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Whether a lock holder still runs. A killed process that its parent has not reaped yet (a zombie: a supervised child
 * the supervisor is about to restart) still answers kill(pid, 0), but it holds nothing: on Linux its state in
 * /proc/<pid>/stat is Z (or X), and its lock is stale (stream E's note: the supervisor restarts the backend child on
 * the same --data-dir).
 */
export function alive(pid: number, procRoot = "/proc"): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    // pid (comm) state ...: comm may hold spaces and parentheses, so the state follows the last ")".
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state === "Z" || state === "X") return false;
  } catch {
    // No /proc (macOS, Windows) or the process just went: kill(pid, 0) decides.
  }
  return true;
}

/** Test seams (G2 fold-in 7, round 2): after a lock was judged stale and before it is taken over; after it was moved aside. */
export const lockHooks: { beforeTakeover?: (path: string) => void; afterAside?: (path: string) => void } = {};

/**
 * Removes a stale lock without ever destroying another starter's lock (G2 fold-in 7; round 2, item 2). The lock is
 * renamed aside (atomic: of several starters only one moves a given file). Only when the moved file is proven to be the
 * stale lock this starter read (the same inode and the same text) is it removed: "removed". Otherwise another starter
 * took the lock over in between, and the moved file is that starter's live lock: it is linked back ("restored"; the
 * caller reads the lock again, and its live pid refuses this start). If link fails for any reason (a third starter's
 * lock is there, EEXIST; or link is not supported) the moved file is left where it is, never unlinked and never renamed
 * back over the lock path (a rename would replace a lock created in between; G2 round 3, F2): "left", and the caller
 * refuses to start, naming it.
 */
function removeStaleLock(path: string, stale: { text: string; ino: number }): { result: "removed" | "restored" | "left"; aside: string } {
  const aside = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { result: "removed", aside }; // another starter removed it first
    throw e;
  }
  lockHooks.afterAside?.(path);
  let proven = false;
  try {
    proven = statSync(aside).ino === stale.ino && readFileSync(aside, "utf8") === stale.text;
  } catch {
    // unreadable: not proven stale
  }
  if (proven) {
    unlinkSync(aside);
    return { result: "removed", aside };
  }
  try {
    linkSync(aside, path);
  } catch {
    return { result: "left", aside };
  }
  // Linked back: the lock is in place under its own name again; the aside name is only a second link to it.
  try {
    unlinkSync(aside);
  } catch {
    // A second name of a lock that is in place: harmless if it stays.
  }
  return { result: "restored", aside };
}

/**
 * The pid lock (review G13): one writer per data dir. A lock whose process is gone is stale and is taken over (logged);
 * a lock held by a live process, by a live journal in this process, or naming this process's pid (another spelling of
 * a directory this process holds), refuses the start. The takeover is a compare-and-remove (removeStaleLock), then an
 * O_EXCL create, so two starters can never both hold the dir.
 */
/**
 * How long a lock that is empty or does not parse counts as one being written right now (G2 round 2, item 1). Locks are
 * created whole (createLock), so such a file is a crash leftover or a writer on a filesystem without link(2); a
 * young one is held, an older one is stale.
 */
export const LOCK_UNREADABLE_GRACE_MS = 10_000;

/**
 * Creates the lock whole (G2 round 2, item 1): the content goes to a private temp file, flushed, which is then linked
 * into place, so the lock never exists empty for another starter to read. link(2) refuses if a lock exists (EEXIST),
 * which is the O_EXCL of the old create. Where link is not supported, an O_EXCL create with the content written at
 * once is the fallback; a starter that reads it empty treats it as held (LOCK_UNREADABLE_GRACE_MS).
 * Returns the new lock's inode, or false when a lock exists.
 */
function createLock(path: string, content: string): number | false {
  const tmp = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  // From here every way out removes the temp file, a failed write or fsync included (G2 round 3, F3).
  try {
    let ino: number;
    try {
      writeSync(fd, content);
      fsyncSync(fd);
      ino = fstatSync(fd).ino;
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, path);
    return ino; // the link is the same inode
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "ENOENT") {
      // G2 follow-up 3: this start stalled past the grace period and another start's sweep removed its temp file.
      throw new DataDirError(`could not take the data-dir lock ${path}: this start's temporary lock file was removed before it was linked into place (the start stalled for more than ${LOCK_UNREADABLE_GRACE_MS / 1000} s and another start swept it); nothing was taken, start again`);
    }
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
    try {
      const lfd = openSync(path, "wx", 0o600);
      try {
        writeSync(lfd, content);
        fsyncSync(lfd);
        return fstatSync(lfd).ino;
      } finally {
        closeSync(lfd);
      }
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e2;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** Whether a lock text naming this pid is one this process wrote and holds (G2 round 3, F4). */
function ownLockText(text: string): boolean {
  return WRITTEN.has(text);
}

/** Whether a leftover lock file's content names a process that can still hold anything. */
function leftoverOwnerAlive(text: string): boolean {
  let pid = NaN;
  try {
    pid = Number(JSON.parse(text).pid);
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid)) return false;
  if (pid === process.pid) return ownLockText(text);
  return alive(pid);
}

/**
 * Removes lock.new-* (a temp file a crashed start left before linking it) and lock.stale-* (a lock a start moved aside
 * and kept) once this start holds the lock (G2 round 3, F3). Only files older than LOCK_UNREADABLE_GRACE_MS whose
 * content names a process that is gone, or names none, are removed: a kept lock.stale-* of a live process is a running
 * server's lock and stays. Returns how many were removed.
 */
export function sweepLockLeftovers(dir: string, log: (m: string) => void): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(`${LOCK_FILE}.new-`) && !name.startsWith(`${LOCK_FILE}.stale-`)) continue;
    const file = join(dir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || Date.now() - st.mtimeMs < LOCK_UNREADABLE_GRACE_MS) continue;
      // A temp file names its writer: while that process runs it may still be writing (a stall), so it stays (G2
      // follow-up 3). This process writes none at this point (createLock is synchronous), so its own pid is not a writer.
      const writer = name.startsWith(`${LOCK_FILE}.new-`) ? Number(name.slice(`${LOCK_FILE}.new-`.length).split("-")[0]) : NaN;
      if (Number.isSafeInteger(writer) && writer !== process.pid && alive(writer)) continue;
      if (leftoverOwnerAlive(readFileSync(file, "utf8"))) continue;
      unlinkSync(file);
      removed++;
    } catch {
      // Gone meanwhile, or unreadable: leave it.
    }
  }
  if (removed) log(`tiny-tracker: removed ${removed} leftover lock file(s) of processes that are gone`);
  return removed;
}

export function acquireLock(dir: string, wallNow: () => Date, log: (m: string) => void, fencedPid?: number): void {
  const path = join(dir, LOCK_FILE);
  const real = heldKey(dir);
  // The own-process checks (HELD, WRITTEN) are module state, which a worker thread does not share (the reviewer's probe 1).
  if (!isMainThread) throw new DataDirError(`the data dir ${dir}: the durable journal opens on the main thread only`);
  if (HELD.has(real)) throw new DataDirError(`the data dir ${dir} is already open in this process; one writer per data dir`);
  for (let attempt = 0; attempt < 5; attempt++) {
    // ppid: a supervised child's lock names its supervisor too (evidence only; liveness is the pid's).
    // nonce (G2 follow-up 2): two locks this process writes never share a text, even in the same millisecond or under a
    // frozen wallNow, so releasing one never makes another look like an earlier process's (WRITTEN matches on text).
    // host (G3 note 26 item 4): a pid lock written on another host is judged by the lease alone, never by its pid here.
    const content = JSON.stringify({ pid: process.pid, ppid: process.ppid, host: hostname(), started_at: wallNow().toISOString(), nonce: randomBytes(8).toString("hex") });
    const createdIno = createLock(path, content);
    if (createdIno !== false) {
      HELD.add(real);
      WRITTEN.add(content);
      CREATED.set(real, { ino: createdIno, text: content });
      sweepLockLeftovers(dir, log);
      return;
    }
    let text: string;
    let mtimeMs: number;
    let ino: number;
    try {
      // One descriptor for the text and the inode, so the takeover can prove it removes exactly this file.
      const fd = openSync(path, "r");
      try {
        const st = fstatSync(fd);
        mtimeMs = st.mtimeMs;
        ino = st.ino;
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // removed meanwhile: try to create it again
      throw e;
    }
    let pid = NaN;
    let parsed: { pid?: unknown; host?: unknown; started_at?: unknown } | undefined;
    try {
      parsed = JSON.parse(text);
      pid = Number(parsed!.pid);
    } catch {
      // Empty or torn: see below.
    }
    if (!Number.isSafeInteger(pid) && Date.now() - mtimeMs < LOCK_UNREADABLE_GRACE_MS) {
      throw new DataDirError(`the data dir ${dir} has a lock that is being written (or was torn less than ${LOCK_UNREADABLE_GRACE_MS / 1000} s ago); one server per data dir`);
    }
    // A lock naming this pid is this process's only if this process wrote that text and still holds it (another spelling
    // of a dir it holds); otherwise an earlier process with the same pid wrote it, as on every start in a container where
    // the server is pid 1 (G2 round 3, F4), and it is stale.
    if (pid === process.pid && ownLockText(text)) {
      throw new DataDirError(`the data dir ${dir} is already open in this process (its lock names this process); one writer per data dir`);
    }
    // A pid lock another host wrote (G3 note 26 item 4): its pid means nothing here. This start holds the lease, which
    // fences every other holder, so such a lock is judged by the lease alone and taken over.
    const foreignHost = typeof parsed?.host === "string" && parsed.host !== hostname() ? parsed.host : undefined;
    // fencedPid (0.4.0; G3 note 26 item 4: any takeover by age): a holder whose lease this start took over because it
    // stopped beating; the lease fences it, so its pid, alive here or not, does not hold the pid lock either.
    if (foreignHost === undefined && Number.isSafeInteger(pid) && pid !== process.pid && alive(pid) && pid !== fencedPid) {
      throw new DataDirError(`the data dir ${dir} is locked by process ${pid}; one server per data dir (more than one instance is not supported)`);
    }
    lockHooks.beforeTakeover?.(path);
    const taken = removeStaleLock(path, { text, ino });
    if (taken.result === "left") {
      // G2 follow-up 4: the file was left in place by this start; another start's sweep or takeover may act on it later.
      throw new DataDirError(`the data dir ${dir}: other starts took the lock over at the same moment; this start moved a lock aside and left it as ${taken.aside} (it may be a running server's; another start may since have removed it); one server per data dir`);
    }
    if (taken.result === "restored") continue; // another starter's lock: read it again (its live pid refuses this start)
    log(foreignHost !== undefined
      ? `tiny-tracker: taking over a data-dir lock written on host ${foreignHost} (process ${pid}); this start holds the lease, which decides`
      : pid === fencedPid && alive(pid)
        ? `tiny-tracker: taking over the data-dir lock of process ${pid}, whose lease this start took over (it stopped beating)`
        : `tiny-tracker: taking over a stale data-dir lock (process ${Number.isNaN(pid) ? "unknown" : pid} is gone)`);
  }
  throw new DataDirError(`could not take the data-dir lock in ${dir}`);
}

/**
 * Releases the lock this process created (G2 round 3, F5): the lock file is removed only if it is still that file (the
 * same inode and the same text). A lock another starter put in its place is left alone.
 */
export function releaseLock(dir: string): void {
  const real = heldKey(dir);
  if (!HELD.delete(real)) return;
  const created = CREATED.get(real);
  CREATED.delete(real);
  if (created) WRITTEN.delete(created.text);
  if (!created) return;
  const path = join(dir, LOCK_FILE);
  try {
    const fd = openSync(path, "r");
    let same = false;
    try {
      same = fstatSync(fd).ino === created.ino && readFileSync(fd, "utf8") === created.text;
    } finally {
      closeSync(fd);
    }
    if (same) unlinkSync(path);
  } catch {
    // Gone already.
  }
}


// ---- the data-dir lease (0.4.0, coordinator note 19 item 11) ----
//
// An mkdir lease with a heartbeat, the proper-lockfile pattern, without the dependency. The lease is the directory
// lock.d with an owner file in it. It is created whole: a private temp directory gets the owner file (flushed), then is
// renamed to lock.d, which fails while a lock.d exists (it is never empty), so of several starters exactly one gets it.
// The holder refreshes lock.d's mtime every heartbeatMs. A starter takes a lease over when it is stale:
//   - its mtime is older than staleMs (the holder stopped beating: killed on another host, paused, or hung), or
//   - it names another hostname and its mtime is older than selfFenceMs: a holder anywhere that has not beaten for that
//     long has fenced itself by its own rule (G3 note 26 item 5: `docker run --rm --init` gets a new hostname each run), or
//   - on this host (same hostname), its pid is gone, or it names this pid with a text this process did not write (a
//     container's pid 1 after an unclean stop): the fast paths, so a restart does not wait staleMs. On a shared hostname
//     this takes over any pid this process cannot see, not only pid 1.
// The takeover is a compare-and-rename: lock.d is renamed aside, and removed only if the moved directory is the one
// judged stale (same inode, same owner text, same mtime); otherwise it is renamed back, or left aside and the start
// refuses. The holder checks before every journal append that lock.d is still its own (inode and owner text) and that
// its last heartbeat is younger than selfFenceMs (< staleMs): a holder that was paused past that, or whose lease was
// taken over or moved, is fenced: it appends nothing more (writes answer 503 journal_unavailable) and must be
// restarted. The check and the write are not atomic: a holder paused between them writes one more line after a
// takeover. That line goes after the new holder's (O_APPEND), carries the old epoch and is not applied at replay
// (unless it reached the file before the new holder read it: then the new holder applied it), and the holder's check
// after the flush answers its request 503 lease_lost, outcome unknown (G3 note 26 item 1).
// The pid lock above stays as a second check for this release.

/** Lease timing. Tests shorten it (a child process sets it before it opens the journal). */
export const leaseTiming = { heartbeatMs: 2_000, selfFenceMs: 10_000, staleMs: 20_000 };

/** Test seams of the load (G3 note 26 item 3): once per journal line read or replayed; before each lease refresh. */
export const loadHooks: { onLine?: () => void; beforeRefresh?: () => void } = {};

/** Test seams: after a lease was judged stale and before it is taken over; after it was moved aside. */
export const leaseHooks: { beforeTakeover?: (path: string) => void; afterAside?: (path: string) => void } = {};

/**
 * The file-system calls that move and remove lease directories (a test seam: on Windows a rename or a recursive remove of
 * a directory another process has a handle in fails with EPERM, EBUSY or EACCES; G3 note 26 item 5).
 */
export const leaseFs: { renameSync: typeof renameSync; rmSync: typeof rmSync; platform: string } = { renameSync, rmSync, platform: process.platform };

/** EPERM/EBUSY/EACCES/ENOTEMPTY from moving or removing a lease directory, said plainly (G3 note 26 item 5); other errors pass. */
function leaseFsRefusal(e: unknown, dir: string, what: string): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY") return e;
  return new DataDirError(`the data dir ${dir}: could not ${what} (${code}; on Windows another process may have a file in it open, or a virus scanner may be reading it); nothing was taken: start again, or once no tiny-tracker runs on this data dir remove it by hand`);
}

/** The lease is no longer this holder's: nothing more is appended. */
export class LeaseLostError extends Error {}

/**
 * The lease was found taken over right after a line was written and flushed (G3 note 26 item 1c): the line is in the
 * file, and whether a restart applies it depends on whether the new holder read it before its lease line. The request
 * is answered 503 lease_lost (outcome unknown), never a success.
 */
export class LeaseLostAfterWriteError extends LeaseLostError {
  readonly code = "lease_lost";
}

interface HeldLease {
  path: string;
  ino: number;
  text: string;
  /** performance.now() of the last heartbeat that found the lease this holder's own. */
  lastBeat: number;
  timer: ReturnType<typeof setInterval>;
  lost?: string;
}

/** Leases this process holds, by the data dir's real path, and the owner texts it wrote and holds. */
const LEASES = new Map<string, HeldLease>();
const LEASE_TEXTS = new Set<string>();

function readOwner(dirPath: string): string | undefined {
  try {
    return readFileSync(join(dirPath, LEASE_OWNER), "utf8");
  } catch {
    return undefined;
  }
}

/** Whether lock.d is still this holder's lease: the same directory (inode) with the same owner text. */
function leaseIsOwnOnce(held: HeldLease): boolean | "missing" {
  try {
    return statSync(held.path).ino === held.ino && readOwner(held.path) === held.text;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : false;
  }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Whether the lease is still this holder's. A missing lock.d is looked at again for up to 50 ms: a starter that judged
 * a lease stale moves it aside and, when it finds it is not the one it judged (this live one), puts it back at once.
 */
function leaseIsOwn(held: HeldLease): boolean {
  for (let i = 0; i < 10; i++) {
    const own = leaseIsOwnOnce(held);
    if (own !== "missing") return own;
    pause(5);
  }
  return false;
}

/** Creates the lease whole (temp directory with the owner file, renamed into place). Returns its inode, or false when one exists. */
function createLease(path: string, text: string): number | false {
  const tmp = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const fd = openSync(join(tmp, LEASE_OWNER), "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const ino = statSync(tmp).ino;
    try {
      leaseFs.renameSync(tmp, path);
    } catch (e) {
      // A lease is there (ENOTEMPTY or EEXIST on POSIX, EPERM or EACCES on Windows): not ours. On POSIX the code alone
      // says so: another start may have moved that lease aside since the rename failed, so it may be gone by now, and
      // the caller looks again (integration pass: racing starts over a killed holder's lease read ENOTEMPTY as a
      // Windows refusal). On Windows the code is ambiguous, so the lease must still be there.
      const code = (e as NodeJS.ErrnoException)?.code;
      // Gated on the platform (fresh-eyes review 24 Nov, should-fix 8): on Windows ENOTEMPTY can be a file held open.
      if ((leaseFs.platform !== "win32" && (code === "ENOTEMPTY" || code === "EEXIST")) || existsSync(path)) return false;
      throw leaseFsRefusal(e, join(path, ".."), `rename its new lease ${tmp} into place`);
    }
    return ino;
  } finally {
    try {
      leaseFs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // A temp folder that cannot be removed now (Windows): the leftover sweep removes it later.
    }
  }
}

/** Removes a moved-aside lease only when it is proven to be the one judged stale; else puts it back or leaves it. */
function removeStaleLease(dir: string, path: string, seen: { ino: number; text: string | undefined; mtimeMs: number }): { result: "removed" | "restored" | "left"; aside: string } {
  const aside = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  // Looked at again right before the move: a lease that is no longer the one judged stale (another start took it over
  // meanwhile) is not moved at all; the caller reads it again.
  try {
    const now = statSync(path);
    if (now.ino !== seen.ino || now.mtimeMs !== seen.mtimeMs || readOwner(path) !== seen.text) return { result: "restored", aside };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { result: "removed", aside };
    throw e;
  }
  try {
    leaseFs.renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { result: "removed", aside };
    throw leaseFsRefusal(e, dir, `move the stale lease ${path} aside`);
  }
  leaseHooks.afterAside?.(path);
  let proven = false;
  try {
    const st = statSync(aside);
    proven = st.ino === seen.ino && st.mtimeMs === seen.mtimeMs && readOwner(aside) === seen.text;
  } catch {
    // unreadable: not proven stale
  }
  if (proven) {
    try {
      leaseFs.rmSync(aside, { recursive: true, force: true });
    } catch (e) {
      throw leaseFsRefusal(e, dir, `remove the stale lease, moved aside as ${aside}`);
    }
    return { result: "removed", aside };
  }
  try {
    // Only into a free name: a lease created meanwhile is never empty, so the rename fails over it.
    if (existsSync(path)) return { result: "left", aside };
    leaseFs.renameSync(aside, path);
    return { result: "restored", aside };
  } catch {
    return { result: "left", aside };
  }
}

/** Removes leftover lease directories (a crashed start's temp, a lease moved aside) older than staleMs. */
export function sweepLeaseLeftovers(dir: string, log: (m: string) => void): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const kind = [".new-", ".stale-", ".released-"].find((k) => name.startsWith(`${LEASE_DIR}${k}`));
    if (!kind) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || Date.now() - st.mtimeMs < leaseTiming.staleMs) continue;
      // A temp directory names its writer: while that process runs it may still be creating its lease.
      const writer = kind === ".new-" ? Number(name.slice(`${LEASE_DIR}.new-`.length).split("-")[0]) : NaN;
      if (Number.isSafeInteger(writer) && writer !== process.pid && alive(writer)) continue;
      leaseFs.rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone meanwhile: leave it.
    }
  }
  if (removed) log(`tiny-tracker: removed ${removed} leftover lease folder(s)`);
  return removed;
}

/**
 * Takes the data-dir lease or throws DataDirError. Returns the pid of a holder on this host whose lease was taken over
 * because it stopped beating while its process still runs (a paused or hung holder): that holder is fenced by the
 * lease, so the pid lock may take over its lock too.
 */
export function acquireLease(dir: string, log: (m: string) => void): { fencedPid?: number } {
  const path = join(dir, LEASE_DIR);
  const real = heldKey(dir);
  if (!isMainThread) throw new DataDirError(`the data dir ${dir}: the durable journal opens on the main thread only`);
  if (LEASES.has(real)) throw new DataDirError(`the data dir ${dir} is already open in this process; one writer per data dir`);
  const host = hostname();
  let fencedPid: number | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const text = JSON.stringify({ pid: process.pid, host, nonce: randomBytes(8).toString("hex") });
    const ino = createLease(path, text);
    if (ino !== false) {
      const held: HeldLease = { path, ino, text, lastBeat: performance.now(), timer: setInterval(() => beat(held), leaseTiming.heartbeatMs) };
      held.timer.unref?.();
      LEASES.set(real, held);
      LEASE_TEXTS.add(text);
      sweepLeaseLeftovers(dir, log);
      return fencedPid !== undefined ? { fencedPid } : {};
    }
    let st;
    try {
      st = statSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const seenText = readOwner(path);
    let owner: { pid?: unknown; host?: unknown } = {};
    try {
      owner = JSON.parse(seenText ?? "");
    } catch {
      // no owner file or a torn one: judged by its age below
    }
    const pid = Number(owner.pid);
    const sameHost = owner.host === host && Number.isSafeInteger(pid);
    const otherHost = typeof owner.host === "string" && owner.host !== host;
    const age = Date.now() - st.mtimeMs;
    let why: string | undefined;
    if (sameHost && pid === process.pid) {
      if (seenText !== undefined && LEASE_TEXTS.has(seenText)) throw new DataDirError(`the data dir ${dir} is already open in this process (its lease names this process); one writer per data dir`);
      why = `it names this process id but an earlier process wrote it`;
    } else if (sameHost && !alive(pid)) {
      why = `process ${pid} is gone`;
    } else if (age > leaseTiming.staleMs) {
      why = `its heartbeat stopped ${Math.round(age / 1000)} s ago`;
    } else if (otherHost && age > leaseTiming.selfFenceMs) {
      // G3 note 26 item 5: another hostname (a container run with --rm gets a new one each time) whose heartbeat is
      // older than the self-fence time: that holder, wherever it runs, has stopped appending by its own rule.
      why = `it names host ${String(owner.host)}, whose heartbeat stopped ${Math.round(age / 1000)} s ago (past the ${leaseTiming.selfFenceMs / 1000} s self-fence time)`;
    }
    // G3 note 26 item 4: any takeover by age fences the old holder, so its pid lock goes with the lease, whatever host
    // it ran on (the pid may name an unrelated live process here).
    if (why !== undefined && !(sameHost && (pid === process.pid || !alive(pid))) && Number.isSafeInteger(pid)) fencedPid = pid;
    if (why === undefined) {
      throw new DataDirError(`the data dir ${dir} is locked by ${Number.isSafeInteger(pid) ? `process ${pid}` : "another start"}${owner.host !== undefined && owner.host !== host ? ` on host ${String(owner.host)}` : ""} (its lease heartbeat is ${Math.round(age / 1000)} s old); one server per data dir (more than one instance is not supported)`);
    }
    leaseHooks.beforeTakeover?.(path);
    const taken = removeStaleLease(dir, path, { ino: st.ino, text: seenText, mtimeMs: st.mtimeMs });
    if (taken.result === "left") {
      throw new DataDirError(`the data dir ${dir}: other starts took the lease over at the same moment; this start moved a lease aside and left it as ${taken.aside} (another start may since have removed it); one server per data dir`);
    }
    if (taken.result === "restored") {
      fencedPid = undefined;
      continue;
    }
    log(`tiny-tracker: taking over a stale data-dir lease (${why})`);
  }
  throw new DataDirError(`could not take the data-dir lease in ${dir}`);
}

/** The heartbeat: refreshes the lease's mtime while it is this holder's; a late or lost lease fences the holder. */
function beat(held: HeldLease): void {
  if (held.lost) return;
  const late = performance.now() - held.lastBeat;
  if (late > leaseTiming.selfFenceMs) {
    held.lost = `no heartbeat for ${Math.round(late)} ms (the process was paused or blocked longer than ${leaseTiming.selfFenceMs} ms); another start may have taken the lease over`;
    return;
  }
  if (!leaseIsOwn(held)) {
    held.lost = "the lease was taken over or moved by another start";
    return;
  }
  try {
    const now = new Date();
    utimesSync(held.path, now, now);
    held.lastBeat = performance.now();
  } catch {
    // Not refreshed: the next beat tries again; the self-fence time bounds how long that can go on.
  }
}

/**
 * The fence (before every journal append): throws LeaseLostError unless the lease is this holder's and its heartbeat
 * is recent. A lost lease stays lost.
 */
export function checkLease(dir: string): void {
  const held = LEASES.get(heldKey(dir));
  if (!held) throw new LeaseLostError(`the data dir ${dir}: this process holds no lease on it`);
  if (!held.lost) {
    const late = performance.now() - held.lastBeat;
    if (late > leaseTiming.selfFenceMs) held.lost = `no heartbeat for ${Math.round(late)} ms (the process was paused or blocked longer than ${leaseTiming.selfFenceMs} ms); another start may have taken the lease over`;
    else if (!leaseIsOwn(held)) held.lost = "the lease was taken over or moved by another start";
  }
  if (held.lost) throw new LeaseLostError(`the data-dir lease is lost (${held.lost}); this server appends nothing more to the journal: restart it`);
}

/**
 * Ownership again, after a line was written and flushed (G3 note 26 item 1c): lock.d is still this holder's (inode and
 * owner text, which holds the nonce). A lease found taken over is lost for good. Lateness is not checked here: the line
 * is already in the file, and only a takeover can supersede it.
 */
export function confirmLease(dir: string): boolean {
  const held = LEASES.get(heldKey(dir));
  if (!held) return false;
  if (!held.lost && !leaseIsOwn(held)) held.lost = "the lease was taken over or moved by another start";
  return !held.lost;
}

/**
 * Checks the lease is still this holder's and beats it now (G3 note 26 item 3): called through a long synchronous load,
 * where the heartbeat timer cannot run, and after the replay before anything is appended. Ownership decides, not the
 * time since the last beat: a lease still in place with this holder's text was not taken over. Throws LeaseLostError.
 */
export function refreshLease(dir: string): void {
  const held = LEASES.get(heldKey(dir));
  if (!held) throw new LeaseLostError(`the data dir ${dir}: this process holds no lease on it`);
  if (!held.lost && !leaseIsOwn(held)) held.lost = "the lease was taken over or moved by another start while this start was loading";
  if (held.lost) throw new LeaseLostError(`the data-dir lease is lost (${held.lost}); this server appends nothing more to the journal: restart it`);
  const now = new Date();
  utimesSync(held.path, now, now);
  held.lastBeat = performance.now();
}

/** The owner this process wrote into the lease it holds on a data dir (pid, host, nonce), for the journal's lease line. */
export function heldLeaseOwner(dir: string): { pid: number; host: string; nonce: string } {
  const held = LEASES.get(heldKey(dir));
  if (!held) throw new LeaseLostError(`the data dir ${dir}: this process holds no lease on it`);
  const o = JSON.parse(held.text) as { pid: number; host: string; nonce: string };
  return { pid: o.pid, host: o.host, nonce: o.nonce };
}

/** Releases the lease this process holds: moved aside and removed only if it is still its own; a lease another start put in its place is left alone. */
export function releaseLease(dir: string): void {
  const real = heldKey(dir);
  const held = LEASES.get(real);
  if (!held) return;
  clearInterval(held.timer);
  LEASES.delete(real);
  LEASE_TEXTS.delete(held.text);
  if (!leaseIsOwn(held)) return;
  const aside = `${held.path}.released-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    leaseFs.renameSync(held.path, aside);
  } catch {
    return;
  }
  let mine = false;
  try {
    mine = statSync(aside).ino === held.ino && readOwner(aside) === held.text;
  } catch {
    // unreadable: put back below
  }
  if (mine) {
    try {
      leaseFs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // Released (moved off lock.d) but not removed (Windows): the leftover sweep removes the folder later.
    }
    return;
  }
  try {
    if (!existsSync(held.path)) leaseFs.renameSync(aside, held.path);
  } catch {
    // Left aside: its holder is fenced by its own check; the sweep removes the folder later.
  }
}

/** Tests only: as a killed process, the lease stays on disk and this process no longer holds it. */
export function abandonLease(dir: string): void {
  const real = heldKey(dir);
  const held = LEASES.get(real);
  if (!held) return;
  clearInterval(held.timer);
  LEASES.delete(real);
  LEASE_TEXTS.delete(held.text);
}

/** A line a superseded writer appended (G3 note 26 item 1b): in the file, not applied. */
export interface SupersededLine {
  jseq: number;
  line: string;
  epoch: number;
  /** The epoch of the lease line that superseded it. */
  by_epoch: number;
}

export interface LoadReport {
  /** Lines after the header that were kept (this start's lease line included; superseded lines not). */
  lines: number;
  /** The last commit sequence replayed. */
  commits: number;
  /** This start found a torn last line (left out; it stays in the file, joined by this start's lease line). */
  droppedTornLine: boolean;
  /** Torn fragments in the file that later writes joined (left out at every start; G3a). */
  fragments: number;
  abortedOrphans: number;
  /** Fences restored (fence and lookup-fence lines). */
  fences: number;
  /** Runs restored from run-alloc lines. */
  runs: number;
  /** The fixture clock offset the last clock line set (0: no clock line). */
  clockOffsetMs: number;
  /**
   * Pending lines a later run-reset commit line had fenced, with no fence line after it (a crash between the reset's
   * commit line and its fence line): fenced at start, and their fence lines written then (G2 fold-in 5).
   */
  fencedAtStart: number;
  /** This start's lease epoch (its lease line's). */
  epoch: number;
  /** Lines of superseded writers (G3 note 26 item 1b): in the file, not applied, logged at start. */
  superseded: SupersededLine[];
}

/** A line's writer epoch: its `epoch` member, 0 when absent (a journal written before 0.4.0) or for the header. */
export function epochOf(line: JournalLine): number {
  if (line.line === "header") return 0;
  return (line as { epoch?: number }).epoch ?? 0;
}

/** The line kinds journal-format/1 knows (INTERFACES 1.9). A line of any other kind is refused, never skipped. */
export const JOURNAL_LINE_KINDS = ["header", "pending", "commit", "aborted", "fence", "run-alloc", "lookup-fence", "clock", "lease"] as const;

/** What is wrong with a line's own members, wherever it is (undefined: nothing). Superseded lines are checked by this too. */
function shapeProblem(line: JournalLine): string | undefined {
  if (!(JOURNAL_LINE_KINDS as readonly string[]).includes(line.line)) return `unknown line kind ${JSON.stringify((line as { line: unknown }).line)}`;
  const epoch = (line as { epoch?: unknown }).epoch;
  if (epoch !== undefined && (!Number.isSafeInteger(epoch) || (epoch as number) < 0)) return "an epoch that is not a non-negative integer";
  if (line.line === "lease" && (!Number.isSafeInteger(line.epoch) || line.epoch < 1 || !Number.isSafeInteger(line.pid) || typeof line.host !== "string" || typeof line.nonce !== "string")) {
    return "a lease line without a positive epoch, pid, host or nonce";
  }
  return undefined;
}

/** What is wrong with an applied line at position `expected` (undefined: nothing). */
function lineProblem(line: JournalLine, expected: number, lastCommit: number, pendings: Set<number>): string | undefined {
  if (line.jseq !== expected) return `jseq ${line.jseq} where ${expected} was expected`;
  if (line.line === "header") return "a second header";
  const shape = shapeProblem(line);
  if (shape !== undefined) return shape;
  if (line.line === "commit") {
    if (line.commit_seq !== lastCommit + 1 || line.tx?.seq !== line.commit_seq) return `commit_seq ${line.commit_seq} where ${lastCommit + 1} was expected`;
    if (line.pending_jseq !== null && !pendings.has(line.pending_jseq)) return `pending_jseq ${line.pending_jseq} names no open pending line`;
  } else if (line.line === "aborted") {
    if (!pendings.has(line.pending_jseq)) return `pending_jseq ${line.pending_jseq} names no open pending line`;
  } else if (line.line === "fence") {
    if (!pendings.has(line.pending_jseq)) return `pending_jseq ${line.pending_jseq} names no open pending line`;
    if (!Number.isSafeInteger(line.reset_seq) || line.reset_seq < 1 || line.reset_seq > lastCommit) return `reset_seq ${line.reset_seq} names no earlier commit`;
  } else if (line.line === "run-alloc") {
    if (typeof line.run_id !== "string" || typeof line.principal !== "string") return "a run-alloc line without run_id or principal";
  } else if (line.line === "lookup-fence") {
    if (typeof line.key !== "string" || typeof line.principal !== "string") return "a lookup-fence line without principal or key";
  } else if (line.line === "clock") {
    if (!Number.isSafeInteger(line.from_ms) || !Number.isSafeInteger(line.to_ms) || line.from_ms < 0 || line.to_ms <= line.from_ms || typeof line.at !== "string") {
      return "a clock line whose offsets are not integers moving forward";
    }
  }
  return undefined;
}

/** How every line the journal writes begins (encodeLine puts jseq first): where a joined line can start. */
const LINE_START = '{"jseq":';

/**
 * One physical line of the file, split into what it holds (G3a): one whole line; or a torn fragment (bytes of a write
 * that was cut short, which the next write joined because nothing is ever cut from the file) followed by the whole
 * line(s) that joined it; or bytes that hold no whole line. A whole line is found by its checksum, so a fragment cannot
 * pass for one: the longest suffix that starts where a line starts and decodes is the joined line.
 */
export function splitJoined(text: string): Array<{ line: JournalLine } | { junk: string }> {
  const whole = decodeLine(text);
  if (whole !== undefined) return [{ line: whole }];
  for (let i = text.indexOf(LINE_START, 1); i > 0; i = text.indexOf(LINE_START, i + 1)) {
    const tail = decodeLine(text.slice(i));
    if (tail !== undefined) return [...splitJoined(text.slice(0, i)), { line: tail }];
  }
  return [{ junk: text }];
}

/** A journal file read and checked: the lines a replay applies, and what it leaves out. */
export interface JournalScan {
  /** The header, then every line a replay applies, jseq contiguous from 0. */
  lines: JournalLine[];
  /** Lines of superseded writers, in file order (G3 note 26 item 1b). */
  superseded: SupersededLine[];
  /** The highest epoch any line in the file names (lease lines and members, superseded ones included). */
  maxEpoch: number;
  /** The file ends in a torn fragment (an unterminated last line that holds no whole line): left out. */
  tornLast: boolean;
  /** Torn fragments a later write joined (left out; G3a): bytes of writes that were cut short, never cut from the file. */
  fragments: number;
  /** The last commit_seq applied. */
  lastCommit: number;
  /** Pending lines still open after the last line, by jseq. */
  open: Map<number, JournalPendingLine>;
  /** Open pending lines a run-reset commit line fenced: pending jseq -> the reset's commit_seq. */
  resetFenced: Map<number, number>;
}

/**
 * Reads and checks a journal file's text (G3 note 26 item 1b; G3a). "new": the file is empty, or holds only a header
 * that was torn at the very first start (an unterminated fragment and nothing else: "torn-header").
 *
 * Fragments: nothing is ever cut from the file (a cut could race with a takeover), so a write that was cut short stays,
 * and the next write joins it on the same physical line. Such a fragment, followed by a whole line on its line, is left
 * out; a physical line that holds no whole line is refused, except the unterminated last line (a torn write, as before).
 * jseq stays contiguous over the applied lines, so a fragment can never hide an applied line.
 *
 * Pass 1 decides which lines apply: a line whose epoch is lower than a lease line before it is superseded; a lease line
 * also supersedes the lines before it with a jseq of its own or higher (appended after its writer read the file, by the
 * previous holder: their writers were answered 503 lease_lost), which must be of a lower epoch; a lease line whose epoch
 * is not above the current one is a start that lost the race (it refused to start); a header after a lease line is a
 * start that found the file empty and lost the race. Every line after a lease line carries an epoch. Superseded lines
 * must still be of a known kind. Pass 2 checks the applied lines as one journal: jseq contiguous, commit_seq contiguous,
 * every pending_jseq naming an open pending line. Anything else throws JournalCorruptError. `tick` is called once per
 * line (the lease refresh of a long load).
 */
export function scanJournal(path: string, raw: string, tick?: () => void): JournalScan | "new" | "torn-header" {
  if (raw.length === 0) return "new";
  const parts = raw.split("\n");
  const terminated = parts[parts.length - 1] === "";
  if (terminated) parts.pop();
  const lines: JournalLine[] = [];
  let tornLast = false;
  let fragments = 0;
  for (let i = 0; i < parts.length; i++) {
    tick?.();
    const pieces = splitJoined(parts[i]);
    if (pieces.length === 1 && "junk" in pieces[0]) {
      if (i === parts.length - 1 && !terminated) {
        tornLast = true;
        break;
      }
      throw new JournalCorruptError(`${path}: line ${i + 1} of the file is not valid (a bad checksum or a torn write, with no whole line after it); only a torn last line (unterminated, not decodable) is tolerated. Not starting.`);
    }
    for (const p of pieces) {
      if ("junk" in p) fragments++;
      else lines.push(p.line);
    }
  }
  const header = lines[0];
  if (header === undefined) {
    // A header torn at the very first start (nothing after it) is the only header problem that is not corruption (G2
    // round 2, item 5). A first line that decodes but is not a header is refused, never wiped.
    return "torn-header";
  }
  if (header.line !== "header" || header.jseq !== 0) {
    throw new JournalCorruptError(`${path}: the first line is not a valid journal header. Not starting.`);
  }
  if (header.journal !== JOURNAL_FORMAT) throw new JournalCorruptError(`${path}: journal format ${JSON.stringify(header.journal)}; this version reads ${JOURNAL_FORMAT}. Not starting.`);
  const accepted: JournalLine[] = [header];
  const superseded: SupersededLine[] = [];
  let epoch = 0;
  let maxEpoch = 0;
  const supersede = (l: JournalLine, by: number) => superseded.push({ jseq: l.jseq, line: l.line, epoch: epochOf(l), by_epoch: by });
  for (const l of lines.slice(1)) {
    const shape = l.line === "header" ? undefined : shapeProblem(l);
    if (shape !== undefined) throw new JournalCorruptError(`${path}: line jseq ${l.jseq} is not valid (${shape}). Not starting.`);
    const e = l.line === "lease" ? l.epoch : epochOf(l);
    maxEpoch = Math.max(maxEpoch, e);
    if (l.line === "header") {
      // A start that found the file empty writes its header and lease line in one write; one that lost the race (its
      // lease was taken over before it wrote) lands after the winner's lines, and refused to start.
      if (epoch === 0) throw new JournalCorruptError(`${path}: line jseq ${l.jseq} is not valid (a second header). Not starting.`);
      supersede(l, epoch);
      continue;
    }
    if (l.line === "lease") {
      if (l.epoch <= epoch) {
        // A start whose lease was taken over between its check and its lease line (it refused to start).
        supersede(l, epoch);
        continue;
      }
      while (accepted.length > 1 && accepted[accepted.length - 1].jseq >= l.jseq) {
        const p = accepted.pop()!;
        if (epochOf(p) >= l.epoch) throw new JournalCorruptError(`${path}: the lease line of epoch ${l.epoch} (jseq ${l.jseq}) follows a line of epoch ${epochOf(p)} with jseq ${p.jseq}. Not starting.`);
        supersede(p, l.epoch);
      }
      epoch = l.epoch;
      accepted.push(l);
      continue;
    }
    if (epoch > 0 && (l as { epoch?: unknown }).epoch === undefined) throw new JournalCorruptError(`${path}: line jseq ${l.jseq} (${l.line}) has no epoch, after a lease line. Not starting.`);
    if (epochOf(l) < epoch) {
      supersede(l, epoch);
      continue;
    }
    if (epochOf(l) > epoch) throw new JournalCorruptError(`${path}: line jseq ${l.jseq} has epoch ${epochOf(l)}, and no lease line before it took that epoch. Not starting.`);
    accepted.push(l);
  }
  const open = new Map<number, JournalPendingLine>();
  const resetFenced = new Map<number, number>();
  let lastCommit = 0;
  for (let k = 1; k < accepted.length; k++) {
    const l = accepted[k];
    const bad = lineProblem(l, k, lastCommit, new Set(open.keys()));
    if (bad !== undefined) throw new JournalCorruptError(`${path}: line jseq ${k} is not valid (${bad}); only a torn last line (unterminated, not decodable) is tolerated. Not starting.`);
    if (l.line === "pending") open.set(l.jseq, l);
    if (l.line === "aborted" || l.line === "fence") open.delete(l.pending_jseq);
    if (l.line === "commit") {
      lastCommit = l.commit_seq;
      if (l.pending_jseq !== null) open.delete(l.pending_jseq);
      // Seams v2.1: a run reset fences its run's pending records. Its fence lines follow its commit line; if the
      // process died between them, the pending line is fenced at start, never ended as an orphan.
      const reset = l.tx.kind === "run-reset" ? l.tx.reset : undefined;
      if (reset) for (const p of open.values()) if (p.principal === reset.principal && p.run === reset.run && !resetFenced.has(p.jseq)) resetFenced.set(p.jseq, l.commit_seq);
    }
  }
  for (const k of [...resetFenced.keys()]) if (!open.has(k)) resetFenced.delete(k);
  return { lines: accepted, superseded, maxEpoch, tornLast, fragments, lastCommit, open, resetFenced };
}

export class Journal implements JournalSeam, KeyLineWriter {
  readonly name = "journal";
  readonly role = "journal" as const;
  private fd: number | undefined;
  private jseq = 0;
  private lastChecksum: string | null = null;
  /** This writer's lease epoch: its lease line's, carried by every line it appends (G3 note 26 item 1b). */
  private epoch = 0;
  private dead = false;
  /**
   * Set when an append failed once its write had begun (G3 note 26 item 1a): part or all of the line may be in the file,
   * and the file is never cut back after a write that may have raced, so nothing more is appended (restart it).
   */
  private broken: Error | undefined;
  readonly path: string;
  report: LoadReport | undefined;
  /** False only under the key-record-not-durable defect: a replayed commit line rebuilds no key record. */
  keyFromCommitLine = true;
  /** The fixture layer's run registry, set before load: run-alloc lines go back into it. */
  runs: RunRestorer | undefined;
  /**
   * The fixture clock, set before load: clock lines go back into it. A journal with clock lines refuses to load
   * without one (a build without the clock feature would run on wall time, and record time would move back).
   */
  clock: ClockRestorer | undefined;
  /**
   * Told each replayed commit after its post-state is applied (no clock, no ledger): the execution records, so
   * /executions/:id and /operations/:key answer for commits made before a restart.
   */
  replayObservers: Array<(tx: CommittedTransaction) => void> = [];
  /** The commit_seq of the last commit line (a fence line names its reset by it). */
  private lastCommitSeq = 0;
  /** performance.now() of the last lease refresh during load (G3 note 26 item 3). */
  private lastRefresh = 0;

  constructor(readonly store: Store, readonly keys: DurableKeyRecords | undefined, readonly options: JournalOptions) {
    this.path = join(options.dataDir, JOURNAL_FILE);
  }

  private log(m: string) {
    (this.options.log ?? ((x: string) => process.stderr.write(`${x}\n`)))(m);
  }

  /** "<jseq>:<checksum prefix>" of the last line, for the build descriptor's journal head. */
  head(): string | null {
    return this.lastChecksum === null ? null : `${this.jseq}:${this.lastChecksum.slice(0, 16)}`;
  }

  /** Opens the data dir, takes the lock, and replays the journal into the store and the key records. */
  load(): void {
    prepareDataDir(this.options.dataDir, this.options.platform);
    // 0.4.0: the lease first; the pid lock stays as a second check for this release.
    const { fencedPid } = acquireLease(this.options.dataDir, (m) => this.log(m));
    try {
      acquireLock(this.options.dataDir, this.options.wallNow ?? (() => new Date()), (m) => this.log(m), fencedPid);
    } catch (e) {
      releaseLease(this.options.dataDir);
      throw e;
    }
    const limit = flushLimit(this.options.platform ?? process.platform);
    if (limit) this.log(limit);
    try {
      this.lastRefresh = performance.now();
      this.replay();
    } catch (e) {
      if (this.fd !== undefined) closeSync(this.fd);
      this.fd = undefined;
      releaseLock(this.options.dataDir);
      releaseLease(this.options.dataDir);
      if (e instanceof LeaseLostError) throw new DataDirError(`the data dir ${this.options.dataDir}: ${e.message.replace(/; this server appends nothing more to the journal: restart it$/, "")}; this start stops (start again)`);
      throw e;
    }
  }

  /**
   * The lease refresh of a long load (G3 note 26 item 3): the heartbeat timer cannot run while the load runs, so the
   * load beats the lease itself, at the heartbeat interval, after checking it is still this holder's.
   */
  private keepLease(force = false): void {
    if (!force && performance.now() - this.lastRefresh < leaseTiming.heartbeatMs) return;
    loadHooks.beforeRefresh?.();
    refreshLease(this.options.dataDir);
    this.lastRefresh = performance.now();
  }

  /** Reads the journal file and checks it (scanJournal); "new" when it is missing or empty. */
  private read(): JournalScan | "new" | "torn-header" {
    if (!existsSync(this.path)) return "new";
    return scanJournal(this.path, readFileSync(this.path, "utf8"), () => {
      loadHooks.onLine?.();
      this.keepLease();
    });
  }

  private refuseClockLines(scan: JournalScan): void {
    const lastClock = scan.lines.findLast((l): l is JournalClockLine => l.line === "clock");
    if (lastClock && !this.clock) {
      throw new JournalCorruptError(`${this.path}: the journal moved the fixture clock to an offset of ${lastClock.to_ms} ms (clock lines); start this data dir with the clock feature, or record time would move back. Not starting.`);
    }
  }

  /**
   * Writes this start's lease line (G3 note 26 item 1b): epoch one more than the highest in the file, jseq after the
   * last line this start read. `header`: a new journal's header, written in the same write (so a start that loses the
   * race leaves a header and a lease line together, which a reader skips as superseded).
   */
  private writeLeaseLine(maxEpoch: number, header?: string): JournalLeaseLine {
    const owner = heldLeaseOwner(this.options.dataDir);
    this.epoch = maxEpoch + 1;
    const body = { jseq: this.jseq + 1, line: "lease", epoch: this.epoch, pid: owner.pid, host: owner.host, nonce: owner.nonce } as Omit<JournalLeaseLine, "checksum">;
    checkLease(this.options.dataDir);
    const text = this.writeLine(body, undefined, header === undefined ? "" : `${header}\n`);
    return JSON.parse(text) as JournalLeaseLine;
  }

  /**
   * The load (G3 note 26 item 1; G3a). Nothing is ever cut from the file once the lease is taken: a start paused between
   * a check and a cut could otherwise cut a newer holder's lines. A torn last line stays where it is, and this start's
   * lease line joins it on its physical line (scanJournal leaves the fragment out); a new journal's header goes in the
   * same write as its lease line.
   */
  private replay(): void {
    const report: LoadReport = { lines: 0, commits: 0, droppedTornLine: false, fragments: 0, abortedOrphans: 0, fences: 0, runs: 0, clockOffsetMs: 0, fencedAtStart: 0, epoch: 0, superseded: [] };
    this.report = report;
    const first = this.read();
    // O_APPEND, written with no position (G3 note 26 item 1a): a line always goes after every line already in the file.
    this.fd = openSync(this.path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
    this.keepLease(true);
    let lease: JournalLeaseLine;
    if (first === "new" || first === "torn-header") {
      // A journal file that is missing, or empty because the first start stopped before its header was written, is new;
      // so is one whose header was torn at the very first start (its bytes stay; the new header joins them).
      if (first === "torn-header") this.log("tiny-tracker: the journal header was torn at the first start; starting a new journal after the torn bytes");
      const header: Omit<JournalHeader, "checksum"> = { jseq: 0, line: "header", journal: JOURNAL_FORMAT, writer: this.options.writer, boot_id: this.store.bootId, seed: structuredClone(this.store.seed) };
      this.jseq = 0;
      lease = this.writeLeaseLine(0, encodeLine(header));
    } else {
      this.refuseClockLines(first);
      this.jseq = first.lines.length - 1;
      // The lease line goes in before the replay (G3 note 26 item 1b): from here on every other writer's line is superseded.
      lease = this.writeLeaseLine(first.maxEpoch);
    }
    // Read again: the lines this start applies are the file's up to its own lease line. Lines a superseded holder
    // appended after this start read it, before or after its lease line, are left out by the epoch rules.
    const second = this.read();
    if (second === "new" || second === "torn-header") throw new JournalCorruptError(`${this.path}: the journal changed under this start (it reads as ${second}). Not starting.`);
    const own = second.lines[second.lines.length - 1];
    if (own.line !== "lease" || own.nonce !== lease.nonce || own.epoch !== lease.epoch) {
      throw new DataDirError(`the data dir ${this.options.dataDir}: another start wrote to the journal at the same moment (this start's lease line, epoch ${lease.epoch}, is not the journal's last applied line); this start stops (start again)`);
    }
    this.refuseClockLines(second);
    report.droppedTornLine = first !== "new" && first !== "torn-header" && first.tornLast;
    report.fragments = second.fragments;
    if (report.droppedTornLine) this.log(`tiny-tracker: left out a torn last journal line (after jseq ${(first as JournalScan).lines.length - 1}: a bad checksum or a torn write); it stays in the file, joined by this start's lease line`);
    report.superseded = second.superseded;
    for (const s of second.superseded) {
      this.log(`tiny-tracker: a superseded writer's journal line was not applied (${s.line} line jseq ${s.jseq}, epoch ${s.epoch}; lease epoch ${s.by_epoch} came before it): a holder paused past a takeover wrote it, and its request was answered 503`);
    }
    const lines = second.lines;
    if (first !== "new" && first !== "torn-header") {
      this.store.applySeed((lines[0] as JournalHeader).seed);
      for (const l of lines.slice(1)) {
        loadHooks.onLine?.();
        this.keepLease();
        this.apply(l, report);
      }
    }
    this.lastCommitSeq = second.lastCommit;
    this.jseq = own.jseq;
    this.lastChecksum = own.checksum;
    report.lines = lines.length - 1;
    report.commits = second.lastCommit;
    report.epoch = this.epoch;
    // G3 note 26 item 3: a replay longer than the stale time must not leave the holder self-fenced: check ownership and
    // beat now, before the first append below.
    this.keepLease(true);
    // Orphan pending lines: a write that began and never committed. Nothing was applied; say so before serving.
    // A pending line whose run a later commit line reset was fenced by that reset (G2 fold-in 5): it gets the fence
    // line it lost and stays fenced, so a late original can never land under its key.
    for (const p of second.open.values()) {
      const resetSeq = second.resetFenced.get(p.jseq);
      if (resetSeq !== undefined && p.run !== null) {
        this.fenceLine({ principal: p.principal }, p.key, p.run, p.jseq, resetSeq);
        this.keys?.restoreFence({ principal: p.principal }, p.key, p.run, this.commitTimes.get(resetSeq) ?? "");
        report.fences++;
        report.fencedAtStart++;
        continue;
      }
      this.aborted(p.jseq, "orphan_at_start");
      this.keys?.restore({ principal: p.principal }, p.key, undefined);
      report.abortedOrphans++;
    }
    if (report.fencedAtStart) this.log(`tiny-tracker: ${report.fencedAtStart} pending key record(s) of a reset run had no fence line; fenced at start`);
    if (report.abortedOrphans) this.log(`tiny-tracker: ${report.abortedOrphans} pending key record(s) with no commit became aborted`);
  }

  /** Applies one line at start: post-state and key states only, no clock, no event, no sink. */
  private readonly commitTimes = new Map<number, string>();

  private apply(line: JournalLine, report: LoadReport): void {
    const keys = this.keys;
    switch (line.line) {
      case "commit": {
        const tx = line.tx;
        this.store.applyPostState(tx);
        this.commitTimes.set(tx.seq, tx.committedAt);
        for (const o of this.replayObservers) o(tx);
        if (!keys) break;
        const scope: KeyScope = { principal: tx.principal };
        if (tx.kind === "run-reset" && tx.reset) {
          // Replay writes nothing and fences nothing: a pending record the reset fenced has its own fence line next.
          keys.replaying = true;
          try {
            keys.dropRun({ principal: tx.reset.principal }, tx.reset.run);
          } finally {
            keys.replaying = false;
          }
        }
        else if (tx.kind === "write" && tx.request !== null && tx.request.key !== null && tx.request.fingerprint) {
          // The key record goes with the effect, in the same line (FX-DUR-2); a pending record it completes ends here.
          if (this.keyFromCommitLine) keys.restore(scope, tx.request.key, { state: "completed", reply: { ...storedReplyOf(tx), objects: tx.objects } });
          else if (keys.state(scope, tx.request.key)?.state === "pending") keys.restore(scope, tx.request.key, undefined);
        }
        break;
      }
      case "pending":
        keys?.restore({ principal: line.principal }, line.key, { state: "pending", fingerprint: line.fingerprint, run: line.run, jseq: line.jseq });
        break;
      case "aborted":
        keys?.restorePendingEnd(line.pending_jseq);
        break;
      case "fence":
        keys?.restorePendingEnd(line.pending_jseq);
        keys?.restoreFence({ principal: line.principal }, line.key, line.run, this.commitTimes.get(line.reset_seq) ?? "");
        report.fences++;
        break;
      case "lookup-fence":
        keys?.restore({ principal: line.principal }, line.key, { state: "fenced", at: line.fenced_at, run: line.run, by: "lookup" });
        report.fences++;
        break;
      case "run-alloc":
        this.runs?.restore({ run_id: line.run_id, principal: line.principal, created_at: line.created_at, label: line.label });
        report.runs++;
        break;
      case "clock":
        this.clock?.restore(line.to_ms);
        report.clockOffsetMs = Math.max(report.clockOffsetMs, line.to_ms);
        break;
      case "lease":
        // A start took the lease: nothing to apply.
        break;
      default:
        break;
    }
  }

  /**
   * Writes one line and flushes it; returns its jseq. The lease is checked before (the fence) and after (ownership
   * again: a takeover meanwhile answers 503 lease_lost). An append that fails once its write has begun marks the
   * journal broken; nothing is ever cut back (G3 note 26 item 1a).
   */
  private append(body: Omit<JournalLine, "jseq" | "checksum" | "epoch">, key?: string | null): number {
    if (this.dead) throw new SimulatedCrash("after a simulated crash");
    if (this.broken) throw new Error(`the journal stopped after an append that failed once it had begun (${this.broken.message}); this server appends nothing more: restart it`);
    if (this.fd === undefined) throw new Error("the journal is not open");
    // 0.4.0: the fence. Nothing is appended unless the data-dir lease is still this process's.
    checkLease(this.options.dataDir);
    this.writeLine({ jseq: this.jseq + 1, ...body, epoch: this.epoch } as Omit<JournalLine, "checksum">, key);
    return this.jseq;
  }

  /** The write itself (append and the lease line): returns the line's text. */
  private writeLine(line: Omit<JournalLine, "checksum">, key: string | null | undefined, prefix = ""): string {
    if (this.dead) throw new SimulatedCrash("after a simulated crash");
    if (this.broken) throw new Error(`the journal stopped after an append that failed once it had begun (${this.broken.message}); this server appends nothing more: restart it`);
    if (this.fd === undefined) throw new Error("the journal is not open");
    const text = encodeLine(line);
    const bytes = Buffer.from(`${prefix}${text}\n`, "utf8");
    const at = { jseq: line.jseq, line: line.line, key };
    let begun = false;
    try {
      if (this.options.crash?.("before-append", at) === "tear") {
        writeSync(this.fd, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)));
        throw new SimulatedCrash("torn-write");
      }
      begun = true;
      const written = writeSync(this.fd, bytes, 0, bytes.length);
      if (written !== bytes.length) throw new Error(`a short write: ${written} of ${bytes.length} bytes`);
      this.options.crash?.("after-write", at);
      fsyncSync(this.fd);
      this.options.crash?.("after-fsync", at);
    } catch (e) {
      if (e instanceof SimulatedCrash) {
        // The process is taken as dead here: whatever reached the file stays, nothing is cleaned up.
        this.dead = true;
        throw e;
      }
      if (!begun) throw e; // nothing of the line was written: the journal carries on
      // Part or all of the line may be in the file, and another holder may have appended after it: the file is not cut
      // back (that could cut the other holder's lines). The journal takes no more lines; the next start drops a torn
      // last line, or applies a whole one.
      this.broken = e as Error;
      throw Object.assign(new Error(`${(e as Error)?.message ?? String(e)}`), { code: "append_failed" });
    }
    // G3 note 26 item 1c: ownership again, after the flush. A lease taken over meanwhile means the new holder may or may
    // not have read this line before its lease line: the outcome is unknown, never a success.
    if (!confirmLease(this.options.dataDir)) {
      throw new LeaseLostAfterWriteError(`the data-dir lease was taken over while this line (${line.line}, jseq ${line.jseq}, epoch ${this.epoch}) was written; this server appends nothing more to the journal: restart it`);
    }
    this.jseq = line.jseq;
    this.lastChecksum = JSON.parse(text).checksum;
    return text;
  }

  // ---- CommitSink (role journal: told first; a throw aborts the write and the store is put back) ----

  onCommit(tx: CommittedTransaction): void {
    const key = tx.kind === "write" ? tx.request?.key ?? null : null;
    const pendingJseq = key !== null && this.keys ? this.keys.pendingJseq({ principal: tx.principal }, key) ?? null : null;
    try {
      this.append({ line: "commit", commit_seq: tx.seq, pending_jseq: pendingJseq, tx } as Omit<JournalCommitLine, "jseq" | "checksum">, key);
    } catch (e) {
      if (key !== null && this.keys && !(e instanceof SimulatedCrash)) this.keys.markJournalFailure({ principal: tx.principal }, key);
      throw e;
    }
    this.lastCommitSeq = tx.seq;
  }

  // ---- JournalSeam.recordRun (seams v2.1): RunRegistry.onAllocate, before the run is registered or answered ----

  recordRun(run: JournalRun): void {
    this.append({ line: "run-alloc", run_id: run.run_id, principal: run.principal, created_at: run.created_at, label: run.label } as Omit<JournalRunAllocLine, "jseq" | "checksum">);
  }

  // ---- the fixture clock (0.4.0): a move is journalled before it is answered (FixtureClock.advance rolls the offset back if this throws) ----

  recordClockMove(move: JournalClockMove): void {
    this.append({ line: "clock", from_ms: move.from_ms, to_ms: move.to_ms, at: move.at } as Omit<JournalClockLine, "jseq" | "checksum">);
  }

  // ---- KeyLineWriter ----

  /**
   * A pending line that cannot be written is a JournalError (G2 fold-in 8): the keyed path answers 503
   * journal_unavailable and records that refusal, not 500 internal. A simulated crash passes through.
   */
  pending(scope: KeyScope, key: string, fingerprint: string, run: string | null): number {
    try {
      return this.appendPending(scope, key, fingerprint, run);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      throw new JournalError(this.name, e);
    }
  }

  private appendPending(scope: KeyScope, key: string, fingerprint: string, run: string | null): number {
    return this.append({ line: "pending", principal: scope.principal, key, fingerprint, run, created_at: this.store.clock.now().toISOString(), clock_offset_ms: this.store.clock.offsetMs() } as Omit<JournalPendingLine, "jseq" | "checksum">, key);
  }

  aborted(pendingJseq: number, reason: AbortReason): void {
    this.append({ line: "aborted", pending_jseq: pendingJseq, reason } as Omit<JournalAbortedLine, "jseq" | "checksum">);
  }

  /** In the run reset's apply step, after its commit line: reset_seq is that commit's commit_seq. */
  fence(scope: KeyScope, key: string, run: string, pendingJseq: number): void {
    this.fenceLine(scope, key, run, pendingJseq, this.lastCommitSeq);
  }

  private fenceLine(scope: KeyScope, key: string, run: string, pendingJseq: number, resetSeq: number): void {
    this.append({ line: "fence", principal: scope.principal, key, run, pending_jseq: pendingJseq, reset_seq: resetSeq } as Omit<JournalFenceLine, "jseq" | "checksum">, key);
  }

  lookupFence(scope: KeyScope, key: string, run: string | null, at: string): void {
    this.append({ line: "lookup-fence", principal: scope.principal, key, run, fenced_at: at } as Omit<JournalLookupFenceLine, "jseq" | "checksum">, key);
  }

  close(): void {
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* closed */ }
      this.fd = undefined;
    }
    releaseLock(this.options.dataDir);
    releaseLease(this.options.dataDir);
  }

  /** Tests only: the process is taken as dead. The descriptor is closed; the lock file stays, as a killed process leaves it. */
  abandon(): void {
    this.dead = true;
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* closed */ }
      this.fd = undefined;
    }
    const real = heldKey(this.options.dataDir);
    HELD.delete(real);
    // As a killed process: its lock text is no longer one this process holds, so the next start takes it over.
    const created = CREATED.get(real);
    CREATED.delete(real);
    if (created) WRITTEN.delete(created.text);
    abandonLease(this.options.dataDir);
  }
}

/** Reads a journal file without a store (recounts, tests): the lines a start applies, after the same checks as a start. */
export function readJournal(path: string): { lines: JournalLine[]; tornLast: boolean; superseded: SupersededLine[]; fragments: number } {
  const scan = scanJournal(path, readFileSync(path, "utf8"));
  // As at start (G2 fold-in 3): only an unterminated last line that does not decode is a torn write.
  if (scan === "new") return { lines: [], tornLast: false, superseded: [], fragments: 0 };
  if (scan === "torn-header") return { lines: [], tornLast: true, superseded: [], fragments: 0 };
  return { lines: scan.lines, tornLast: scan.tornLast, superseded: scan.superseded, fragments: scan.fragments };
}
