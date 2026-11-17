// The durable store: a JSONL journal of committed post-state (0.3.0, feature
// durable; decision 0003, review B8 and G13; line shapes in docs/INTERFACES.md
// 1.9, types in src/backend/commit.ts).
//
// Files in the data dir (created 0700; an existing one must be private, owned by
// this user, not a symlink, and either empty or made by tiny-tracker):
//   tiny-tracker.data   marker: this directory was created by tiny-tracker
//   lock                the pid lock {"pid": N, "started_at": ...}: one writer per data dir
//   journal.jsonl       one JSON object per line, each with `jseq` (its own number, 0 for
//                       the header, contiguous) and `checksum` (SHA-256 of the line's
//                       RFC 8785 bytes without the checksum member)
//
// Lines: the header (with the seed), commit lines (commit_seq = tx.seq, the
// complete CommittedTransaction, pending_jseq), pending lines (inflight),
// aborted lines, fence lines (a run reset ended a pending line; seams v2.1),
// run-alloc lines (the fixture layer's run registry; seams v2.1) and
// lookup-fence lines (settle-by-lookup; additive). The effect and its key record are one line: replay rebuilds the
// key record from the commit line with storedReplyOf(tx).
//
// The journal is the commit path's step 2 (src/backend/commit.ts): the line is
// written and flushed (writeSync + fsyncSync) before the write is applied; if it
// cannot be, the file is cut back to where it was and the error is thrown, so the
// store is put back and the request gets 503. Replay applies post-state only: no
// operation is re-run and no clock is read, so a restart cannot change a digest.
//
// Recovery: a torn write (an unterminated last line that does not decode) is
// dropped, cut from the file and logged. Any other bad line, the last one
// included when it has its newline or decodes (an unknown kind, a sequence
// gap), stops the start with an error and the file is not touched. A pending line
// that no commit or aborted line names is ended at start by an aborted line
// (reason orphan_at_start), written before the backend serves.

import { closeSync, existsSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { canonicalize } from "../digest.js";
import { ensurePrivateDir, PrivateDirError } from "../private-dir.js";
import { JournalError, storedReplyOf, type CommittedTransaction, type JournalAbortedLine, type JournalCommitLine, type JournalFenceLine, type JournalHeader, type JournalLine, type JournalLookupFenceLine, type JournalPendingLine, type JournalRunAllocLine } from "./commit.js";
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

/** Where run-alloc lines go back at load (the fixture layer's RunRegistry). */
export interface RunRestorer {
  restore(run: JournalRun): void;
}

export const JOURNAL_FORMAT = "journal-format/1";
export const JOURNAL_FILE = "journal.jsonl";
export const LOCK_FILE = "lock";
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
/** Data dirs whose Journal this process abandoned (tests' in-process crash): their lock names this pid and is stale. */
const ABANDONED = new Set<string>();

/** The key a data dir is held under: its real path (the dir exists once prepareDataDir ran), else the resolved path. */
function heldKey(dir: string): string {
  try {
    return realpathSync(dir);
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

/** Test seam (G2 fold-in 7): called after a lock was judged stale and before it is taken over. */
export const lockHooks: { beforeTakeover?: (path: string) => void } = {};

/**
 * Removes a stale lock without ever removing another starter's fresh one (G2 fold-in 7). The lock is renamed aside
 * (atomic: of two starters only one moves a given file) and the moved file is compared with the stale text this starter
 * read. The same text: the stale lock is gone, and the caller creates its own with O_EXCL. Another text: a second
 * starter took the lock over in between, so the moved file is linked back (link refuses if a lock exists again) and the
 * caller reads the lock afresh. Returns false when the lock could not be put back (a third starter created one in the
 * same instant); the caller then refuses to start.
 */
function removeStaleLock(path: string, staleText: string): boolean {
  const aside = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; // another starter removed it first
    throw e;
  }
  let moved: string | undefined;
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    // unreadable: treat it as not the stale lock
  }
  if (moved === staleText) {
    unlinkSync(aside);
    return true;
  }
  let restored = true;
  try {
    linkSync(aside, path);
  } catch {
    restored = false;
  }
  unlinkSync(aside);
  return restored;
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
 * Returns false when a lock exists.
 */
function createLock(path: string, content: string): boolean {
  const tmp = `${path}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
    try {
      const lfd = openSync(path, "wx", 0o600);
      try {
        writeSync(lfd, content);
        fsyncSync(lfd);
      } finally {
        closeSync(lfd);
      }
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e2;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

export function acquireLock(dir: string, wallNow: () => Date, log: (m: string) => void): void {
  const path = join(dir, LOCK_FILE);
  const real = heldKey(dir);
  if (HELD.has(real)) throw new DataDirError(`the data dir ${dir} is already open in this process; one writer per data dir`);
  for (let attempt = 0; attempt < 5; attempt++) {
    // ppid: a supervised child's lock names its supervisor too (evidence only; liveness is the pid's).
    if (createLock(path, JSON.stringify({ pid: process.pid, ppid: process.ppid, started_at: wallNow().toISOString() }))) {
      HELD.add(real);
      ABANDONED.delete(real);
      return;
    }
    let text: string;
    let mtimeMs: number;
    try {
      text = readFileSync(path, "utf8");
      mtimeMs = statSync(path).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // removed meanwhile: try to create it again
      throw e;
    }
    let pid = NaN;
    let parsed: { pid?: unknown; started_at?: unknown } | undefined;
    try {
      parsed = JSON.parse(text);
      pid = Number(parsed!.pid);
    } catch {
      // Empty or torn: see below.
    }
    if (!Number.isSafeInteger(pid) && Date.now() - mtimeMs < LOCK_UNREADABLE_GRACE_MS) {
      throw new DataDirError(`the data dir ${dir} has a lock that is being written (or was torn less than ${LOCK_UNREADABLE_GRACE_MS / 1000} s ago); one server per data dir`);
    }
    if (pid === process.pid && !ABANDONED.has(real)) {
      throw new DataDirError(`the data dir ${dir} is already open in this process (its lock names this process); one writer per data dir`);
    }
    if (Number.isSafeInteger(pid) && pid !== process.pid && alive(pid)) {
      throw new DataDirError(`the data dir ${dir} is locked by process ${pid}; one server per data dir (more than one instance is not supported)`);
    }
    lockHooks.beforeTakeover?.(path);
    if (!removeStaleLock(path, text)) {
      throw new DataDirError(`the data dir ${dir}: another start took the lock over at the same moment; one server per data dir`);
    }
    log(`tiny-tracker: taking over a stale data-dir lock (process ${Number.isNaN(pid) ? "unknown" : pid} is gone)`);
    ABANDONED.delete(real);
  }
  throw new DataDirError(`could not take the data-dir lock in ${dir}`);
}

export function releaseLock(dir: string): void {
  if (!HELD.delete(heldKey(dir))) return;
  try {
    if (JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")).pid === process.pid) unlinkSync(join(dir, LOCK_FILE));
  } catch {
    // Gone already.
  }
}

export interface LoadReport {
  /** Lines after the header that were kept. */
  lines: number;
  /** The last commit sequence replayed. */
  commits: number;
  droppedTornLine: boolean;
  abortedOrphans: number;
  /** Fences restored (fence and lookup-fence lines). */
  fences: number;
  /** Runs restored from run-alloc lines. */
  runs: number;
  /**
   * Pending lines a later run-reset commit line had fenced, with no fence line after it (a crash between the reset's
   * commit line and its fence line): fenced at start, and their fence lines written then (G2 fold-in 5).
   */
  fencedAtStart: number;
}

/** What is wrong with a line at position `expected` (undefined: nothing). */
function lineProblem(line: JournalLine | undefined, expected: number, lastCommit: number, pendings: Set<number>): string | undefined {
  if (line === undefined) return "a bad checksum or a torn write";
  if (line.jseq !== expected) return `jseq ${line.jseq} where ${expected} was expected`;
  if (line.line === "header") return "a second header";
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
  } else if (line.line !== "pending") {
    return `unknown line kind ${JSON.stringify((line as { line: unknown }).line)}`;
  }
  return undefined;
}

/** The journal: the commit path's journal sink, the key-state line writer and the replay at start. */
export class Journal implements JournalSeam, KeyLineWriter {
  readonly name = "journal";
  readonly role = "journal" as const;
  private fd: number | undefined;
  private size = 0;
  private jseq = 0;
  private lastChecksum: string | null = null;
  private dead = false;
  /** Set when a failed append could not be cut back: later lines would follow a torn one, so nothing more is appended. */
  private broken: Error | undefined;
  readonly path: string;
  report: LoadReport | undefined;
  /** False only under the key-record-not-durable defect: a replayed commit line rebuilds no key record. */
  keyFromCommitLine = true;
  /** The fixture layer's run registry, set before load: run-alloc lines go back into it. */
  runs: RunRestorer | undefined;
  /**
   * Told each replayed commit after its post-state is applied (no clock, no ledger): the execution records, so
   * /executions/:id and /operations/:key answer for commits made before a restart.
   */
  replayObservers: Array<(tx: CommittedTransaction) => void> = [];
  /** The commit_seq of the last commit line (a fence line names its reset by it). */
  private lastCommitSeq = 0;

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
    acquireLock(this.options.dataDir, this.options.wallNow ?? (() => new Date()), (m) => this.log(m));
    const limit = flushLimit(this.options.platform ?? process.platform);
    if (limit) this.log(limit);
    try {
      this.replay();
    } catch (e) {
      if (this.fd !== undefined) closeSync(this.fd);
      this.fd = undefined;
      releaseLock(this.options.dataDir);
      throw e;
    }
  }

  private replay(): void {
    const report: LoadReport = { lines: 0, commits: 0, droppedTornLine: false, abortedOrphans: 0, fences: 0, runs: 0, fencedAtStart: 0 };
    this.report = report;
    // A journal file that is missing, or empty because the first start stopped before its header was flushed, is new.
    if (!existsSync(this.path) || statSync(this.path).size === 0) {
      this.fd = openSync(this.path, "w", 0o600);
      const header: Omit<JournalHeader, "checksum"> = { jseq: 0, line: "header", journal: JOURNAL_FORMAT, writer: this.options.writer, boot_id: this.store.bootId, seed: structuredClone(this.store.seed) };
      const text = `${encodeLine(header)}\n`;
      writeSync(this.fd, text, 0);
      fsyncSync(this.fd);
      this.size = Buffer.byteLength(text);
      this.lastChecksum = lineChecksum(header as unknown as Record<string, unknown>);
      return;
    }
    const raw = readFileSync(this.path, "utf8");
    const parts = raw.split("\n");
    const terminated = parts[parts.length - 1] === "";
    if (terminated) parts.pop();
    const header = decodeLine(parts[0]);
    if (header === undefined || header.line !== "header" || header.jseq !== 0) {
      // A header torn at the very first start (nothing after it) is the only header problem that is not corruption.
      if (parts.length === 1 && !terminated) {
        this.log("tiny-tracker: the journal header was torn at the first start; starting a new journal");
        const fd = openSync(this.path, "r+");
        ftruncateSync(fd, 0);
        closeSync(fd);
        return this.replay();
      }
      throw new JournalCorruptError(`${this.path}: the first line is not a valid journal header. Not starting.`);
    }
    if (header.journal !== JOURNAL_FORMAT) throw new JournalCorruptError(`${this.path}: journal format ${JSON.stringify(header.journal)}; this version reads ${JOURNAL_FORMAT}. Not starting.`);
    let offset = Buffer.byteLength(parts[0]) + (parts.length === 1 && !terminated ? 0 : 1);
    const lines: JournalLine[] = [header];
    const open = new Map<number, JournalPendingLine>();
    /** Open pending lines a run-reset commit line has fenced: pending jseq → the reset's commit_seq. */
    const resetFenced = new Map<number, number>();
    let lastCommit = 0;
    for (let i = 1; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const line = decodeLine(parts[i]);
      const bad = lineProblem(line, i, lastCommit, new Set(open.keys()));
      if (bad !== undefined) {
        // G2 fold-in 3: only a torn write is tolerated, that is an unterminated last line that does not decode. A line
        // that decodes (an unknown kind, a sequence gap) or that has its newline is refused whatever its problem, and
        // the file is left as it is (nothing below has touched it yet).
        if (!(isLast && !terminated && line === undefined)) {
          throw new JournalCorruptError(`${this.path}: line jseq ${i} is not valid (${bad}); only a torn last line (unterminated, not decodable) is tolerated. Not starting.`);
        }
        this.log(`tiny-tracker: dropped a torn last journal line (jseq ${i}: ${bad})`);
        report.droppedTornLine = true;
        break;
      }
      const l = line!;
      if (l.line === "pending") open.set(l.jseq, l);
      if (l.line === "aborted" || l.line === "fence") open.delete(l.pending_jseq);
      if (l.line === "commit") {
        lastCommit = l.commit_seq;
        if (l.pending_jseq !== null) open.delete(l.pending_jseq);
        // Seams v2.1: a run reset fences its run's pending records. Its fence lines follow its commit line; if the
        // process died between them, the pending line is fenced at start below, never ended as an orphan.
        const reset = l.tx.kind === "run-reset" ? l.tx.reset : undefined;
        if (reset) for (const p of open.values()) if (p.principal === reset.principal && p.run === reset.run && !resetFenced.has(p.jseq)) resetFenced.set(p.jseq, l.commit_seq);
      }
      lines.push(l);
      offset += Buffer.byteLength(parts[i]) + (isLast && !terminated ? 0 : 1);
    }
    this.store.applySeed(header.seed);
    for (const l of lines.slice(1)) this.apply(l, report);
    this.lastCommitSeq = lastCommit;
    this.jseq = lines.length - 1;
    this.lastChecksum = lines[lines.length - 1].checksum;
    report.lines = lines.length - 1;
    report.commits = lastCommit;
    this.fd = openSync(this.path, "r+");
    // Cut a dropped torn line off, and end a whole last line that lost only its newline.
    ftruncateSync(this.fd, offset);
    this.size = offset;
    if (!terminated && !report.droppedTornLine) {
      writeSync(this.fd, "\n", this.size);
      this.size += 1;
    }
    fsyncSync(this.fd);
    // Orphan pending lines: a write that began and never committed. Nothing was applied; say so before serving.
    // A pending line whose run a later commit line reset was fenced by that reset (G2 fold-in 5): it gets the fence
    // line it lost and stays fenced, so a late original can never land under its key.
    for (const p of open.values()) {
      const resetSeq = resetFenced.get(p.jseq);
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
      default:
        break;
    }
  }

  /** Writes one line and flushes it; returns its jseq. On an I/O error the file is cut back and the error is thrown. */
  private append(body: Omit<JournalLine, "jseq" | "checksum">, key?: string | null): number {
    if (this.dead) throw new SimulatedCrash("after a simulated crash");
    if (this.broken) throw new Error(`the journal stopped after a failed append it could not cut back: ${this.broken.message}`);
    if (this.fd === undefined) throw new Error("the journal is not open");
    const line = { jseq: this.jseq + 1, ...body } as Omit<JournalLine, "checksum">;
    const text = encodeLine(line);
    const bytes = Buffer.from(`${text}\n`, "utf8");
    const at = { jseq: line.jseq, line: line.line, key };
    try {
      if (this.options.crash?.("before-append", at) === "tear") {
        writeSync(this.fd, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), this.size);
        throw new SimulatedCrash("torn-write");
      }
      writeSync(this.fd, bytes, 0, bytes.length, this.size);
      this.options.crash?.("after-write", at);
      fsyncSync(this.fd);
      this.options.crash?.("after-fsync", at);
    } catch (e) {
      if (e instanceof SimulatedCrash) {
        // The process is taken as dead here: whatever reached the file stays, nothing is cleaned up.
        this.dead = true;
        throw e;
      }
      // A failed append is cut back to the last good offset, so a later line never follows a torn one (decision 0003,
      // "only a torn last line"). If it cannot be cut back, the journal takes no more lines: every later write gets
      // 503 journal_unavailable, and the next start drops the torn last line.
      try {
        ftruncateSync(this.fd, this.size);
      } catch (t) {
        this.broken = t as Error;
      }
      throw e;
    }
    this.size += bytes.length;
    this.jseq = line.jseq;
    this.lastChecksum = JSON.parse(text).checksum;
    return line.jseq;
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
    ABANDONED.add(real);
  }
}

/** Reads a journal file without a store (recounts, tests): the lines, after the same checks as a start. */
export function readJournal(path: string): { lines: JournalLine[]; tornLast: boolean } {
  const parts = readFileSync(path, "utf8").split("\n");
  const terminated = parts[parts.length - 1] === "";
  if (terminated) parts.pop();
  const lines: JournalLine[] = [];
  let tornLast = false;
  const open = new Set<number>();
  let lastCommit = 0;
  for (let i = 0; i < parts.length; i++) {
    const l = decodeLine(parts[i]);
    const bad = i === 0
      ? (l === undefined ? "a bad checksum or a torn write" : l.line !== "header" || l.jseq !== 0 ? "not a journal header" : undefined)
      : lineProblem(l, i, lastCommit, open);
    if (bad !== undefined) {
      // As at start (G2 fold-in 3): only an unterminated last line that does not decode is a torn write.
      if (i === parts.length - 1 && !terminated && l === undefined) { tornLast = true; break; }
      throw new JournalCorruptError(`${path}: line jseq ${i} is not valid (${bad})`);
    }
    const line = l!;
    if (line.line === "pending") open.add(line.jseq);
    if (line.line === "aborted" || line.line === "fence") open.delete(line.pending_jseq);
    if (line.line === "commit") {
      lastCommit = line.commit_seq;
      if (line.pending_jseq !== null) open.delete(line.pending_jseq);
    }
    lines.push(line);
  }
  return { lines, tornLast };
}
