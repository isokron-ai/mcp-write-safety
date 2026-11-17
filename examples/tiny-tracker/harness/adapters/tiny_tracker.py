"""tiny-tracker adapter for the lost-response harness (tiny-tracker 0.2.0 evidence).

Pinned to the contract `zambodotdev/lost-response-test-contract` at
92bf1ba5f8226a67409fd8a7a68411b5c4a7258d (CONTRACT.md, the driver
fixtures/harness/lost_response.py and adapters/base.py at that commit).
Adapter version 0.2.0. It replaces adapter 0.1.0
(rafe-walker/lost-response-test-contract, branch add-tiny-tracker-adapter,
b1519f7), which ran against tiny-tracker 0.1.0. The master copy lives in
isokron-ai/mcp-write-safety, examples/tiny-tracker/harness/adapters/, with
the tests that run it; the copy in the contract repository is taken from
there.

System under test: tiny-tracker (npm @mcp-write-safety/tiny-tracker,
source isokron-ai/mcp-write-safety, examples/tiny-tracker), an issue
tracker: an MCP server (Streamable HTTP, /mcp) in front of a REST
backend. From 0.2.0 the backend writes one execution record per applied
write, with the committed response body's canonical bytes (RFC 8785) and
a digest; it answers lookups by idempotency key; and it keeps an
append-only execution ledger below every MCP-layer defect. Its evidence
namespace (/build, /ledger, /executions/:id, /operations/:key) is
read-only and needs the evidence token. See FIXTURE.md in tiny-tracker.

Target tool: create_ticket, with K as its idempotency_key. Every
execution creates exactly one ticket, so every execution is countable.
The arguments A come from the config's args_template; A2 changes exactly
one parameter value (the config's mismatch).

Attribution: every attempt carries, in request _meta,
dev.writesafety.tiny-tracker/operation = the driver's run-scoped session
identity, and dev.writesafety.tiny-tracker/run = a run id the adapter
allocated on the control listener (when the config gives one). The MCP
server reads both before any tool handler runs and stamps them on the
backend request, so an effect is attributed even in a build that drops or
mangles the key. Recovery calls carry neither: they hold only K.

The shared external effect counter: the execution ledger (GET /ledger,
evidence token), read directly from the backend, never through the MCP
server. Each ledger entry of kind "execution" whose operation tag is the
session identity, and whose key is K or absent (a build that drops the
key still executed the operation), is one committed execution. The count
is reported with the execution record ids (X-<n>) it was counted from and
the raw ledger as served. If the ledger is not built (a 0.1.0 build: 501
or no evidence token), the 0.1.0 counter is used instead and labelled:
backend tickets whose title starts with K and whose description names the
session (that needs the backend token and K in the title).

Fault point: by default the lost response is server-side, where the
contract's common setup puts it. Before attempt 1 the adapter arms
mcp/after-backend-reply/drop on the control listener for exactly this
tool, this session's operation tag and the adapter's run, once (the
fixture's control API selects calls by their tags, not by key: where the
key travels depends on the code under test); the backend commits and answers, the MCP server never
answers, and the caller gives up after drop_timeout_s. If the fault does
not fire (the call is answered), the answer is read and discarded
client-side and the attempt records that the fallback was used. With
"fault": "client", or with no control listener, the 0.1.0 client-side
discard is used. Either way no result, record id or digest from the
attempt is returned.

fetch_record(record_id):
  X-<n>  GET /executions/X-<n> (evidence token): the execution record.
         digests carries exactly one value, result_digest (the driver's
         delayed leg takes the first value it finds). recomputation
         hashes the served canonical bytes under the served domain tag:
         SHA-256 over UTF-8(domain), one line feed, UTF-8(canonical)
         (tiny-tracker decision 0002). A bare SHA-256 of the canonical
         bytes does not match by design; it is reported for information.
  K      GET /operations/K (evidence token): the operation record of the
         key, as the contract's A5 delayed leg asks ("addressable by K").
         digests carries result_digest; recomputation fetches the
         execution record the operation names and checks that its
         served digest recomputes and equals result_digest.

recover_by_key(K): a fresh MCP session holding only K (no run id, no
response, no result, no digest from attempt 1, no run tag; caller
authentication is the MCP server's own backend credential, which CONTRACT.md
A3 allows). Path 1: tools/call get_operation {idempotency_key: K}, then
the execution record it names (embedded, or tools/call get_execution).
The attempt is "found" only when the operation is completed and the
execution record's served digest recomputes and equals the operation's
result_digest. The attempt reports the recovered digest (digest_returned).

  Self-attested: the driver at 92bf1ba, on a "found" attempt, takes the
  committed digest as the recovered digest without comparing it with the
  attempt's digest (driver ask (b)). Until the driver compares, the A3
  K-only verdict rests on this adapter's classification, and every
  "found" attempt says so (self_attested: true). The digest it reports
  can be compared with a3_summary.json's committed_digest by hand or by
  tiny-tracker's harness/selfcheck.py.

If the build has no get_operation tool (0.1.0), recovery reports
"not_available" and the 0.1.0 title-prefix read, classed
"found_by_caller_convention", never "found".

Adapter config keys (the config's adapter_config object):
  mcp_url              MCP endpoint, e.g. http://127.0.0.1:4632/mcp.
  mcp_command          Instead of mcp_url (0.4.0): the MCP server over stdio.
                       A command list, e.g. ["tiny-tracker", "stdio",
                       "--features", "...", "--fixture-control"]. The adapter
                       starts it once (tokens come from the environment, as
                       for any start), reads its state line on stderr for the
                       backend and control URLs (unless backend_url and
                       control_url are given), and stops it at exit. Over
                       stdio there is one connection: the K-only recovery
                       uses it with no run tag instead of a fresh session.
                       A start that is refused (or prints no state line
                       within start_timeout_s, default 20) raises
                       StdioStartError with the exit code and the server's
                       stderr tail, e.g. TRACKER_MCP_TOKEN set in the
                       harness environment, which stdio refuses.
  backend_url          Backend base URL (API and evidence namespace).
  control_url          Control listener URL (optional): run allocation and
                       the server-side fault.
  evidence_token_env   Variable holding the evidence token (default
                       TRACKER_EVIDENCE_TOKEN; NAME_FILE is read as a file).
  control_token_env    Likewise for the control token (default
                       TRACKER_CONTROL_TOKEN).
  backend_token_env    Likewise for the backend token (default
                       TRACKER_BACKEND_TOKEN); only the 0.1.0 counter uses it.
  token_dir            tiny-tracker's --token-dir folder (optional): a token
                       not given by the environment is read from
                       evidence.token / control.token there.
  tool                 The target tool (create_ticket).
  args_template        Arguments A, with {K} and {SESSION}. The adapter
                       binds K as idempotency_key itself.
  mismatch             {"field", "altered_value"}: the one parameter A2
                       changes.
  fault                "server" (default when control_url is set) or
                       "client".
  drop_timeout_s       How long the caller waits for a dropped answer
                       (default 5).
  protocol_version     MCP protocol version sent in initialize (default
                       2025-11-25).
  operation_path       Evidence path of a key's record (default
                       /operations/{K}).
  principal            The principal the evidence reads name
                       (?principal=<id>), needed when more than one is
                       configured. Default: the principal the adapter's run
                       was allocated for; without a control listener, the
                       only principal the evidence namespace lists. With
                       more than one principal and none recorded the
                       adapter refuses (PrincipalUnknown) rather than
                       guess: TRACKER_BACKEND_TOKEN may be any of them.
                       initialize records the principal it settled on here,
                       so the driver's A5 plant (which keeps this config)
                       carries it to the delayed leg.
  expected_build_hash  Optional: the build_hash the run must be against;
                       initialize records whether GET /build matches.
  build                Informational: what was started, recorded with the
                       run.

Tokens are never written to the run outputs. Generate a config from a
running tiny-tracker with tiny-tracker's harness/adapter_config.py.
"""

import hashlib
import json
import os
import re
import socket
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

try:
    from .base import SystemAdapter
except ImportError:  # outside the contract repository (tiny-tracker's own tests)
    class SystemAdapter:
        name = "base"

        def __init__(self, config):
            self.config = config or {}

ADAPTER_VERSION = "0.2.0"
CONTRACT = {"repo": "zambodotdev/lost-response-test-contract",
            "commit": "92bf1ba5f8226a67409fd8a7a68411b5c4a7258d"}
META_PREFIX = "dev.writesafety.tiny-tracker"
META_RUN = META_PREFIX + "/run"
META_OPERATION = META_PREFIX + "/operation"
EXECUTION_ID = re.compile(r"^X-[1-9][0-9]*$")
SELF_ATTESTED_NOTE = (
    "self-attested: the driver at 92bf1ba takes the committed digest as the recovered digest "
    "on a found attempt without comparing (driver ask (b)); this attempt's own digest is "
    "digest_returned")

# Loopback only: no proxy, whatever the environment says.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def substitute(template, values):
    if isinstance(template, str):
        out = template
        for key, value in values.items():
            out = out.replace("{" + key + "}", value)
        return out
    if isinstance(template, dict):
        return {k: substitute(v, values) for k, v in template.items()}
    if isinstance(template, list):
        return [substitute(v, values) for v in template]
    return template


def read_token(env_name, token_dir=None, file_name=None):
    """A token from NAME, from the file NAME_FILE names, or from token_dir/file_name. Never from argv."""
    value = os.environ.get(env_name)
    if value:
        return value.strip()
    path = os.environ.get(env_name + "_FILE")
    if not path and token_dir and file_name:
        path = os.path.join(token_dir, file_name)
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    return None


# -- digests (tiny-tracker decision 0002) -------------------------------

def domain_digest(domain, canonical):
    h = hashlib.sha256()
    h.update(domain.encode("utf-8"))
    h.update(b"\n")
    h.update(canonical.encode("utf-8"))
    return h.hexdigest()


def _canon_number(x):
    if isinstance(x, bool):
        raise ValueError("bool")
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("not a finite number")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _canon_number(-x)
    mantissa, _, exp = repr(x).partition("e")
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
    head = digits if k == 1 else digits[0] + "." + digits[1:]
    return head + "e" + ("+" if e >= 0 else "-") + str(abs(e))


_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _canon_string(s):
    out = ['"']
    for ch in s:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            raise ValueError("lone surrogate")
        out.append(_SHORT.get(ch) or ("\\u%04x" % ord(ch) if ord(ch) < 0x20 else ch))
    out.append('"')
    return "".join(out)


def canonicalize(value):
    """RFC 8785, as tiny-tracker's verify/python/tt_digest.py writes it."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _canon_number(value)
    if isinstance(value, str):
        return _canon_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        names = sorted(value, key=lambda n: n.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(_canon_string(k) + ":" + canonicalize(value[k]) for k in names) + "}"
    raise ValueError("not JSON data")


def recompute_served(served):
    """Checks one served digest {alg, domain, canonical, digest}: the recomputation the driver records."""
    if not isinstance(served, dict) or not all(isinstance(served.get(k), str) for k in ("domain", "canonical", "digest")):
        return {"status": "not_computable", "reason": "the record serves no domain, canonical bytes and digest"}
    recomputed = domain_digest(served["domain"], served["canonical"])
    try:
        canonical_form = canonicalize(json.loads(served["canonical"])) == served["canonical"]
    except ValueError:
        canonical_form = False
    out = {
        "status": "matched" if recomputed == served["digest"] else "mismatched",
        "method": "SHA-256 over UTF-8(domain) || 0x0A || UTF-8(canonical), from the served bytes",
        "alg": served.get("alg"),
        "domain": served["domain"],
        "served_digest": served["digest"],
        "recomputed_digest": recomputed,
        "canonical_bytes_are_rfc8785": canonical_form,
        "informational_bare_sha256": hashlib.sha256(served["canonical"].encode("utf-8")).hexdigest(),
        "informational_note": "SHA-256 of the canonical bytes without the domain tag; it differs from the "
                              "served digest by design (tiny-tracker decision 0002)",
    }
    return out


def find_record(value, kind, depth=0):
    """The first object whose "record" member is kind (e.g. operation-record/1), searched depth-first."""
    if depth > 6:
        return None
    if isinstance(value, dict):
        if value.get("record") == kind:
            return value
        for v in value.values():
            hit = find_record(v, kind, depth + 1)
            if hit is not None:
                return hit
    elif isinstance(value, list):
        for v in value:
            hit = find_record(v, kind, depth + 1)
            if hit is not None:
                return hit
    return None


# -- HTTP -----------------------------------------------------------------

def http(method, url, headers=None, body=None, timeout=30):
    """Returns (meta, raw bytes or None, error). A read timeout returns meta with timed_out True."""
    started = time.time()
    meta = {"method": method, "url": url, "sent_at": utcnow()}
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        resp = _OPENER.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    except (socket.timeout, TimeoutError):
        meta.update(received_at=utcnow(), elapsed_ms=round((time.time() - started) * 1000),
                    http_status=None, timed_out=True)
        return meta, None
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            meta.update(received_at=utcnow(), elapsed_ms=round((time.time() - started) * 1000),
                        http_status=None, timed_out=True)
            return meta, None
        meta.update(received_at=utcnow(), http_status=None, connection_error=str(e.reason))
        return meta, None
    try:
        raw = resp.read()
    except (socket.timeout, TimeoutError):
        meta.update(received_at=utcnow(), elapsed_ms=round((time.time() - started) * 1000),
                    http_status=resp.status, timed_out=True, content_type=resp.headers.get("Content-Type"))
        return meta, None
    except (ConnectionError, OSError) as e:
        meta.update(received_at=utcnow(), http_status=resp.status, connection_error=str(e))
        return meta, None
    meta.update(received_at=utcnow(), elapsed_ms=round((time.time() - started) * 1000),
                http_status=resp.status, content_type=resp.headers.get("Content-Type"),
                response_bytes=len(raw), headers={k.lower(): v for k, v in resp.headers.items()})
    return meta, raw


def parse_json(raw):
    if raw is None:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        return None


def parse_mcp_body(meta, raw, jsonrpc_id):
    """The JSON-RPC message answering jsonrpc_id, from application/json or a text/event-stream answer."""
    if raw is None:
        return None
    ctype = (meta.get("content_type") or "").lower()
    text = raw.decode("utf-8", errors="replace")
    if "text/event-stream" in ctype:
        messages, data = [], []
        for line in text.splitlines() + [""]:
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
            elif line == "" and data:
                try:
                    messages.append(json.loads("\n".join(data)))
                except ValueError:
                    messages.append({"_unparsed_sse_data": "\n".join(data)[:4000]})
                data = []
        for msg in messages:
            if isinstance(msg, dict) and msg.get("id") == jsonrpc_id:
                return msg
        return {"_no_matching_message": True, "_sse_messages": messages}
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return {"_non_json_body": text[:4000]}


class McpClient:
    """A minimal MCP client over Streamable HTTP."""

    def __init__(self, endpoint, protocol_version):
        self.endpoint = endpoint
        self.protocol_version = protocol_version
        self.negotiated_version = None
        self.session_id = None

    def _headers(self):
        h = {"Accept": "application/json, text/event-stream"}
        if self.negotiated_version:
            h["MCP-Protocol-Version"] = self.negotiated_version
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def post(self, payload, timeout=60):
        meta, raw = http("POST", self.endpoint, self._headers(), payload, timeout=timeout)
        meta["jsonrpc_id"] = payload.get("id")
        return meta, raw

    def initialize(self):
        payload = {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": "initialize",
                   "params": {"protocolVersion": self.protocol_version, "capabilities": {},
                              "clientInfo": {"name": "lost-response-harness", "version": "1.0.0"}}}
        meta, raw = self.post(payload)
        body = parse_mcp_body(meta, raw, payload["id"])
        self.session_id = (meta.get("headers") or {}).get("mcp-session-id")
        result = (body or {}).get("result") or {}
        self.negotiated_version = result.get("protocolVersion")
        note = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        nmeta, _ = self.post(note)
        return {"initialize": {"request": payload, "transport": _public(meta), "body": body},
                "notifications_initialized": {"request": note, "transport": _public(nmeta)}}

    def request(self, method, params, timeout=60):
        payload = {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}
        meta, raw = self.post(payload, timeout=timeout)
        return payload, meta, parse_mcp_body(meta, raw, payload["id"])

    def tools(self):
        _, _, body = self.request("tools/list", {})
        return [t.get("name") for t in (((body or {}).get("result") or {}).get("tools") or [])]


class StdioMcpClient:
    """A minimal MCP client over stdio (newline-delimited JSON-RPC), with McpClient's interface.

    One process, one connection. A reader thread files every message by id, so an answer that arrives after the caller
    gave up (a held answer: the server-side drop) is kept apart and never taken for a later call's.
    """

    def __init__(self, command, protocol_version, env=None):
        import subprocess
        import threading
        import atexit
        self.protocol_version = protocol_version
        self.negotiated_version = None
        self.session_id = None
        self.endpoint = "stdio:" + " ".join(command[:2])
        self._messages = {}
        self._late = []
        self._waiting = set()
        self._cond = threading.Condition()
        self.state = None
        self._stderr = []
        # Our own child: stopped by closing its stdin, then by its own pid if it lingers.
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=env if env is not None else dict(os.environ))
        threading.Thread(target=self._read_stdout, daemon=True).start()
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_thread.start()
        atexit.register(self.close)

    def _read_stdout(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                continue
            with self._cond:
                mid = msg.get("id") if isinstance(msg, dict) else None
                if mid in self._waiting:
                    self._messages[mid] = msg
                elif mid is not None:
                    self._late.append(mid)
                self._cond.notify_all()

    def _read_stderr(self):
        for line in self.proc.stderr:
            text = line.decode("utf-8", errors="replace")
            with self._cond:
                self._stderr.append(text)
                if self.state is None and text.lstrip().startswith("{"):
                    try:
                        st = json.loads(text)
                        if isinstance(st, dict) and st.get("transport") == "stdio":
                            self.state = st
                    except ValueError:
                        pass
                self._cond.notify_all()

    def wait_state(self, timeout=20):
        """The server's state line (stderr), for the backend and control URLs."""
        end = time.time() + timeout
        with self._cond:
            while self.state is None and self.proc.poll() is None and time.time() < end:
                self._cond.wait(0.1)
            return self.state

    def stderr_tail(self, lines=20):
        """The last lines the server wrote to stderr (its refusal, when it would not start). It never prints a token."""
        if self.proc.poll() is not None:
            self._stderr_thread.join(2)  # the child has exited: let the reader take what is left in the pipe
        with self._cond:
            return "".join(self._stderr[-lines:]).strip()

    def start_failure(self, timeout):
        """Why there is no state line: the exit code and the stderr tail. A child still running is stopped."""
        code = self.proc.poll()
        if code is None:
            self.close()
            what = "printed no state line within %ss and was stopped" % timeout
        else:
            what = "exited %s before its state line" % code
        tail = self.stderr_tail()
        return "the stdio server (%s) %s%s" % (self.endpoint, what, (": " + tail) if tail else " (nothing on stderr)")

    def post(self, payload, timeout=60):
        started = time.time()
        meta = {"method": "stdio", "url": self.endpoint, "sent_at": utcnow(), "transport": "stdio"}
        mid = payload.get("id")
        with self._cond:
            if mid is not None:
                self._waiting.add(mid)
        try:
            self.proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            meta.update(received_at=utcnow(), http_status=None, connection_error=str(e))
            return meta, None
        if mid is None:  # a notification: nothing comes back
            meta.update(received_at=utcnow(), http_status=202)
            return meta, None
        end = started + timeout
        with self._cond:
            while mid not in self._messages and time.time() < end and self.proc.poll() is None:
                self._cond.wait(min(0.1, max(0.0, end - time.time())))
            msg = self._messages.pop(mid, None)
            self._waiting.discard(mid)
        elapsed = round((time.time() - started) * 1000)
        if msg is None:
            meta.update(received_at=utcnow(), elapsed_ms=elapsed, http_status=None, timed_out=True)
            return meta, None
        raw = json.dumps(msg).encode("utf-8")
        meta.update(received_at=utcnow(), elapsed_ms=elapsed, http_status=200, content_type="application/json",
                    response_bytes=len(raw), jsonrpc_id=mid)
        return meta, raw

    def initialize(self):
        return McpClient.initialize(self)

    def request(self, method, params, timeout=60):
        return McpClient.request(self, method, params, timeout)

    def tools(self):
        return McpClient.tools(self)

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=10)
            except Exception:  # still running: stop our own child by its pid
                self.proc.kill()
                self.proc.wait(timeout=10)


def _public(meta):
    """Transport metadata without response headers (they can carry session ids; nothing secret, but not needed)."""
    return {k: v for k, v in meta.items() if k != "headers"}


def classify(meta, body):
    """The caller-visible response class of a tools/call answer."""
    if meta.get("timed_out"):
        return "no_answer:timeout"
    if meta.get("http_status") != 200 and not body:
        return "http_error:%s" % meta.get("http_status")
    if not isinstance(body, dict) or body.get("_no_matching_message") or body.get("_non_json_body"):
        return "unparseable"
    if body.get("error"):
        return "jsonrpc_error:" + str((body["error"] or {}).get("code", "unknown"))
    result = body.get("result")
    if not result:
        return "empty_result"
    structured = result.get("structuredContent") or {}
    if result.get("isError"):
        code = None
        if isinstance(structured, dict):
            code = (structured.get("mws") or {}).get("code") or structured.get("error")
        return "tool_error:" + (str(code) if code else "isError")
    return "success"


def text_of(body):
    content = (((body or {}).get("result") or {}).get("content") or [])
    return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")


def record_ids_of(body):
    structured = (((body or {}).get("result") or {}).get("structuredContent") or {})
    if isinstance(structured, dict) and isinstance(structured.get("id"), str):
        return [structured["id"]]
    return []


def ticket_number(ticket_id):
    try:
        return int(str(ticket_id).split("-", 1)[1])
    except (IndexError, ValueError):
        return 0


def execution_number(execution_id):
    try:
        return int(str(execution_id)[2:])
    except ValueError:
        return 0


class Http:
    """Bearer-token GETs and POSTs against one listener."""

    def __init__(self, base_url, token):
        self.base = base_url.rstrip("/")
        self.token = token

    def call(self, method, path, body=None, headers=None, timeout=30):
        h = {"Accept": "application/json"}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        h.update(headers or {})
        meta, raw = http(method, self.base + path, h, body, timeout=timeout)
        out = {"url": self.base + path, "method": method, "fetched_at": meta.get("received_at"),
               "http_status": meta.get("http_status"), "content_type": meta.get("content_type"),
               "headers": {k: v for k, v in (meta.get("headers") or {}).items()
                           if k in ("etag", "tiny-tracker-build", "idempotent-replayed")},
               "body_text": raw.decode("utf-8", errors="replace") if raw is not None else None,
               "body_json": parse_json(raw)}
        if meta.get("connection_error"):
            out["connection_error"] = meta["connection_error"]
        return out, raw


def ledger_entries(served_json):
    """Ledger entries from GET /ledger: {"entries": [...]}, a bare list, or {"ledger": [...]}."""
    if isinstance(served_json, list):
        return served_json
    if isinstance(served_json, dict):
        for k in ("entries", "ledger"):
            if isinstance(served_json.get(k), list):
                return served_json[k]
    return None


class PrincipalUnknown(RuntimeError):
    """More than one principal is configured and the adapter has none recorded: it does not guess."""


def only_principal(body):
    """The principal a 400 principal_required answer leaves no doubt about (exactly one listed), else None."""
    listed = body.get("principals") if isinstance(body, dict) else None
    if isinstance(listed, list) and len(listed) == 1 and isinstance(listed[0], str):
        return listed[0]
    return None


def refuse_to_guess(body, where):
    listed = body.get("principals") if isinstance(body, dict) else None
    return PrincipalUnknown(
        "%s: the backend lists %s principals (%s) and this adapter has none recorded; set adapter_config.principal "
        "(harness/adapter_config.py --principal ID) to the principal the MCP server writes as. Not guessing: the "
        "wrong principal reads an applied write as missing." % (where, len(listed or []), ", ".join(map(str, listed or []))))


class StdioStartError(RuntimeError):
    """mcp_command did not start: the message carries the exit code and the server's stderr tail."""


class Adapter(SystemAdapter):
    """The tiny-tracker 0.2.0 adapter. See the module docstring."""

    name = "tiny_tracker"
    stdio = None  # the StdioMcpClient with mcp_command (0.4.0); a class default, so an adapter built without __init__ has it

    def __init__(self, config):
        super().__init__(config)
        c = self.config
        self.protocol_version = c.get("protocol_version", "2025-11-25")
        self.stdio = None
        if c.get("mcp_command"):
            # 0.4.0: the MCP server over stdio; its state line names the backend and control listeners.
            self.stdio = StdioMcpClient(list(c["mcp_command"]), self.protocol_version)
            wait = float(c.get("start_timeout_s", 20))
            state = self.stdio.wait_state(wait)
            if state is None:
                # A refused start (exit 2) says why on stderr; the common case is TRACKER_MCP_TOKEN set in the harness
                # environment, which stdio refuses (it has no listener to protect).
                raise StdioStartError(self.stdio.start_failure(wait))
            c = dict(c)
            c.setdefault("backend_url", state.get("backend"))
            if state.get("control"):
                c.setdefault("control_url", state.get("control"))
            self.config = c
        self.endpoint = self.stdio.endpoint if self.stdio else c["mcp_url"]
        self.tool_name = c.get("tool", "create_ticket")
        token_dir = c.get("token_dir")
        self.evidence = Http(c["backend_url"], read_token(c.get("evidence_token_env", "TRACKER_EVIDENCE_TOKEN"), token_dir, "evidence.token"))
        self.backend = Http(c["backend_url"], read_token(c.get("backend_token_env", "TRACKER_BACKEND_TOKEN")))
        control_url = c.get("control_url")
        self.control = Http(control_url, read_token(c.get("control_token_env", "TRACKER_CONTROL_TOKEN"), token_dir, "control.token")) if control_url else None
        self.fault_mode = c.get("fault") or ("server" if self.control and self.control.token else "client")
        self.drop_timeout = float(c.get("drop_timeout_s", 5))
        self.operation_path = c.get("operation_path", "/operations/{K}")
        self.client = self.stdio or McpClient(self.endpoint, self.protocol_version)
        self.run_id = None
        self.principal = c.get("principal")

    def _ev(self, path):
        """GET on the evidence namespace, naming the principal when one is set (INTERFACES §1.4).

        The principal comes from the config (the delayed leg's plant carries the one initialize settled on). Without
        one, a 400 principal_required that lists exactly one principal is answered by naming it and the read is
        repeated once; with more than one listed the adapter raises PrincipalUnknown (G2 fold-in 6): the MCP server
        may write as any of them, and a read under the wrong one reports an applied write as missing.
        """
        def call(p):
            if self.principal:
                p += ("&" if "?" in p else "?") + "principal=" + quote(self.principal, safe="")
            return self.evidence.call("GET", p)
        served, raw = call(path)
        body = served.get("body_json") if isinstance(served.get("body_json"), dict) else {}
        if not self.principal and served.get("http_status") == 400 and body.get("error") == "principal_required":
            only = only_principal(body)
            if only is None:
                raise refuse_to_guess(body, path)
            self._settle_principal(only)
            served, raw = call(path)
        return served, raw

    def _settle_principal(self, principal):
        """Records the principal, in the config too: the driver's A5 plant keeps this config for the delayed leg."""
        self.principal = principal
        self.config["principal"] = principal

    def _args(self, session_id, operation_key, mismatched):
        template = dict(self.config["args_template"])
        if mismatched:
            m = self.config["mismatch"]
            template[m["field"]] = m["altered_value"]
        args = substitute(template, {"K": operation_key, "SESSION": session_id})
        args["idempotency_key"] = operation_key
        return args

    # -- adapter contract -------------------------------------------------
    def initialize(self):
        evidence = {"adapter": self.name, "adapter_version": ADAPTER_VERSION, "contract": CONTRACT,
                    "mcp_url": self.endpoint, "mcp_transport": "stdio" if self.stdio else "streamable-http",
                    "backend_url": self.evidence.base,
                    "control_url": self.control.base if self.control else None,
                    "fault_mode": self.fault_mode, "build": self.config.get("build"), "at": utcnow()}
        evidence.update(self.client.initialize())
        payload, meta, body = self.client.request("tools/list", {})
        evidence["tools_list"] = {"request": payload, "transport": _public(meta), "body": body}
        build, _ = self.evidence.call("GET", "/build")
        evidence["build_descriptor"] = {k: v for k, v in build.items() if k != "body_text"}
        descriptor = build.get("body_json") if build.get("http_status") == 200 else None
        if self.control and self.control.token:
            run, _ = self.control.call("POST", "/_fixture/runs", {"label": "lost-response harness"})
            evidence["run_allocation"] = {k: v for k, v in run.items() if k != "body_text"}
            if run.get("http_status") == 201 and isinstance(run.get("body_json"), dict):
                self.run_id = run["body_json"].get("run_id")
                if not self.principal and isinstance(run["body_json"].get("principal"), str):
                    self._settle_principal(run["body_json"]["principal"])
        if not self.principal:
            probe, _ = self.evidence.call("GET", "/executions/X-0")
            body = probe.get("body_json") if isinstance(probe.get("body_json"), dict) else {}
            if probe.get("http_status") == 400 and body.get("error") == "principal_required":
                only = only_principal(body)
                if only is None:
                    raise refuse_to_guess(body, "initialize")
                self._settle_principal(only)
        elif self.config.get("principal") != self.principal:
            self.config["principal"] = self.principal
        evidence["evidence_principal"] = self.principal
        init_body = evidence["initialize"]["body"] or {}
        result = init_body.get("result") or {}
        tools = ((body or {}).get("result") or {}).get("tools") or []
        target = next((t for t in tools if t.get("name") == self.tool_name), None)
        names = [t.get("name") for t in tools]
        expected = self.config.get("expected_build_hash")
        summary = {
            "http_status": evidence["initialize"]["transport"].get("http_status"),
            "protocol_version": result.get("protocolVersion"),
            "server_info": result.get("serverInfo"),
            "target_tool_listed": bool(target),
            "target_tool_annotations": (target or {}).get("annotations"),
            "target_tool_accepts_idempotency_key": "idempotency_key" in
            (((target or {}).get("inputSchema") or {}).get("properties") or {}),
            "get_operation_listed": "get_operation" in names,
            "get_execution_listed": "get_execution" in names,
            "build_descriptor_status": build.get("http_status"),
            "build_hash": (descriptor or {}).get("build_hash"),
            "descriptor_hash": (descriptor or {}).get("descriptor_hash"),
            "features": (descriptor or {}).get("features"),
            "defects": (descriptor or {}).get("defects"),
            "faults_armed_at_start": ((descriptor or {}).get("faults") or {}).get("armed"),
            "clock": (descriptor or {}).get("clock"),
            "contract_commit_in_descriptor": ((descriptor or {}).get("contract") or {}).get("commit"),
            "contract_commit_matches_adapter": ((descriptor or {}).get("contract") or {}).get("commit") == CONTRACT["commit"],
            "expected_build_hash": expected,
            "build_matches": None if not expected else (descriptor or {}).get("build_hash") == expected,
            "run_id": self.run_id,
            "evidence_principal": self.principal,
            "fault_mode": self.fault_mode,
            "lrt_a3_k_only": SELF_ATTESTED_NOTE,
            "build": self.config.get("build"),
        }
        return evidence, summary

    def _arm_drop(self, session_id):
        selector = {"tool": self.tool_name, "operation": session_id, "once": True}
        if self.run_id:
            selector["run"] = self.run_id
        armed, _ = self.control.call("POST", "/_fixture/faults",
                                     {"point": "mcp/after-backend-reply/drop", "selector": selector})
        return {"point": "mcp/after-backend-reply/drop", "selector": selector,
                "arm_http_status": armed.get("http_status"),
                "armed": armed.get("http_status") in (200, 201)}

    def execute(self, *, session_id, operation_key, mismatched=False, drop_response=False):
        args = self._args(session_id, operation_key, mismatched)
        meta_tags = {META_OPERATION: session_id}
        if self.run_id:
            meta_tags[META_RUN] = self.run_id
        params = {"name": self.tool_name, "arguments": args, "_meta": meta_tags}
        if drop_response:
            fault = None
            timeout = 60
            if self.fault_mode == "server" and self.control:
                fault = self._arm_drop(session_id)
                if fault["armed"]:
                    timeout = self.drop_timeout
            payload, meta, body = self.client.request("tools/call", params, timeout=timeout)
            del body
            server_side = bool(fault and fault["armed"] and meta.get("timed_out"))
            call = {"dropped": True, "transport": _public(meta),
                    "fault": {"mode": "server" if server_side else "client",
                              "server_fault": fault,
                              "fired": server_side,
                              "fallback_used": bool(fault) and not server_side}}
            call["note"] = (
                "Server-side lost response: mcp/after-backend-reply/drop fired; the backend committed and "
                "answered, the MCP server never answered, and the caller gave up after %ss." % self.drop_timeout
                if server_side else
                "Response read off the wire in full (the call had finished and committed on the server), then "
                "discarded client-side. No result, ticket id, or digest from this attempt is available to the "
                "caller.")
            return {"arguments_sent": args, "call": call}
        payload, meta, body = self.client.request("tools/call", params)
        structured = ((body or {}).get("result") or {}).get("structuredContent") or {}
        call = {"dropped": False, "transport": _public(meta), "body": body,
                "response_class": classify(meta, body),
                "replayed": structured.get("replayed") if isinstance(structured, dict) else None,
                "mws_outcome": (structured.get("mws") or {}).get("outcome") if isinstance(structured, dict) else None,
                "receipt_ids": record_ids_of(body)}
        return {"arguments_sent": args, "call": call}

    # -- the counter ------------------------------------------------------
    def _ledger_count(self, session_id, operation_key):
        served, _ = self._ev("/ledger")
        entries = ledger_entries(served.get("body_json")) if served.get("http_status") == 200 else None
        if entries is None:
            return served, None
        attributed, ids, refusals, replays = [], [], [], []
        for e in entries:
            if not isinstance(e, dict) or e.get("operation_tag") != session_id:
                continue
            if self.run_id and e.get("run") not in (self.run_id, None):
                continue
            req = e.get("request") or {}
            key = req.get("key")
            row = {"ledger_seq": e.get("seq"), "kind": e.get("kind"), "execution_id": e.get("execution_id"),
                   "key": key, "key_is_K": key == operation_key, "status": e.get("status"),
                   "objects": e.get("objects"), "run": e.get("run"), "at": e.get("at")}
            if e.get("kind") == "execution":
                row["counted_as_execution"] = key in (operation_key, None)
                if row["counted_as_execution"]:
                    ids.append(e.get("execution_id"))
            elif e.get("kind") == "refusal":
                refusals.append(row)
            elif e.get("kind") == "replay":
                replays.append(row)
            attributed.append(row)
        return served, {"attributed": attributed, "ids": sorted(ids, key=execution_number),
                        "refusals": refusals, "replays": replays}

    def _title_count(self, session_id, operation_key):
        listing, _ = self.backend.call("GET", "/tickets?title_prefix=" + quote(operation_key, safe=""))
        tickets = ((listing.get("body_json") or {}).get("tickets") or [])
        attributed, ids = [], []
        for t in sorted(tickets, key=lambda t: ticket_number(t.get("id"))):
            title_ok = str(t.get("title", "")).startswith(operation_key)
            session_ok = session_id is None or session_id in str(t.get("description", ""))
            counted = listing["http_status"] == 200 and title_ok and session_ok
            attributed.append({"ticket_id": t.get("id"), "title_starts_with_K": title_ok,
                               "description_names_session": session_ok, "counted_as_execution": counted})
            if counted:
                ids.append(t.get("id"))
        return listing, attributed, ids

    def count_effects(self, *, session_id, operation_key, label):
        served, counted = self._ledger_count(session_id, operation_key)
        if counted is not None:
            evidence = {
                "label": label, "session_id": session_id, "K": operation_key, "run_id": self.run_id, "at": utcnow(),
                "counter": "ledger",
                "method": "GET <backend>/ledger (evidence token), read directly, not through MCP; each entry of kind "
                          "execution whose operation tag is the session identity and whose key is K or absent is "
                          "one committed execution of the operation",
                "listing_http_status": served["http_status"],
                "attributed_records": counted["attributed"],
                "execution_record_ids": counted["ids"],
                "external_effect_count": len(counted["ids"]),
                "refusal_records": counted["refusals"],
                "replay_records": counted["replays"],
            }
            return {"evidence": evidence, "files": {"ledger_%s.json" % label: served}}
        listing, attributed, ids = self._title_count(session_id, operation_key)
        evidence = {
            "label": label, "session_id": session_id, "K": operation_key, "at": utcnow(),
            "counter": "title-prefix (0.1.0 fallback)",
            "counter_note": "the ledger answered %s, so the 0.1.0 counter was used: it depends on the caller "
                            "putting K in the title" % served.get("http_status"),
            "method": "GET <backend>/tickets?title_prefix=<K> (backend token); each ticket whose title starts with "
                      "K and whose description names the session identity is one committed execution",
            "listing_http_status": listing["http_status"],
            "attributed_records": attributed,
            "execution_record_ids": ids,
            "external_effect_count": len(ids),
            "refusal_records": [],
        }
        return {"evidence": evidence, "files": {"backend_%s_listing.json" % label: listing}}

    # -- records ----------------------------------------------------------
    def fetch_record(self, record_id):
        rid = str(record_id)
        if EXECUTION_ID.match(rid):
            served, _ = self._ev("/executions/" + quote(rid, safe=""))
            record = served.get("body_json") if served.get("http_status") == 200 else None
            record = find_record(record, "execution-record/1") if record is not None else None
            result = (record or {}).get("result")
            digests = {"result_digest": result["digest"]} if isinstance(result, dict) and result.get("digest") else {}
            if served.get("http_status") != 200:
                recomp = {"status": "not_computable", "reason": "GET %s answered %s" % (served["url"], served["http_status"])}
            else:
                recomp = recompute_served(result)
            return {"record_id": rid, "kind": "execution-record", "http_status": served["http_status"],
                    "url": served["url"], "fetched_at": served["fetched_at"], "content_type": served["content_type"],
                    "body_text": served["body_text"], "record_json": served.get("body_json"),
                    "digests": digests, "recomputation": recomp}
        path = self.operation_path.replace("{K}", quote(rid, safe=""))
        served, _ = self._ev(path)
        op = find_record(served.get("body_json"), "operation-record/1") if served.get("http_status") == 200 else None
        digests = {"result_digest": op["result_digest"]} if op and op.get("result_digest") else {}
        if not op:
            recomp = {"status": "not_computable", "reason": "GET %s answered %s" % (served["url"], served["http_status"])}
        elif not op.get("execution_id"):
            recomp = {"status": "not_computable", "reason": "the operation record names no execution record (state %s)" % op.get("state")}
        else:
            ex, _ = self._ev("/executions/" + quote(op["execution_id"], safe=""))
            exrec = find_record(ex.get("body_json"), "execution-record/1") if ex.get("http_status") == 200 else None
            inner = recompute_served((exrec or {}).get("result"))
            equal = inner.get("status") == "matched" and inner.get("served_digest") == op.get("result_digest")
            recomp = dict(inner)
            recomp["status"] = "matched" if equal else ("not_computable" if inner["status"] == "not_computable" else "mismatched")
            recomp["via"] = "the execution record %s named by the operation record (HTTP %s)" % (op["execution_id"], ex.get("http_status"))
            recomp["operation_result_digest"] = op.get("result_digest")
        return {"record_id": rid, "kind": "operation-record", "http_status": served["http_status"],
                "url": served["url"], "fetched_at": served["fetched_at"], "content_type": served["content_type"],
                "body_text": served["body_text"], "record_json": served.get("body_json"),
                "digests": digests, "recomputation": recomp}

    def recover_by_key(self, *, operation_key):
        attempts, files = [], {}
        if self.stdio:
            # One stdio connection: the K-only caller is this connection with no run tag and no operation tag.
            client = self.stdio
            files["a3_konly_initialize.json"] = {"note": "stdio: the one connection, reused with only K (no run tag)"}
        else:
            client = McpClient(self.endpoint, self.protocol_version)  # a fresh caller: only K
            init = client.initialize()
            files["a3_konly_initialize.json"] = init
        tools = client.tools()
        if "get_operation" not in tools:
            attempts.append({"path": "tools/call get_operation {idempotency_key: K}",
                             "response_class": "not_available",
                             "note": "this build lists no get_operation tool (tiny-tracker 0.1.0 has no lookup by key)"})
            payload, meta, body = client.request("tools/call", {"name": "list_tickets", "arguments": {"title_prefix": operation_key}})
            listed = ((((body or {}).get("result") or {}).get("structuredContent") or {}).get("tickets") or [])
            ids = [t.get("id") for t in listed if isinstance(t, dict)]
            files["a3_konly_list_tickets.json"] = {"request": payload, "transport": _public(meta), "body": body}
            cls = classify(meta, body)
            attempts.append({"path": "tools/call list_tickets {title_prefix: K}",
                             "response_class": ("found_by_caller_convention" if ids else "not_found") if cls == "success" else cls,
                             "record_ids_returned": ids, "digest_returned": None, "depends_on_caller_convention": True,
                             "note": "finds tickets only because the caller put K in the title; it carries no digest, "
                                     "so it is never classed found"})
            return {"attempts": attempts, "files": files}
        payload, meta, body = client.request("tools/call", {"name": "get_operation", "arguments": {"idempotency_key": operation_key}})
        files["a3_konly_get_operation.json"] = {"request": payload, "transport": _public(meta), "body": body}
        cls = classify(meta, body)
        structured = ((body or {}).get("result") or {}).get("structuredContent")
        op = find_record(structured, "operation-record/1")
        attempt = {"path": "tools/call get_operation {idempotency_key: K} (%s, no run tag)" % ("the stdio connection" if self.stdio else "fresh session"),
                   "response_class": cls, "record_ids_returned": [], "digest_returned": None}
        no_record = re.search(r"no record of this key", text_of(body), re.I) is not None
        if cls == "success" and op is None:
            attempt["response_class"] = "not_found" if no_record else "unparseable_record"
        elif cls.startswith("tool_error:") and no_record:
            attempt["response_class"] = "not_found"
        elif op is not None:
            attempt["operation_state"] = op.get("state")
            attempt["operation_result_digest"] = op.get("result_digest")
            attempt["execution_id"] = op.get("execution_id")
            if op.get("key") != operation_key:
                attempt["response_class"] = "wrong_record"
                attempt["note"] = "the record answered is for key %r, not K" % op.get("key")
            elif op.get("state") != "completed":
                attempt["response_class"] = {"pending": "in_progress"}.get(op.get("state"), str(op.get("state")))
            else:
                execution = find_record(structured, "execution-record/1")
                if execution is None and op.get("execution_id"):
                    p2, m2, b2 = client.request("tools/call", {"name": "get_execution", "arguments": {"id": op["execution_id"]}})
                    files["a3_konly_get_execution.json"] = {"request": p2, "transport": _public(m2), "body": b2}
                    execution = find_record(((b2 or {}).get("result") or {}).get("structuredContent"), "execution-record/1")
                    attempt["execution_fetched_with"] = "tools/call get_execution {id}"
                recomp = recompute_served((execution or {}).get("result"))
                attempt["digest_recomputation"] = recomp
                attempt["record_ids_returned"] = [op.get("execution_id")] if op.get("execution_id") else []
                attempt["digest_returned"] = recomp.get("served_digest")
                consistent = (recomp.get("status") == "matched" and recomp.get("served_digest") == op.get("result_digest")
                              and (execution or {}).get("id") == op.get("execution_id"))
                if consistent:
                    attempt["response_class"] = "found"
                    attempt["self_attested"] = True
                    attempt["note"] = SELF_ATTESTED_NOTE
                else:
                    attempt["response_class"] = "found_digest_inconsistent"
                    attempt["note"] = "the execution record's served digest does not recompute, or differs from the operation record's result_digest"
        attempts.append(attempt)
        return {"attempts": attempts, "files": files}
