// Canonical bytes and digests (design rule 5).
//
// Canonical form: the JSON Canonicalization Scheme, RFC 8785. Object members
// sorted by their names' UTF-16 code units, no whitespace, numbers written as
// ECMAScript writes them (1.0 is "1", -0 is "0", 1e-7 is "1e-7", 1e21 is
// "1e+21"), strings escaped as JSON.stringify escapes them. Strings that are
// not well-formed Unicode (a lone surrogate) are refused, never encoded.
//
// Digest: SHA-256 over the UTF-8 bytes of a domain tag, one line feed (0x0A),
// and the canonical bytes. The domain tag names what was hashed and its
// version (`dev.writesafety.tiny-tracker/execution-result/1`), so a digest of
// one kind of object can never be taken for a digest of another, or for a hash
// of some other JSON. Records serve the canonical bytes themselves, as a
// string, so a verifier hashes the bytes it was given and needs no
// canonicalizer of its own; it can still check that they parse to the served
// object. Cross-language vectors: vectors/digest-1.json, checked in Node by
// test/digest.test.ts and in Python by verify/python/tt_digest.py.

import { createHash } from "node:crypto";

export const DIGEST_ALG = "sha-256";

/** Domain tags in use. A new kind of hashed object gets its own tag; a change to an object's canonical form gets a new version. */
export const DOMAINS = {
  executionResult: "dev.writesafety.tiny-tracker/execution-result/1",
  build: "dev.writesafety.tiny-tracker/build/1",
  buildDescriptor: "dev.writesafety.tiny-tracker/build-descriptor/1",
  testVector: "dev.writesafety.tiny-tracker/test-vector/1",
} as const;

const DOMAIN_PATTERN = /^[a-z0-9.-]+(\/[a-z0-9-]+)+\/[0-9]+$/;

export class CanonicalizationError extends Error {}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the string has no lone surrogate (String.prototype.isWellFormed, written out for the ES2023 lib). */
export function isWellFormedString(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

/** The JSON pointer of the first string (value or member name) that is not well-formed, or undefined. */
export function findIllFormedString(value: unknown, path = ""): string | undefined {
  if (typeof value === "string") return isWellFormedString(value) ? undefined : path || "/";
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findIllFormedString(value[i], `${path}/${i}`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (!isWellFormedString(k)) return p;
      const hit = findIllFormedString(v, p);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeString(s: string): string {
  if (!isWellFormedString(s)) throw new CanonicalizationError("a string is not well-formed Unicode (lone surrogate)");
  return JSON.stringify(s);
}

/**
 * RFC 8785 canonical JSON of a JSON value. Object members whose value is undefined are left out, as JSON.stringify
 * leaves them out; anything that is not JSON data (a non-finite number, a bigint, a function, a class instance, an
 * undefined array element) is refused.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(`not a finite number: ${value}`);
      // ECMAScript Number::toString is the RFC 8785 number form; -0 is written "0".
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return serializeString(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => {
          if (v === undefined) throw new CanonicalizationError("an array element is undefined");
          return canonicalize(v);
        }).join(",")}]`;
      }
      if (!isPlainObject(value)) throw new CanonicalizationError("not a plain JSON object");
      const names = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined);
      // Default string order compares UTF-16 code units: the order RFC 8785 asks for.
      names.sort();
      return `{${names.map((k) => `${serializeString(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`not JSON data: ${typeof value}`);
  }
}

export function checkDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) throw new CanonicalizationError(`not a domain tag: ${domain}`);
}

/** SHA-256 (lower-case hex) over UTF-8(domain), 0x0A, UTF-8(canonical). */
export function domainDigest(domain: string, canonical: string): string {
  checkDomain(domain);
  return createHash("sha256").update(domain, "utf8").update("\n", "utf8").update(canonical, "utf8").digest("hex");
}

/** What a record serves for one hashed object. */
export interface ServedDigest {
  alg: typeof DIGEST_ALG;
  domain: string;
  /** The exact canonical bytes that were hashed, as a string. */
  canonical: string;
  /** Lower-case hex. */
  digest: string;
}

export function digestOf(domain: string, value: unknown): ServedDigest {
  const canonical = canonicalize(value);
  return { alg: DIGEST_ALG, domain, canonical, digest: domainDigest(domain, canonical) };
}

/** Checks served canonical bytes: they hash to the digest and parse to the same canonical form. Returns the problems found. */
export function verifyServed(served: ServedDigest): string[] {
  const problems: string[] = [];
  if (served.alg !== DIGEST_ALG) problems.push(`alg is ${served.alg}, not ${DIGEST_ALG}`);
  if (domainDigest(served.domain, served.canonical) !== served.digest) problems.push("the digest is not SHA-256 of the domain tag and the served bytes");
  try {
    if (canonicalize(JSON.parse(served.canonical)) !== served.canonical) problems.push("the served bytes are not in canonical form");
  } catch (e) {
    problems.push(`the served bytes do not parse: ${(e as Error).message}`);
  }
  return problems;
}
