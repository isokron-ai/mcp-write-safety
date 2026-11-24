// A durable backend in its own process (test/crash.test.ts): it prints its URL
// and kills itself with SIGKILL at the journal point named by CRASH_POINT on the
// first CRASH_LINE line of the request keyed CRASH_KEY. "torn-write" appends half
// a line to the journal first, as a write cut by the kill would leave it.
//
// G3 note 26 item 1 (T1, the reviewer's probe): STOP_KEY and STOP_LINE make it
// SIGSTOP itself at before-append of the first STOP_LINE line of the request
// keyed STOP_KEY: after its lease check, before its write. With STOP_FAIL=1 that
// same line's write then fails at after-write with an I/O error once it is
// continued (the failure path after a takeover).

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { startBackend } from "../../src/start.js";
import { JOURNAL_FILE, leaseTiming } from "../../src/backend/journal.js";

const TOKEN = "backend-token-durable-000000000";
// The lease tests (test/crash.test.ts) shorten the lease timing: LEASE_TIMING={"heartbeatMs":..,"selfFenceMs":..,"staleMs":..}.
if (process.env.LEASE_TIMING) Object.assign(leaseTiming, JSON.parse(process.env.LEASE_TIMING));
const dataDir = process.env.DATA_DIR!;
const want = { point: process.env.CRASH_POINT ?? "", line: process.env.CRASH_LINE ?? "", key: process.env.CRASH_KEY ?? "" };
const stop = { key: process.env.STOP_KEY ?? "", line: process.env.STOP_LINE ?? "", fail: process.env.STOP_FAIL === "1", done: false };
const features = ["durable", "inflight", "retention"];
const clockStart = Date.UTC(2030, 0, 1);
const clock = { domain: "fixture" as const, now: () => new Date(clockStart), wallNow: () => new Date(), offsetMs: () => 0 };

const backend = await startBackend({
  token: TOKEN, port: 0, clock, features, bootId: "c1c1c1c1c1c1c1c1",
  durability: {
    features, dataDir, log: () => {},
    crash: (point, at) => {
      if (stop.key && at.key === stop.key && at.line === stop.line) {
        if (point === "before-append" && !stop.done) {
          stop.done = true;
          process.kill(process.pid, "SIGSTOP");
        } else if (point === "after-write" && stop.fail) {
          stop.fail = false;
          throw Object.assign(new Error("EIO: i/o error, fsync (injected)"), { code: "EIO" });
        }
        return;
      }
      if (at.line !== want.line || at.key !== want.key) return;
      if (want.point === "torn-write" && point === "before-append") {
        appendFileSync(join(dataDir, JOURNAL_FILE), `{"jseq":${at.jseq},"line":"commit","commit_seq":`);
        process.kill(process.pid, "SIGKILL");
      }
      if (point === want.point) process.kill(process.pid, "SIGKILL");
    },
  },
});
process.stdout.write(`${backend.url}\n`);
