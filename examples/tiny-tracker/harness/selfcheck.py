"""Exercises the tiny-tracker contract adapter against a running build (stdlib only).

Two modes, both reading a harness config (harness/adapter_config.py prints one):

  python3 -I harness/selfcheck.py --config cfg.json
      Calls the adapter's five operations in the order the contract driver at
      92bf1ba calls them (A1, A2, A3 legs, the A5 K-only lookup at once) and
      prints what they returned as JSON: counts, response classes, digests,
      recomputations, and the cross-check the driver does not do yet: whether
      the K-only attempt's digest equals the committed digest. It gives no
      verdicts; the driver does that.

  python3 -I harness/selfcheck.py --config cfg.json --driver DIR [--out RUNDIR]
      Runs the contract driver itself: DIR is a checkout of
      zambodotdev/lost-response-test-contract (its commit is checked against
      harness/contract.json and reported). The driver's harness folder is
      copied to a temporary folder with this adapter added, so DIR is never
      changed. Prints the driver's own verdict strings for A1 to A5, which
      ones are self-attested, and the same cross-check.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.join(HERE, "adapters", "tiny_tracker.py")


def load_adapter_module():
    spec = importlib.util.spec_from_file_location("tt_contract_adapter", ADAPTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pin():
    with open(os.path.join(HERE, "contract.json"), encoding="utf-8") as f:
        return json.load(f)


def konly_cross_check(attempts, committed_digest):
    """What driver ask (b) would compare: a found attempt's own digest against the committed digest."""
    found = [a for a in attempts if a.get("response_class") == "found"]
    if not found:
        return {"found_attempts": 0, "digest_equal": None}
    return {"found_attempts": len(found),
            "digest_returned": [a.get("digest_returned") for a in found],
            "committed_digest": committed_digest,
            "digest_equal": bool(committed_digest) and all(a.get("digest_returned") == committed_digest for a in found)}


def exercise(config):
    mod = load_adapter_module()
    adapter = mod.Adapter(config["adapter_config"])
    tag = uuid.uuid4().hex[:10]
    out = {"adapter_version": mod.ADAPTER_VERSION, "contract": mod.CONTRACT}
    _, summary = adapter.initialize()
    out["initialize"] = summary

    def operation(name, mismatched):
        session, k = "lr-%s-%s" % (tag, name), "lr-op-%s-%s" % (tag, name)
        first = adapter.execute(session_id=session, operation_key=k, drop_response=True)
        after = adapter.count_effects(session_id=session, operation_key=k, label=name + "_after_attempt1")["evidence"]
        retry = adapter.execute(session_id=session, operation_key=k, mismatched=mismatched)
        final = adapter.count_effects(session_id=session, operation_key=k, label=name + "_final")["evidence"]
        leaked = {key for key in ("body", "receipt_ids", "response_class") if key in first["call"]}
        return {"K": k, "session_id": session,
                "attempt1": {"dropped": first["call"].get("dropped"), "fault": first["call"].get("fault"), "leaked_members": sorted(leaked)},
                "counter": after.get("counter"),
                "count_after_attempt1": after["external_effect_count"],
                "count_final": final["external_effect_count"],
                "execution_record_ids": final["execution_record_ids"],
                "retry_response_class": retry["call"].get("response_class"),
                "retry_replayed": retry["call"].get("replayed"),
                "refusal_records": len(final.get("refusal_records") or [])}

    a1 = operation("a1", False)
    a2 = operation("a2", True)
    out["A1"], out["A2"] = a1, a2
    committed = None
    if a1["execution_record_ids"]:
        rec = adapter.fetch_record(a1["execution_record_ids"][0])
        committed = (rec.get("digests") or {}).get("result_digest")
        out["A3_run_id_leg"] = {"record_id": rec["record_id"], "http_status": rec["http_status"],
                                "digest_keys": sorted(rec.get("digests") or {}),
                                "recomputation": rec["recomputation"].get("status")}
    recovery = adapter.recover_by_key(operation_key=a1["K"])
    out["A3_k_only_leg"] = {"attempts": [{k: v for k, v in a.items() if k in ("path", "response_class", "digest_returned", "record_ids_returned", "self_attested", "operation_state")}
                                         for a in recovery["attempts"]],
                            "cross_check": konly_cross_check(recovery["attempts"], committed)}
    by_key = adapter.fetch_record(a1["K"])
    out["A5_k_lookup_now"] = {"http_status": by_key["http_status"], "digest_keys": sorted(by_key.get("digests") or {}),
                              "digest_equals_committed": (by_key.get("digests") or {}).get("result_digest") == committed if committed else None,
                              "recomputation": by_key["recomputation"].get("status"),
                              "note": "the K-only lookup the A5 delayed leg makes, made at once; not a delayed result"}
    return out


def git_head(path):
    try:
        r = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def run_driver(config, contract_dir, out_dir=None):
    harness = os.path.join(contract_dir, "fixtures", "harness")
    if not os.path.isfile(os.path.join(harness, "lost_response.py")):
        raise SystemExit("selfcheck.py: %s has no fixtures/harness/lost_response.py" % contract_dir)
    work = tempfile.mkdtemp(prefix="tt-contract-")
    try:
        copy = os.path.join(work, "harness")
        shutil.copytree(harness, copy, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy(ADAPTER, os.path.join(copy, "adapters", "tiny_tracker.py"))
        cfg_path = os.path.join(work, "config.json")
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(config, f)
        run_dir = out_dir or os.path.join(work, "run")
        r = subprocess.run([sys.executable, "-I", os.path.join(copy, "lost_response.py"), "--config", cfg_path, "--out", run_dir],
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise SystemExit("selfcheck.py: the driver exited %s: %s" % (r.returncode, r.stderr[-2000:]))
        with open(os.path.join(run_dir, "summary.json"), encoding="utf-8") as f:
            summary = json.load(f)
        with open(os.path.join(run_dir, "a3_summary.json"), encoding="utf-8") as f:
            a3 = json.load(f)
    finally:
        if out_dir is None:
            shutil.rmtree(work, ignore_errors=True)
        else:
            shutil.rmtree(os.path.join(work, "harness"), ignore_errors=True)
    head = git_head(contract_dir)
    expected = pin()["contract"]["commit"]
    verdicts = {name: (summary["assertions"].get(name) or {}).get("score") for name in ("A1", "A2", "A3", "A4", "A5")}
    konly = ((a3.get("legs") or {}).get("k_only") or {}).get("attempts") or []
    return {"driver": {"repo": pin()["contract"]["repo"], "commit": head, "pinned_commit": expected, "commit_matches_pin": head == expected},
            "verdicts": verdicts,
            "self_attested": ["A3"],
            "initialize": summary.get("initialize"),
            "a3_run_id_leg": ((a3.get("legs") or {}).get("run_id") or {}).get("score"),
            "cross_check": konly_cross_check(konly, a3.get("committed_digest"))}


def main(argv):
    args = argv[1:]
    opts = {}
    while args:
        flag = args.pop(0)
        if flag in ("--config", "--driver", "--out") and args:
            opts[flag] = args.pop(0)
        else:
            sys.stderr.write(__doc__)
            return 2
    if "--config" not in opts:
        sys.stderr.write(__doc__)
        return 2
    with open(opts["--config"], encoding="utf-8") as f:
        config = json.load(f)
    if "adapter_config" not in config:
        raise SystemExit("selfcheck.py: the config has no adapter_config")
    result = run_driver(config, opts["--driver"], opts.get("--out")) if "--driver" in opts else exercise(config)
    sys.stdout.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
