// Requirement IDs of the MCP Write-Safety Requirements (MWS), draft 0.9 (spec/0.9-review, 098621b; the requirement set is unchanged since 516c4ed).
//
// This is the only place tiny-tracker spells requirement IDs and their short
// titles. The normative text lives in `spec/` and may still change; when it
// does, update this file and nothing else. Titles here are short labels for
// test names and the README, not the normative sentences.

export type Level = "MUST" | "SHOULD";

export interface Requirement {
  level: Level;
  title: string;
}

export const REQUIREMENTS = {
  "MWS-UPD-1": { level: "MUST", title: "A field patch changes only the named fields" },
  "MWS-UPD-2": { level: "MUST", title: "A list edit lands on the element the caller's address denoted, or is refused" },

  "MWS-CONC-1": { level: "MUST", title: "Do not bypass the backend's concurrency control by default" },
  "MWS-CONC-2": { level: "MUST", title: "Refuse a stale write where the backend can detect it" },
  "MWS-CONC-3": { level: "MUST", title: "Concurrent writes to different parts do not both succeed with one lost" },
  "MWS-CONC-4": { level: "MUST", title: "A refused conflict is not applied and is a tool error that says so" },
  "MWS-CONC-5": { level: "SHOULD", title: "The description says when stale writes are not detected" },
  "MWS-CONC-6": { level: "SHOULD", title: "A conflict error says to re-read, or carries the current state" },

  "MWS-TGT-1": { level: "MUST", title: "Honor or reject a scope argument" },
  "MWS-TGT-2": { level: "MUST", title: "An empty or match-all selector does not mean everything" },
  "MWS-TGT-3": { level: "MUST", title: "A create does not overwrite" },

  "MWS-RES-1": { level: "MUST", title: "Success only when the state asked for is in effect" },
  "MWS-RES-2": { level: "MUST", title: "A failure is never a success, says what remains applied, and is isError" },
  "MWS-RES-3": { level: "MUST", title: "A create returns its identifier, even on later failure" },
  "MWS-RES-4": { level: "SHOULD", title: "A write returns a receipt: identity, fields changed, new version" },

  "MWS-ATOM-1": { level: "MUST", title: "A partial outcome is not success, and names what was applied" },
  "MWS-ATOM-2": { level: "SHOULD", title: "Multi-object writes are all-or-nothing" },

  "MWS-RETRY-1": { level: "SHOULD", title: "A non-idempotent create accepts an idempotency key" },
  "MWS-RETRY-2": { level: "MUST", title: "A keyed repeat is applied once and answered with the first outcome" },
  "MWS-RETRY-3": { level: "MUST", title: "No write is in effect when a tool answers input_required" },

  "MWS-IN-1": { level: "MUST", title: "No coercion that changes the meaning of a value" },
  "MWS-IN-2": { level: "MUST", title: "Unknown arguments are not dropped silently" },
  "MWS-IN-3": { level: "MUST", title: "Declared schema constraints are enforced" },
  "MWS-IN-4": { level: "MUST", title: "A validation failure is a tool error naming the argument and reason" },
  "MWS-IN-5": { level: "SHOULD", title: "Fixed constraints the server enforces are declared in the schema" },
  "MWS-IN-6": { level: "SHOULD", title: "Wrong types are rejected, not converted or dropped" },
  "MWS-IN-7": { level: "SHOULD", title: "Unknown arguments are rejected" },

  "MWS-CFG-1": { level: "MUST", title: "An unrecognized read-only setting never leaves writes enabled" },
  "MWS-CFG-2": { level: "MUST", title: "An unknown name in a tool deny-list stops the server or disables writes" },
  "MWS-CFG-3": { level: "MUST", title: "Read-only mode refuses every write tool" },
  "MWS-CFG-4": { level: "SHOULD", title: "An unknown name in a tool allow-list stops the server" },

  "MWS-ANN-1": { level: "MUST", title: "readOnlyHint: true means no state change" },
  "MWS-ANN-2": { level: "MUST", title: "destructiveHint: false never deletes or replaces data the arguments did not name" },
  "MWS-ANN-3": { level: "MUST", title: "idempotentHint: true means no further effect on repeat" },
  "MWS-ANN-4": { level: "SHOULD", title: "readOnlyHint and destructiveHint are declared explicitly" },
  "MWS-ANN-5": { level: "SHOULD", title: "destructiveHint: false means additive updates only" },

  "MWS-SEC-1": { level: "MUST", title: "No credentials in tool results" },
} as const satisfies Record<string, Requirement>;

export type RequirementId = keyof typeof REQUIREMENTS;

export const REQUIREMENT_IDS = Object.keys(REQUIREMENTS) as RequirementId[];

