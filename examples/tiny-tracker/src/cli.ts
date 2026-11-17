#!/usr/bin/env node
// tiny-tracker command line. See the README for usage.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { ConfigError, startBackend, startServer, type RunningBackend } from "./start.js";
import { activeFeatures, needsFixtureLayer, parseFeatures, parseProfile, SettingError } from "./profile.js";
import { checkCompat, type ProcessLayout } from "./compat.js";
import { checkArgv, checkDistinct, TokenError } from "./tokens.js";
import { resolveDefects } from "./defects/index.js";
import type { ServerExtras } from "./mcp/server.js";
import type { BackendExtension } from "./backend/http.js";

const USAGE = `usage:
  tiny-tracker all     [--port N] [--backend-port N] [--defect NAME]... [--backend-defect lost-update]
                       [--read-only VALUE] [--tools a,b] [--default-project KEY]
  tiny-tracker backend [--port N] [--backend-defect lost-update]      (needs TRACKER_BACKEND_TOKEN)
  tiny-tracker server  [--port N] [--defect NAME]... [--backend-url URL] [--read-only VALUE] [--tools a,b]
                                                                      (needs TRACKER_BACKEND_TOKEN)
Defect names are listed in the README; --defect also takes a requirement ID (e.g. MWS-CONC-3) or "all".
Fixture options (see FIXTURE.md):
  --profile 0.1|default    0.1: exactly the surface of the published 0.1.0 (no features). Default: default.
  --features a,b           features to switch on (TRACKER_FEATURES); unknown or not-yet-built names stop the process.
  --fixture-control        start the control listener (needs TRACKER_CONTROL_TOKEN or _FILE); --control-port N.
Tokens are read from the environment or a 0600 file, never from the command line.`;

function fail(message: string): never {
  process.stderr.write(`tiny-tracker: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
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
      help: { type: "boolean" },
    },
  });
  const mode = positionals[0];
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
  let profile: ReturnType<typeof parseProfile>, named: ReturnType<typeof parseFeatures>, features: string[];
  try {
    profile = parseProfile(values.profile ?? env.TRACKER_PROFILE);
    named = parseFeatures(values.features ?? env.TRACKER_FEATURES);
    features = activeFeatures(profile, named);
  } catch (e) {
    if (e instanceof SettingError) fail(e.message);
    throw e;
  }
  const fixtureControl = values["fixture-control"] === true;
  const variantNames = (env.TRACKER_VARIANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let mcpDefects: string[] = [];
  if (layout !== "backend") {
    try {
      mcpDefects = resolveDefects(defects, features).map((d) => d.name);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const refusals = checkCompat({
    layout, profile, features: named, defects: mcpDefects, backendDefects, variants: variantNames, faults: [],
    fixtureControl, dataDir: values["data-dir"],
  });
  if (values["data-dir"] !== undefined && !features.includes("durable")) refusals.push("--data-dir has no effect without the durable feature");
  const tokenDir = values["token-dir"] ?? env.TRACKER_TOKEN_DIR;
  if (tokenDir !== undefined && !needsFixtureLayer(features, fixtureControl)) refusals.push("--token-dir has no effect without a fixture feature or --fixture-control");
  // ---- lane lead: principals (stream A replaces this refusal when it wires the file and the principals feature) ----
  if (env.TRACKER_BACKEND_TOKENS_FILE !== undefined) refusals.push("TRACKER_BACKEND_TOKENS_FILE is read from 0.2.0 (feature principals); this build has one principal, p-default, holding TRACKER_BACKEND_TOKEN");
  if (refusals.length > 0) fail(`${refusals.join("; ")}. Not starting.`);

  if (mode === "all" && !env.TRACKER_BACKEND_TOKEN) env.TRACKER_BACKEND_TOKEN = `tt-local-${randomBytes(16).toString("hex")}`;

  // Token rules that hold with or without the fixture layer: all tokens differ, and none is on the command line.
  try {
    const tokens = { backend: env.TRACKER_BACKEND_TOKEN, evidence: env.TRACKER_EVIDENCE_TOKEN, control: env.TRACKER_CONTROL_TOKEN };
    checkDistinct(tokens);
    checkArgv(process.argv.slice(2), tokens);
  } catch (e) {
    if (e instanceof TokenError) fail(e.message);
    throw e;
  }

  // The fixture layer is loaded only when asked for, so the teaching server never imports it (test/import-graph.test.ts).
  let fixture: Awaited<ReturnType<typeof import("./fixture/index.js")["createFixtureLayer"]>> | undefined;
  let backendExtension: BackendExtension | undefined;
  let serverExtras: ServerExtras = {};
  if (needsFixtureLayer(features, fixtureControl)) {
    const layer = await import("./fixture/index.js");
    try {
      fixture = layer.createFixtureLayer({
        layout, profile, features, control: fixtureControl,
        mcpDefects: layout === "backend" ? null : mcpDefects,
        backendDefects: layout === "server" ? null : backendDefects,
        variants: layout === "backend" ? null : variantNames,
        env, argv: process.argv.slice(2), backendToken: env.TRACKER_BACKEND_TOKEN, tokenDir,
      });
    } catch (e) {
      if (e instanceof layer.TokenError) fail(e.message);
      throw e;
    }
    backendExtension = fixture.backendExtension;
    serverExtras = fixture.serverExtras;
  }

  const closers: Array<() => Promise<void>> = [];
  const shutdown = async () => {
    for (const close of closers.reverse()) await close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const out: Record<string, unknown> = {};
  let backend: RunningBackend | undefined;
  if (mode === "all" || mode === "backend") {
    if (!env.TRACKER_BACKEND_TOKEN) fail("TRACKER_BACKEND_TOKEN is required");
    try {
      backend = await startBackend({
        token: env.TRACKER_BACKEND_TOKEN!, port: port(mode === "all" ? values["backend-port"] : values.port), defects: backendDefects,
        features, extension: backendExtension,
        ...(fixture ? { bootId: fixture.descriptor.bootId, runOwner: fixture.runOwner } : {}),
      });
    } catch (e) {
      fail((e as Error).message);
    }
    closers.push(backend.close);
    out.backend = backend.url;
    if (backendDefects.length) out.backend_defects = backendDefects;
  }
  if (mode === "all" || mode === "server") {
    if (backend) env.TRACKER_BACKEND_URL = backend.url;
    try {
      const server = await startServer({ env, defects, port: port(values.port), features, extras: serverExtras });
      closers.push(server.close);
      out.mcp = server.url;
      if (fixture) {
        fixture.descriptor.serverSettings = {
          read_only: server.config.readOnly, tools: server.config.tools, deny_tools: server.config.deny,
          default_project: server.config.defaultProject, key_journal: server.variants.includes("key-store-honest"),
        };
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
    if (fixtureControl) {
      try {
        const control = await fixture.startControl(port(values["control-port"]));
        closers.push(control.close);
        out.control = control.url;
      } catch (e) {
        for (const close of closers) await close();
        fail(`the control listener did not start: ${(e as Error).message}`);
      }
    }
  }
  if ((out.defects as string[] | undefined)?.length || backendDefects.length) {
    process.stderr.write("\n*** tiny-tracker BROKEN BUILD (teaching fixture): "
      + `${[...((out.defects as string[]) ?? []), ...backendDefects.map((d) => `backend:${d}`)].join(", ")}.\n`
      + "*** Deliberately unsafe. Loopback only. Never point it at data you care about. ***\n\n");
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
