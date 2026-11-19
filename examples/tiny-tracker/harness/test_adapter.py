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


if __name__ == "__main__":
    unittest.main()
