/**
 * The call capture: every byte the tester sent to or received from the server and the control, in
 * order, redacted before it is written.
 *
 *   <out>/capture/capture.jsonl          one line per thing on the wire: each line written to a
 *                                        server's stdin, each line of its stdout and stderr, each HTTP
 *                                        request and response (MCP and control), process start and exit
 *   <out>/capture/blobs/sha256/<hex>     the redacted body; <hex> is the sha256 of the file's bytes
 *
 * A line carries `original_sha256` and `original_bytes` of the bytes as they were on the wire only
 * when nothing was redacted (a hash of a redacted secret would let a short secret be guessed). The
 * last line is `capture_closed` with the line count and `lines_sha256`, the sha256 of every byte of
 * the file before it, so a truncated or edited capture shows.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Redactor } from './redact.js';
import { nowMs, sha256 } from './util.js';

export const CAPTURE_FORMAT = 'mws-capture/1';

export interface CaptureEvent {
  label: string | null;
  step: string | null;
  dir: 'send' | 'recv' | 'event';
  channel: 'stdin' | 'stdout' | 'stderr' | 'process' | 'mcp-http' | 'http';
  [k: string]: unknown;
}

export interface CaptureSink {
  write(e: CaptureEvent, bytes?: string | Buffer): void;
}

/** A sink that drops everything (plan, init and unit tests that do not keep a capture). */
export const NO_CAPTURE: CaptureSink = { write() {} };

export class Capture implements CaptureSink {
  private seq = 0;
  private readonly file: string;
  private readonly blobs: string;
  private readonly hash = createHash('sha256');
  private closed = false;
  /** The largest result body seen on each channel (Annex A-3 reads the MCP one). */
  readonly largest: { mcp_bytes: number; step: string | null } = { mcp_bytes: 0, step: null };

  constructor(
    readonly dir: string,
    readonly red: Redactor,
  ) {
    mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true, mode: 0o700 });
    this.file = join(dir, 'capture.jsonl');
    this.blobs = join(dir, 'blobs', 'sha256');
    writeFileSync(this.file, '');
    this.line({ type: 'capture_opened', format: CAPTURE_FORMAT, t_ms: nowMs() });
  }

  private line(rec: Record<string, unknown>): void {
    const text = JSON.stringify(rec) + '\n';
    this.hash.update(text);
    appendFileSync(this.file, text);
  }

  write(e: CaptureEvent, bytes?: string | Buffer): void {
    if (this.closed) return;
    const rec: Record<string, unknown> = { type: 'wire', seq: ++this.seq, t_ms: nowMs(), ...e };
    if (bytes !== undefined) {
      const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
      const text = buf.toString('utf8');
      const stored = this.red.body(text);
      const redacted = stored !== text;
      const out = Buffer.from(stored, 'utf8');
      const h = sha256(out);
      const path = join(this.blobs, h);
      if (!existsSync(path)) writeFileSync(path, out, { mode: 0o600 });
      rec['blob'] = { sha256: h, bytes: out.length, redacted, ...(redacted ? {} : { original_sha256: sha256(buf), original_bytes: buf.length }) };
      // why: Annex A-3 is about tool results; the catalog and the handshake are not (CLI-BUGS item 10).
      if (e.dir === 'recv' && (e.channel === 'stdout' || e.channel === 'mcp-http') && buf.length > this.largest.mcp_bytes && !/^(tools-list|prompts-list|resources-templates-list|resources-list|init\.|launch\.|server-discover|ping)/i.test(e.step ?? '')) {
        this.largest.mcp_bytes = buf.length;
        this.largest.step = e.step;
      }
    }
    // why: header values and other fields can carry secrets too; the whole line goes through the redactor.
    this.line(JSON.parse(this.red.text(JSON.stringify(rec))) as Record<string, unknown>);
  }

  close(): { lines: number; lines_sha256: string } {
    if (this.closed) return { lines: this.seq, lines_sha256: '' };
    const digest = this.hash.copy().digest('hex');
    this.line({ type: 'capture_closed', t_ms: nowMs(), lines: this.seq + 1, lines_sha256: digest });
    this.closed = true;
    return { lines: this.seq, lines_sha256: digest };
  }
}

/** Check a capture file's closing record against its bytes (used by tests and `recheck`). */
export function verifyCapture(dir: string): { ok: boolean; reason?: string } {
  const text = readFileSync(join(dir, 'capture.jsonl'), 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
  if (last['type'] !== 'capture_closed') return { ok: false, reason: 'no capture_closed record (the run did not finish cleanly)' };
  const before = text.slice(0, text.length - (lines[lines.length - 1]!.length + 1));
  const ok = sha256(before) === last['lines_sha256'];
  return ok ? { ok } : { ok, reason: 'lines_sha256 does not match the file' };
}
