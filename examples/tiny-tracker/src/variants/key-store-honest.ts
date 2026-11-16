// VARIANT key-store-honest -- correct, not a defect (MWS-RETRY-2, Annex B-5)
//
// A server whose backend offered no idempotency key would have to keep keys
// itself. This variant shows how to do that honestly: create_ticket keeps a
// record of each key in the server's memory and answers a repeat from it, and
// it also writes every key it uses to a journal file before it calls the
// backend. The journal holds keys only, never results. After the server
// restarts, the memory record is gone; a repeat with a key the journal holds is
// refused with an error that says the earlier call's result was not kept and
// that nothing was written, so the create is never applied twice. A repeat
// whose earlier call lost its backend answer is told the outcome is not known.
//
// MWS-RETRY-2 judges this server `held` with the note "key record not kept"
// (step (e)) and "outcome not established" (the proxy-assisted step and the
// crash form), as long as the declaration does not claim that the backend
// offers a key. It does not send the key to the backend on purpose: it stands
// for a backend without one.
//
// Switched on with TRACKER_VARIANTS=key-store-honest; the journal file is
// TRACKER_KEY_JOURNAL (required with this variant).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Build } from "../mcp/types.js";
import { applied, fail, fromBackend, notApplied, ok, unknownOutcome, type WriteContext } from "../mcp/results.js";
import { receipt } from "../mcp/tools/tickets.js";
import { canonicalJson } from "../backend/store.js";

type Entry = { fingerprint: string; state: "pending" | "done" | "unknown" | "refused"; result: Promise<CallToolResult> };

export function applyKeyStoreHonest(build: Build, journal: string): void {
  const correct = build.tools.get("create_ticket")!;
  const records = new Map<string, Entry>();
  const journalled = new Set<string>(existsSync(journal) ? readFileSync(journal, "utf8").split("\n").filter(Boolean) : []);
  build.tools.set("create_ticket", {
    ...correct,
    async handler(args, deps) {
      const { idempotency_key: key, ...fields } = args;
      if (key === undefined) return correct.handler(args, deps) as Promise<CallToolResult>;
      const project = args.project ?? deps.config.defaultProject;
      // The outcome a repeat reports is the keyed write's (here unknown where the earlier answer was lost or not kept).
      const w: WriteContext = { operation: "create", type: "ticket", ...(project !== undefined ? { scope: project } : {}), guard: "key", read: { tool: "list_tickets", arguments: project !== undefined ? { project } : {} } };
      // A repeat whose first call lost its answer: unknown with the first call's code, replayed (this call applied nothing).
      const lost = () => ({ ...unknownOutcome(w, "no_answer"), replayed: true as const });
      // A key from before a restart: the server has no record and cannot vouch for it (B-9 v2 key_not_known; read first).
      const notKnown = () => ({ ...unknownOutcome(w, "key_not_known"), repeat: "read_first" as const });
      const fingerprint = createHash("sha256").update(canonicalJson({ ...fields, project })).digest("hex");
      const seen = records.get(key);
      if (seen && seen.state !== "refused") {
        if (seen.fingerprint !== fingerprint) {
          return fail("This idempotency_key was already used with different arguments; nothing was written.", { error: "idempotency_key_reused" }, notApplied(w, "idempotency_key_reused", { argument: "/idempotency_key" }));
        }
        if (seen.state === "unknown") {
          return fail("It is not known whether the earlier call with this idempotency_key was applied: the tracker backend's answer was lost. "
            + "Nothing was written now; list your tickets before retrying with a new key.", { outcome: "unknown" }, lost());
        }
        const first = await seen.result;
        if (!first.isError) {
          const s = first.structuredContent as { id: string; version: number; project: string };
          return ok(`Ticket ${s.id} was already created by an earlier call with this idempotency_key; nothing new was written (replay).`,
            { ...receipt(s.id, s.version, [], true), project: s.project }, applied({ ...w, scope: s.project }, { id: s.id, version: s.version, changed: Object.keys(fields).filter((k) => k !== "project"), replayed: true }));
        }
        // The state is set when the first call's answer arrives, after the check above.
        if ((seen.state as Entry["state"]) === "unknown") {
          return fail("It is not known whether the earlier call with this idempotency_key was applied: the tracker backend's answer was lost. "
            + "Nothing was written now; list your tickets before retrying with a new key.", { outcome: "unknown" }, lost());
        }
      } else if (!seen && journalled.has(key)) {
        // A key used before this process started: its result was not kept, so the server cannot vouch for it.
        return fail("The result of the earlier call with this idempotency_key was not kept (the server restarted since); "
          + "nothing was written. List your tickets to find the one it may have created, or send a new key.", { outcome: "not_kept" }, notKnown());
      }
      // The key is journalled before the backend is called, and recorded before the first await.
      if (!journalled.has(key)) {
        appendFileSync(journal, `${key}\n`);
        journalled.add(key);
      }
      const entry: Entry = { fingerprint, state: "pending", result: Promise.resolve(undefined as never) };
      entry.result = (async () => {
        const res = await deps.api.request("POST", "/tickets", { body: { ...fields, project } });
        if (res.status === 0) entry.state = "unknown";
        else if (!res.ok) entry.state = "refused";
        if (!res.ok) return fromBackend(res, `project ${project}`, w);
        entry.state = "done";
        const t = res.body.ticket;
        return ok(`Created ticket ${t.id} in project ${t.project} (version ${t.version}).`,
          { ...receipt(t.id, t.version, ["created", ...Object.keys(fields)]), project: t.project },
          applied({ ...w, scope: t.project }, { id: t.id, version: t.version, changed: Object.keys(fields).filter((k) => k !== "project") }));
      })();
      records.set(key, entry);
      return entry.result;
    },
  });
}
