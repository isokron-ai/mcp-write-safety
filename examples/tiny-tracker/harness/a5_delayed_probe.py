"""The protection half of the delayed A5 leg: the delayed retries and the effect counts around them (stdlib + the driver).

The contract driver's `--delayed-leg` (contract main, score_a5) dispatches nothing itself: it reads the K-only
lookup it makes, plus these records, if they already sit in the plant's run directory:

  count_a5_delayed_before_protection.json   the effect count before either retry
  a5_delayed_retry_identical.json           an identical retry (same K, same arguments)
  count_a5_delayed_after_identical.json     the count after it
  a5_delayed_retry_mismatched.json          a retry with the configured one parameter changed
  count_a5_delayed_final.json               the count after both

This script writes them through the adapter, in the driver's own record shapes (the A1/A2 attempt records and the
count evidence), into the folder of a5_plant.json. Run it right before the driver's delayed leg, at or after
due_at (the scorer judges every record by its own timestamp). It reads the tokens from the environment or the
token folder exactly as the adapter does and prints none.

  python3 -I harness/a5_delayed_probe.py --driver A5_DIR/driver --plant A5_DIR/runs/<dir>/a5_plant.json
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--driver", required=True, help="the driver copy (contract fixtures/harness) the plant was made with")
    ap.add_argument("--plant", required=True, help="path to a5_plant.json")
    args = ap.parse_args(argv)
    sys.path.insert(0, os.path.abspath(args.driver))  # -I leaves script folders off sys.path
    from adapters import load_adapter  # the driver's package; the adapter is loaded from the same folder

    plant_path = Path(args.plant)
    out = plant_path.parent
    plant = json.loads(plant_path.read_text(encoding="utf-8"))
    session, k = plant["session_id"], plant["K"]
    adapter = load_adapter(plant.get("adapter", "tiny_tracker"), plant["adapter_config"])

    def write(name, obj):
        (out / name).write_text(json.dumps(obj, indent=2, sort_keys=True), encoding="utf-8")

    def count(label):
        res = adapter.count_effects(session_id=session, operation_key=k, label=label)
        for name, obj in (res.get("files") or {}).items():
            write(name, obj)
        write("count_%s.json" % label, res["evidence"])
        return res["evidence"]

    def retry(label, mismatched):
        res = adapter.execute(session_id=session, operation_key=k, mismatched=mismatched, drop_response=False)
        rec = {"label": label, "at": utcnow(), "session_id": session, "K": k,
               "arguments_sent": res["arguments_sent"], "call": res["call"]}
        write(label + ".json", rec)
        return rec

    init, _ = adapter.initialize()
    write("a5_delayed_initialize.json", init)
    before = count("a5_delayed_before_protection")
    ident = retry("a5_delayed_retry_identical", False)
    after_ident = count("a5_delayed_after_identical")
    mism = retry("a5_delayed_retry_mismatched", True)
    final = count("a5_delayed_final")
    print("a5_delayed_probe: count %s -> %s -> %s; identical retry %s, changed-argument retry %s" % (
        before["external_effect_count"], after_ident["external_effect_count"], final["external_effect_count"],
        ident["call"].get("response_class"), mism["call"].get("response_class")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
