// VARIANT key-store-durable -- correct, not a defect (MWS-RETRY-2, Annex B-5; review G6)
//
// Most MCP servers wrap an API they cannot change, with no idempotency key. The
// pattern for them: the server records the key as pending before it calls the
// backend, and completes the record with the result afterwards. This variant
// keeps that record in its own journal file, flushed (fsync) before each step,
// so it survives a restart of the server:
//
//   done        a repeat (also after a restart) is answered with the stored result
//   refused     the backend refused; nothing was written, the key is free again
//   pending     the server stopped, or the answer was lost, between its call and
//   / unknown   the backend's answer: it is not known whether the create applied.
//               A repeat says so (unknown) and writes nothing; it never creates
//               a second ticket.
//
// Unlike key-store-honest (keys only, never results), a restart keeps the
// result, so a repeat after a restart is a true replay. The key is not sent to
// the backend: the variant stands for a backend without one.
//
// Switched on with TRACKER_VARIANTS=key-store-durable and TRACKER_KEY_JOURNAL
// (the journal file).

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Build } from "../mcp/types.js";
import { applied, fail, fromBackend, notApplied, ok, unknownOutcome, type WriteContext } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";
import { canonicalJson } from "../backend/store.js";

type State = "pending" | "done" | "unknown" | "refused";
interface Rec { key: string; fingerprint: string; state: State; result?: { id: string; version: number; project: string; changed: string[] } }

/** Reads the journal: the last line for each key wins; a torn last line is ignored. */
function readJournal(path: string): Map<string, Rec> {
  const out = new Map<string, Rec>();
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  lines.forEach((line, i) => {
    try {
      const r = JSON.parse(line) as Rec;
      out.set(r.key, r);
    } catch (e) {
      if (i !== lines.length - 1) throw new Error(`${path}: line ${i + 1} is not valid; only a torn last line is tolerated`);
    }
  });
  return out;
}

export function applyKeyStoreDurable(build: Build, journal: string): void {
  const correct = build.tools.get("create_ticket")!;
  const records = readJournal(journal);
  // A record left pending by a stopped process: the answer was never seen.
  for (const r of records.values()) if (r.state === "pending") r.state = "unknown";
  const write = (r: Rec) => {
    const fd = openSync(journal, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(r)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    records.set(r.key, { ...r });
  };
  const inFlight = new Map<string, Promise<CallToolResult>>();
  build.tools.set("create_ticket", {
    ...correct,
    async handler(args, deps) {
      const { idempotency_key: key, ...fields } = args;
      if (key === undefined) return correct.handler(args, deps) as Promise<CallToolResult>;
      const project = args.project ?? deps.config.defaultProject;
      const w: WriteContext = { operation: "create", type: "ticket", ...(project !== undefined ? { scope: project } : {}), guard: "key", read: { tool: "list_tickets", arguments: project !== undefined ? { project } : {} } };
      const fingerprint = createHash("sha256").update(canonicalJson({ ...fields, project })).digest("hex");
      const changed = Object.keys(fields).filter((k) => k !== "project");
      const seen = records.get(key);
      if (seen && seen.state !== "refused") {
        if (seen.fingerprint !== fingerprint) {
          return fail("This idempotency_key was already used with different arguments; nothing was written.", { error: "idempotency_key_reused" }, notApplied(w, "idempotency_key_reused", { argument: "/idempotency_key" }));
        }
        const running = inFlight.get(key);
        if (running) await running;
        const now = records.get(key)!;
        if (now.state === "done" && now.result) {
          const s = now.result;
          return ok(`Ticket ${s.id} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
            { ...receipt(s.id, s.version, [], true), project: s.project }, applied({ ...w, scope: s.project }, { id: s.id, version: s.version, changed: s.changed, replayed: true }));
        }
        if (now.state !== "refused") {
          return fail("It is not known whether the earlier call with this idempotency_key was applied: its answer was lost, or the server stopped before it arrived. "
            + "Nothing was written now; list your tickets before retrying with a new key.", { outcome: "unknown" }, { ...unknownOutcome(w, "no_answer"), replayed: true });
        }
      }
      // pending is flushed before the backend is called.
      write({ key, fingerprint, state: "pending" });
      const run = (async () => {
        const res = await deps.api.request("POST", "/tickets", { body: { ...fields, project } });
        if (res.status === 0 || res.status >= 500) {
          write({ key, fingerprint, state: "unknown" });
          return fromBackend(res, `project ${project}`, w);
        }
        if (!res.ok) {
          write({ key, fingerprint, state: "refused" });
          return fromBackend(res, `project ${project}`, w);
        }
        const t = res.body.ticket;
        write({ key, fingerprint, state: "done", result: { id: t.id, version: t.version, project: t.project, changed } });
        return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
          { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project },
          applied({ ...w, scope: t.project }, { id: t.id, version: t.version, changed }));
      })();
      inFlight.set(key, run);
      try {
        return await run;
      } finally {
        inFlight.delete(key);
      }
    },
  });
}
