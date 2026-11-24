"""Prints a lost-response harness config for a running tiny-tracker (stdlib only).

Give it tiny-tracker's state line (the first stdout line of `tiny-tracker all`)
and it prints, on stdout, a config the contract driver loads:

  tiny-tracker all --features evidence,... --fixture-control --token-dir ~/.tt-tokens | head -1 > state.json
  python3 -I harness/adapter_config.py --state state.json > config.tiny-tracker.json
  python3 lost_response.py --config config.tiny-tracker.json --out ../../runs/<dir>

It reads GET /build with the evidence token (from TRACKER_EVIDENCE_TOKEN,
TRACKER_EVIDENCE_TOKEN_FILE or the state line's token folder) and pins the
build: expected_build_hash, the features and the defects of both layers go into
the config, and the adapter checks the hash again at the start of the run.
Tokens are never written into the config: only the names of the variables that
hold them, and the token folder's path.

Options:
  --state FILE|-        the state line (default: stdin)
  --label TEXT          system_name (default: built from the build descriptor)
  --fault server|client the lost-response fault (default: server when the state line names a control listener)
  --no-build            do not read GET /build (no expected_build_hash)
  --delay-hours N       a5_delay_hours (default 24)
  --start TEXT          the command line that started the build, recorded as build.start_command (no tokens)
  --principal ID        the principal the MCP server writes as (adapter_config.principal); needed with more than one
                        principal and no control listener (the adapter refuses to guess)
"""

import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

ARGS_TEMPLATE = {"title": "{K} lost-response probe", "description": "lost-response harness, session {SESSION}", "priority": 3}
MISMATCH = {"field": "priority", "altered_value": 4}


def read_token(env_name, token_dir, file_name):
    if os.environ.get(env_name):
        return os.environ[env_name].strip()
    path = os.environ.get(env_name + "_FILE") or (os.path.join(token_dir, file_name) if token_dir else None)
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    return None


def get_build(backend, token):
    req = urllib.request.Request(backend.rstrip("/") + "/build", headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    try:
        with _OPENER.open(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None


def parse_args(argv):
    opts = {"state": "-", "label": None, "fault": None, "build": True, "delay": 24, "start": None, "principal": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--state", "--label", "--fault", "--delay-hours", "--start", "--principal") and i + 1 < len(argv):
            key = {"--state": "state", "--label": "label", "--fault": "fault", "--delay-hours": "delay", "--start": "start", "--principal": "principal"}[a]
            opts[key] = argv[i + 1]
            i += 2
        elif a == "--no-build":
            opts["build"] = False
            i += 1
        else:
            raise SystemExit("adapter_config.py: unknown option %s\n%s" % (a, __doc__))
    if opts["fault"] not in (None, "server", "client"):
        raise SystemExit("adapter_config.py: --fault is server or client")
    return opts


def config_for(state, opts, env_ok=True):
    """The config dict for one state line. Separate from main() for the tests."""
    if not isinstance(state, dict) or "mcp" not in state or "backend" not in state:
        raise SystemExit("adapter_config.py: the state line names no mcp and backend URL (use `tiny-tracker all`)")
    token_dir = state.get("tokens")
    descriptor = None
    if opts["build"]:
        token = read_token("TRACKER_EVIDENCE_TOKEN", token_dir, "evidence.token") if env_ok else None
        if not token:
            raise SystemExit("adapter_config.py: no evidence token (TRACKER_EVIDENCE_TOKEN, _FILE, or the state line's token folder); "
                             "use --no-build to skip the build pin")
        status, descriptor = get_build(state["backend"], token)
        if status != 200 or not isinstance(descriptor, dict):
            raise SystemExit("adapter_config.py: GET /build answered %s" % status)
    fault = opts["fault"] or ("server" if state.get("control") else "client")
    if fault == "server" and not state.get("control"):
        raise SystemExit("adapter_config.py: --fault server needs a control listener (--fixture-control)")
    defects = (descriptor or {}).get("defects") or {"mcp": state.get("defects") or [], "backend": state.get("backend_defects") or []}
    features = (descriptor or {}).get("features") or state.get("features") or []
    label = opts["label"] or "tiny-tracker %s, %s (local, 127.0.0.1)" % (
        ((descriptor or {}).get("package") or {}).get("version", "?"),
        "correct build" if not (defects.get("mcp") or defects.get("backend")) else
        "defects " + ", ".join(list(defects.get("mcp") or []) + ["backend:" + d for d in (defects.get("backend") or [])]))
    adapter_config = {
        "mcp_url": state["mcp"],
        "backend_url": state["backend"],
        "evidence_token_env": "TRACKER_EVIDENCE_TOKEN",
        "backend_token_env": "TRACKER_BACKEND_TOKEN",
        "tool": "create_ticket",
        "args_template": ARGS_TEMPLATE,
        "mismatch": MISMATCH,
        "fault": fault,
        "drop_timeout_s": 5,
        "protocol_version": "2025-11-25",
        "build": {"defects": defects, "features": features,
                  "build_hash": (descriptor or {}).get("build_hash"),
                  "start_command": opts["start"]},
    }
    if state.get("control"):
        adapter_config["control_url"] = state["control"]
        adapter_config["control_token_env"] = "TRACKER_CONTROL_TOKEN"
    if token_dir:
        adapter_config["token_dir"] = token_dir
    if descriptor:
        adapter_config["expected_build_hash"] = descriptor["build_hash"]
    if opts.get("principal"):
        adapter_config["principal"] = opts["principal"]
    return {"adapter": "tiny_tracker", "system_name": label, "a5_delay_hours": (lambda d: int(d) if d == int(d) else d)(float(opts["delay"])), "adapter_config": adapter_config}


def main(argv):
    opts = parse_args(argv[1:])
    text = sys.stdin.read() if opts["state"] == "-" else open(opts["state"], encoding="utf-8").read()
    line = next((l for l in text.splitlines() if l.strip()), "")
    try:
        state = json.loads(line)
    except ValueError:
        raise SystemExit("adapter_config.py: the first line is not tiny-tracker's JSON state line")
    sys.stdout.write(json.dumps(config_for(state, opts), indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
