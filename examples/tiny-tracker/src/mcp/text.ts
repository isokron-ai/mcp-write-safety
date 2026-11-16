// The first text block of a result, generated from its write-result/0.1 shape by the same rules as the MCP Write-Safety
// kits (TypeScript `renderText`, Python `render_text`): the same shape gives the same sentence, byte for byte, pinned by the
// kits' shared golden fixtures (test/golden/first-sentence.json, a copy of the kits' file). It never restates
// `current_state`: a conflict's state and version are in the JSON block (MWS Annex B-9, "Text"; MWS-CONC-6, Guidance).

import type { Outcome, WriteResult } from "./results.js";

/** A value as JSON, so that a string reads only one way. */
export function q(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

const HEADLINE: Record<Outcome, string> = {
  applied: "Applied",
  not_applied: "Not applied",
  partial: "Partly applied",
  unknown: "Outcome unknown",
  accepted: "Accepted",
};

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Options for the first text block. */
export interface TextOptions {
  /**
   * One plain sentence about the write, without a final period, e.g. `updated note "n-3"`. It
   * follows the opening words ("Applied:", "Not applied:", ...). Quote every value in it (`q()`).
   */
  summary: string;
  /** Further sentences, after the fixed ones. */
  notes?: string[];
  /** The argument that carries an idempotency key, for the sentence on `repeat: "same_key"`. */
  keyArgument?: string;
  /** The key the call carried, for the same sentence. */
  key?: string;
  /** The version the call carried, for the sentence on `repeat: "same_version"`. */
  sentVersion?: string | number;
}

function readSentence(r: WriteResult): string | null {
  if (!r.read_with) return null;
  return `read it with ${q(r.read_with.tool)} and the arguments ${JSON.stringify(r.read_with.arguments)}`;
}

/**
 * Renders the first text block from the shape: the outcome in plain words, the repeat instruction
 * and the read to make. It never restates `current_state`; the second block carries the JSON.
 */
export function renderText(r: WriteResult, o: TextOptions): string {
  const lines: string[] = [];
  const head = `${HEADLINE[r.outcome]}: ${o.summary}`;
  switch (r.outcome) {
    case "not_applied":
      lines.push(`${sentence(head)} Nothing was changed.`);
      break;
    case "partial":
      lines.push(`${sentence(head)} Some items remain applied; the JSON below gives the outcome of each.`);
      break;
    case "unknown":
      lines.push(`${sentence(head)} It is not known whether the change was applied.`);
      break;
    case "accepted":
      lines.push(`${sentence(head)} The backend has not yet reported the result.`);
      break;
    default:
      lines.push(sentence(head));
  }
  if (r.replayed) lines.push("Replay: this call repeats an earlier call with the same idempotency key and applied nothing itself; the answer describes the earlier call's write.");
  if (r.conflict && (r.conflict.current_state || r.conflict.current_version !== undefined)) lines.push("Its current state and version are in the JSON below.");
  if (r.changed) lines.push(`Changed: ${r.changed.length ? r.changed.map(q).join(", ") : "nothing"}.`);
  if (r.object?.version !== undefined && r.outcome !== "not_applied") lines.push(`Version now: ${q(r.object.version)}.`);
  const read = readSentence(r);
  switch (r.repeat) {
    case "no":
      lines.push("Do not send the same call again.");
      break;
    case "yes":
      lines.push("The same call can be sent again unchanged; it cannot apply the write more than once.");
      break;
    case "same_key":
      lines.push(`Send the call again only with the same ${o.keyArgument ?? "idempotency key"}${o.key !== undefined ? ` ${q(o.key)}` : ""}${read ? `, or first ${read}` : ""}.`);
      break;
    case "same_version":
      lines.push(`Send the call again only with the same ${r.version_argument ?? "version"}${o.sentVersion !== undefined ? ` ${q(o.sentVersion)}` : ""}${read ? `; or first ${read}` : ""}.`);
      break;
    case "read_first":
      lines.push(r.conflict && r.conflict.current_state && !(r.conflict.omitted?.length)
        ? `Build the write again from them${read ? `, or ${read}` : ""}; do not resend your earlier values with the new version.`
        : `Before writing again, ${read ?? "read the object"} and build the write from what the read shows.`);
      break;
    default:
      if (read) lines.push(`To see the current state, ${read}.`);
  }
  for (const n of o.notes ?? []) lines.push(sentence(n));
  return lines.join("\n");
}
