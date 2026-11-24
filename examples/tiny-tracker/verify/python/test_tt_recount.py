"""Unit tests for tt_recount (stdlib unittest). Run: python3 -I verify/python/test_tt_recount.py"""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's own folder off sys.path

import tt_digest  # noqa: E402
import tt_recount  # noqa: E402

DOMAIN = tt_recount.EXECUTION_DOMAIN


def execution(seq, method, path, key, objects, body, run="run-a-1", op="op-1", principal="p-default"):
    canonical = tt_digest.canonicalize(body)
    return {"record": "execution-record/1", "id": "X-%d" % seq, "principal": principal, "run": run, "operation_tag": op,
            "boot_id": "0123456789abcdef", "seq": seq,
            "request": {"method": method, "path": path, "key": key, "fingerprint_hash": "0" * 64},
            "objects": objects, "result": {"alg": "sha-256", "domain": DOMAIN, "canonical": canonical,
                                            "digest": tt_digest.domain_digest(DOMAIN, canonical)},
            "committed_at": "2026-11-16T20:00:00.000Z", "clock_offset_ms": 0}


def entry(seq, rec=None, kind="execution", run=None):
    base = {"entry": "ledger-entry/1", "seq": seq, "at": "2026-11-16T20:00:00.000Z", "clock_offset_ms": 0,
            "boot_id": "0123456789abcdef", "kind": kind, "principal": None, "run": run, "operation_tag": None,
            "request": None, "status": None, "execution_id": None, "objects": [], "fault": None}
    if rec:
        base.update(principal=rec["principal"], run=rec["run"], operation_tag=rec["operation_tag"], request=rec["request"],
                    status=201, execution_id=rec["id"], objects=rec["objects"])
    return base


def history():
    x1 = execution(1, "POST", "/tickets", "key-00000001", [{"type": "ticket", "id": "T-1"}], {"ticket": {"id": "T-1"}})
    x2 = execution(2, "POST", "/tickets", None, [{"type": "ticket", "id": "T-2"}], {"ticket": {"id": "T-2"}}, op="op-2")
    x3 = execution(3, "POST", "/tickets/T-1/comments", None, [{"type": "comment", "id": "C-1"}], {"comment": {"id": "C-1"}}, op="op-3")
    x4 = execution(4, "DELETE", "/tickets/T-2", None, [{"type": "ticket", "id": "T-2"}], {"deleted": "T-2"}, op="op-4")
    x5 = execution(5, "POST", "/tickets", "key-00000005", [{"type": "ticket", "id": "T-3"}], {"ticket": {"id": "T-3"}}, run="run-b-2", op="op-5")
    entries = [entry(1, kind="start"), entry(2, x1), entry(3, kind="replay"), entry(4, x2), entry(5, x3), entry(6, x4),
               entry(7, x5), entry(8, kind="run-reset", run="run-b-2")]
    export = {"projects": [{"key": "inbox"}], "tickets": [{"id": "T-1", "comments": [{"id": "C-1"}]}]}
    return export, entries, [x1, x2, x3, x4, x5]


class Recount(unittest.TestCase):
    def test_three_sources_agree(self):
        export, entries, records = history()
        out = tt_recount.recount(export, entries, records, journal=records)
        self.assertEqual(out["problems"], [])
        self.assertEqual(out["executions"], {"ledger": 5, "executions": 5, "journal": 5})
        self.assertEqual(out["objects"]["tickets_from_ledger"], 1, "T-2 deleted, T-3 removed by its run's reset")

    def test_a_missing_or_extra_execution_is_named(self):
        export, entries, records = history()
        out = tt_recount.recount(export, entries, records[:-1])
        self.assertTrue(any("only in the ledger: ['X-5']" in p for p in out["problems"]), out["problems"])

    def test_an_object_without_a_recorded_creation_is_named(self):
        export, entries, records = history()
        export["tickets"].append({"id": "T-9"})
        out = tt_recount.recount(export, entries, records)
        self.assertIn("export holds ticket(s) no recorded write created: T-9", out["problems"])

    def test_a_ticket_the_export_lost_is_named(self):
        export, entries, records = history()
        export["tickets"] = []
        problems = tt_recount.recount(export, entries, records)["problems"]
        self.assertIn("the ledger leaves ticket(s) the export does not hold: T-1", problems)
        self.assertIn("the ledger leaves comment(s) the export does not hold: C-1", problems)

    def test_digest_problems(self):
        export, entries, records = history()
        records[0]["result"]["digest"] = tt_digest.domain_digest("dev.writesafety.tiny-tracker/other/1", records[0]["result"]["canonical"])
        records[1]["result"]["canonical"] = '{"ticket": {"id": "T-2"}}'
        records[1]["result"]["digest"] = tt_digest.domain_digest(DOMAIN, records[1]["result"]["canonical"])
        problems = tt_recount.recount(export, entries, records)["problems"]
        self.assertTrue(any("X-1: the served digest is not SHA-256" in p for p in problems), problems)
        self.assertTrue(any("X-2: the served bytes are not RFC 8785" in p for p in problems), problems)

    def test_a_count_mismatch_per_attribution(self):
        export, entries, records = history()
        records[1] = dict(records[1], operation_tag="op-other")
        problems = tt_recount.recount(export, entries, records)["problems"]
        self.assertTrue(any("operation=op-other" in p for p in problems), problems)

    def test_operation_count_takes_key_K_or_none(self):
        _, entries, _ = history()
        self.assertEqual(tt_recount.operation_count(entries, "op-1", "key-00000001")["external_effect_count"], 1)
        self.assertEqual(tt_recount.operation_count(entries, "op-2", "key-00000002")["external_effect_count"], 1, "a dropped key still counts")
        self.assertEqual(tt_recount.operation_count(entries, "op-5", "key-other")["external_effect_count"], 0)

    def write_journal(self, records, tamper=None, torn=True, other_principal=False, extra=None, raw_tail=None):
        """A journal-format/1 file shaped as tiny-tracker writes it (INTERFACES 1.9): jseq and checksum on every line."""
        import hashlib
        lines = [{"jseq": 0, "line": "header", "journal": "journal-format/1", "writer": "0.3.0", "boot_id": "0123456789abcdef", "seed": {}}]
        for r in records:
            tx = {"kind": "write", "seq": r["seq"], "principal": r["principal"],
                  "attribution": {"run": r["run"], "operation": r["operation_tag"]},
                  "request": {"method": r["request"]["method"], "path": r["request"]["path"], "key": r["request"]["key"]},
                  "objects": r["objects"], "body": tt_digest.loads(r["result"]["canonical"])}
            lines.append({"jseq": len(lines), "line": "commit", "commit_seq": r["seq"], "pending_jseq": None, "tx": tx})
        if other_principal:
            seq = records[-1]["seq"] + 1
            lines.append({"jseq": len(lines), "line": "commit", "commit_seq": seq, "pending_jseq": None,
                          "tx": {"kind": "write", "seq": seq, "principal": "p-second", "attribution": {"run": None, "operation": None},
                                 "request": {"method": "POST", "path": "/tickets", "key": None}, "objects": [], "body": {}}})
        lines.append({"jseq": len(lines), "line": "run-alloc", "run_id": "run-0123abcd-0123456789ab", "principal": "p-default", "created_at": "t", "label": None})
        for e in extra or []:
            lines.append(dict(e, jseq=len(lines)))
        text = ""
        for i, l in enumerate(lines):
            l["checksum"] = hashlib.sha256(tt_digest.canonicalize(l).encode("utf-8")).hexdigest()
            if tamper == i:
                l["tx"]["body"] = {"changed": True}
            text += json.dumps(l) + "\n"
        if torn:
            text += '{"jseq": %d, "line": "comm' % len(lines)
        if raw_tail is not None:
            text += raw_tail
        f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        f.write(text)
        f.close()
        return f.name

    def test_journal_reader_reads_commit_lines_and_tolerates_only_a_torn_last_line(self):
        export, entries, records = history()
        path = self.write_journal(records, other_principal=True)
        try:
            got, problems = tt_recount.journal_executions(path, "p-default")
            self.assertEqual(problems, [])
            self.assertEqual([r["id"] for r in got], ["X-1", "X-2", "X-3", "X-4", "X-5"])
            self.assertEqual([r["result"]["digest"] for r in got], [r["result"]["digest"] for r in records], "digests recomputed from the bodies")
            out = tt_recount.recount(export, entries, records, *tt_recount.journal_executions(path, "p-default"))
            self.assertEqual(out["problems"], [])
            self.assertEqual(len(tt_recount.journal_executions(path)[0]), 6, "without --principal every principal's writes")
        finally:
            os.unlink(path)

    def test_journal_reader_catches_a_line_changed_without_its_checksum(self):
        export, entries, records = history()
        path = self.write_journal(records, tamper=2)
        try:
            got, problems = tt_recount.journal_executions(path, "p-default")
            self.assertEqual(problems, ["journal: line jseq 2 has a bad jseq or checksum"])
            out = tt_recount.recount(export, entries, records, got, problems)
            self.assertIn("journal: line jseq 2 has a bad jseq or checksum", out["problems"])
            self.assertTrue(any("journal and ledger name different executions" in p for p in out["problems"]))
        finally:
            os.unlink(path)

    def test_journal_reader_refuses_a_commit_seq_gap_and_an_unknown_kind_as_tiny_tracker_does(self):
        # G2 fold-in 10: both lines are checksummed, so only the reader's own checks can catch them.
        export, entries, records = history()
        gap = {"line": "commit", "commit_seq": records[-1]["seq"] + 5, "pending_jseq": None,
               "tx": {"kind": "write", "seq": records[-1]["seq"] + 5, "principal": "p-default", "attribution": {"run": None, "operation": None},
                      "request": {"method": "POST", "path": "/tickets", "key": None}, "objects": [], "body": {}}}
        path = self.write_journal(records, extra=[gap], torn=False)
        try:
            _, problems = tt_recount.journal_executions(path, "p-default")
            self.assertEqual(problems, ["journal: line jseq 7 has commit_seq 10 where 6 was expected"])
        finally:
            os.unlink(path)
        path = self.write_journal(records, extra=[{"line": "future-kind", "principal": "p-default"}], torn=False)
        try:
            _, problems = tt_recount.journal_executions(path, "p-default")
            self.assertEqual(len(problems), 1)
            self.assertIn("unknown line kind 'future-kind'", problems[0])
        finally:
            os.unlink(path)
        # Every known kind passes; a lookup-fence line and a clock line (0.4.0) among them.
        path = self.write_journal(records, extra=[{"line": "lookup-fence", "principal": "p-default", "key": "k-12345678", "run": None, "fenced_at": "t"},
                                                  {"line": "clock", "from_ms": 0, "to_ms": 60000, "at": "t"}])
        try:
            self.assertEqual(tt_recount.journal_executions(path, "p-default")[1], [])
        finally:
            os.unlink(path)

    def test_journal_reader_tolerates_only_an_unterminated_undecodable_last_line(self):
        export, entries, records = history()
        path = self.write_journal(records, torn=False, raw_tail='{"jseq": 7, "line": "comm\n')
        try:
            self.assertEqual(tt_recount.journal_executions(path, "p-default")[1], ["journal: line jseq 7 has a bad jseq or checksum"],
                             "a bad last line with its newline is not a torn write")
        finally:
            os.unlink(path)

    def raw_journal(self, lines, raw=None):
        """Lines (dicts, or raw text) checksummed and written as tiny-tracker writes them (no spaces)."""
        import hashlib
        text = ""
        for l in lines:
            if isinstance(l, str):
                text += l
                continue
            body = {k: v for k, v in l.items() if k != "checksum"}
            body["checksum"] = hashlib.sha256(tt_digest.canonicalize(body).encode("utf-8")).hexdigest()
            text += json.dumps(body, separators=(",", ":")) + "\n"
        f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
        f.write(text + (raw or ""))
        f.close()
        return f.name

    @staticmethod
    def commit(jseq, seq, epoch=None, title="t"):
        line = {"jseq": jseq, "line": "commit", "commit_seq": seq, "pending_jseq": None,
                "tx": {"kind": "write", "seq": seq, "principal": "p-default", "attribution": {"run": None, "operation": None},
                       "request": {"method": "POST", "path": "/tickets", "key": None}, "objects": [], "body": {"title": title}}}
        if epoch is not None:
            line["epoch"] = epoch
        return line

    HEADER = {"jseq": 0, "line": "header", "journal": "journal-format/1", "writer": "0.4.0", "boot_id": "0123456789abcdef", "seed": {}}

    @staticmethod
    def lease(jseq, epoch, nonce="n"):
        return {"jseq": jseq, "line": "lease", "epoch": epoch, "pid": 7, "host": "h", "nonce": nonce}

    def ids(self, path):
        try:
            got, problems = tt_recount.journal_executions(path)
            return [r["id"] for r in got], problems
        finally:
            os.unlink(path)

    def test_lease_epochs_decide_which_lines_apply(self):
        # 0.4.0 (G3 note 26 item 1b): a paused holder (epoch 1) appended after the new holder's lease line (epoch 2).
        lines = [self.HEADER, self.lease(1, 1), self.commit(2, 1, 1), self.lease(3, 2), self.commit(4, 2, 2, "b"),
                 self.commit(3, 2, 1, "stale"), self.commit(5, 3, 2, "b2")]
        self.assertEqual(self.ids(self.raw_journal(lines)), (["X-1", "X-2", "X-3"], []))
        path = self.raw_journal(lines)
        with open(path, encoding="utf-8") as f:
            _, superseded, problems = tt_recount.scan_journal(f.read())
        os.unlink(path)
        self.assertEqual(([(s["jseq"], s["epoch"]) for s in superseded], problems), ([(3, 1)], []))
        # The jseq rule: the stale line landed before the new lease line, after the new holder read the file.
        lines = [self.HEADER, self.lease(1, 1), self.commit(2, 1, 1), self.commit(3, 2, 1, "stale"), self.lease(3, 2), self.commit(4, 2, 2, "b")]
        self.assertEqual(self.ids(self.raw_journal(lines)), (["X-1", "X-2"], []))
        # A lease line that does not raise the epoch (a start that lost the race) and a header after a lease line (one
        # that found the file empty and lost) are superseded.
        lines = [self.HEADER, self.lease(1, 1), self.commit(2, 1, 1), self.HEADER, self.lease(1, 1, "other"), self.commit(3, 2, 1)]
        self.assertEqual(self.ids(self.raw_journal(lines)), (["X-1", "X-2"], []))

    def test_a_0_3_0_journal_has_no_epochs_and_still_reads(self):
        lines = [self.HEADER, self.commit(1, 1), self.commit(2, 2), self.lease(3, 1), self.commit(4, 3, 1)]
        self.assertEqual(self.ids(self.raw_journal(lines)), (["X-1", "X-2", "X-3"], []))

    def test_epoch_problems_are_named(self):
        _, problems = self.ids(self.raw_journal([self.HEADER, self.lease(1, 1), self.commit(2, 1)]))
        self.assertEqual(problems, ["journal: line jseq 2 (commit) has no epoch, after a lease line"])
        _, problems = self.ids(self.raw_journal([self.HEADER, self.lease(1, 1), self.commit(2, 1, 3)]))
        self.assertEqual(problems, ["journal: line jseq 2 has epoch 3, and no lease line before it took that epoch"])
        _, problems = self.ids(self.raw_journal([self.HEADER, self.lease(1, 1), dict(self.commit(2, 1, 0), line="future-kind")]))
        self.assertEqual(len(problems), 1)
        self.assertIn("unknown line kind 'future-kind'", problems[0], "a superseded line must still be of a known kind")

    def test_a_torn_fragment_a_later_write_joined_is_left_out(self):
        # 0.4.0 never cuts the file: the next start's lease line joins a torn write on its physical line.
        frag = '{"jseq":3,"line":"commit","commit_s'
        lines = [self.HEADER, self.lease(1, 1), self.commit(2, 1, 1), frag, self.lease(3, 2), self.commit(4, 2, 2)]
        self.assertEqual(self.ids(self.raw_journal(lines)), (["X-1", "X-2"], []))
        # A fragment with no whole line after it on its line, other than the unterminated last line, is a bad line.
        lines = [self.HEADER, self.lease(1, 1), self.commit(2, 1, 1), frag + "\n", self.lease(3, 2)]
        self.assertEqual(self.ids(self.raw_journal(lines))[1][0], "journal: line jseq 3 has a bad jseq or checksum")
        # A fragment can never hide an applied line: jseq stays contiguous.
        lines = [self.HEADER, self.lease(1, 1), frag, self.commit(3, 2, 1)]
        self.assertIn("journal: line jseq 2 has a bad jseq or checksum", self.ids(self.raw_journal(lines))[1])

    def test_batch_writes_limit_the_object_comparison(self):
        export, entries, records = history()
        b = execution(6, "POST", "/batch", None, [{"type": "ticket", "id": "T-1"}], {"results": []}, op="op-6")
        entries.append(entry(9, b))
        records.append(b)
        export["tickets"] = []
        out = tt_recount.recount(export, entries, records)
        self.assertEqual(out["objects"]["batch_touched_tickets_not_compared"], ["T-1"])
        self.assertFalse(any("ticket(s)" in p for p in out["problems"]), out["problems"])

    def test_command_line(self):
        export, entries, records = history()
        with tempfile.TemporaryDirectory() as d:
            paths = {}
            for name, doc in (("export", export), ("ledger", {"entries": entries}), ("executions", {"executions": records})):
                paths[name] = os.path.join(d, name + ".json")
                with open(paths[name], "w", encoding="utf-8") as f:
                    json.dump(doc, f)
            argv = ["tt_recount", "--export", paths["export"], "--ledger", paths["ledger"], "--executions", paths["executions"], "--json"]
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(tt_recount.main(argv), 0)
                self.assertEqual(tt_recount.main(["tt_recount", "--export", paths["export"]]), 2)
            self.assertEqual(json.loads(out.getvalue())["problems"], [])


if __name__ == "__main__":
    unittest.main()
