/**
 * Signing results.json (`mws-results-signature/1`): an Ed25519 signature over the file's own content, stored in
 * `evidence.signature`, so a published results.json can be checked on its own (no folder, no SHA256SUMS) against a pinned key.
 *
 *   body     = the results document with evidence.signature replaced by its bound members { format, alg, key_id, sums }
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
import { existsSync, readFileSync, statSync } from 'node:fs';

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
  if (flag !== undefined) {
    // why: review: --sign-key names a path; errors print the path, never the file's content.
    if (!existsSync(flag)) throw new WritecheckError(`--sign-key ${flag} does not exist`, 2);
    try {
      return privateKeyFrom(readFileSync(flag, 'utf8'));
    } catch (e) {
      throw new WritecheckError(`--sign-key ${flag}: ${e instanceof WritecheckError ? e.message.replace(/^signing key: /, '') : 'not a readable Ed25519 private key'}`, 2);
    }
  }
  const v = env[SIGN_KEY_ENV];
  if (!v) return null;
  // why: review: the variable may hold key material; it is never echoed. Key material if it parses, else a path, else refused.
  const generic = new WritecheckError(`${SIGN_KEY_ENV} is not a key or an existing path`, 2);
  if (v.includes('-----BEGIN')) {
    try {
      return privateKeyFrom(v);
    } catch (e) {
      throw e instanceof WritecheckError && /Ed25519 only|encrypted/.test(e.message) ? new WritecheckError(`${SIGN_KEY_ENV}: ${e.message.replace(/^signing key: /, '')}`, 2) : generic;
    }
  }
  let isFile = false;
  try {
    isFile = existsSync(v) && statSync(v).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw generic;
  try {
    return privateKeyFrom(readFileSync(v, 'utf8'));
  } catch (e) {
    throw e instanceof WritecheckError && /Ed25519 only|encrypted/.test(e.message) ? new WritecheckError(`${SIGN_KEY_ENV} (a path): ${e.message.replace(/^signing key: /, '')}`, 2) : new WritecheckError(`${SIGN_KEY_ENV} names a file that is not an Ed25519 private key`, 2);
  }
}

/** A pinned public key from the operator: a PEM (SPKI) or `ssh-ed25519 AAAA…` text, or a file holding one. Bad input: exit 2. */
export function publicKeyFrom(src: string): KeyObject {
  try {
    // why: re-review 4: a directory or an unreadable file is a usage error too.
    const text = !src.includes('-----BEGIN') && !/^ssh-ed25519\s/.test(src.trim()) && existsSync(src) ? readFileSync(src, 'utf8') : src;
    return publicKeyFromText(text);
  } catch (e) {
    // why: review: a truncated or garbled key is a usage error, never a crash (exit 4) or a verdict.
    throw e instanceof WritecheckError ? e : new WritecheckError(`public key: not a PEM public key or an ssh-ed25519 line (${(e as Error).message})`, 2);
  }
}

/** A public key from text only (never a path): what a results file embeds is never opened as a file. */
export function publicKeyFromText(text: string): KeyObject {
  const t = text.trim();
  let k: KeyObject;
  if (/^ssh-ed25519\s/.test(t)) {
    const blob = Buffer.from(t.split(/\s+/)[1] ?? '', 'base64');
    if (blob.length < 8) throw new WritecheckError('public key: a truncated ssh-ed25519 key', 2);
    const n = blob.readUInt32BE(0);
    if (blob.subarray(4, 4 + n).toString() !== 'ssh-ed25519' || blob.length < 8 + n) throw new WritecheckError('public key: not an ssh-ed25519 key, or truncated', 2);
    const m = blob.readUInt32BE(4 + n);
    const raw = blob.subarray(8 + n, 8 + n + m);
    if (raw.length !== 32) throw new WritecheckError('public key: a damaged ssh-ed25519 key', 2);
    k = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  } else {
    try {
      k = createPublicKey(t);
    } catch (e) {
      throw new WritecheckError(`public key: not a PEM public key or an ssh-ed25519 line (${(e as Error).message})`, 2);
    }
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new WritecheckError(`public key: a ${k.asymmetricKeyType} key; results are signed with Ed25519 only`, 2);
  return k;
}

export function keyId(k: KeyObject): string {
  const pub = k.type === 'private' ? createPublicKey(k) : k;
  return `ed25519-${createHash('sha256').update(pub.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16)}`;
}

/** The signature members the body binds (review: `sums` and the key id are signed, not only carried). */
export const BOUND_MEMBERS = ['format', 'alg', 'key_id', 'sums'] as const;

/**
 * The canonical body a signature covers: the document with evidence.signature replaced by its bound members
 * ({ format, alg, key_id, sums }); `meta` gives them when signing, otherwise they are read from the document.
 */
export function signedBody(doc: unknown, meta?: Pick<ResultsSignature, (typeof BOUND_MEMBERS)[number]>): string {
  if (!isObj(doc) || !isObj(doc['evidence'])) throw new WritecheckError('not a results document (no evidence block)', 2);
  const sig = doc['evidence']['signature'];
  const from = meta ?? (isObj(sig) ? sig : null);
  const bound = from ? Object.fromEntries(BOUND_MEMBERS.map((k) => [k, (from as Record<string, unknown>)[k] ?? null])) : null;
  return canonical({ ...doc, evidence: { ...doc['evidence'], signature: bound } });
}

/** The first member name an object in this JSON text repeats (`$.a.b`), or null. JSON.parse keeps the last silently. */
export function duplicateKey(text: string): string | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: string): string | null => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') return (i++, null);
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) return `${path}.${k}`;
        seen.add(k);
        ws();
        i++; // :
        const d = value(`${path}.${k}`);
        if (d) return d;
        ws();
        if (text[i++] === '}') return null;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return (i++, null);
      for (let n = 0; ; n++) {
        const d = value(`${path}[${n}]`);
        if (d) return d;
        ws();
        if (text[i++] === ']') return null;
      }
    }
    if (c === '"') {
      str();
      return null;
    }
    while (i < text.length && !',}] \t\n\r'.includes(text[i]!)) i++;
    return null;
  };
  return value('$');
}

const digestOf = (body: string) => `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;

export function signResults(doc: unknown, key: KeyObject, sums: string | null = null): ResultsSignature {
  const pub = createPublicKey(key);
  const meta = { format: RESULTS_SIGNATURE_FORMAT as typeof RESULTS_SIGNATURE_FORMAT, alg: 'ed25519' as const, key_id: keyId(pub), sums };
  const body = signedBody(doc, meta);
  const value = edSign(null, Buffer.from(RESULTS_SIGNATURE_DOMAIN + body, 'utf8'), key).toString('base64');
  return { ...meta, public_key_pem: pub.export({ format: 'pem', type: 'spki' }).toString(), digest: digestOf(body), value };
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
      // why: review: the embedded key is text; a path named inside results.json is never opened.
      key = publicKeyFromText(String(sig['public_key_pem'] ?? ''));
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
