// A directory only its owner can use (review X5: "create the data dir 0700").
//
// For the durable feature's --data-dir and any other folder that holds
// journals, key records or tokens. A missing directory is created 0700. An
// existing one that a group or other users can read, write or search is
// refused rather than silently changed: the operator chose its mode, and a
// journal that others could read before the start may already have leaked.
// The mode check is POSIX-only; on Windows the folder's ACL is the operator's.

import { existsSync, lstatSync, mkdirSync, statSync } from "node:fs";

export class PrivateDirError extends Error {}

/** Creates `dir` 0700 if it does not exist; refuses one that is not a directory, is a symlink, or is open to others. */
export function ensurePrivateDir(dir: string, what = "the data dir", platform: string = process.platform): void {
  if (!existsSync(dir)) {
    // The process umask cannot widen a mode given to mkdir, only narrow it, so 0700 is what lands.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const link = lstatSync(dir);
  if (link.isSymbolicLink()) throw new PrivateDirError(`${what} must not be a symbolic link. Not starting.`);
  const st = statSync(dir);
  if (!st.isDirectory()) throw new PrivateDirError(`${what} must name a directory. Not starting.`);
  if (platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new PrivateDirError(`${what} must not be readable, writable or searchable by group or others (chmod 700). Not starting.`);
  }
}
