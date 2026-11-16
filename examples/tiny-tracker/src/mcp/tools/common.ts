// Schema fragments and annotation helpers shared by the tool definitions.

import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { JsonSchema } from "../validate.js";

export const S = {
  projectKey: {
    type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
    description: "Project key: lower-case letters, digits and dashes. Test runs use their run prefix, e.g. mwsc-<run>-a.",
  },
  ticketId: { type: "string", pattern: "^T-[0-9]+$", description: "Ticket id, e.g. T-12." },
  title: { type: "string", minLength: 1, maxLength: 200, description: "Title, 1 to 200 characters." },
  // The backend also knows "archived"; archiving is an admin action this server does not offer.
  status: { type: "string", enum: ["open", "in_progress", "closed"] },
  assignee: { type: ["string", "null"], minLength: 1, maxLength: 64, description: "User name, or null to unassign." },
  priority: { type: "integer", minimum: 1, maximum: 5, description: "1 (highest) to 5 (lowest)." },
  labelName: { type: "string", minLength: 1, maxLength: 32 },
  description: { type: "string", maxLength: 2000, description: "Free text, up to 2000 characters; an empty string clears it." },
  details: {
    type: "object", additionalProperties: false,
    properties: {
      component: { type: ["string", "null"], minLength: 1, maxLength: 64 },
      severity: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
    },
    description: "Nested details; an update sets only the sub-fields you name.",
  },
  expectedVersion: {
    type: "integer", minimum: 1,
    description: "The version you read. If the object changed since, nothing is written and you get a conflict.",
  },
  idempotencyKey: {
    type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$",
    description: "Your own unique key for this create. Sending the same call again with the same key creates nothing new and says it is a replay.",
  },
} satisfies Record<string, JsonSchema>;

export function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Annotations, always explicit (MWS-ANN-4). Every tool reaches only the tracker's own backend. */
export const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

export function writes(opts: { destructive: boolean; idempotent: boolean }): ToolAnnotations {
  return { readOnlyHint: false, destructiveHint: opts.destructive, idempotentHint: opts.idempotent, openWorldHint: false };
}

export const enc = encodeURIComponent;
