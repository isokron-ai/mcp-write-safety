/**
 * `node --import mcp-writecheck/register server.js`
 * Env: MWSC_OUTBOUND_LOG (JSONL path), MWSC_GATE_RULES (rules file, hot-reloaded),
 * MWSC_EGRESS_ALLOW (comma-separated hosts; when set, everything else is blocked).
 * Secrets are not read from a file: values to redact come from MWSC_REDACT_ENV, a comma-separated
 * list of environment variable names whose values are masked in the log.
 */

import { FaultStore } from './faults.js';
import { installOutbound } from './outbound.js';

const secrets = (process.env['MWSC_REDACT_ENV'] ?? '')
  .split(',')
  .map((n) => process.env[n.trim()])
  .filter((v): v is string => typeof v === 'string' && v.length > 0);
installOutbound({
  faults: new FaultStore(process.env['MWSC_GATE_RULES']),
  ...(process.env['MWSC_OUTBOUND_LOG'] ? { log: process.env['MWSC_OUTBOUND_LOG'] } : {}),
  secrets,
  ...(process.env['MWSC_EGRESS_ALLOW'] ? { egress: { allow: process.env['MWSC_EGRESS_ALLOW'].split(',').map((h) => h.trim()).filter(Boolean) } } : {}),
});
