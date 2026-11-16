// DEFECT key-store-in-memory -- MWS-RETRY-2 (MUST)
// A write repeated with the same idempotency key is applied at most once, also
// when the server restarted between the two calls.
//
// WRONG ON PURPOSE. Correct code: createTicket in src/mcp/tools/tickets.ts,
// which leaves keys to the backend; the backend keeps them across a restart of
// the MCP server.
//
// What goes wrong: create_ticket keeps its own record of keys, in the server
// process's memory, and does not send the key to the backend. Within one
// process it answers a repeat from that record. After the server restarts the
// record is gone, and a repeat of a create that was applied before the restart
// creates the ticket a second time.
//
// Mirrors: no published finding yet; Annex B-5 of the spec ("a record kept
// only in memory is lost when the server restarts"), found by MWS-RETRY-2
// step (e).

import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Defect } from "./types.js";
import { patchTool } from "./types.js";
import { fail, fromBackend, ok } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";
import { canonicalJson } from "../backend/store.js";

type Entry = { fingerprint: string; state: "pending" | "done" | "unknown"; result: Promise<CallToolResult> };

export const defect: Defect = {
  name: "key-store-in-memory",
  requirement: "MWS-RETRY-2",
  summary: "create_ticket keeps idempotency keys only in the server's memory, so after a restart a repeat creates the ticket again",
  mirrors: "none published; Annex B-5, the MWS-RETRY-2 restart step",
  replaces: "createTicket (src/mcp/tools/tickets.ts)",
  apply(build) {
    const correct = build.tools.get("create_ticket")!;
    // DEFECT: the record lives and dies with this process.
    const records = new Map<string, Entry>();
    patchTool(build, "create_ticket", {
      async handler(args, deps) {
        const { idempotency_key: key, ...fields } = args;
        if (key === undefined) return correct.handler(args, deps) as Promise<CallToolResult>;
        const project = args.project ?? deps.config.defaultProject;
        const fingerprint = createHash("sha256").update(canonicalJson({ ...fields, project })).digest("hex");
        const seen = records.get(key);
        if (seen && seen.fingerprint !== fingerprint) {
          return fail("This idempotency_key was already used with different arguments; nothing was written.", { error: "idempotency_key_reused" });
        }
        if (seen && seen.state === "unknown") {
          return fail("It is not known whether the earlier call with this idempotency_key was applied: the tracker backend's answer was lost. "
            + "Nothing was written now; list your tickets before retrying with a new key.", { outcome: "unknown" });
        }
        if (seen) {
          const first = await seen.result;
          if (!first.isError) {
            const s = first.structuredContent as { id: string; version: number; project: string };
            return ok(`Ticket ${s.id} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
              { ...receipt(s.id, s.version, [], true), project: s.project });
          }
        }
        // The record is set before the first await, so a simultaneous repeat in this process waits for the same answer.
        const entry: Entry = { fingerprint, state: "pending", result: Promise.resolve(undefined as never) };
        entry.result = (async () => {
          // DEFECT: the key is not sent to the backend, which would keep it across a restart.
          const res = await deps.api.request("POST", "/tickets", { body: { ...fields, project } });
          if (res.status === 0) entry.state = "unknown";
          if (!res.ok) {
            if (res.status !== 0) records.delete(key);
            return fromBackend(res, `project ${project}`);
          }
          entry.state = "done";
          const t = res.body.ticket;
          return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
            { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project });
        })();
        records.set(key, entry);
        return entry.result;
      },
    });
  },
};
