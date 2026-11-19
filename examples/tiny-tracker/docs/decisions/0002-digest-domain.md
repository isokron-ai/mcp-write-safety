# 0002. Digests: RFC 8785 canonical bytes, served, under a type/version domain tag

- Status: accepted (16 Nov 2026)
- Applies from: Phase 0 (code and vectors); execution records use it from 0.2.0

## Context

A lost-response check compares the digest of a recovered result with the digest of the committed one. That only works if every party computes the same bytes. Canonical JSON is easy to get almost right: a canonicalizer that sorts member names by code point, rather than by UTF-16 code unit, differs as soon as a name holds a character outside the Basic Multilingual Plane; one that writes `1.0` or `-0.0` or `1e-07` as its language does differs on numbers; and a string holding a lone surrogate can be hashed in one language and cannot be encoded as UTF-8 in another.

A bare SHA-256 of JSON also says nothing about what was hashed.

## Decision

1. **Canonical form:** RFC 8785 (JSON Canonicalization Scheme). Member names sorted by UTF-16 code units; no whitespace; numbers as ECMAScript writes them; strings escaped as `JSON.stringify` escapes them; no Unicode normalization. A member whose value is undefined is left out; anything that is not JSON data (a non-finite number, a lone surrogate in a string or a member name) is refused, never hashed.
2. **Domain tag:** every digest is SHA-256 over `UTF-8(domain) || 0x0A || UTF-8(canonical)`. The domain names the object and its version, e.g. `dev.writesafety.tiny-tracker/execution-result/1`. A new kind of hashed object gets a new tag; a change to an object's canonical form gets a new version.
3. **Serve the bytes:** a record carries `{alg, domain, canonical, digest}`. A verifier hashes the served bytes and needs no canonicalizer; it can still parse them and check they are canonical.
4. **Refuse ill-formed strings at the backend** (feature `strict-input`), so every stored string can be encoded as UTF-8 and hashed the same way in any language.
5. **Vectors:** `vectors/digest-1.json`, checked in Node (`test/digest.test.ts`) and in Python (`verify/python/tt_digest.py`, standard library only). They include the RFC 8785 member-order example, astral-plane names next to high-BMP names, the float cases (`1.0`, `-0.0`, `1e-7`, `0.000001`, `1e21`, `2^53 + 1`) and refusals. A seeded batch of random values is compared byte for byte between the two languages on every test run.
6. **Name:** the object that carries a committed result and its digest is an **execution record**. "Receipt" keeps its MWS meaning, the compact result every write tool returns.

## Consequences

- Any language with SHA-256 can verify a served digest. A language with a JSON parser and the vectors can check canonical form.
- A digest of an execution result can never match a digest of a build descriptor or of other JSON.
- The domain tag means a plain `sha256(canonical)` does not match: a harness that expects one must include the tag. The contract adapter does.
