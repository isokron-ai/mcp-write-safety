"""Recounts tiny-tracker's effects from its published evidence, independently of tiny-tracker (stdlib only).

A third party recounts from files, not from a live server: the export
(GET /export), the execution ledger (GET /ledger), and optionally the execution
records (GET /executions) and, from 0.3.0, the journal (journal-format/1,
JSONL). The three derivations the fixture's own tests compare (ledger, journal
replay, export) are recomputed here a second time, in another language, from
the raw files:

  executions  every execution id, and the count per (principal, run, operation tag, key),
              from the ledger, from the execution records and from the journal; they must agree;
  objects     the tickets (and their comments) that the recorded writes leave behind, derived from
              the ledger (creations minus deletions minus run resets), must be exactly the tickets
              and comments the export holds;
  digests     every execution record's served digest is SHA-256 over its domain tag and served
              canonical bytes, and the bytes are RFC 8785 (tt_digest.py); from the journal, the digest is
              recomputed from each committed body and must equal the record's served digest;
  journal     every line's jseq is contiguous and its checksum holds, commit_seq is contiguous, and an unknown line
              kind is refused (only a torn last line, unterminated and not decodable, is tolerated, and from 0.4.0 a
              torn fragment a later write joined); from 0.4.0 a superseded writer's lines (lease epochs) are left out.
              The journal holds every principal's writes: --principal keeps the one the ledger was read for.

  python3 -I tt_recount.py --export export.json --ledger ledger.json [--executions executions.json]
                           [--journal journal.jsonl [--principal P]] [--operation TAG [--key K]] [--json]

Exit 0: every derivation agrees. Exit 1: a disagreement (each one is listed). Exit 2: a file is missing or
unreadable. --operation prints the effect count of one operation (the contract's counter: executions
attributed by operation tag and by K, or no key at all).

What it cannot recount: a batch write (POST /batch) names its objects but not which were deleted, so with
batch writes present the object comparison covers only tickets no batch write touched, and says so.
"""

import hashlib
import json
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's own folder off sys.path

import tt_digest  # noqa: E402

EXECUTION_DOMAIN = "dev.writesafety.tiny-tracker/execution-result/1"
TICKET_PATH = re.compile(r"^/tickets/([^/]+)$")
COMMENTS_PATH = re.compile(r"^/tickets/([^/]+)/comments$")


def read_json_or_lines(path):
    """A JSON document, or JSON Lines (one value per non-empty line)."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        return json.loads(text)
    except ValueError:
        return [json.loads(line) for line in text.splitlines() if line.strip()]


def as_list(doc, *members):
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict):
        for m in members:
            if isinstance(doc.get(m), list):
                return doc[m]
    raise ValueError("expected a list or an object with one of %s" % ", ".join(members))


def find_records(value, kind, out=None, depth=0):
    """Every object whose "record" member is kind, depth-first (the journal's line layout is the journal's own)."""
    out = [] if out is None else out
    if depth > 8:
        return out
    if isinstance(value, dict):
        if value.get("record") == kind:
            out.append(value)
            return out
        for v in value.values():
            find_records(v, kind, out, depth + 1)
    elif isinstance(value, list):
        for v in value:
            find_records(v, kind, out, depth + 1)
    return out


# journal-format/1's line kinds (tiny-tracker INTERFACES 1.9; lookup-fence is the additive 0.3.0 kind, clock the
# additive 0.4.0 kind: a fixture clock move, lease the additive 0.4.0 kind: a start took the data-dir lease).
JOURNAL_LINE_KINDS = frozenset(["header", "commit", "pending", "aborted", "fence", "run-alloc", "lookup-fence", "clock", "lease"])

# Where a line can start inside a physical line: a torn fragment that a later write joined (tiny-tracker 0.4.0 never cuts
# the file, so the bytes of a write cut short stay in front of the next line).
LINE_START = re.compile(r'\{"jseq"\s*:')


def _decode(text):
    """One journal line, or None when it does not parse, has no integer jseq, or its checksum does not hold."""
    try:
        line = json.loads(text)
        if not isinstance(line, dict) or not isinstance(line.get("jseq"), int) or isinstance(line.get("jseq"), bool):
            return None
        body = {k: v for k, v in line.items() if k != "checksum"}
        if hashlib.sha256(tt_digest.canonicalize(body).encode("utf-8")).hexdigest() != line.get("checksum"):
            return None
        return line
    except (ValueError, AttributeError, TypeError, tt_digest.CanonicalizationError):
        return None


def split_joined(text):
    """A physical line split into ("line", obj) and ("junk", text) pieces: a torn fragment, then the whole line that joined it."""
    whole = _decode(text)
    if whole is not None:
        return [("line", whole)]
    for m in LINE_START.finditer(text, 1):
        tail = _decode(text[m.start():])
        if tail is not None:
            return split_joined(text[:m.start()]) + [("line", tail)]
    return [("junk", text)]


def _epoch(line):
    return 0 if line.get("line") == "header" else (line.get("epoch") or 0)


def scan_journal(text):
    """The lines a tiny-tracker start applies, as tiny-tracker's own reader decides them (0.4.0, G3 note 26 item 1).

    Returns (applied, superseded, problems). A fragment followed by a whole line on its physical line is left out; a
    physical line that holds no whole line is a problem, except an unterminated last one (a torn write). Epochs: a line
    whose epoch is lower than a lease line before it is a superseded writer's; a lease line also supersedes the lines
    before it with a jseq of its own or higher (of a lower epoch); a lease line whose epoch is not above the current one,
    or a header after a lease line, is a start that lost the race. Every line after a lease line carries an epoch; a line
    without one there, or with an epoch no lease line took, is a problem. Superseded lines must still be of a known kind.
    """
    problems = []
    parts = text.split("\n")
    terminated = parts[-1] == ""
    if terminated:
        parts.pop()
    lines = []
    for i, part in enumerate(parts):
        pieces = split_joined(part)
        if len(pieces) == 1 and pieces[0][0] == "junk":
            if i == len(parts) - 1 and not terminated:
                break  # a torn write: an unterminated last line that does not decode (decision 0003)
            lines.append(None)  # a bad line: named at its place below
            continue
        lines.extend(obj for kind, obj in pieces if kind == "line")
    applied, superseded = [], []
    epoch = 0
    for line in lines:
        expected = len(applied)
        if line is None:
            problems.append("journal: line jseq %d has a bad jseq or checksum" % expected)
            applied.append(None)
            continue
        kind = line.get("line")
        if not applied:
            if kind != "header" or line.get("jseq") != 0:
                problems.append("journal: line jseq 0 is not the header")
            applied.append(line)
            continue
        if kind not in JOURNAL_LINE_KINDS:
            problems.append("journal: line jseq %d has an unknown line kind %r; this reader knows %s and does not skip a line"
                            % (expected, kind, ", ".join(sorted(JOURNAL_LINE_KINDS))))
            applied.append(None)
            continue
        ep = line.get("epoch")
        if ep is not None and (not isinstance(ep, int) or isinstance(ep, bool) or ep < 0):
            problems.append("journal: line jseq %d has an epoch that is not a non-negative integer" % line.get("jseq"))
            continue
        if kind == "header":
            if epoch == 0:
                problems.append("journal: line jseq %d is a second header" % expected)
            else:
                superseded.append(line)
            continue
        if kind == "lease":
            if not isinstance(ep, int) or ep < 1:
                problems.append("journal: line jseq %d is a lease line without a positive epoch" % line.get("jseq"))
                continue
            if ep <= epoch:
                superseded.append(line)
                continue
            while len(applied) > 1 and applied[-1] is not None and applied[-1].get("jseq") >= line.get("jseq"):
                popped = applied.pop()
                if _epoch(popped) >= ep:
                    problems.append("journal: the lease line of epoch %d (jseq %d) follows a line of epoch %d with jseq %d"
                                    % (ep, line.get("jseq"), _epoch(popped), popped.get("jseq")))
                superseded.append(popped)
            epoch = ep
            applied.append(line)
            continue
        if epoch > 0 and ep is None:
            problems.append("journal: line jseq %d (%s) has no epoch, after a lease line" % (line.get("jseq"), kind))
            continue
        if (ep or 0) < epoch:
            superseded.append(line)
            continue
        if (ep or 0) > epoch:
            problems.append("journal: line jseq %d has epoch %d, and no lease line before it took that epoch" % (line.get("jseq"), ep))
            continue
        applied.append(line)
    return applied, superseded, problems


def journal_executions(path, principal=None):
    """Execution records derived from a journal-format/1 file (tiny-tracker decision 0003, INTERFACES 1.9).

    The journal keeps post-state, not records: each commit line holds the committed transaction. A write's record
    is derived from it here: id X-<commit_seq>, principal, run and operation tag, key, objects, and the result
    digest recomputed from the committed body (RFC 8785 bytes under the execution-result domain tag). Every line's
    jseq and checksum (SHA-256 of the line's RFC 8785 bytes without the checksum member) are checked, as tiny-tracker's
    own reader does (G2 fold-in 10): the first line is the header, jseq is contiguous over the lines a start applies,
    commit_seq is contiguous from 1 over every principal's commits, and a line kind this reader does not know is refused,
    never skipped (an older reader must not pass over a fence). From 0.4.0 the lease epochs decide which lines apply
    (scan_journal): a superseded writer's line is left out, as a torn fragment a later write joined is. Only a torn
    write is tolerated otherwise: an unterminated last line that does not decode. Returns (records, problems).
    `principal` keeps one principal's writes (the ledger and the export a third party reads are filtered by
    ?principal=; the journal holds every principal's).
    """
    records = []
    with open(path, encoding="utf-8") as f:
        applied, _superseded, problems = scan_journal(f.read())
    last_commit = 0
    for i, line in enumerate(applied):
        if line is None:
            last_commit = None  # a bad line may have been a commit: the next commit line sets the count again
            continue
        if line.get("jseq") != i:
            problems.append("journal: line jseq %d has a bad jseq or checksum" % i)
            continue
        kind = line.get("line")
        if i > 0 and kind == "header":
            problems.append("journal: line jseq %d is a second header" % i)
            continue
        if kind != "commit":
            continue
        if last_commit is not None and line.get("commit_seq") != last_commit + 1:
            problems.append("journal: line jseq %d has commit_seq %r where %d was expected" % (i, line.get("commit_seq"), last_commit + 1))
        if isinstance(line.get("commit_seq"), int):
            last_commit = line["commit_seq"]
        tx = line.get("tx") or {}
        if tx.get("kind") != "write" or not tx.get("request"):
            continue
        if principal is not None and tx.get("principal") != principal:
            continue
        if line.get("commit_seq") != tx.get("seq"):
            problems.append("journal: line jseq %d has commit_seq %r for transaction %r" % (i, line.get("commit_seq"), tx.get("seq")))
        canonical = tt_digest.canonicalize(tx.get("body"))
        attribution_ = tx.get("attribution") or {}
        records.append({
            "record": "execution-record/1", "id": "X-%s" % tx.get("seq"), "principal": tx.get("principal"),
            "run": attribution_.get("run"), "operation_tag": attribution_.get("operation"),
            "request": {"key": (tx.get("request") or {}).get("key")},
            "objects": tx.get("objects") or [],
            "result": {"domain": EXECUTION_DOMAIN, "canonical": canonical, "digest": tt_digest.domain_digest(EXECUTION_DOMAIN, canonical)},
        })
    return records, problems


def attribution(principal, run, operation_tag, key):
    return (principal, run, operation_tag, key)


def label(t):
    return "principal=%s run=%s operation=%s key=%s" % t


def from_ledger(entries):
    ids, counts = [], Counter()
    for e in entries:
        if e.get("kind") != "execution":
            continue
        ids.append(e.get("execution_id"))
        counts[attribution(e.get("principal"), e.get("run"), e.get("operation_tag"), (e.get("request") or {}).get("key"))] += 1
    return ids, counts


def from_executions(records):
    ids, counts = [], Counter()
    for r in records:
        ids.append(r.get("id"))
        counts[attribution(r.get("principal"), r.get("run"), r.get("operation_tag"), (r.get("request") or {}).get("key"))] += 1
    return ids, counts


def check_digests(records, source):
    problems = []
    for r in records:
        served = r.get("result") or {}
        if served.get("domain") != EXECUTION_DOMAIN:
            problems.append("%s %s: result domain is %r, not %s" % (source, r.get("id"), served.get("domain"), EXECUTION_DOMAIN))
            continue
        if not isinstance(served.get("canonical"), str) or tt_digest.domain_digest(served["domain"], served["canonical"]) != served.get("digest"):
            problems.append("%s %s: the served digest is not SHA-256 of the domain tag and the served bytes" % (source, r.get("id")))
            continue
        try:
            if tt_digest.canonicalize(tt_digest.loads(served["canonical"])) != served["canonical"]:
                problems.append("%s %s: the served bytes are not RFC 8785 canonical" % (source, r.get("id")))
        except (tt_digest.CanonicalizationError, ValueError) as e:
            problems.append("%s %s: the served bytes do not parse: %s" % (source, r.get("id"), e))
    return problems


def live_from_ledger(entries):
    """Tickets and comments the recorded writes leave, from the ledger alone; and the tickets a batch write touched."""
    tickets, comments, ticket_run, batch_touched = {}, {}, {}, set()
    for e in sorted(entries, key=lambda e: e.get("seq") or 0):
        kind = e.get("kind")
        if kind == "run-reset":
            run = e.get("run")
            for tid in [t for t, r in ticket_run.items() if r == run]:
                tickets.pop(tid, None)
                ticket_run.pop(tid, None)
            for cid in [c for c, (_, r) in comments.items() if r == run]:
                comments.pop(cid, None)
            continue
        if kind != "execution":
            continue
        req = e.get("request") or {}
        method, path = req.get("method"), req.get("path") or ""
        objects = e.get("objects") or []
        if method == "POST" and path == "/tickets":
            for o in objects:
                if o.get("type") == "ticket":
                    tickets[o["id"]] = True
                    ticket_run[o["id"]] = e.get("run")
        elif method == "POST" and COMMENTS_PATH.match(path):
            for o in objects:
                if o.get("type") == "comment":
                    comments[o["id"]] = (COMMENTS_PATH.match(path).group(1), e.get("run"))
        elif method == "DELETE" and TICKET_PATH.match(path):
            tid = TICKET_PATH.match(path).group(1)
            tickets.pop(tid, None)
            ticket_run.pop(tid, None)
            for cid in [c for c, (t, _) in comments.items() if t == tid]:
                comments.pop(cid, None)
        elif path == "/batch":
            batch_touched.update(o.get("id") for o in objects if o.get("type") == "ticket")
    return set(tickets), set(comments), batch_touched


def live_from_export(export):
    tickets = as_list(export, "tickets") if isinstance(export, dict) and "tickets" in export else []
    ids = {t.get("id") for t in tickets}
    comments = {c.get("id") for t in tickets for c in (t.get("comments") or []) if isinstance(c, dict)}
    return ids, comments


def recount(export, entries, executions=None, journal=None, journal_problems=None):
    """The comparison, as a dict: sources, counts, problems."""
    problems = list(journal_problems or [])
    out = {"sources": ["ledger", "export"] + (["executions"] if executions is not None else []) + (["journal"] if journal is not None else [])}
    ledger_ids, ledger_counts = from_ledger(entries)
    out["executions"] = {"ledger": len(ledger_ids)}
    seqs = [e.get("seq") for e in entries]
    if seqs != sorted(seqs) or len(set(seqs)) != len(seqs):
        problems.append("ledger: sequence numbers are not strictly increasing")
    if len(set(ledger_ids)) != len(ledger_ids):
        problems.append("ledger: an execution id appears in two execution entries")
    for name, records in (("executions", executions), ("journal", journal)):
        if records is None:
            continue
        ids, counts = from_executions(records)
        out["executions"][name] = len(ids)
        if sorted(ids, key=str) != sorted(ledger_ids, key=str):
            missing = sorted(set(ledger_ids) - set(ids), key=str)
            extra = sorted(set(ids) - set(ledger_ids), key=str)
            problems.append("%s and ledger name different executions (only in the ledger: %s; only in %s: %s)" % (name, missing or "none", name, extra or "none"))
        for t in sorted(set(counts) | set(ledger_counts), key=lambda t: tuple(str(x) for x in t)):
            if counts[t] != ledger_counts[t]:
                problems.append("%s: %d execution(s) for %s, the ledger %d" % (name, counts[t], label(t), ledger_counts[t]))
        problems.extend(check_digests(records, name))
    if executions is not None and journal is not None:
        # The journal's digest is recomputed from the committed body: it must equal the digest the record serves.
        served = {r.get("id"): (r.get("result") or {}).get("digest") for r in executions}
        for r in journal:
            if r["id"] in served and served[r["id"]] != r["result"]["digest"]:
                problems.append("journal %s: the result digest recomputed from the committed body is not the served one" % r["id"])
    live_tickets, live_comments, batch = live_from_ledger(entries)
    exp_tickets, exp_comments = live_from_export(export)
    compared_tickets = {t for t in exp_tickets | live_tickets if t not in batch}
    out["objects"] = {"tickets_in_export": len(exp_tickets), "tickets_from_ledger": len(live_tickets),
                      "comments_in_export": len(exp_comments), "comments_from_ledger": len(live_comments),
                      "batch_touched_tickets_not_compared": sorted(batch)}
    only_export = sorted((exp_tickets - live_tickets) & compared_tickets)
    only_ledger = sorted((live_tickets - exp_tickets) & compared_tickets)
    if only_export:
        problems.append("export holds ticket(s) no recorded write created: %s" % ", ".join(only_export))
    if only_ledger:
        problems.append("the ledger leaves ticket(s) the export does not hold: %s" % ", ".join(only_ledger))
    if exp_comments - live_comments:
        problems.append("export holds comment(s) no recorded write created: %s" % ", ".join(sorted(exp_comments - live_comments)))
    if live_comments - exp_comments:
        problems.append("the ledger leaves comment(s) the export does not hold: %s" % ", ".join(sorted(live_comments - exp_comments)))
    out["problems"] = problems
    return out


def operation_count(entries, operation_tag, key=None):
    """The contract's counter: executions attributed to one operation tag, whose key is K or absent."""
    ids = [e.get("execution_id") for e in entries if e.get("kind") == "execution" and e.get("operation_tag") == operation_tag
           and (key is None or (e.get("request") or {}).get("key") in (key, None))]
    return {"operation_tag": operation_tag, "key": key, "external_effect_count": len(ids), "execution_record_ids": ids}


def main(argv):
    args = argv[1:]
    opts = {"--json": False}
    while args:
        a = args.pop(0)
        if a in ("--export", "--ledger", "--executions", "--journal", "--principal", "--operation", "--key") and args:
            opts[a] = args.pop(0)
        elif a == "--json":
            opts["--json"] = True
        else:
            sys.stderr.write(__doc__)
            return 2
    if "--export" not in opts or "--ledger" not in opts:
        sys.stderr.write(__doc__)
        return 2
    try:
        export = read_json_or_lines(opts["--export"])
        entries = as_list(read_json_or_lines(opts["--ledger"]), "entries", "ledger")
        executions = as_list(read_json_or_lines(opts["--executions"]), "executions") if "--executions" in opts else None
        journal, journal_problems = journal_executions(opts["--journal"], opts.get("--principal")) if "--journal" in opts else (None, [])
    except (OSError, ValueError) as e:
        sys.stderr.write("tt_recount: %s\n" % e)
        return 2
    result = recount(export, entries, executions, journal, journal_problems)
    if "--operation" in opts:
        result["operation"] = operation_count(entries, opts["--operation"], opts.get("--key"))
    if opts["--json"]:
        sys.stdout.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
    else:
        e = result["executions"]
        sys.stdout.write("executions: %s\n" % ", ".join("%s %d" % (k, v) for k, v in sorted(e.items())))
        o = result["objects"]
        sys.stdout.write("tickets: export %d, ledger %d; comments: export %d, ledger %d\n" % (
            o["tickets_in_export"], o["tickets_from_ledger"], o["comments_in_export"], o["comments_from_ledger"]))
        if "operation" in result:
            op = result["operation"]
            sys.stdout.write("operation %s: %d execution(s) %s\n" % (op["operation_tag"], op["external_effect_count"], op["execution_record_ids"]))
        for p in result["problems"]:
            sys.stdout.write("disagreement: %s\n" % p)
        sys.stdout.write("%d sources, %d disagreements\n" % (len(result["sources"]), len(result["problems"])))
    return 1 if result["problems"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
