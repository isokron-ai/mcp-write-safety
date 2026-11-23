/**
 * The egress list: the tester connects to the target server, to the hosts under `control` and
 * `backend`, and to nothing else. Every HTTP request the tester makes goes through `assertEgress`
 * (the raw HTTP helper calls it), redirects are never followed, and `lockGlobalFetch` replaces the
 * process-wide `fetch` so no other code in the process can reach anything off the list. There is no
 * telemetry, update check or account call to allow.
 *
 * Test targets usually live on loopback or a private network, so private addresses are allowed for
 * hosts on the list; a cloud metadata endpoint never is, whether it is named literally or a listed
 * name resolves to it (the raw HTTP client connects only to the address it vetted).
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export interface EgressPolicy {
  /** Hostnames (or host:port) allowed; `*.example.com` matches subdomains. */
  allow: string[];
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast + reserved + broadcast
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** Why an address is not a public unicast target, or null if it is. */
export function blockedReason(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 0) return `not an IP address: ${ip}`;
  if (fam === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return blockedReason(mapped[1] as string);
    return blocked.check(ip, 'ipv6') ? `non-public IPv6 address ${ip}` : null;
  }
  return blocked.check(ip, 'ipv4') ? `non-public IPv4 address ${ip}${ip === '169.254.169.254' ? ' (cloud metadata)' : ''}` : null;
}

/** Default ports by scheme: HTTP for the tester's own requests, database schemes for the wire gate's upstream. */
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'postgres:': '5432', 'postgresql:': '5432', 'redis:': '6379', 'rediss:': '6379', 'mongodb:': '27017' };
/** The default port of a scheme (`postgres:` → 5432); 80 for a scheme not listed. */
export function defaultPortOf(protocol: string): string {
  return DEFAULT_PORTS[protocol.toLowerCase()] ?? '80';
}
/** Schemes the wire gate may connect to (its upstream only; the tester's own requests stay HTTP). */
export const WIRE_SCHEMES = new Set(['postgres:', 'postgresql:', 'redis:', 'mongodb:']);

export function hostAllowed(url: URL, allow: string[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const withPort = `${host}:${url.port || defaultPortOf(url.protocol)}`;
  return allow.some((a) => {
    const p = a.toLowerCase();
    if (p.startsWith('*.')) return host.endsWith(p.slice(1));
    return p === host || p === withPort;
  });
}

export class EgressBlocked extends Error {
  readonly code = 'EGRESS_BLOCKED';
}

/** Cloud metadata endpoints, by address: blocked whatever name resolves to them. */
const METADATA_ADDRS = new Set(['169.254.169.254', '169.254.170.2', '169.254.170.23', 'fd00:ec2::254', '100.100.100.200']);
/** Metadata names blocked by name as well (they may resolve only inside the cloud). */
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

/** Is this address a cloud metadata endpoint (IPv4-mapped IPv6 forms included)? */
export function isMetadataAddress(ip: string): boolean {
  const a = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return METADATA_ADDRS.has(mapped[1]!);
  // why: ::ffff:a9fe:a9fe is 169.254.169.254 written in hex.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return METADATA_ADDRS.has([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  if (isIP(a) === 6) {
    try {
      // why: normalise zero-compression so fd00:ec2:0:0:0:0:0:254 matches too.
      const b = new BlockList();
      b.addAddress('fd00:ec2::254', 'ipv6');
      if (b.check(a, 'ipv6')) return true;
    } catch {
      /* not an address */
    }
  }
  return METADATA_ADDRS.has(a);
}

/** How names are resolved: injectable so tests never touch real DNS. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) =>
  new Promise((res, rej) => dnsLookup(host, { all: true }, (e, addrs) => (e ? rej(e) : res((addrs as LookupAddress[]).map((a) => ({ address: a.address, family: a.family }))))));
let resolver: Resolver = systemResolver;
/** Tests: replace the resolver; returns a function that restores the system one. */
export function setResolver(r: Resolver): () => void {
  resolver = r;
  return () => {
    resolver = systemResolver;
  };
}

/**
 * Throw unless the URL is http(s) to a host on the list (and never a metadata name or address).
 * `wire: true` (the wire gate's upstream only) also allows the database schemes in WIRE_SCHEMES.
 */
export function assertEgress(url: URL, policy: EgressPolicy, o: { wire?: boolean } = {}): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && !(o.wire && WIRE_SCHEMES.has(url.protocol))) throw new EgressBlocked(`egress blocked: scheme ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (METADATA_NAMES.has(host) || isMetadataAddress(host)) throw new EgressBlocked(`egress blocked: ${host} is a cloud metadata address`);
  if (!hostAllowed(url, policy.allow)) throw new EgressBlocked(`egress blocked: ${url.host} is not on the egress list (${policy.allow.join(', ') || 'empty'})`);
}

/**
 * Resolve a host and refuse it when any address it resolves to is a metadata endpoint. Returns the
 * vetted addresses (a literal IP is returned as is, after the same check).
 */
export async function resolveVetted(host: string): Promise<{ address: string; family: number }[]> {
  const h = host.replace(/^\[|\]$/g, '');
  const fam = isIP(h);
  const addrs = fam ? [{ address: h, family: fam }] : await resolver(h);
  if (!addrs.length) throw new EgressBlocked(`egress blocked: ${host} did not resolve`);
  const bad = addrs.find((a) => isMetadataAddress(a.address));
  if (bad) throw new EgressBlocked(`egress blocked: ${host} resolves to ${bad.address}, a cloud metadata address`);
  return addrs;
}

/** The full check: the URL against the list, then the addresses its host resolves to. */
export async function assertEgressResolved(url: URL, policy: EgressPolicy): Promise<void> {
  assertEgress(url, policy);
  await resolveVetted(url.hostname);
}

/**
 * A `lookup` for node:http(s) and node:net: it resolves through the (injectable) resolver, refuses
 * metadata addresses, and hands the socket only a vetted address, so the address checked is the
 * address connected to (no second resolution in between).
 */
export function vettedLookup(hostname: string, options: { all?: boolean; family?: number | string } | number, cb: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void): void {
  const all = typeof options === 'object' && options !== null && options.all === true;
  resolveVetted(hostname).then(
    (addrs) => (all ? cb(null, addrs.map((a) => ({ address: a.address, family: a.family }))) : cb(null, addrs[0]!.address, addrs[0]!.family)),
    (e: Error) => cb(Object.assign(e, { code: 'EGRESS_BLOCKED' }) as NodeJS.ErrnoException),
  );
}

/** The hosts a manifest allows: the target URL, the control base, the backend gate's upstream. */
export function egressFor(urls: (string | undefined | null)[]): EgressPolicy {
  const allow = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const p = new URL(u);
      allow.add(`${p.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${p.port || defaultPortOf(p.protocol)}`);
    } catch {
      /* not a URL: nothing to allow */
    }
  }
  return { allow: [...allow] };
}

/**
 * Replace the process-wide fetch with one that refuses every host off the list. The tester itself
 * uses node:http through `assertEgress`; this catches anything else loaded into the process.
 * Returns a function that restores the original.
 */
export function lockGlobalFetch(policy: EgressPolicy): () => void {
  const original = globalThis.fetch;
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    // why: the name check first (no DNS for a host off the list), then the resolved addresses.
    await assertEgressResolved(url, policy);
    return original(input, { ...(init ?? {}), redirect: 'manual' });
  };
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}
