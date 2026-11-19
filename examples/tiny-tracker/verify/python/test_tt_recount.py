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

    def test_journal_reader_skips_the_header_and_a_torn_last_line(self):
        _, _, records = history()
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
            f.write(json.dumps({"journal": "journal-format/1", "writer": "0.3.0"}) + "\n")
            for r in records:
                f.write(json.dumps({"seq": r["seq"], "tx": {"execution": r}}) + "\n")
            f.write('{"seq": 6, "tx": {"exec')
        try:
            self.assertEqual([r["id"] for r in tt_recount.journal_executions(f.name)], ["X-1", "X-2", "X-3", "X-4", "X-5"])
        finally:
            os.unlink(f.name)

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
