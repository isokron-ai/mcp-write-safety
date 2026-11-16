/**
 * The evidence folder is sealed with SHA256SUMS over every file in it (the `sha256sum` text format,
 * so `shasum -a 256 -c` or `sha256sum -c` checks it with nothing of ours installed), and optionally
 * signed with the runner's own SSH key through `ssh-keygen -Y sign` (namespace `mcp-writecheck`).
 * The tester never reads the key itself; ssh-keygen does, or the SSH agent when given a .pub file.
 * No one else countersigns. In GitHub Actions, a build-provenance attestation over SHA256SUMS can be
 * added by the workflow itself (actions/attest-build-provenance with subject-path SHA256SUMS).
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { sha256, WritecheckError } from '../core/util.js';

export const SIGN_NAMESPACE = 'mcp-writecheck';

function walk(dir: string, root: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
  }
}

export function writeChecksums(dir: string): string {
  const files: string[] = [];
  walk(dir, dir, files);
  const lines = files
    .filter((f) => f !== 'SHA256SUMS' && f !== 'SHA256SUMS.sig')
    .sort()
    .map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}`);
  const file = join(dir, 'SHA256SUMS');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export function verifyChecksums(dir: string): { ok: boolean; bad: string[] } {
  const bad: string[] = [];
  for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [h, f] = [line.slice(0, 64), line.slice(66)];
    try {
      if (!statSync(join(dir, f)).isFile() || sha256(readFileSync(join(dir, f))) !== h) bad.push(f);
    } catch {
      bad.push(f);
    }
  }
  return { ok: bad.length === 0, bad };
}

/** Sign SHA256SUMS with the runner's SSH key; returns the signature file name. */
export function signChecksums(dir: string, key: string): string {
  const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', SIGN_NAMESPACE, join(dir, 'SHA256SUMS')], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new WritecheckError(`ssh-keygen -Y sign failed (${r.status}): ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`, 4);
  return 'SHA256SUMS.sig';
}
