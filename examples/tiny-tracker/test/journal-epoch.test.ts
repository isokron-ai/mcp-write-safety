// The journal's lease epochs and the load without a cut (G3 note 26 items 1, 3, 4
// and 5; pause note 3.3 "g3a" and its remaining cases), in process. The same
// cases with real paused processes are in test/crash.test.ts (T1).
//
// A Journal is opened on its own here (a Store, no key records): run-alloc lines
// stand for data lines, because which of them a start applies is visible in the
// run registry it restores.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/durable.js";
import { DataDirError, encodeLine, JOURNAL_FILE, JournalCorruptError, Journal, LEASE_DIR, LEASE_OWNER, LOCK_FILE, leaseTiming, loadHooks, prepareDataDir, readJournal, splitJoined, type CrashHook } from "../src/backend/journal.js";
import { Store } from "../src/backend/store.js";

const child = fileURLToPath(new URL("./support/durable-child.js", import.meta.url));

function open(dataDir: string, crash?: CrashHook) {
  const runs: string[] = [];
  const logs: string[] = [];
  const j = new Journal(new Store(), undefined, { dataDir, writer: "test", log: (m) => void logs.push(m), crash });
  j.runs = { restore: (r) => void runs.push(r.run_id) };
  j.load();
  return { j, runs, logs };
}

const run = (n: number) => `run-${String(n).padStart(8, "0")}-0123456789ab`;
const runLine = (jseq: number, n: number, epoch?: number) =>
  encodeLine({ jseq, line: "run-alloc", run_id: run(n), principal: "p-default", created_at: "t", label: null, ...(epoch === undefined ? {} : { epoch }) } as any);
const leaseLine = (jseq: number, epoch: number, nonce = "feedfacefeedface") => encodeLine({ jseq, line: "lease", epoch, pid: 4_000_001, host: "elsewhere", nonce } as any);

/** A journal with a header, start 1's lease line and `n` run-alloc lines of epoch 1, closed cleanly. */
function journalWith(dataDir: string, n: number): string {
  const { j } = open(dataDir);
  for (let i = 1; i <= n; i++) j.recordRun({ run_id: run(i), principal: "p-default", created_at: "t", label: null });
  j.close();
  return join(dataDir, JOURNAL_FILE);
}

const kinds = (file: string) => readJournal(file).lines.map((l) => `${l.line}${(l as any).epoch !== undefined ? `@${(l as any).epoch}` : ""}`);

describe("lease epochs (G3 note 26 item 1b)", () => {
  it("every start writes a lease line one epoch higher, before it replays; every line carries its writer's epoch", () => {
    const t = tempDir("ep-basic");
    try {
      const file = journalWith(t.dataDir, 2);
      assert.deepEqual(kinds(file), ["header", "lease@1", "run-alloc@1", "run-alloc@1"]);
      const s2 = open(t.dataDir);
      assert.deepEqual([s2.j.report!.epoch, s2.runs], [2, [run(1), run(2)]]);
      s2.j.recordRun({ run_id: run(3), principal: "p-default", created_at: "t", label: null });
      s2.j.close();
      assert.deepEqual(kinds(file), ["header", "lease@1", "run-alloc@1", "run-alloc@1", "lease@2", "run-alloc@2"]);
      assert.equal(open(t.dataDir).j.report!.epoch, 3);
    } finally {
      t.cleanup();
    }
  });

  it("a line of a lower epoch after a newer lease line is a superseded writer's: not applied, reported and logged", () => {
    const t = tempDir("ep-sup");
    try {
      const file = journalWith(t.dataDir, 1);
      open(t.dataDir).j.close(); // start 2: lease@2 at jseq 3
      appendFileSync(file, `${runLine(4, 9, 1)}\n`); // a holder of epoch 1, paused past the takeover, appends late
      const s = open(t.dataDir);
      try {
        assert.deepEqual(s.runs, [run(1)], "the superseded line is not applied");
        assert.deepEqual(s.j.report!.superseded, [{ jseq: 4, line: "run-alloc", epoch: 1, by_epoch: 2 }]);
        assert.match(s.logs.join("\n"), /a superseded writer's journal line was not applied \(run-alloc line jseq 4, epoch 1; lease epoch 2/);
        assert.equal(s.j.report!.epoch, 3);
      } finally {
        s.j.close();
      }
      // This start's lines follow, contiguous over the applied lines (jseq 4 again: the superseded line holds no number).
      assert.deepEqual(readJournal(file).lines.map((l) => l.jseq), [0, 1, 2, 3, 4]);
      assert.equal(readJournal(file).superseded.length, 1);
    } finally {
      t.cleanup();
    }
  });

  it("a lease line supersedes the lines before it with its jseq or higher (appended after its writer read the file)", () => {
    const t = tempDir("ep-pop");
    try {
      const file = journalWith(t.dataDir, 1); // header, lease@1, run-alloc@1 (jseq 2)
      // The race of the reviewer's probe, as the file records it: the new holder read jseq 0-2, the paused holder then
      // appended jseq 3 (epoch 1), and the new holder's lease line (epoch 2) also took jseq 3.
      appendFileSync(file, `${runLine(3, 8, 1)}\n${leaseLine(3, 2)}\n`);
      const s = open(t.dataDir);
      try {
        assert.deepEqual(s.runs, [run(1)]);
        assert.deepEqual(s.j.report!.superseded.map((x) => [x.jseq, x.line, x.epoch, x.by_epoch]), [[3, "run-alloc", 1, 2]]);
        assert.equal(s.j.report!.epoch, 3);
      } finally {
        s.j.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("refuses, untouched: an epoch no lease line took, a line without an epoch after a lease line, a lease line without a positive epoch", async () => {
    const cases: Array<[string, (jseq: number) => string]> = [
      ["an epoch no lease line took", (j) => runLine(j, 7, 5)],
      ["no epoch after a lease line", (j) => runLine(j, 7)],
      ["a lease line of epoch 0", (j) => encodeLine({ jseq: j, line: "lease", epoch: 0, pid: 1, host: "h", nonce: "n" } as any)],
      ["an epoch that is not an integer", (j) => runLine(j, 7, 1.5)],
    ];
    for (const [what, line] of cases) {
      const t = tempDir("ep-bad");
      try {
        const file = journalWith(t.dataDir, 1);
        writeFileSync(file, readFileSync(file, "utf8") + `${line(3)}\n`);
        const before = readFileSync(file, "utf8");
        assert.throws(() => open(t.dataDir), JournalCorruptError, what);
        assert.equal(readFileSync(file, "utf8"), before, `${what}: untouched`);
        assert.ok(!existsSync(join(t.dataDir, LOCK_FILE)) && !existsSync(join(t.dataDir, LEASE_DIR)), `${what}: the lock and the lease are released`);
        assert.throws(() => readJournal(file), JournalCorruptError, `${what}: the reader refuses it too`);
      } finally {
        t.cleanup();
      }
    }
  });

  it("a journal written before 0.4.0 (no epochs, no lease lines) loads as epoch 0; the next starts take epochs 1 and 2", () => {
    const t = tempDir("ep-030");
    try {
      const file = journalWith(t.dataDir, 0);
      const header = readFileSync(file, "utf8").split("\n")[0];
      writeFileSync(file, `${header}\n${runLine(1, 1)}\n${runLine(2, 2)}\n`); // a 0.3.0 journal: header and two lines, no epoch
      const s1 = open(t.dataDir);
      assert.deepEqual([s1.runs, s1.j.report!.epoch, s1.j.report!.superseded], [[run(1), run(2)], 1, []]);
      s1.j.close();
      const s2 = open(t.dataDir);
      assert.deepEqual([s2.runs, s2.j.report!.epoch], [[run(1), run(2)], 2]);
      s2.j.close();
      assert.deepEqual(kinds(file), ["header", "run-alloc", "run-alloc", "lease@1", "lease@2"]);
    } finally {
      t.cleanup();
    }
  });
});

describe("nothing is cut from the file (G3 note 26 item 1a; pause note 3.3 remaining cases a and b)", () => {
  it("splitJoined: a fragment and the whole line that joined it; a line alone; bytes with no whole line", () => {
    const whole = runLine(3, 1, 1);
    assert.deepEqual(splitJoined(whole).map((p) => ("line" in p ? p.line.jseq : "junk")), [3]);
    assert.deepEqual(splitJoined(`{"jseq":3,"line":"comm${whole}`).map((p) => ("line" in p ? p.line.jseq : p.junk)), ['{"jseq":3,"line":"comm', 3]);
    assert.deepEqual(splitJoined(`${runLine(2, 1, 1)}${whole}`).map((p) => ("line" in p ? p.line.jseq : "junk")), [2, 3], "a line that lost only its newline, then the next");
    assert.deepEqual(splitJoined('{"jseq":3,"line":"comm'), [{ junk: '{"jseq":3,"line":"comm' }]);
  });

  it("a last line that lost only its newline is joined by the lease line; both apply", () => {
    const t = tempDir("ep-nl");
    try {
      const file = journalWith(t.dataDir, 2);
      writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, ""));
      const s = open(t.dataDir);
      assert.deepEqual([s.runs, s.j.report!.droppedTornLine], [[run(1), run(2)], false]);
      s.j.close();
      assert.deepEqual(open(t.dataDir).runs, [run(1), run(2)]);
    } finally {
      t.cleanup();
    }
  });

  it("(a) a superseded holder's append cut short after the takeover: the new holder's next line joins it, and still applies", () => {
    const t = tempDir("ep-frag");
    try {
      const file = journalWith(t.dataDir, 1);
      const s = open(t.dataDir);
      // The paused holder (epoch 1) wakes and its append is cut short (disk full): a fragment with no newline.
      appendFileSync(file, runLine(4, 9, 1).slice(0, 40));
      s.j.recordRun({ run_id: run(2), principal: "p-default", created_at: "t", label: null }); // acknowledged
      s.j.close();
      const again = open(t.dataDir);
      try {
        assert.deepEqual(again.runs, [run(1), run(2)], "the acknowledged line that joined the fragment applies");
        assert.equal(again.j.report!.fragments, 1);
      } finally {
        again.j.close();
      }
      assert.equal(readJournal(file).fragments, 1);
    } finally {
      t.cleanup();
    }
  });

  it("(b) a last line without its newline, then a superseded holder's line before this start's lease line: the start goes on; the stale line is left out", () => {
    const t = tempDir("ep-nl-race");
    try {
      const file = journalWith(t.dataDir, 1); // jseq 0-2
      writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, ""));
      let raced = false;
      const s = open(t.dataDir, (point, at) => {
        if (!raced && point === "before-append" && at.line === "lease") {
          raced = true;
          appendFileSync(file, `${runLine(3, 9, 1)}\n`); // the paused holder's line joins the newline-less last line
        }
      });
      try {
        assert.deepEqual(s.runs, [run(1)]);
        assert.deepEqual(s.j.report!.superseded.map((x) => [x.jseq, x.epoch, x.by_epoch]), [[3, 1, 2]]);
      } finally {
        s.j.close();
      }
      assert.deepEqual(open(t.dataDir).runs, [run(1)]);
    } finally {
      t.cleanup();
    }
  });

  it("a fragment can never hide an applied line: a whole line lost inside bytes that do not decode leaves a jseq gap, refused", () => {
    const t = tempDir("ep-gap");
    try {
      const file = journalWith(t.dataDir, 2); // jseq 0-3
      const lines = readFileSync(file, "utf8").split("\n");
      lines[2] = `garbage${lines[2].slice(3)}${lines[3]}`; // jseq 2 corrupted, then jseq 3 joined to it
      lines.splice(3, 1);
      writeFileSync(file, lines.join("\n"));
      assert.throws(() => open(t.dataDir), (e) => e instanceof JournalCorruptError && /jseq 3 where 2 was expected/.test(e.message));
    } finally {
      t.cleanup();
    }
  });

  it("an append that fails once its write began marks the journal broken: 503 for every later line, nothing cut; the next start decides the line", () => {
    const t = tempDir("ep-broken");
    try {
      const file = journalWith(t.dataDir, 1);
      let fail = true;
      const s = open(t.dataDir, (point, at) => {
        if (fail && point === "after-write" && at.line === "run-alloc") {
          fail = false;
          throw Object.assign(new Error("EIO: fsync failed"), { code: "EIO" });
        }
      });
      const size = readFileSync(file).length;
      assert.throws(() => s.j.recordRun({ run_id: run(2), principal: "p-default", created_at: "t", label: null }), (e: any) => e.code === "append_failed");
      assert.ok(readFileSync(file).length > size, "the whole line is in the file, not cut back");
      assert.throws(() => s.j.recordRun({ run_id: run(3), principal: "p-default", created_at: "t", label: null }), /stopped after an append that failed once it had begun/);
      s.j.close();
      assert.deepEqual(open(t.dataDir).runs, [run(1), run(2)], "a whole line is applied by the next start (its writer said the outcome is unknown)");
    } finally {
      t.cleanup();
    }
  });
});

describe("starts that race (pause note 3.3 remaining case c)", () => {
  it("two lease lines of one epoch: another start's lease line landing between this start's read and its own: this start refuses; the next start goes on", () => {
    const t = tempDir("ep-same");
    try {
      const file = journalWith(t.dataDir, 1); // jseq 0-2, epoch 1
      let raced = false;
      assert.throws(() => open(t.dataDir, (point, at) => {
        if (!raced && point === "before-append" && at.line === "lease") {
          raced = true;
          appendFileSync(file, `${leaseLine(3, 2)}\n`); // a start of the same epoch that read the same file
        }
      }), (e) => e instanceof DataDirError && /another start wrote to the journal at the same moment/.test(e.message));
      assert.ok(!existsSync(join(t.dataDir, LEASE_DIR)), "the refused start released its lease");
      const read = readJournal(file);
      assert.deepEqual(read.superseded.map((x) => [x.line, x.epoch, x.by_epoch]), [["lease", 2, 2]], "the second lease line of epoch 2 is left out");
      const next = open(t.dataDir);
      assert.deepEqual([next.runs, next.j.report!.epoch], [[run(1)], 3]);
      next.j.close();
    } finally {
      t.cleanup();
    }
  });

  it("a start that found the file empty and lost the race: its header and lease line land together after the winner's lines and are left out", () => {
    const t = tempDir("ep-new");
    try {
      prepareDataDir(t.dataDir);
      const file = join(t.dataDir, JOURNAL_FILE);
      // This start writes its header and lease line in one write (G3a); a racing start's pair landed first.
      let raced = false;
      const store = new Store();
      const header = encodeLine({ jseq: 0, line: "header", journal: "journal-format/1", writer: "other", boot_id: "0000000000000000", seed: structuredClone(store.seed) } as any);
      assert.throws(() => open(t.dataDir, (point, at) => {
        if (!raced && point === "before-append" && at.line === "lease") {
          raced = true;
          appendFileSync(file, `${header}\n${leaseLine(1, 1)}\n${runLine(2, 5, 1)}\n`);
        }
      }), (e) => e instanceof DataDirError && /another start wrote to the journal at the same moment/.test(e.message));
      const read = readJournal(file);
      assert.deepEqual(read.lines.map((l) => l.line), ["header", "lease", "run-alloc"], "the winner's lines apply");
      assert.deepEqual(read.superseded.map((x) => x.line), ["header", "lease"]);
      const next = open(t.dataDir);
      assert.deepEqual([next.runs, next.j.report!.epoch], [[run(5)], 2]);
      next.j.close();
    } finally {
      t.cleanup();
    }
  });
});

describe("a long load keeps the lease (G3 note 26 item 3)", () => {
  it("a replay longer than the stale time: the load beats the lease, a racing start is refused, and the first appends after it work", () => {
    const t = tempDir("ep-slow");
    const saved = { ...leaseTiming };
    try {
      const file = journalWith(t.dataDir, 6);
      // An open pending line: after the replay the load must append its aborted line (orphan_at_start).
      appendFileSync(file, `${encodeLine({ jseq: 8, line: "pending", principal: "p-default", key: "slow-key-000001", fingerprint: "f", run: null, created_at: "t", clock_offset_ms: 0, epoch: 1 } as any)}\n`);
      Object.assign(leaseTiming, { heartbeatMs: 100, selfFenceMs: 1500, staleMs: 3000 });
      const ages: number[] = [];
      let racer: { status: number | null; stderr: string } | undefined;
      let lines = 0;
      loadHooks.onLine = () => {
        lines++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); // each line takes 200 ms: the load runs past the stale time
        ages.push(Date.now() - statSync(join(t.dataDir, LEASE_DIR)).mtimeMs);
        if (lines === 12 && racer === undefined) {
          // A start racing this load: the lease must look held, not stale.
          const r = spawnSync(process.execPath, [child], { env: { ...process.env, DATA_DIR: t.dataDir, LEASE_TIMING: JSON.stringify(leaseTiming) }, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
          racer = { status: r.status, stderr: r.stderr };
        }
      };
      const s = open(t.dataDir);
      loadHooks.onLine = undefined;
      try {
        assert.ok(lines >= 16, `the load read and replayed every line (${lines})`);
        assert.ok(Math.max(...ages) < leaseTiming.staleMs, `the lease never looked stale during the load (oldest ${Math.max(...ages)} ms)`);
        assert.ok(racer && racer.status !== 0 && /locked by process/.test(racer.stderr), `the racing start was refused: ${JSON.stringify(racer)}`);
        assert.equal(s.j.report!.abortedOrphans, 1, "the orphan's aborted line was appended after the replay");
        s.j.recordRun({ run_id: run(99), principal: "p-default", created_at: "t", label: null });
      } finally {
        s.j.close();
      }
      assert.deepEqual(kinds(file).slice(-3), ["lease@2", "aborted@2", "run-alloc@2"]);
    } finally {
      loadHooks.onLine = undefined;
      Object.assign(leaseTiming, saved);
      t.cleanup();
    }
  });
});

describe("the pid lock across hosts (G3 note 26 item 4)", () => {
  /** A live process that is not this one (recorded; killed by its pid only). */
  async function livePid(): Promise<{ pid: number; stop(): Promise<void> }> {
    const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise((r) => p.once("spawn", r));
    return { pid: p.pid!, stop: async () => { const gone = new Promise((r) => p.once("exit", r)); p.kill("SIGKILL"); await gone; } };
  }

  it("a pid lock another host wrote is judged by the lease alone, even when its pid is alive here", async () => {
    const t = tempDir("ep-host");
    const other = await livePid();
    try {
      prepareDataDir(t.dataDir);
      writeFileSync(join(t.dataDir, LOCK_FILE), JSON.stringify({ pid: other.pid, ppid: 1, host: "another-host", started_at: "t", nonce: "aa" }), { mode: 0o600 });
      const s = open(t.dataDir);
      try {
        assert.match(s.logs.join("\n"), /taking over a data-dir lock written on host another-host/);
        assert.equal(JSON.parse(readFileSync(join(t.dataDir, LOCK_FILE), "utf8")).host, hostname(), "the pid lock names its host");
      } finally {
        s.j.close();
      }
    } finally {
      await other.stop();
      t.cleanup();
    }
  });

  it("a takeover by age takes a host-less pid lock whose pid is alive here (the old holder is fenced by the lease)", async () => {
    const t = tempDir("ep-age");
    const other = await livePid();
    try {
      prepareDataDir(t.dataDir);
      const lease = join(t.dataDir, LEASE_DIR);
      mkdirSync(lease, { mode: 0o700 });
      writeFileSync(join(lease, LEASE_OWNER), JSON.stringify({ pid: other.pid, host: "a-moved-container", nonce: "bb" }));
      const old = new Date(Date.now() - leaseTiming.staleMs - 5000);
      utimesSync(lease, old, old);
      writeFileSync(join(t.dataDir, LOCK_FILE), JSON.stringify({ pid: other.pid, ppid: 1, started_at: "t", nonce: "cc" }), { mode: 0o600 });
      const s = open(t.dataDir);
      try {
        assert.match(s.logs.join("\n"), new RegExp(`taking over the data-dir lock of process ${other.pid}, whose lease this start took over`));
      } finally {
        s.j.close();
      }
    } finally {
      await other.stop();
      t.cleanup();
    }
  });
});
