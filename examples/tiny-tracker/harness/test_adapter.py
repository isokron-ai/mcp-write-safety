"""Unit tests for the contract adapter's own digest code and helpers (stdlib unittest).

Run: python3 -I harness/test_adapter.py
"""

import importlib.util
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "verify", "python"))  # -I leaves script folders off sys.path

import tt_digest  # noqa: E402


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapter = load(os.path.join(HERE, "adapters", "tiny_tracker.py"), "tt_adapter")
selfcheck = load(os.path.join(HERE, "selfcheck.py"), "tt_selfcheck")
config = load(os.path.join(HERE, "adapter_config.py"), "tt_adapter_config")

with open(os.path.join(ROOT, "vectors", "digest-1.json"), encoding="utf-8") as f:
    VECTORS = json.load(f)


class Digests(unittest.TestCase):
    def test_the_adapter_canonicalizes_every_vector_as_the_verifier_does(self):
        for case in VECTORS["cases"]:
            if case.get("expect") == "reject":
                continue
            value = tt_digest.loads(case["input_json"])
            self.assertEqual(adapter.canonicalize(value), case["canonical"], case["name"])
            self.assertEqual(adapter.domain_digest(case["domain"], case["canonical"]), case["digest"], case["name"])

    def test_recomputation_uses_the_domain_tag(self):
        domain = "dev.writesafety.tiny-tracker/execution-result/1"
        canonical = '{"ticket":{"id":"T-1"}}'
        served = {"alg": "sha-256", "domain": domain, "canonical": canonical, "digest": tt_digest.domain_digest(domain, canonical)}
        r = adapter.recompute_served(served)
        self.assertEqual(r["status"], "matched")
        self.assertTrue(r["canonical_bytes_are_rfc8785"])
        self.assertNotEqual(r["informational_bare_sha256"], served["digest"], "a bare SHA-256 differs by design (D2)")
        bare = dict(served, digest=r["informational_bare_sha256"])
        self.assertEqual(adapter.recompute_served(bare)["status"], "mismatched")
        loose = dict(served, canonical='{"ticket": {"id": "T-1"}}')
        loose["digest"] = tt_digest.domain_digest(domain, loose["canonical"])
        self.assertFalse(adapter.recompute_served(loose)["canonical_bytes_are_rfc8785"])
        self.assertEqual(adapter.recompute_served(None)["status"], "not_computable")


class Helpers(unittest.TestCase):
    def test_find_record_searches_nested_members(self):
        op = {"record": "operation-record/1", "key": "k"}
        self.assertIs(adapter.find_record({"operation": op}, "operation-record/1"), op)
        self.assertIs(adapter.find_record([{"x": [op]}], "operation-record/1"), op)
        self.assertIsNone(adapter.find_record({"operation": None}, "operation-record/1"))

    def test_ledger_envelopes(self):
        self.assertEqual(adapter.ledger_entries({"entries": [1]}), [1])
        self.assertEqual(adapter.ledger_entries([2]), [2])
        self.assertIsNone(adapter.ledger_entries({"error": "not_built"}))

    def test_classify(self):
        ok = {"http_status": 200}
        self.assertEqual(adapter.classify({"timed_out": True}, None), "no_answer:timeout")
        self.assertEqual(adapter.classify(ok, {"result": {"content": []}}), "success")
        self.assertEqual(adapter.classify(ok, {"result": {"isError": True, "structuredContent": {"mws": {"code": "idempotency_key_reused"}}}}),
                         "tool_error:idempotency_key_reused")
        self.assertEqual(adapter.classify(ok, {"error": {"code": -32601}}), "jsonrpc_error:-32601")

    def test_execution_ids_only_look_like_X_n(self):
        self.assertTrue(adapter.EXECUTION_ID.match("X-12"))
        for not_id in ("X-0", "lr-op-abc-a1", "T-1", "X-1a"):
            self.assertIsNone(adapter.EXECUTION_ID.match(not_id), not_id)

    def test_konly_cross_check(self):
        found = [{"response_class": "found", "digest_returned": "a" * 64}]
        self.assertTrue(selfcheck.konly_cross_check(found, "a" * 64)["digest_equal"])
        self.assertFalse(selfcheck.konly_cross_check(found, "b" * 64)["digest_equal"])
        self.assertIsNone(selfcheck.konly_cross_check([{"response_class": "not_found"}], "a" * 64)["digest_equal"])


class ConfigPrinter(unittest.TestCase):
    STATE = {"backend": "http://127.0.0.1:4633", "mcp": "http://127.0.0.1:4632/mcp", "defects": ["idempotency-key-dropped"],
             "features": ["evidence"], "control": "http://127.0.0.1:4634", "tokens": "/tmp/tt-tokens"}

    def test_no_token_is_written_only_variable_names(self):
        opts = {"state": "-", "label": None, "fault": None, "build": False, "delay": 24, "start": "tiny-tracker all"}
        c = config.config_for(self.STATE, opts)
        ac = c["adapter_config"]
        self.assertEqual(c["adapter"], "tiny_tracker")
        self.assertEqual(ac["fault"], "server")
        self.assertEqual(ac["token_dir"], "/tmp/tt-tokens")
        self.assertEqual(ac["build"]["defects"], {"mcp": ["idempotency-key-dropped"], "backend": []})
        self.assertNotIn("expected_build_hash", ac)
        self.assertIn("idempotency-key-dropped", c["system_name"])
        for k, v in ac.items():
            if k.endswith("_env"):
                self.assertRegex(v, r"^TRACKER_[A-Z_]+$")

    def test_client_fault_without_control(self):
        state = {k: v for k, v in self.STATE.items() if k != "control"}
        opts = {"state": "-", "label": "x", "fault": None, "build": False, "delay": 1, "start": None}
        self.assertEqual(config.config_for(state, opts)["adapter_config"]["fault"], "client")
        with self.assertRaises(SystemExit):
            config.config_for(state, dict(opts, fault="server"))
        with self.assertRaises(SystemExit):
            config.config_for({"backend": "x"}, opts)


class CountAcrossRestart(unittest.TestCase):
    """R-TT-02: the ledger is in memory, so after a restart the count must also read the durable execution records."""

    S, K = "lr-s-a1", "lr-op-s-a1"

    def bare(self, ledger, executions):
        a = adapter.Adapter.__new__(adapter.Adapter)
        a.run_id = None
        served = {"/ledger": {"entries": ledger}, "/executions": {"executions": executions}}
        a._ev = lambda path: ({"http_status": 200, "body_json": served[path]}, b"")
        return a

    def record(self, xid, tag=None, key=None):
        return {"id": xid, "operation_tag": tag or self.S, "request": {"key": key or self.K}, "boot_id": "b0",
                "objects": ["T-1"], "committed_at": "2026-11-23T18:11:06Z"}

    def test_R_TT_02_after_a_restart_an_execution_only_the_records_hold_is_counted(self):
        _, counted = self.bare([], [self.record("X-1")])._ledger_count(self.S, self.K)
        self.assertEqual(counted["ids"], ["X-1"], "the planted execution survives the restart in the count")
        self.assertEqual([r["execution_id"] for r in counted["from_execution_records"]], ["X-1"])

    def test_R_TT_02_an_execution_in_both_the_ledger_and_the_records_is_counted_once(self):
        ledger = [{"seq": 1, "kind": "execution", "execution_id": "X-1", "operation_tag": self.S,
                   "request": {"key": self.K}, "status": 201}]
        _, counted = self.bare(ledger, [self.record("X-1")])._ledger_count(self.S, self.K)
        self.assertEqual(counted["ids"], ["X-1"])
        self.assertEqual(counted["from_execution_records"], [])

    def test_R_TT_02_records_of_another_operation_or_key_are_not_counted(self):
        executions = [self.record("X-2", tag="lr-s-a2"), self.record("X-3", key="lr-op-other")]
        _, counted = self.bare([], executions)._ledger_count(self.S, self.K)
        self.assertEqual(counted["ids"], [])


class EvidencePrincipal(unittest.TestCase):
    """G2 fold-in 6: the delayed leg reads under the principal initialize settled on; with several and none, refuse."""

    @staticmethod
    def bare(principal=None, listed=("p-default", "p-second")):
        a = adapter.Adapter.__new__(adapter.Adapter)
        a.config = {} if principal is None else {"principal": principal}
        a.principal = principal
        seen = []

        class Ev:
            def call(self, method, path):
                seen.append(path)
                if "principal=" not in path:
                    return {"http_status": 400, "body_json": {"error": "principal_required", "principals": list(listed)}}, b""
                return {"http_status": 200, "body_json": {"ok": True}}, b""
        a.evidence = Ev()
        return a, seen

    def test_with_several_principals_and_none_recorded_the_adapter_refuses_rather_than_guess(self):
        a, seen = self.bare()
        with self.assertRaises(adapter.PrincipalUnknown) as e:
            a._ev("/operations/K-1")
        self.assertIn("p-default, p-second", str(e.exception))
        self.assertIsNone(a.principal, "nothing guessed")
        self.assertEqual(seen, ["/operations/K-1"], "no read under a guessed principal")

    def test_a_single_listed_principal_is_named_and_recorded_in_the_config(self):
        a, seen = self.bare(listed=("p-only",))
        served, _ = a._ev("/operations/K-1")
        self.assertEqual(served["http_status"], 200)
        self.assertEqual(seen, ["/operations/K-1", "/operations/K-1?principal=p-only"])
        self.assertEqual(a.config["principal"], "p-only")

    def test_the_principal_in_the_config_is_used_from_the_first_read(self):
        # The plant carries adapter_config; a fresh adapter on it reads under the recorded principal, here not the
        # first listed one (TRACKER_BACKEND_TOKEN belonged to the second).
        a, seen = self.bare(principal="p-second")
        a._ev("/executions/X-1")
        self.assertEqual(seen, ["/executions/X-1?principal=p-second"])

    def test_initialize_records_the_run_principal_in_the_config_and_refuses_an_ambiguous_probe(self):
        class Client:
            def initialize(self):
                return {"initialize": {"body": {"result": {}}, "transport": {"http_status": 200}}}

            def request(self, method, params):
                return {}, {"http_status": 200}, {"result": {"tools": []}}

        class Http:
            def __init__(self, answers):
                self.answers, self.base, self.token = answers, "http://127.0.0.1:0", "t"

            def call(self, method, path, body=None):
                return self.answers(method, path), b""

        def ev(method, path):
            if path == "/build":
                return {"http_status": 200, "body_json": {}}
            return {"http_status": 400, "body_json": {"error": "principal_required", "principals": ["p-default", "p-second"]}}

        cfg = {"mcp_url": "http://127.0.0.1:0/mcp", "backend_url": "http://127.0.0.1:0"}
        a = adapter.Adapter.__new__(adapter.Adapter)
        a.config, a.principal, a.run_id, a.endpoint, a.fault_mode, a.tool_name = cfg, None, None, cfg["mcp_url"], "client", "create_ticket"
        a.client, a.evidence = Client(), Http(ev)
        a.control = Http(lambda m, p: {"http_status": 201, "body_json": {"run_id": "run-1", "principal": "p-second"}})
        _, summary = a.initialize()
        self.assertEqual(summary["evidence_principal"], "p-second")
        self.assertEqual(cfg["principal"], "p-second", "the plant (this config) carries it to the delayed leg")
        b = adapter.Adapter.__new__(adapter.Adapter)
        b.config, b.principal, b.run_id, b.endpoint, b.fault_mode, b.tool_name = {}, None, None, cfg["mcp_url"], "client", "create_ticket"
        b.client, b.evidence, b.control = Client(), Http(ev), None
        with self.assertRaises(adapter.PrincipalUnknown):
            b.initialize()

    def test_adapter_config_takes_a_principal(self):
        state = {"mcp": "http://127.0.0.1:1/mcp", "backend": "http://127.0.0.1:2"}
        opts = dict(config.parse_args(["--no-build", "--principal", "p-second"]))
        self.assertEqual(config.config_for(state, opts)["adapter_config"]["principal"], "p-second")
        self.assertNotIn("principal", config.config_for(state, config.parse_args(["--no-build"]))["adapter_config"])


if __name__ == "__main__":
    unittest.main()
