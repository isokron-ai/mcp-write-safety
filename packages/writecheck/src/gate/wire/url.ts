/**
 * Database URLs for the wire gate: which protocol a scheme names, the default port, the rewrite
 * the server is given (only the authority changes; Mongo also gets directConnection=true), and the
 * URLs the gate refuses because it could not interpose on them faithfully (docs/WIRE-GATE.md §2).
 */

import { defaultPortOf } from '../../core/egress.js';
import type { WireProtocol } from './codec.js';

/** The default port of a URL scheme (`postgres:` → 5432). */
export const defaultPort = defaultPortOf;

/** The wire protocol a URL's scheme names, or null for anything else (http and https included). */
export function wireProtocolOf(url: string): WireProtocol | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  const s = m?.[1]?.toLowerCase();
  if (s === 'postgres' || s === 'postgresql') return 'postgres';
  if (s === 'redis' || s === 'rediss') return 'redis';
  if (s === 'mongodb' || s === 'mongodb+srv') return 'mongodb';
  return null;
}

/** Why the wire gate cannot stand in for this URL, or null when it can. */
export function wireRefusal(url: string): string | null {
  const s = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase() ?? '';
  if (scheme === 'mongodb+srv') return 'mongodb+srv: SRV discovery would let the driver connect around the gate; give a mongodb:// URL with one host';
  if (scheme === 'rediss') return 'rediss: TLS to the backend is not built in this preview of the wire gate';
  const auth = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(s)?.[1] ?? '';
  if (!auth) return 'the URL names no host (a Unix socket or a host given elsewhere): the gate forwards to one TCP host';
  if (auth.includes(',')) return `the URL names several hosts (${auth.split(',').length}); the gate forwards to one host`;
  if (/%2f/i.test(auth) || auth.startsWith('/')) return 'a Unix-socket host: the gate forwards TCP only';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'not a URL the gate can read';
  }
  const q = (k: string) => [...u.searchParams.entries()].find(([n]) => n.toLowerCase() === k)?.[1]?.toLowerCase();
  if (scheme.startsWith('postgres') && ['require', 'verify-ca', 'verify-full'].includes(q('sslmode') ?? '')) return `sslmode=${q('sslmode')}: TLS to the backend is not built in this preview of the wire gate`;
  if (scheme === 'mongodb' && (q('tls') === 'true' || q('ssl') === 'true')) return 'tls=true: TLS to the backend is not built in this preview of the wire gate';
  if (u.searchParams.has('host')) return 'the host is given in a query parameter; the gate rewrites the authority only';
  return null;
}

/** The URL with only host and port replaced (Mongo: directConnection=true, so the driver never learns the real hosts from hello). */
export function rewriteUrl(url: string, host: string, port: number): string {
  // why: string surgery rather than URL serialisation, so credentials, path and query stay byte for byte as given.
  const m = /^([a-z][a-z0-9+.-]*:\/\/)((?:[^@/?#]*@)?)([^/?#]*)(.*)$/is.exec(url.trim());
  if (!m) return url;
  let rest = m[4]!;
  if (/^mongodb:/i.test(url.trim())) {
    if (/[?&]directConnection=/i.test(rest)) rest = rest.replace(/([?&]directConnection=)[^&#]*/i, '$1true');
    else {
      const [beforeHash, hash = ''] = rest.split(/(?=#)/);
      const base = beforeHash!.includes('?') ? `${beforeHash}&` : beforeHash!.startsWith('/') ? `${beforeHash}?` : `/${beforeHash}?`;
      rest = `${base}directConnection=true${hash}`;
    }
  }
  return `${m[1]}${m[2]}${host}:${port}${rest}`;
}
