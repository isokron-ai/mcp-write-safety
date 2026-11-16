#!/usr/bin/env node
// tiny-tracker command line. See the README for usage.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { ConfigError, startBackend, startServer, type RunningBackend } from "./start.js";

const USAGE = `usage:
  tiny-tracker all     [--port N] [--backend-port N] [--defect NAME]... [--backend-defect lost-update]
                       [--read-only VALUE] [--tools a,b] [--default-project KEY]
  tiny-tracker backend [--port N] [--backend-defect lost-update]      (needs TRACKER_BACKEND_TOKEN)
  tiny-tracker server  [--port N] [--defect NAME]... [--backend-url URL] [--read-only VALUE] [--tools a,b]
                                                                      (needs TRACKER_BACKEND_TOKEN)
Defect names are listed in the README; --defect also takes a requirement ID (e.g. MWS-CONC-3) or "all".`;

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
    if (mode === "all" && !env.TRACKER_BACKEND_TOKEN) env.TRACKER_BACKEND_TOKEN = `tt-local-${randomBytes(16).toString("hex")}`;
    if (!env.TRACKER_BACKEND_TOKEN) fail("TRACKER_BACKEND_TOKEN is required");
    try {
      backend = await startBackend({
        token: env.TRACKER_BACKEND_TOKEN!, port: port(mode === "all" ? values["backend-port"] : values.port), defects: backendDefects,
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
      const server = await startServer({ env, defects, port: port(values.port) });
      closers.push(server.close);
      out.mcp = server.url;
      out.defects = server.build.defects;
      out.read_only = server.config.readOnly;
      if (server.variants.length) out.variants = server.variants;
    } catch (e) {
      for (const close of closers) await close();
      if (e instanceof ConfigError) fail(e.message);
      throw e;
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
