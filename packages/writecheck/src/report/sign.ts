/**
 * Signing results.json (`mws-results-signature/1`): an Ed25519 signature over the file's own content, stored in
 * `evidence.signature`, so a published results.json can be checked on its own (no folder, no SHA256SUMS) against a pinned key.
 *
 *   body     = the results document with evidence.signature set to null
 *   canon    = RFC 8785 (JCS) canonical JSON of body, UTF-8
 *   digest   = "sha256:" + hex sha256(canon)
 *   message  = "mcp-writecheck/results-signature/1\n" + canon
 *   value    = standard base64 of the pure Ed25519 signature of message (64 bytes)
 *   key_id   = "ed25519-" + the first 16 hex characters of sha256(SPKI DER of the public key)
 *
 * This follows the kronicle-lite evidence-bundle conventions (JCS, a domain-separation line, pure Ed25519, standard base64,
 * the same key id), so the same key can sign a results.json and the Evidence Pack that wraps it, and a verifier needs nothing
 * of ours: any RFC 8785 implementation (the npm package canonicalize, which kronicle-lite uses) gives the canonical body, and
 * `openssl pkeyutl -verify -rawin` checks the signature.
 *
 * The key is read from a file (`--sign-key`) or MWSC_SIGN_KEY (a path, or the PEM itself in CI); it is never written anywhere.
 * A PKCS#8 PEM Ed25519 key and an unencrypted OpenSSH Ed25519 key are accepted. An embedded public key only says which key
 * signed: a verifier trusts a signature only against a key it pinned out of band (`verify-results --pubkey`).
 */

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { canonical, isObj, WritecheckError } from '../core/util.js';

export const RESULTS_SIGNATURE_FORMAT = 'mws-results-signature/1';
export const RESULTS_SIGNATURE_DOMAIN = 'mcp-writecheck/results-signature/1\n';
export const SIGN_KEY_ENV = 'MWSC_SIGN_KEY';

export interface ResultsSignature {
  format: typeof RESULTS_SIGNATURE_FORMAT;
  alg: 'ed25519';
  key_id: string;
  public_key_pem: string;
  /** sha256 of the canonical body (results.json with evidence.signature null). */
  digest: string;
  /** Standard base64 of the 64-byte Ed25519 signature over the domain line and the canonical body. */
  value: string;
  /** The ssh signature of SHA256SUMS written beside it (`--sign`), or null. */
  sums: string | null;
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Read an unencrypted OpenSSH ed25519 private key (openssh-key-v1) and return its 32-byte seed. */
function opensshSeed(pem: string): Buffer {
  const b64 = pem.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  if (!buf.subarray(0, magic.length).equals(magic)) throw new WritecheckError('signing key: not an OpenSSH private key', 2);
  let at = magic.length;
  const u32 = () => {
    const v = buf.readUInt32BE(at);
    at += 4;
    return v;
  };
  const bytes = () => {
    const n = u32();
    const v = buf.subarray(at, at + n);
    at += n;
    return v;
  };
  const cipher = bytes().toString();
  const kdf = bytes().toString();
  bytes();
  if (cipher !== 'none' || kdf !== 'none') throw new WritecheckError('signing key: the OpenSSH key is encrypted; give an unencrypted copy (kept out of the repository) or a PKCS#8 PEM key', 2);
  if (u32() !== 1) throw new WritecheckError('signing key: an OpenSSH file with more than one key', 2);
  bytes();
  const priv = bytes();
  at = 0;
  const p = priv;
  const r32 = () => {
    const v = p.readUInt32BE(at);
    at += 4;
    return v;
  };
  const rb = () => {
    const n = r32();
    const v = p.subarray(at, at + n);
    at += n;
    return v;
  };
  if (r32() !== r32()) throw new WritecheckError('signing key: the OpenSSH key is damaged (check words differ)', 2);
  const type = rb().toString();
  if (type !== 'ssh-ed25519') throw new WritecheckError(`signing key: an OpenSSH ${type} key; results are signed with Ed25519 only`, 2);
  rb();
  const sk = rb();
  if (sk.length !== 64) throw new WritecheckError('signing key: the OpenSSH ed25519 key is damaged', 2);
  return Buffer.from(sk.subarray(0, 32));
}

/** A private key from PEM text (PKCS#8 or OpenSSH). */
export function privateKeyFrom(text: string): KeyObject {
  let k: KeyObject;
  if (text.includes('BEGIN OPENSSH PRIVATE KEY')) k = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, opensshSeed(text)]), format: 'der', type: 'pkcs8' });
  else {
    try {
      k = createPrivateKey(text);
    } catch (e) {
      throw new WritecheckError(`signing key: not a PEM private key (${(e as Error).message})`, 2);
    }
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new WritecheckError(`signing key: a ${k.asymmetricKeyType} key; results are signed with Ed25519 only`, 2);
  return k;
}

/** The signing key named by `--sign-key` (a path) or MWSC_SIGN_KEY (a path, or the PEM itself); null when neither is given. */
export function loadSigningKey(flag: string | undefined, env: NodeJS.ProcessEnv): KeyObject | null {
  const src = flag ?? env[SIGN_KEY_ENV];
  if (!src) return null;
  if (src.includes('-----BEGIN')) return privateKeyFrom(src);
  if (!existsSync(src)) throw new WritecheckError(`signing key ${src} does not exist (--sign-key or ${SIGN_KEY_ENV})`, 2);
  return privateKeyFrom(readFileSync(src, 'utf8'));
}

/** A public key from a PEM (SPKI) file or text, or an OpenSSH `ssh-ed25519 AAAA…` line or .pub file. */
export function publicKeyFrom(src: string): KeyObject {
  const text = !src.includes('-----BEGIN') && !/^ssh-ed25519\s/.test(src.trim()) && existsSync(src) ? readFileSync(src, 'utf8') : src;
  const t = text.trim();
  let k: KeyObject;
  if (/^ssh-ed25519\s/.test(t)) {
    const blob = Buffer.from(t.split(/\s+/)[1] ?? '', 'base64');
    const n = blob.readUInt32BE(0);
    if (blob.subarray(4, 4 + n).toString() !== 'ssh-ed25519') throw new WritecheckError('public key: not an ssh-ed25519 key', 2);
    const m = blob.readUInt32BE(4 + n);
    const raw = blob.subarray(8 + n, 8 + n + m);
    if (raw.length !== 32) throw new WritecheckError('public key: a damaged ssh-ed25519 key', 2);
    k = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  } else {
    try {
      k = createPublicKey(t);
    } catch (e) {
      throw new WritecheckError(`public key: not a PEM public key, an ssh-ed25519 line or a file holding one (${(e as Error).message})`, 2);
    }
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new WritecheckError(`public key: a ${k.asymmetricKeyType} key; results are signed with Ed25519 only`, 2);
  return k;
}

export function keyId(k: KeyObject): string {
  const pub = k.type === 'private' ? createPublicKey(k) : k;
  return `ed25519-${createHash('sha256').update(pub.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16)}`;
}

/** The canonical body a signature covers: the document with evidence.signature null. */
export function signedBody(doc: unknown): string {
  if (!isObj(doc) || !isObj(doc['evidence'])) throw new WritecheckError('not a results document (no evidence block)', 2);
  return canonical({ ...doc, evidence: { ...doc['evidence'], signature: null } });
}

const digestOf = (body: string) => `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;

export function signResults(doc: unknown, key: KeyObject, sums: string | null = null): ResultsSignature {
  const body = signedBody(doc);
  const value = edSign(null, Buffer.from(RESULTS_SIGNATURE_DOMAIN + body, 'utf8'), key).toString('base64');
  const pub = createPublicKey(key);
  return { format: RESULTS_SIGNATURE_FORMAT, alg: 'ed25519', key_id: keyId(pub), public_key_pem: pub.export({ format: 'pem', type: 'spki' }).toString(), digest: digestOf(body), value, sums };
}

export type VerifyStatus = 'valid' | 'valid-unpinned' | 'unsigned' | 'ssh-only' | 'invalid';

export interface VerifyOutcome {
  status: VerifyStatus;
  /** One line a person reads. */
  detail: string;
  key_id: string | null;
  digest: string | null;
}

/**
 * Check a results document's signature. With `pinned`, the signature must be by that key (key ids must match, and the
 * signature must verify under the pinned key, never the embedded one). Without it, the signature is checked under the
 * embedded key and the outcome is `valid-unpinned`: it shows the file was not changed since that key signed it, not who signed.
 */
export function verifyResults(doc: unknown, pinned: KeyObject | null): VerifyOutcome {
  if (!isObj(doc) || !isObj(doc['evidence'])) return { status: 'invalid', detail: 'not a results document (no evidence block)', key_id: null, digest: null };
  const sig = doc['evidence']['signature'];
  if (sig === null || sig === undefined) return { status: 'unsigned', detail: 'results.json is not signed (evidence.signature is null)', key_id: null, digest: null };
  if (typeof sig === 'string') return { status: 'ssh-only', detail: `results.json carries no results signature; ${sig} is an ssh signature of SHA256SUMS (check it with ssh-keygen -Y verify, see report.md)`, key_id: null, digest: null };
  if (!isObj(sig) || sig['format'] !== RESULTS_SIGNATURE_FORMAT || sig['alg'] !== 'ed25519' || typeof sig['value'] !== 'string' || typeof sig['key_id'] !== 'string') return { status: 'invalid', detail: `evidence.signature is not a ${RESULTS_SIGNATURE_FORMAT} Ed25519 signature`, key_id: null, digest: null };
  const body = signedBody(doc);
  const digest = digestOf(body);
  const kid = sig['key_id'];
  if (sig['digest'] !== digest) return { status: 'invalid', detail: `the content changed after signing: digest ${digest}, signed ${String(sig['digest'])}`, key_id: kid, digest };
  let key: KeyObject;
  if (pinned) {
    if (keyId(pinned) !== kid) return { status: 'invalid', detail: `signed by ${kid}, not by the pinned key ${keyId(pinned)}`, key_id: kid, digest };
    key = pinned;
  } else {
    try {
      key = publicKeyFrom(String(sig['public_key_pem'] ?? ''));
    } catch (e) {
      return { status: 'invalid', detail: `the embedded public key cannot be read: ${(e as Error).message}`, key_id: kid, digest };
    }
    if (keyId(key) !== kid) return { status: 'invalid', detail: `the embedded public key is ${keyId(key)}, not ${kid}`, key_id: kid, digest };
  }
  const ok = edVerify(null, Buffer.from(RESULTS_SIGNATURE_DOMAIN + body, 'utf8'), key, Buffer.from(sig['value'], 'base64'));
  if (!ok) return { status: 'invalid', detail: `the Ed25519 signature does not verify under ${pinned ? 'the pinned' : 'the embedded'} key ${kid}`, key_id: kid, digest };
  return pinned
    ? { status: 'valid', detail: `signed by the pinned key ${kid}; content digest ${digest}`, key_id: kid, digest }
    : { status: 'valid-unpinned', detail: `the signature verifies under the key embedded in the file (${kid}), which is not pinned: give --pubkey to check who signed`, key_id: kid, digest };
}
