#!/usr/bin/env node
// tiny-tracker command line. See the README for usage.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { ConfigError, startBackend, startServer, type RunningBackend } from "./start.js";
import { effectiveFeatures, featureOffText, needsFixtureLayer, parseFeatures, parseProfile, SettingError, type FeatureOff } from "./profile.js";
import { checkCompat, type ProcessLayout } from "./compat.js";
import { checkArgv, checkDistinct, TokenError } from "./tokens.js";
import { resolveDefects } from "./defects/index.js";
import type { ServerExtras } from "./mcp/server.js";
import type { BackendExtension, BackendFaultHooks } from "./backend/http.js";
import { loadPrincipalsFile, PrincipalError, type Principal } from "./principals.js";
import type { Clock } from "./clock.js";
import { containerMode, resolveTransport, TransportError } from "./transport.js"; // stream F

const USAGE = `usage:
  tiny-tracker all     [--port N] [--backend-port N] [--defect NAME]... [--backend-defect lost-update]
                       [--read-only VALUE] [--tools a,b] [--default-project KEY]
  tiny-tracker backend [--port N] [--backend-defect lost-update]      (needs TRACKER_BACKEND_TOKEN)
  tiny-tracker server  [--port N] [--defect NAME]... [--backend-url URL] [--read-only VALUE] [--tools a,b]
                                                                      (needs TRACKER_BACKEND_TOKEN)
  tiny-tracker stdio   [--backend-port N] [--defect NAME]... [--backend-defect lost-update] [--backend-url URL]
                       [--read-only VALUE] [--tools a,b] [--default-project KEY]
                       MCP over stdin/stdout, with the options of \`all\` (or of \`server\` with --backend-url) except
                       --port and --supervise; the state line goes to stderr (stdio --help).
Defect names are listed in the README; --defect also takes a requirement ID (e.g. MWS-CONC-3) or "all".
Fixture options (see FIXTURE.md):
  --profile 0.1|default    0.1: exactly the surface of the published 0.1.0 (no features). Default: default.
  --features a,b           features to switch on (TRACKER_FEATURES); unknown or not-yet-built names stop the process.
  --fixture-control        start the control listener (needs TRACKER_CONTROL_TOKEN or _FILE); --control-port N.
  --supervise              (all only) run the backend and the MCP server as two children and restart either one
                           when it stops; a new state line follows every restart.
  --fault POINT[:once]     arm a fault point at start (process/position/action, src/fault-points.ts); the
                           supervisor keeps the arming, so a once fault does not re-arm on a restart.
Listeners: there is no --host or --hostname option, and nothing binds by hostname. The backend API and the control
listener bind 127.0.0.1; the MCP listener binds 127.0.0.1, or 0.0.0.0 in container mode (TRACKER_CONTAINER=1, which
needs an MCP token). /mcp serves loopback Host and Origin values only (localhost, 127.0.0.1, [::1]): a request with a
non-loopback Host or Origin gets 403, even with the token (a client connecting by a LAN address or DNS name sends one).
TRACKER_EVIDENCE_LISTEN=HOST:PORT takes an IP address or localhost, not a hostname; off loopback it serves only the
evidence routes, behind the evidence token, for any Host (for a build with defects, only in container mode).
Tokens are read from the environment or a 0600 file, never from the command line.`;

/**
 * Settings that existed in a pre-release of 0.4.0 and were removed before it shipped. A start that still sets one is
 * refused, naming it, so a stale setting is never ignored without a word.
 */
const RETIRED_ENV: Record<string, string> = {
  TRACKER_CONTAINER_ALLOW_DEFECTS: "was removed in 0.4.0: in container mode a build with defects serves its evidence off loopback behind the evidence token, with no opt-in; unset it",
};

/** The probe key: a peek (fence: false) at a key no tool makes; any answer of the fence route states the retention. */
const RETENTION_PROBE_KEY = "tiny-tracker.retention-probe";

/**
 * The key retention the backend states (follow-up F2), in ms, or undefined when it states none: no URL or token, not
 * reachable within 3 s, no fence route (no inflight), or no retention_ms in its answer (no retention).
 */
async function backendRetentionMs(url: string | undefined, token: string | undefined): Promise<number | undefined> {
  if (!url || !token) return undefined;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/operations/${RETENTION_PROBE_KEY}/fence`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fence: false }), signal: AbortSignal.timeout(3000),
    });
    const body = (await res.json().catch(() => null)) as { retention_ms?: unknown } | null;
    const ms = body?.retention_ms;
    return typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 1 ? ms : undefined;
  } catch {
    return undefined;
  }
}

function fail(message: string): never {
  process.stderr.write(`tiny-tracker: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values, tokens: argTokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      port: { type: "string" },
      "backend-port": { type: "string" },
      "backend-url": { type: "string" },
      defect: { type: "string", multiple: true },
      defects: { type: "string" },
      "backend-defect": { type: "string", multiple: true },
      "read-only": { type: "string" },
      tools: { type: "string" },
      "default-project": { type: "string" },
      profile: { type: "string" },
      features: { type: "string" },
      "fixture-control": { type: "boolean" },
      "control-port": { type: "string" },
      "data-dir": { type: "string" },
      "token-dir": { type: "string" },
      // ---- stream D: key retention options ----
      "key-retention": { type: "string" },
      "key-expiry": { type: "string" },
      // ---- end stream D ----
      // ---- stream E ----
      supervise: { type: "boolean" },
      fault: { type: "string", multiple: true },
      // ---- end stream E ----
      help: { type: "boolean" },
    },
  });
  let mode = positionals[0];
  // ---- stream F: the stdio transport (src/stdio.ts) ----
  // `tiny-tracker stdio` is `all` (or `server` with --backend-url) whose MCP layer speaks over stdin and stdout instead of
  // an HTTP listener: the same features, fixture layer, evidence and control listeners. stdout carries protocol messages
  // only, so the usage, the state line, the banner and every refusal go to stderr.
  const stdio = mode === "stdio";
  if (stdio) {
    const { STDIO_USAGE } = await import("./stdio.js");
    if (values.help) {
      process.stderr.write(`${STDIO_USAGE}\n`);
      process.exit(0);
    }
    if (positionals.length > 1) fail(`stdio takes no positional arguments (got ${positionals.slice(1).join(" ")}). Not starting.`);
    if (values.port !== undefined) fail("--port has no effect over stdio (there is no MCP listener; --backend-port and --control-port name the others). Not starting.");
    mode = (values["backend-url"] ?? process.env.TRACKER_BACKEND_URL) !== undefined ? "server" : "all";
    if (mode === "server" && values["backend-port"] !== undefined) fail("--backend-port has no effect with --backend-url (the backend is another process). Not starting.");
  }
  // ---- end stream F ----
  if (values.help || !["all", "backend", "server"].includes(mode ?? "")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(values.help ? 0 : 2);
  }

  const env: Record<string, string | undefined> = { ...process.env };
  if (values["read-only"] !== undefined) env.TRACKER_READ_ONLY = values["read-only"];
  if (values.tools !== undefined) env.TRACKER_TOOLS = values.tools;
  if (values["default-project"] !== undefined) env.TRACKER_DEFAULT_PROJECT = values["default-project"];
  if (values["backend-url"] !== undefined) env.TRACKER_BACKEND_URL = values["backend-url"];
  const defects = [
    ...(values.defect ?? []),
    ...(values.defects ?? env.TRACKER_DEFECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ];
  const backendDefects = values["backend-defect"] ?? [];
  const port = (v: string | undefined) => (v === undefined ? 0 : Number(v));

  // Profile, features and the compatibility table (src/compat.ts). Profile 0.1 keeps the 0.1.0 command line.
  const layout = mode as ProcessLayout;
  const variantNames = (env.TRACKER_VARIANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let profile: ReturnType<typeof parseProfile>, named: ReturnType<typeof parseFeatures>, features: string[];
  // Profile features a variant turns off for this build (owner decision, CMP-5 option b), named on the state line.
  let featuresOff: FeatureOff[];
  try {
    profile = parseProfile(values.profile ?? env.TRACKER_PROFILE);
    named = parseFeatures(values.features ?? env.TRACKER_FEATURES);
    ({ features, off: featuresOff } = effectiveFeatures(profile, named, variantNames));
  } catch (e) {
    if (e instanceof SettingError) fail(e.message);
    throw e;
  }
  const fixtureControl = values["fixture-control"] === true;
  // ---- stream E: the supervisor and its children ----
  // A supervised child is a `tiny-tracker all` that starts one half; the supervisor has already checked the command line.
  let child: import("./supervision.js").ChildContext | null = null;
  if (env.TRACKER_SUPERVISED_CHILD) {
    const supervision = await import("./supervision.js");
    try {
      child = supervision.childContext(env);
    } catch (e) {
      fail((e as Error).message);
    }
    if (mode !== "all") fail("a supervised child runs as `tiny-tracker all`");
  }
  const supervise = values.supervise === true;
  const faultArgs: Array<{ point: string; once: boolean }> = (values.fault ?? []).map((raw) => {
    const once = raw.endsWith(":once");
    return { point: once ? raw.slice(0, -":once".length) : raw, once };
  });
  // ---- end stream E ----
  let mcpDefects: string[] = [];
  if (layout !== "backend") {
    try {
      mcpDefects = resolveDefects(defects, features).map((d) => d.name);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const refusals = checkCompat({
    layout, profile, features: named, defects: mcpDefects, backendDefects, variants: variantNames, faults: faultArgs.map((f) => f.point),
    fixtureControl, dataDir: values["data-dir"], supervise, keyExpiry: values["key-expiry"] ?? env.TRACKER_KEY_EXPIRY,
    transport: stdio ? "stdio" : "http",
  });
  for (const [name, why] of Object.entries(RETIRED_ENV)) if (env[name] !== undefined) refusals.push(`${name} ${why}`);
  if (values["data-dir"] !== undefined && !features.includes("durable")) refusals.push("--data-dir has no effect without the durable feature");
  const tokenDir = values["token-dir"] ?? env.TRACKER_TOKEN_DIR;
  if (tokenDir !== undefined && !needsFixtureLayer(features, fixtureControl)) refusals.push("--token-dir has no effect without a fixture feature or --fixture-control");
  // ---- stream A ----
  // Principals (feature principals, design rule 7): TRACKER_BACKEND_TOKENS_FILE names a 0600 JSON file of principals and
  // their tokens. Without it there is one principal, p-default, holding TRACKER_BACKEND_TOKEN. In `all` the MCP server
  // talks to the backend as the first principal, unless TRACKER_BACKEND_TOKEN is another principal's token. Profile 0.1
  // never reads the file, as 0.1.0 did not; `server` does not either (its backend is another process).
  let principals: Principal[] | undefined;
  const principalsFile = env.TRACKER_BACKEND_TOKENS_FILE;
  if (principalsFile !== undefined && profile !== "0.1" && layout !== "server") {
    if (!features.includes("principals")) refusals.push("TRACKER_BACKEND_TOKENS_FILE needs the principals feature");
    else {
      try {
        principals = loadPrincipalsFile(principalsFile);
      } catch (e) {
        if (e instanceof PrincipalError || (e as NodeJS.ErrnoException).code !== undefined) fail(`${(e as Error).message}. Not starting.`);
        throw e;
      }
      if (env.TRACKER_BACKEND_TOKEN === undefined) env.TRACKER_BACKEND_TOKEN = principals[0].token;
      else if (mode === "all" && !principals.some((p) => p.token === env.TRACKER_BACKEND_TOKEN)) {
        refusals.push("with TRACKER_BACKEND_TOKENS_FILE, TRACKER_BACKEND_TOKEN must be one of its principals' tokens (the MCP server uses it)");
      }
    }
  }
  // Container mode (owner decision): TRACKER_EVIDENCE_LISTEN=HOST:PORT adds a listener that serves only the evidence
  // routes, behind the evidence token, on that address (0.0.0.0 inside a container). The API stays on loopback.
  let evidenceListen: { host: string; port: number } | undefined;
  const listen = env.TRACKER_EVIDENCE_LISTEN;
  if (listen !== undefined && profile !== "0.1") {
    const m = /^(\[[0-9a-fA-F:]+\]|[0-9.]+|localhost):([0-9]{1,5})$/.exec(listen);
    if (!m || Number(m[2]) > 65535) refusals.push(`TRACKER_EVIDENCE_LISTEN must be HOST:PORT (an IP address or localhost), not "${listen}"`);
    else if (!features.includes("evidence") || layout !== "all") refusals.push("TRACKER_EVIDENCE_LISTEN needs the evidence feature and `tiny-tracker all`");
    else {
      evidenceListen = { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(evidenceListen.host);
      // 0.4.0 (owner decision, 16 Nov: evidence reachable behind its token, no opt-in): in container mode, which already
      // refuses to start without a bearer token on /mcp, a defect build serves its read-only evidence on the
      // container's interfaces behind the evidence token, so an outside harness can check a defect build. Outside a
      // container a defect build keeps every listener on loopback.
      let container = false;
      try {
        container = containerMode(env);
      } catch {
        // An unrecognized value is refused by the transport checks below.
      }
      if (!loopback && !container && (mcpDefects.length > 0 || backendDefects.length > 0)) {
        refusals.push("a build with defects keeps every listener on loopback outside container mode; TRACKER_EVIDENCE_LISTEN on another address is refused");
      }
    }
  }
  // ---- end stream A ----
  // ---- stream D: durability settings (durable, inflight, retention) ----
  const keyRetention = values["key-retention"] ?? env.TRACKER_KEY_RETENTION;
  const keyExpiry = values["key-expiry"] ?? env.TRACKER_KEY_EXPIRY;
  let durability: import("./backend/durability.js").DurabilityOptions | undefined;
  // `server`, and `stdio` with a backend URL, which runs as `server` (0.3.0 default flip): retention comes from the
  // profile and the backend is another process. The tools and (0.4.0) the server instructions state the retention the
  // backend states (follow-up F2, read at start below); --key-retention given here must agree with it. null: the
  // backend did not state one and none was given, so the tools say the retention is not known.
  let statedRetentionMs: number | null | undefined;
  let givenRetentionMs: number | undefined;
  if ((keyRetention !== undefined || keyExpiry !== undefined) && !features.includes("retention")) {
    refusals.push("--key-retention and --key-expiry (TRACKER_KEY_RETENTION, TRACKER_KEY_EXPIRY) need the retention feature");
  } else if (layout === "server" && keyExpiry !== undefined) {
    // Follow-up F3: the expiry policy is the backend's (it keeps the key records); in `server`, and in `stdio` with a
    // backend URL (layout "server" too), it would be ignored. The refusal names the command that was run.
    const where = stdio ? "`tiny-tracker stdio` with a backend URL (--backend-url or TRACKER_BACKEND_URL)" : "`tiny-tracker server`";
    refusals.push(`--key-expiry (TRACKER_KEY_EXPIRY) is the backend's setting, and in ${where} the backend is another process: give it where the backend runs (\`all\`, \`backend\`, or \`stdio\` without a backend URL)`);
  } else if (["durable", "inflight", "retention"].some((f) => features.includes(f))) {
    const expiry = await import("./backend/expiry.js");
    try {
      const retentionMs = expiry.parseRetention(keyRetention);
      const policy = expiry.parseExpiryPolicy(keyExpiry);
      if (layout !== "server") durability = { features, dataDir: values["data-dir"], retentionMs, policy };
      else if (keyRetention !== undefined && keyRetention.trim() !== "") givenRetentionMs = retentionMs;
    } catch (e) {
      if (e instanceof expiry.ExpirySettingError) refusals.push(e.message);
      else throw e;
    }
  }
  // ---- end stream D ----
  if (refusals.length > 0) fail(`${refusals.join("; ")}. Not starting.`);
  if (child && (supervise || faultArgs.length > 0)) fail("a supervised child takes no --supervise or --fault");

  if (mode === "all" && !env.TRACKER_BACKEND_TOKEN) env.TRACKER_BACKEND_TOKEN = `tt-local-${randomBytes(16).toString("hex")}`;

  // Token rules that hold with or without the fixture layer: all tokens differ, and none is on the command line.
  try {
    const tokens: Record<string, string | undefined> = { backend: env.TRACKER_BACKEND_TOKEN, evidence: env.TRACKER_EVIDENCE_TOKEN, control: env.TRACKER_CONTROL_TOKEN };
    // stream A: every principal's token joins the checks (the backend token is one of them, so it is named once).
    for (const p of principals ?? []) if (p.token !== env.TRACKER_BACKEND_TOKEN) tokens[`principal ${p.id}`] = p.token;
    checkDistinct(tokens);
    checkArgv(process.argv.slice(2), tokens);
  } catch (e) {
    if (e instanceof TokenError) fail(e.message);
    throw e;
  }

  // ---- stream F: transport settings (src/transport.ts): container mode needs a bearer token for /mcp (X1) ----
  let mcpToken: string | undefined;
  try {
    // Principal tokens join the MCP token's distinctness check (A's principals file; F's integration note).
    // (The backend token is one of them, so it is named once, as in the token check above.)
    const principalTokens = Object.fromEntries((principals ?? []).filter((p) => p.token !== env.TRACKER_BACKEND_TOKEN).map((p) => [`principal ${p.id}`, p.token]));
    mcpToken = resolveTransport(stdio ? "stdio" : layout, env, process.argv.slice(2), process.platform, principalTokens)?.bearerToken;
  } catch (e) {
    if (e instanceof TransportError) fail(e.message);
    throw e;
  }
  // ---- end stream F ----

  // ---- stream E: --supervise hands over to the supervisor (src/supervisor.ts), which starts this command twice ----
  if (supervise) {
    const { runSupervisor } = await import("./supervisor.js");
    const args = [...process.argv.slice(2)];
    args.splice(argTokens.find((t) => t.kind === "positional")!.index, 1);
    await runSupervisor({ cli: process.argv[1], args, env, faults: faultArgs });
    return;
  }
  // ---- end stream E ----

  // Follow-up F2: a `server` with retention states its backend's retention, read from the backend's fence route (every
  // answer of it states retention_ms; a peek with fence: false writes nothing). A --key-retention that differs is
  // refused. A backend that states none (no inflight or retention, or not reachable at start) leaves the given value,
  // or else "not known": never a default the backend may not have.
  if (layout === "server" && features.includes("retention")) {
    const backendStated = await backendRetentionMs(env.TRACKER_BACKEND_URL, env.TRACKER_BACKEND_TOKEN);
    if (backendStated !== undefined && givenRetentionMs !== undefined && backendStated !== givenRetentionMs) {
      const { describeRetention } = await import("./backend/expiry.js");
      fail(`--key-retention (TRACKER_KEY_RETENTION) gives ${describeRetention(givenRetentionMs)}, but the backend states ${describeRetention(backendStated)}; `
        + "drop it (the backend's is used) or give the backend's. Not starting.");
    }
    statedRetentionMs = backendStated ?? givenRetentionMs ?? null;
  }

  // The fixture layer is loaded only when asked for, so the teaching server never imports it (test/import-graph.test.ts).
  let fixture: Awaited<ReturnType<typeof import("./fixture/index.js")["createFixtureLayer"]>> | undefined;
  let backendExtension: BackendExtension | undefined;
  let serverExtras: ServerExtras = {};
  /** The clock every timestamp comes from: wall time, or the fixture clock with the clock feature (stream E). */
  let clock: Clock | undefined;
  if (needsFixtureLayer(features, fixtureControl)) {
    const layer = await import("./fixture/index.js");
    // ---- stream E: the fixture clock ----
    if (features.includes("clock")) {
      const fc = await import("./fixture/clock.js");
      clock = new fc.FixtureClock(child ? fc.folderOffset(child.stateDir) : fc.memoryOffset());
    }
    // ---- end stream E ----
    try {
      fixture = layer.createFixtureLayer({
        layout, profile, features, control: fixtureControl,
        mcpDefects: layout === "backend" ? null : mcpDefects,
        backendDefects: layout === "server" ? null : backendDefects,
        variants: layout === "backend" ? null : variantNames,
        env, argv: process.argv.slice(2), backendToken: env.TRACKER_BACKEND_TOKEN, tokenDir, clock,
        ...(principals ? { principals } : {}), // stream A
        ...(mcpToken !== undefined ? { mcpToken } : {}), // 0.4.0: evidence and control tokens differ from the MCP token
        // 0.3.0 integration: the descriptor's durability block (part of build_hash: it is what the build is).
        durability: features.includes("durable") ? { mode: "journal", journal_format: "journal-format/1" } : { mode: "memory", journal_format: null },
      });
    } catch (e) {
      if (e instanceof layer.TokenError) fail(e.message);
      throw e;
    }
    backendExtension = fixture.backendExtension;
    serverExtras = fixture.serverExtras;
  }
  // ---- stream E: a supervised child's process state and crash points ----
  /** The backend fault hooks (BackendOptions.faults). Stream B's controller passes its own hooks as `next` below. */
  let backendFaults: BackendFaultHooks | undefined;
  if (child && fixture) {
    const supervision = await import("./supervision.js");
    const crash = await import("./fixture/process.js");
    const descriptor = fixture.descriptor;
    descriptor.supervise(child);
    descriptor.arming = supervision.folderArming(child.stateDir, () => descriptor.clock.wallNow());
    const crashOptions = { arming: descriptor.arming, bootId: descriptor.bootId, wallNow: () => descriptor.clock.wallNow() };
    // 0.3.0 integration: in the backend child a firing reaches the ledger (synchronously, before the process stops),
    // naming the execution entry it fired on at after-commit. The firing is kept durably in the arming store too.
    const ledger = fixture.ledger;
    const onFire = ledger ? (f: import("./supervision.js").FaultFiring) => {
      try {
        const on = f.seq === null ? undefined : ledger.list({ kind: "execution" }).findLast((e) => e.execution_id === `X-${f.seq}`);
        ledger.faultFired({ point: f.point, selector: { once: true } }, { run: null, operation: null }, on);
      } catch {
        // The ledger refused (cap or stopped): the firing stays in the arming store.
      }
    } : undefined;
    if (child.role === "backend") {
      backendFaults = crash.backendCrashHooks({ ...crashOptions, ...(onFire ? { onFire } : {}) }, fixture.backendOptions.faults);
      // G2 fold-in 11: the point between a keyed write's effect and its key record (inside the section).
      if (durability) durability.afterEffect = crash.afterEffectCrash({ ...crashOptions, ...(onFire ? { onFire } : {}) });
    }
    else serverExtras = { ...serverExtras, onResult: crash.mcpCrashOnResult(crashOptions, serverExtras.onResult) };
  }
  // ---- end stream E ----

  const closers: Array<() => Promise<void>> = [];
  // One shutdown per process (note 27 item 1): a signal, stdin closing over stdio and a supervisor going away may all
  // ask for it, and a closer may ask again while it runs (closing the stdio server fires its onClose). Every caller gets
  // the same promise, and the closers run last-started first without reordering the array, so each runs exactly once
  // and the backend (the lease and the pid lock) is closed before the process exits.
  let stopping: Promise<never> | undefined;
  const shutdown = (code = 0): Promise<never> => stopping ??= (async () => {
    for (const close of [...closers].reverse()) await close().catch(() => {});
    process.exit(code);
  })();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const out: Record<string, unknown> = {};
  /** Over stdio: starts reading stdin; called after every other listener is up (note 27 item 5). */
  let serveStdio: (() => void) | undefined;
  let backend: RunningBackend | undefined;
  const runsBackend = (mode === "all" || mode === "backend") && child?.role !== "mcp";
  const runsServer = (mode === "all" || mode === "server") && child?.role !== "backend";
  if (runsBackend) {
    if (!env.TRACKER_BACKEND_TOKEN) fail("TRACKER_BACKEND_TOKEN is required");
    // 0.3.0 integration (seams v2.1): the run registry goes to the journal before the backend opens it, and so before
    // the control listener can allocate: run-alloc lines are restored at load, and each new run is journalled.
    if (durability && fixture) durability.runs = fixture.runs;
    // 0.4.0 (note 19 item 7): the fixture clock's moves are journalled and its offset is restored at load.
    if (durability && clock && "restore" in clock) durability.clock = clock as import("./fixture/clock.js").FixtureClock;
    try {
      backend = await startBackend({
        token: env.TRACKER_BACKEND_TOKEN!, port: port(mode === "all" ? values["backend-port"] : values.port), defects: backendDefects,
        features, extension: backendExtension, clock,
        // ---- stream D ----
        durability,
        // ---- end stream D ----
        // Run tags are checked against the registry only when the control listener allocates runs (seams v2.1).
        ...(fixture ? { bootId: fixture.descriptor.bootId, ...(fixtureControl ? { runOwner: fixture.runOwner } : {}) } : {}),
        ...(principals ? { principals } : {}), ...(evidenceListen ? { evidenceListen } : {}), // stream A
        ...(fixture ? fixture.backendOptions : {}), // ---- stream B: the ledger sink and the backend fault hooks ----
        // ---- stream E: a supervised child's crash points, in front of stream B's hooks ----
        ...(backendFaults ? { faults: backendFaults } : {}),
      });
    } catch (e) {
      fail((e as Error).message);
    }
    closers.push(backend.close);
    // ---- stream B ----
    // The run reset and the record routes reach the started backend. On shutdown, held answers are sent before the
    // servers close. The record routes read stream A's EvidenceReader (undefined without execution-records).
    if (fixture) {
      const layer = fixture;
      layer.attachBackend({ store: backend.store, dropRun: backend.dropRun, ...(backend.evidence ? { evidence: backend.evidence } : {}) });
      process.prependListener("SIGINT", () => layer.close());
      process.prependListener("SIGTERM", () => layer.close());
    }
    // ---- end stream B ----
    out.backend = backend.url;
    if (backend.evidenceUrl) out.evidence_listener = backend.evidenceUrl; // stream A: container mode
    if (backendDefects.length) out.backend_defects = backendDefects;
    // ---- stream D: the state line names the data dir and the journal head ----
    if (backend.durability?.journal) out.journal = { data_dir: values["data-dir"], head: backend.durability.journal.head() };
    // 0.3.0 integration: GET /build reads the journal head live.
    if (fixture && backend.durability?.journal) {
      const journal = backend.durability.journal;
      fixture.descriptor.journalHead = () => journal.head();
    }
    // ---- end stream D ----
  }
  if (runsServer) {
    if (backend) env.TRACKER_BACKEND_URL = backend.url;
    try {
      let server: { build: import("./mcp/types.js").Build; config: import("./mcp/config.js").ServerConfig; variants: string[]; close(): Promise<void> };
      if (stdio) {
        // ---- stream F: the MCP layer over stdio; stdin closing stops the process as SIGTERM would ----
        // Checked here, served last (note 27 item 5): stdin is read only once the control listener is up and --fault
        // is armed, just before the state line. A connection the transport closed on an error (a message over the
        // 4 MiB cap) is logged with its reason, and the process exits 1.
        const { prepareStdioServer } = await import("./stdio.js");
        const prepared = prepareStdioServer({ env, defects, features, extras: serverExtras, retentionMs: durability?.retentionMs ?? statedRetentionMs,
          onClose: (failure) => {
            if (failure) process.stderr.write(`tiny-tracker: ${failure}. Stopping.\n`);
            fixture?.close();
            void shutdown(failure ? 1 : 0);
          } });
        serveStdio = prepared.serve;
        server = prepared;
        out.transport = "stdio";
      } else {
        const http = await startServer({ env, defects, port: port(values.port), features, extras: serverExtras, retentionMs: durability?.retentionMs ?? statedRetentionMs });
        server = http;
        out.mcp = http.url;
      }
      closers.push(server.close);
      if (fixture) {
        fixture.descriptor.serverSettings = {
          read_only: server.config.readOnly, tools: server.config.tools, deny_tools: server.config.deny,
          default_project: server.config.defaultProject, key_journal: server.variants.includes("key-store-honest"),
        };
        // ---- stream E: the backend child serves GET /build, so it reads these settings from the state folder ----
        if (child) {
          const supervision = await import("./supervision.js");
          supervision.writeJsonDurable(supervision.settingsPath(child.stateDir), fixture.descriptor.serverSettings);
        }
      }
      out.defects = server.build.defects;
      out.read_only = server.config.readOnly;
      if (server.variants.length) out.variants = server.variants;
    } catch (e) {
      for (const close of closers) await close();
      if (e instanceof ConfigError) fail(e.message);
      throw e;
    }
  }
  if (fixture) {
    out.profile = profile;
    out.features = features;
    if (backendExtension && out.backend) out.evidence = `${out.backend as string}/build`;
    if (tokenDir !== undefined) out.tokens = tokenDir;
    if (fixtureControl && child?.role !== "mcp") {
      try {
        const control = await fixture.startControl(port(values["control-port"]));
        closers.push(control.close);
        out.control = control.url;
      } catch (e) {
        for (const close of closers) await close();
        fail(`the control listener did not start: ${(e as Error).message}`);
      }
    }
    // 0.3.0 integration: --fault at start without --supervise arms through the fault controller, as the control
    // listener would (a ledger entry per arming). CMP-7 has checked the feature and the point; crash points need
    // --supervise (CMP-63), where the supervisor arms them in its state folder instead.
    if (!child && faultArgs.length > 0 && fixture.faults) {
      for (const f of faultArgs) {
        try {
          fixture.faults.arm({ point: f.point, selector: f.once ? { once: true } : {} });
        } catch (e) {
          for (const close of closers) await close();
          fail(`--fault ${f.point}: ${(e as Error).message}. Not starting.`);
        }
      }
    }
  }
  const bannerBackend = runsBackend || !child ? backendDefects : [];
  if ((out.defects as string[] | undefined)?.length || bannerBackend.length) {
    process.stderr.write("\n*** tiny-tracker BROKEN BUILD (teaching fixture): "
      + `${[...((out.defects as string[]) ?? []), ...bannerBackend.map((d) => `backend:${d}`)].join(", ")}.\n`
      + "*** Deliberately unsafe. Loopback only. Never point it at data you care about. ***\n\n");
  }
  if (featuresOff.length) {
    out.features_off = featuresOff.map(featureOffText);
    for (const o of featuresOff) {
      process.stderr.write(`tiny-tracker: ${featureOffText(o)}; this build runs without ${o.feature} (name --features ${o.feature} to be refused instead).\n`);
    }
  }
  // ---- stream E: a supervised child tells the supervisor its boot id, and stops when the supervisor goes away ----
  if (child) {
    out.boot_id = fixture?.descriptor.bootId ?? null;
    process.on("disconnect", () => void shutdown());
  }
  // ---- end stream E ----
  // The MCP transport over stdio starts last, as the state line comes last over HTTP.
  serveStdio?.();
  // stdout carries protocol messages only over stdio: the state line goes to stderr there.
  (stdio ? process.stderr : process.stdout).write(`${JSON.stringify(out)}\n`);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
