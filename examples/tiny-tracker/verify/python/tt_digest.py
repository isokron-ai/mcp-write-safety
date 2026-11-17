"""Canonical bytes and digests for tiny-tracker records, in Python (stdlib only).

The same rules as src/digest.ts:

  canonical  RFC 8785 (JSON Canonicalization Scheme): object members sorted by
             their names' UTF-16 code units, no whitespace, numbers written as
             ECMAScript writes them, strings escaped as JSON.stringify does.
             A string or member name holding a lone surrogate is refused.
  digest     lower-case hex SHA-256 over UTF-8(domain) + b"\\n" + UTF-8(canonical).

A verifier given a record's served canonical bytes does not need this module:
it hashes the bytes it was given (domain_digest). This module is for checking
that the bytes are canonical, and for the cross-language vectors.

Usage:
  python3 -I tt_digest.py --vectors ../../vectors/digest-1.json   # check the vectors
  python3 -I tt_digest.py --stdin   # JSON list of JSON texts in, JSON list of results out
"""

import hashlib
import json
import math
import sys


class CanonicalizationError(ValueError):
    pass


def _reject_constant(name):
    raise CanonicalizationError("not JSON: " + name)


def _no_duplicates(pairs):
    seen = set()
    for name, _ in pairs:
        if name in seen:
            raise CanonicalizationError("a member name appears twice in one object: %r" % name)
        seen.add(name)
    return dict(pairs)


def loads(text):
    """Parses JSON text. NaN and Infinity literals and duplicate member names are refused; an out-of-range number
    (float or integer) is refused by canonicalize."""
    return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_no_duplicates)


def _check_string(s):
    for ch in s:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            raise CanonicalizationError("a string is not well-formed Unicode (lone surrogate)")
    return s


_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _string(s):
    _check_string(s)
    out = ['"']
    for ch in s:
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _number(x):
    """ECMAScript Number::toString for a finite double (RFC 8785 section 3.2.2.3)."""
    try:
        x = float(x)
    except OverflowError:
        raise CanonicalizationError("a number out of the double range")
    if math.isnan(x) or math.isinf(x):
        raise CanonicalizationError("not a finite number")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _number(-x)
    r = repr(x)  # shortest digits that round-trip
    mantissa, _, exp = r.partition("e")
    exponent = int(exp) if exp else 0
    whole, _, frac = mantissa.partition(".")
    digits = whole + frac
    point = len(whole) + exponent
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    head = digits if k == 1 else digits[0] + "." + digits[1:]
    return head + "e" + sign + str(abs(e))


def _utf16_key(name):
    return name.encode("utf-16-be", "surrogatepass")


def canonicalize(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        for k in value:
            if not isinstance(k, str):
                raise CanonicalizationError("member names must be strings")
            _check_string(k)
        names = sorted(value, key=_utf16_key)
        return "{" + ",".join(_string(k) + ":" + canonicalize(value[k]) for k in names) + "}"
    raise CanonicalizationError("not JSON data: %s" % type(value).__name__)


def fingerprint_hash(principal, method, path, body):
    """fingerprint_hash in every record: SHA-256 under the request-fingerprint/1 domain (see src/digest.ts)."""
    return domain_digest("dev.writesafety.tiny-tracker/request-fingerprint/1",
                         canonicalize({"body": body, "method": method, "path": path, "principal": principal}))


def domain_digest(domain, canonical):
    h = hashlib.sha256()
    h.update(domain.encode("utf-8"))
    h.update(b"\n")
    h.update(canonical.encode("utf-8"))
    return h.hexdigest()


def run_case(input_json, domain):
    """Returns {"canonical", "digest"} or {"error"}."""
    try:
        canonical = canonicalize(loads(input_json))
    except (CanonicalizationError, ValueError) as e:
        return {"error": str(e)}
    return {"canonical": canonical, "digest": domain_digest(domain, canonical)}


def check_vectors(path):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    problems = []
    for case in doc["cases"]:
        got = run_case(case["input_json"], case["domain"])
        if case.get("expect") == "reject":
            if "error" not in got:
                problems.append("%s: expected a refusal, got %r" % (case["name"], got["canonical"]))
        elif got.get("canonical") != case["canonical"] or got.get("digest") != case["digest"]:
            problems.append("%s: expected %r / %s, got %r" % (case["name"], case["canonical"], case["digest"], got))
    return len(doc["cases"]), problems


def main(argv):
    if len(argv) == 3 and argv[1] == "--vectors":
        count, problems = check_vectors(argv[2])
        for p in problems:
            sys.stdout.write(p + "\n")
        sys.stdout.write("%d vectors, %d problems\n" % (count, len(problems)))
        return 1 if problems else 0
    if len(argv) == 2 and argv[1] == "--stdin":
        items = json.load(sys.stdin)
        out = [run_case(item["input_json"], item["domain"]) for item in items]
        sys.stdout.write(json.dumps(out, ensure_ascii=True) + "\n")
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
