// The digest (design rule 5): RFC 8785 canonical bytes under a domain tag.
// The vectors in vectors/digest-1.json are checked here in Node and, when
// python3 is on PATH, by the Python verifier (verify/python/tt_digest.py);
// then a seeded batch of random values is canonicalized by both and compared
// byte for byte.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, canonicalizeText, CanonicalizationError, digestOf, fingerprintHash, domainDigest, DOMAINS, findIllFormedString, verifyServed } from "../src/digest.js";

const VECTORS_PATH = fileURLToPath(new URL("../../vectors/digest-1.json", import.meta.url));
const PY = fileURLToPath(new URL("../../verify/python/tt_digest.py", import.meta.url));
const PY_TESTS = fileURLToPath(new URL("../../verify/python/test_tt_digest.py", import.meta.url));

interface Vector { name: string; input_json: string; domain: string; canonical?: string; digest?: string; expect?: "reject"; note: string }
const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as { vectors: string; cases: Vector[] };

const python = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0 ? "python3" : undefined;
/** TT_GATE=1 (gate runs, CI): a missing python3 fails these tests instead of skipping them. */
const GATE = process.env.TT_GATE === "1";
const needPython = python || GATE ? false : "python3 is not on PATH";

/** Seeded PRNG (mulberry32): the same seed gives the same values on every platform. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random JSON values with astral-plane and high-BMP member names, every float magnitude, and nesting. */
function randomValue(rand: () => number, depth = 0): unknown {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const char = () => pick([
    () => String.fromCharCode(0x20 + Math.floor(rand() * 0x5f)),
    () => String.fromCharCode(Math.floor(rand() * 0x20)),
    () => String.fromCharCode(0xe000 + Math.floor(rand() * 0x2000)),
    () => String.fromCodePoint(0x10000 + Math.floor(rand() * 0xfffff)),
    () => pick(["é", "€", " ", "\u007f", "דּ", "￿"]),
  ])();
  const str = () => Array.from({ length: Math.floor(rand() * 6) }, char).join("");
  const num = () => {
    const buf = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) buf.setUint8(i, Math.floor(rand() * 256));
    const n = buf.getFloat64(0);
    return Number.isFinite(n) ? n : rand() * 1e6;
  };
  const kinds = depth > 3 ? ["str", "num", "int", "lit"] : ["str", "num", "int", "lit", "arr", "obj", "obj"];
  switch (pick(kinds)) {
    case "str": return str();
    case "num": return num();
    case "int": return Math.floor((rand() - 0.5) * 2 ** 53);
    case "lit": return pick([true, false, null, 0, -0, 1e21, 1e-7]);
    case "arr": return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(rand() * 5); i > 0; i--) o[str()] = randomValue(rand, depth + 1);
      return o;
    }
  }
}

describe("digest: RFC 8785 canonical bytes under a domain tag", () => {
  it("every vector gives its canonical bytes and digest in Node; every refusal is refused", () => {
    assert.equal(vectors.vectors, "digest-vectors/1");
    for (const v of vectors.cases) {
      if (v.expect === "reject") {
        assert.throws(() => canonicalizeText(v.input_json), CanonicalizationError, v.name);
      } else {
        const canonical = canonicalizeText(v.input_json);
        assert.equal(canonical, v.canonical, v.name);
        assert.equal(domainDigest(v.domain, canonical), v.digest, v.name);
      }
    }
  });

  it("the vectors include astral-plane keys, the float cases and lone surrogates", () => {
    const names = vectors.cases.map((v) => v.name);
    for (const n of ["RFC 8785 member order", "astral key before high BMP key", "floats", "float members", "lone high surrogate in a value"]) {
      assert.ok(names.includes(n), n);
    }
    assert.equal(vectors.cases.find((v) => v.name === "RFC 8785 member order")!.canonical,
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
    assert.match(vectors.cases.find((v) => v.name === "floats")!.canonical!, /^\[1,0,0,1e-7,1e-7,0\.000001,1e\+21,100000000000000000000,/);
  });

  it("the digest is SHA-256 over the domain tag, a line feed and the canonical bytes", async () => {
    const { createHash } = await import("node:crypto");
    const served = digestOf(DOMAINS.executionResult, { b: 1, a: [true, null] });
    assert.equal(served.canonical, '{"a":[true,null],"b":1}');
    assert.equal(served.digest, createHash("sha256").update(`${DOMAINS.executionResult}\n{"a":[true,null],"b":1}`).digest("hex"));
    assert.deepEqual(verifyServed(served), []);
    assert.notEqual(digestOf(DOMAINS.build, { b: 1, a: [true, null] }).digest, served.digest, "another domain, another digest");
    assert.deepEqual(verifyServed({ ...served, canonical: '{"b":1,"a":[true,null]}' }).length, 2, "reordered bytes: wrong digest, not canonical");
    assert.throws(() => domainDigest("no tag", "{}"));
  });

  it("fingerprint_hash: the request-fingerprint/1 domain over principal, method, path and body", () => {
    const v = vectors.cases.find((c) => c.name === "request fingerprint")!;
    assert.equal(fingerprintHash("p-default", "POST", "/tickets", { project: "inbox", title: "First", priority: 2 }), v.digest);
    assert.notEqual(fingerprintHash("p-other", "POST", "/tickets", { project: "inbox", title: "First", priority: 2 }), v.digest);
    assert.throws(() => canonicalizeText('{"a":1,"a":2}'), /appears twice/);
    assert.equal(canonicalizeText('{"a":{"a":1},"b":["a","a"]}'), '{"a":{"a":1},"b":["a","a"]}', "the same name in different objects is fine");
  });

  it("refuses what is not JSON data, and finds ill-formed strings by path", () => {
    for (const bad of [Infinity, NaN, 1n, () => 1, new Date(0), [undefined]]) assert.throws(() => canonicalize(bad), CanonicalizationError);
    assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(findIllFormedString({ ok: "x", list: ["fine", { "t/x": "\ud800" }] }), "/list/1/t~1x");
    assert.equal(findIllFormedString({ "😀": "fine" }), undefined);
  });

  it("the Python verifier agrees on every vector (python3 -I)", { skip: needPython }, () => {
    assert.ok(python, "TT_GATE=1 needs python3 on PATH");
    const r = spawnSync(python!, ["-I", PY, "--vectors", VECTORS_PATH], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^${vectors.cases.length} vectors, 0 problems`, "m"));
    const unit = spawnSync(python!, ["-I", PY_TESTS], { encoding: "utf8" });
    assert.equal(unit.status, 0, unit.stderr);
  });

  it("Node and Python give the same bytes for 2000 seeded random values", { skip: needPython }, () => {
    assert.ok(python, "TT_GATE=1 needs python3 on PATH");
    const rand = prng(20261116);
    const items: Array<{ input_json: string; domain: string }> = [];
    const expected: string[] = [];
    while (items.length < 2000) {
      const value = randomValue(rand);
      const input = JSON.stringify(value);
      if (input === undefined || findIllFormedString(value) !== undefined) continue;
      items.push({ input_json: input, domain: DOMAINS.testVector });
      expected.push(canonicalize(JSON.parse(input)));
    }
    const r = spawnSync(python!, ["-I", PY, "--stdin"], { input: JSON.stringify(items), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout) as Array<{ canonical?: string; digest?: string; error?: string }>;
    let astral = 0;
    for (let i = 0; i < items.length; i++) {
      assert.equal(got[i].error, undefined, `item ${i}: ${items[i].input_json}`);
      assert.equal(got[i].canonical, expected[i], `item ${i}: ${items[i].input_json}`);
      assert.equal(got[i].digest, domainDigest(DOMAINS.testVector, expected[i]));
      if (/[\uD800-\uDBFF]/.test(expected[i])) astral++;
    }
    assert.ok(astral > 100, `astral-plane characters in ${astral} items`);
  });
});
