"""An external recount of a tiny-tracker journal (journal-format/1), for review T3.

Reads the journal with Python's own JSON parser and the Python RFC 8785
canonicalizer (verify/python/tt_digest.py), checks every line's jseq and
checksum, and rebuilds the tickets and projects from the header's seed and the
commit lines' post-state. Prints one JSON object:
  {"tickets": {id: [version, title]}, "projects": [keys], "commits": n,
   "keyed_effects": {"principal key": count}}

Usage: python3 -I recount_journal.py <tt_digest.py dir> <journal.jsonl>
"""

import hashlib
import json
import sys


def main(argv):
    sys.path.insert(0, argv[1])
    import tt_digest  # noqa: E402

    lines = open(argv[2], encoding="utf-8").read().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    projects, tickets, effects = {}, {}, {}
    commits = 0
    for i, text in enumerate(lines):
        line = tt_digest.loads(text)
        checksum = line.pop("checksum")
        if hashlib.sha256(tt_digest.canonicalize(line).encode("utf-8")).hexdigest() != checksum:
            raise SystemExit(f"line {i}: checksum mismatch")
        if line["jseq"] != i:
            raise SystemExit(f"line {i}: jseq {line['jseq']}")
        if line["line"] == "header":
            for p in line["seed"]["projects"]:
                projects[p["key"]] = p
        elif line["line"] == "commit":
            commits += 1
            if line["commit_seq"] != commits:
                raise SystemExit(f"line {i}: commit_seq {line['commit_seq']}")
            tx = line["tx"]
            post = tx["post"]
            for p in post["upserts"]["projects"]:
                projects[p["key"]] = p
            for t in post["upserts"]["tickets"]:
                tickets[t["id"]] = t
            for k in post["deletes"]["projects"]:
                projects.pop(k, None)
            for k in post["deletes"]["tickets"]:
                tickets.pop(k, None)
            key = tx["request"]["key"]
            if tx["kind"] == "write" and key is not None and tx["request"]["fingerprint"] is not None:
                name = f"{tx['principal']} {key}"
                effects[name] = effects.get(name, 0) + 1
    print(json.dumps({
        "tickets": {i: [t["version"], t["title"]] for i, t in tickets.items()},
        "projects": sorted(projects),
        "commits": commits,
        "keyed_effects": effects,
    }, sort_keys=True))


if __name__ == "__main__":
    main(sys.argv)
