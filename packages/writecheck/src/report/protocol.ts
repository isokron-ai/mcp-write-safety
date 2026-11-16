/**
 * Spec 5.3: a conformance statement states the MCP protocol revision and the transport used, and the client
 * capabilities and extensions the tester declared. Spec 7.3, rule 10: where a server asks for input during a call,
 * the record states what the tester answered. Spec 7.3, rule 11: the patterns that decided what a result says are
 * part of the declaration used.
 */

import { patternsInEffect, type SaysKind } from '../checks/says.js';
import { shapesInEffect, type ShapeName } from '../checks/shape.js';
import type { Manifest } from '../core/manifest.js';
import type { Result } from './verdicts.js';

export interface McpRecord {
  revision: string | null;
  transport: 'stdio' | 'streamable HTTP';
  /** Declared on every request (initialize, or the 2026-07-28 _meta envelope). */
  client_capabilities: Record<string, unknown>;
  /** Declared for one call only: the input_required flows of MWS-RETRY-3. */
  per_call_capabilities: { tool: string; capabilities: Record<string, unknown> }[];
  extensions: string[];
  input_requests: { step: string; tool: string; method: string; answer: string }[];
  patterns: Record<SaysKind, { pattern: string; from: 'declaration' | 'default' }>;
  /** Spec 7.3, rule 11: the result shape the declaration adopts by name and version, at the top level and per tool. */
  result_shapes?: { shape: ShapeName | null; tools: Record<string, ShapeName | null> };
}

export function mcpRecord(m: Manifest, revision: string | null, inputRequests: McpRecord['input_requests']): McpRecord {
  return {
    revision,
    transport: m.server.stdio ? 'stdio' : 'streamable HTTP',
    client_capabilities: {},
    per_call_capabilities: m.resources.flatMap((r) => (r.input_required ?? []).map((ir) => ({ tool: ir.tool, capabilities: ir.client_capabilities }))),
    extensions: [],
    input_requests: inputRequests,
    patterns: patternsInEffect(),
    result_shapes: shapesInEffect(),
  };
}

/** One line for report.md and stdout. */
export function mcpLine(x: McpRecord): string {
  const per = x.per_call_capabilities.length ? `; for single calls of MWS-RETRY-3: ${x.per_call_capabilities.map((p) => `${p.tool} ${JSON.stringify(p.capabilities)}`).join(', ')}` : '';
  return `MCP revision ${x.revision ?? 'not established'} over ${x.transport}. Client capabilities declared: none (an empty capabilities object)${per}. Extensions declared: ${x.extensions.length ? x.extensions.join(', ') : 'none'}.`;
}

const CONFIRMING = ['MWS-CONC-1', 'MWS-TGT-2', 'MWS-TGT-3'];

/**
 * Rule 10 in the records: a record whose calls met a request for input says what the tester answered; a `held` record of a
 * test of an override or an opt-in says that no confirmation was asked or declined, because the tester declares no
 * capability for one, and that a client that declares it was not tested.
 */
export function annotateInputs(results: Result[], x: McpRecord): void {
  for (const r of results) {
    const met = x.input_requests.filter((q) => r.steps.includes(q.step));
    for (const q of met) r.notes.push(`During ${q.step} (${q.tool}) the server asked for input (${q.method}); the tester answered: ${q.answer} (spec 7.3, rule 10).`);
    if (CONFIRMING.includes(r.requirement) && r.verdict === 'held' && !met.length) r.notes.push('The tester declares no client capability for input requests, so no confirmation was asked for or declined in this test; a client that declares the capability was not tested (spec 7.3, rule 10).');
  }
}
