// Token rules that hold whether or not the fixture layer is loaded (design
// rule 2, review X2): every token differs from every other (backend,
// principals, evidence, control), no token appears on the command line, and
// tokens are compared in constant time. The fixture layer adds loading from a
// 0600 file or the token folder (src/fixture/tokens.ts).

import { timingSafeEqual } from "node:crypto";

export class TokenError extends Error {}

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
    if (value === undefined || value.length === 0) continue;
    // A token of 8 characters or more is looked for anywhere in an argument (--flag=TOKEN, a URL holding it). A shorter
    // one (only a 0.1-style backend token can be that short) would match ordinary words, so an argument must equal it.
    const found = value.length >= 8 ? argv.some((a) => a.includes(value)) : argv.some((a) => a === value || a.endsWith(`=${value}`));
    if (found) {
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
