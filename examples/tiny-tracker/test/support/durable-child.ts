// A durable backend in its own process (test/crash.test.ts): it prints its URL
// and kills itself with SIGKILL at the journal point named by CRASH_POINT on the
// first CRASH_LINE line of the request keyed CRASH_KEY. "torn-write" appends half
// a line to the journal first, as a write cut by the kill would leave it.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { startBackend } from "../../src/start.js";
import { JOURNAL_FILE } from "../../src/backend/journal.js";

const TOKEN = "backend-token-durable-000000000";
const dataDir = process.env.DATA_DIR!;
const want = { point: process.env.CRASH_POINT!, line: process.env.CRASH_LINE!, key: process.env.CRASH_KEY! };
const features = ["durable", "inflight", "retention"];
const clockStart = Date.UTC(2030, 0, 1);
const clock = { domain: "fixture" as const, now: () => new Date(clockStart), wallNow: () => new Date(), offsetMs: () => 0 };

const backend = await startBackend({
  token: TOKEN, port: 0, clock, features, bootId: "c1c1c1c1c1c1c1c1",
  durability: {
    features, dataDir, log: () => {},
    crash: (point, at) => {
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
