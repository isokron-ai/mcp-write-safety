// src/private-dir.ts (stream F, review X5), brought in at the 0.3.0 integration
// for the durable feature's --data-dir; stream F integrates fully at 0.4.0.
// These are stream F's own tests for it, moved with the file.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, PrivateDirError } from "../src/private-dir.js";
import { DataDirError, prepareDataDir } from "../src/backend/journal.js";

const posix = process.platform !== "win32";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tt-private-"));
}

describe("a data dir only its owner can use (src/private-dir.ts, X5)", () => {
  it("creates a missing directory 0700, nested too", { skip: !posix && "POSIX modes" }, () => {
    const dir = tempDir();
    try {
      const data = join(dir, "a", "data");
      ensurePrivateDir(data);
      assert.equal(statSync(data).mode & 0o777, 0o700);
      ensurePrivateDir(data); // an existing private dir is fine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an existing directory open to others, a file and a symlink", { skip: !posix && "POSIX modes" }, () => {
    const dir = tempDir();
    try {
      const open = join(dir, "open");
      mkdirSync(open, { mode: 0o755 });
      chmodSync(open, 0o755);
      assert.throws(() => ensurePrivateDir(open), (e) => e instanceof PrivateDirError && /chmod 700/.test(e.message));
      assert.equal(statSync(open).mode & 0o777, 0o755, "the mode is not changed behind the operator's back");
      ensurePrivateDir(open, "the data dir", "win32");
      const file = join(dir, "file");
      writeFileSync(file, "");
      assert.throws(() => ensurePrivateDir(file), /must name a directory/);
      const priv = join(dir, "priv");
      mkdirSync(priv, { mode: 0o700 });
      const link = join(dir, "link");
      symlinkSync(priv, link);
      assert.throws(() => ensurePrivateDir(link), /symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--data-dir goes through ensurePrivateDir (0.3.0 integration)", () => {
  it("prepareDataDir refuses a directory open to others with the private-dir message, as a DataDirError", { skip: !posix && "POSIX modes" }, () => {
    const dir = tempDir();
    try {
      const open = join(dir, "open");
      mkdirSync(open, { mode: 0o755 });
      chmodSync(open, 0o755);
      assert.throws(() => prepareDataDir(open), (e) => e instanceof DataDirError && /--data-dir .*\(chmod 700\)/.test((e as Error).message));
      const fresh = join(dir, "a", "data");
      prepareDataDir(fresh);
      assert.equal(statSync(fresh).mode & 0o777, 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
