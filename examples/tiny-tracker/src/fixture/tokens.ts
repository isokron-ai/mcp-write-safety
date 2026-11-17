// Fixture tokens (design rule 2, review X2).
//
// Two tokens besides the backend's own: a read-only evidence token for the
// evidence namespace, and a control token for the control listener. Each is
// read from the environment (TRACKER_EVIDENCE_TOKEN, TRACKER_CONTROL_TOKEN) or
// from a file named there (TRACKER_EVIDENCE_TOKEN_FILE,
// TRACKER_CONTROL_TOKEN_FILE) that no group or other user can read. A token is
// never taken from the command line, never printed on stdout and never put in
// a record, a descriptor or a result.

import { statSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export type TokenKind = "evidence" | "control";

export const TOKEN_ENV: Record<TokenKind, { value: string; file: string }> = {
  evidence: { value: "TRACKER_EVIDENCE_TOKEN", file: "TRACKER_EVIDENCE_TOKEN_FILE" },
  control: { value: "TRACKER_CONTROL_TOKEN", file: "TRACKER_CONTROL_TOKEN_FILE" },
};

/** 16 to 256 printable ASCII characters, no spaces. */
const TOKEN_PATTERN = /^[\x21-\x7e]{16,256}$/;

export class TokenError extends Error {}

export function loadToken(kind: TokenKind, env: Record<string, string | undefined>, platform: string = process.platform): string {
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
  } else {
    throw new TokenError(`the ${kind} ${kind === "evidence" ? "namespace" : "listener"} needs a token: set ${names.value} or ${names.file} (never on the command line). Not starting.`);
  }
  if (!TOKEN_PATTERN.test(token)) throw new TokenError(`the ${kind} token must be 16 to 256 printable characters with no spaces. Not starting.`);
  return token;
}

/** Each token must differ from every other: a shared token would let a reader write, or a writer arm faults. */
export function checkDistinct(tokens: Record<string, string | undefined>): void {
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(tokens)) {
    if (value === undefined) continue;
    const other = seen.get(value);
    if (other) throw new TokenError(`the ${name} token and the ${other} token must differ. Not starting.`);
    seen.set(value, name);
  }
}

/** Refuses a command line that carries a token: argv is visible to every local user and ends up in published run notes. */
export function checkArgv(argv: readonly string[], tokens: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (value !== undefined && argv.some((a) => a.includes(value))) {
      throw new TokenError(`the ${name} token appeared on the command line; give it in the environment or a 0600 file. Not starting.`);
    }
  }
}

/** Constant-time comparison of a presented bearer token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
