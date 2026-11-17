// Fixture tokens (design rule 2, review X2).
//
// Two tokens besides the backend's own: a read-only evidence token for the
// evidence namespace, and a control token for the control listener. Each is
// read from the environment (TRACKER_EVIDENCE_TOKEN, TRACKER_CONTROL_TOKEN) or
// from a file named there (TRACKER_EVIDENCE_TOKEN_FILE,
// TRACKER_CONTROL_TOKEN_FILE) that no group or other user can read. A token is
// never taken from the command line, never printed on stdout and never put in
// a record, a descriptor or a result.

import { statSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { TokenError } from "../tokens.js";

export type TokenKind = "evidence" | "control";

export const TOKEN_ENV: Record<TokenKind, { value: string; file: string }> = {
  evidence: { value: "TRACKER_EVIDENCE_TOKEN", file: "TRACKER_EVIDENCE_TOKEN_FILE" },
  control: { value: "TRACKER_CONTROL_TOKEN", file: "TRACKER_CONTROL_TOKEN_FILE" },
};

/** 16 to 256 printable ASCII characters, no spaces. */
const TOKEN_PATTERN = /^[\x21-\x7e]{16,256}$/;

export { TokenError } from "../tokens.js";

/**
 * The token folder (--token-dir, owner decision D1): a 0700 directory where a token the operator did not supply is
 * generated as <kind>.token (0600) and kept across restarts. Only the folder's path is ever printed.
 */
export function ensureTokenDir(dir: string, platform: string = process.platform): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new TokenError("--token-dir must name a directory. Not starting.");
  if (platform !== "win32" && (st.mode & 0o077) !== 0) throw new TokenError("--token-dir must not be readable, writable or searchable by group or others (chmod 700). Not starting.");
}

function tokenFromDir(kind: TokenKind, dir: string, platform: string): string {
  ensureTokenDir(dir, platform);
  const file = join(dir, `${kind}.token`);
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  const st = statSync(file);
  if (!st.isFile() || (platform !== "win32" && (st.mode & 0o077) !== 0)) throw new TokenError(`${file} must be a file only its owner can read (chmod 600). Not starting.`);
  return readFileSync(file, "utf8").trim();
}

/** A token from the environment or its file (the operator's wins), else generated in the token folder, else an error. */
export function loadToken(kind: TokenKind, env: Record<string, string | undefined>, platform: string = process.platform, tokenDir?: string): string {
  const names = TOKEN_ENV[kind];
  const direct = env[names.value];
  const file = env[names.file];
  if (direct !== undefined && file !== undefined) throw new TokenError(`set ${names.value} or ${names.file}, not both. Not starting.`);
  let token: string;
  if (file !== undefined) {
    let st;
    try {
      st = statSync(file);
    } catch {
      throw new TokenError(`${names.file} names a file that cannot be read. Not starting.`);
    }
    if (!st.isFile()) throw new TokenError(`${names.file} must name a regular file. Not starting.`);
    // The mode check is POSIX-only; on Windows the file's ACL is the operator's to set.
    if (platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new TokenError(`${names.file} must not be readable or writable by group or others (chmod 600). Not starting.`);
    }
    token = readFileSync(file, "utf8").trim();
  } else if (direct !== undefined) {
    token = direct;
  } else if (tokenDir !== undefined) {
    token = tokenFromDir(kind, tokenDir, platform);
  } else {
    throw new TokenError(`the ${kind} ${kind === "evidence" ? "namespace" : "listener"} needs a token: set ${names.value} or ${names.file}, or give --token-dir (never on the command line). Not starting.`);
  }
  if (!TOKEN_PATTERN.test(token)) throw new TokenError(`the ${kind} token must be 16 to 256 printable characters with no spaces. Not starting.`);
  return token;
}

export { checkArgv, checkDistinct, bearerMatches } from "../tokens.js";
