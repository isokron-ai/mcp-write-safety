// Principals (frozen configuration; feature principals builds the rest in
// 0.2.0). A principal is one backend token with an id. Records carry the
// principal; key records and lookups are scoped to it.
//
// Configuration: TRACKER_BACKEND_TOKENS_FILE names a JSON file that no group or
// other user can read: {"principals": [{"id": "p-alice", "token": "..."}, ...]}.
// Without it there is one principal, "p-default", whose token is
// TRACKER_BACKEND_TOKEN. Ids match ^p-[a-z0-9-]{1,62}$; tokens follow the
// fixture token rule (16 to 256 printable characters, no spaces) and must all
// differ.

import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export interface Principal {
  id: string;
  token: string;
}

export const DEFAULT_PRINCIPAL = "p-default";
const ID = /^p-[a-z0-9-]{1,62}$/;
const TOKEN = /^[\x21-\x7e]{16,256}$/;

export class PrincipalError extends Error {}

export function defaultPrincipals(token: string): Principal[] {
  return [{ id: DEFAULT_PRINCIPAL, token }];
}

export function parsePrincipals(json: string): Principal[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new PrincipalError("the principals file is not valid JSON");
  }
  const list = (doc as { principals?: unknown })?.principals;
  if (!Array.isArray(list) || list.length < 1) throw new PrincipalError("the principals file needs a non-empty \"principals\" list");
  const out: Principal[] = [];
  for (const p of list as Array<Record<string, unknown>>) {
    if (typeof p?.id !== "string" || !ID.test(p.id)) throw new PrincipalError(`principal id must match ${ID}`);
    if (typeof p.token !== "string" || !TOKEN.test(p.token)) throw new PrincipalError(`principal ${p.id}: the token must be 16 to 256 printable characters with no spaces`);
    if (out.some((q) => q.id === p.id)) throw new PrincipalError(`principal ${p.id} appears twice`);
    if (out.some((q) => q.token === p.token)) throw new PrincipalError(`principal ${p.id} shares a token`);
    out.push({ id: p.id, token: p.token });
  }
  return out;
}

export function loadPrincipalsFile(path: string, platform: string = process.platform): Principal[] {
  const st = statSync(path);
  if (!st.isFile()) throw new PrincipalError("TRACKER_BACKEND_TOKENS_FILE must name a regular file");
  if (platform !== "win32" && (st.mode & 0o077) !== 0) throw new PrincipalError("TRACKER_BACKEND_TOKENS_FILE must not be readable by group or others (chmod 600)");
  return parsePrincipals(readFileSync(path, "utf8"));
}

/** The principal whose token the Authorization header presents, compared in constant time; undefined when none. */
export function principalFor(header: string | undefined, principals: readonly Principal[]): string | undefined {
  const presented = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  let found: string | undefined;
  for (const p of principals) {
    const expected = Buffer.from(p.token);
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) found = p.id;
  }
  return found;
}
