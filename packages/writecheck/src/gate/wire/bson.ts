/**
 * A small BSON reader and writer for the wire gate: enough to read a command's name, namespace,
 * session and transaction fields, an aggregate pipeline's stage names and a reply's ok/code/
 * writeErrors, and to write the gate's own error replies. Values the gate never needs (binary,
 * ObjectId, decimal, regex, code) are decoded into tagged objects, never interpreted.
 */

import { WireDesync } from './codec.js';

export type Bson = null | undefined | boolean | number | string | Bson[] | { [k: string]: Bson } | Tagged;
export interface Tagged {
  _bson: 'binary' | 'oid' | 'date' | 'regex' | 'timestamp' | 'long' | 'decimal' | 'code' | 'minkey' | 'maxkey' | 'dbpointer' | 'symbol';
  hex?: string;
  sub?: number;
  value?: string;
}

export const isTagged = (v: unknown): v is Tagged => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Tagged)._bson === 'string';

function need(b: Buffer, at: number, n: number): void {
  if (at + n > b.length) throw new WireDesync('bson: document runs past its message');
}

function cstring(b: Buffer, at: number): [string, number] {
  const z = b.indexOf(0, at);
  if (z < 0) throw new WireDesync('bson: unterminated name');
  return [b.toString('utf8', at, z), z + 1];
}

function str(b: Buffer, at: number): [string, number] {
  need(b, at, 4);
  const n = b.readInt32LE(at);
  if (n < 1) throw new WireDesync('bson: bad string length');
  need(b, at + 4, n);
  return [b.toString('utf8', at + 4, at + 4 + n - 1), at + 4 + n];
}

/** Decode the document at `at`. Returns the document (key order kept) and its end offset. */
export function decode(b: Buffer, at = 0, depth = 0): [Record<string, Bson>, number] {
  if (depth > 100) throw new WireDesync('bson: nested too deep');
  need(b, at, 5);
  const len = b.readInt32LE(at);
  if (len < 5) throw new WireDesync('bson: bad document length');
  need(b, at, len);
  const end = at + len;
  const out: Record<string, Bson> = {};
  let p = at + 4;
  while (p < end - 1) {
    const type = b[p]!;
    const [key, q] = cstring(b, p + 1);
    p = q;
    let v: Bson;
    switch (type) {
      case 0x01:
        need(b, p, 8);
        v = b.readDoubleLE(p);
        p += 8;
        break;
      case 0x02:
      case 0x0d:
      case 0x0e:
        [v, p] = str(b, p);
        if (type !== 0x02) v = { _bson: type === 0x0d ? 'code' : 'symbol', value: v as string };
        break;
      case 0x03:
      case 0x04: {
        const [d, e] = decode(b, p, depth + 1);
        v = type === 0x04 ? Object.values(d) : d;
        p = e;
        break;
      }
      case 0x05: {
        need(b, p, 5);
        const n = b.readInt32LE(p);
        need(b, p + 5, n);
        v = { _bson: 'binary', sub: b[p + 4]!, hex: b.toString('hex', p + 5, p + 5 + n) };
        p += 5 + n;
        break;
      }
      case 0x06:
      case 0x0a:
        v = type === 0x0a ? null : undefined;
        break;
      case 0x07:
        need(b, p, 12);
        v = { _bson: 'oid', hex: b.toString('hex', p, p + 12) };
        p += 12;
        break;
      case 0x08:
        need(b, p, 1);
        v = b[p] === 1;
        p += 1;
        break;
      case 0x09:
      case 0x11:
      case 0x12: {
        need(b, p, 8);
        const n = b.readBigInt64LE(p);
        p += 8;
        v = type === 0x12 ? (n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : { _bson: 'long', value: n.toString() }) : { _bson: type === 0x09 ? 'date' : 'timestamp', value: n.toString() };
        break;
      }
      case 0x0b: {
        const [pat, q1] = cstring(b, p);
        const [flags, q2] = cstring(b, q1);
        v = { _bson: 'regex', value: `/${pat}/${flags}` };
        p = q2;
        break;
      }
      case 0x0c: {
        const [, q1] = str(b, p);
        need(b, q1, 12);
        v = { _bson: 'dbpointer' };
        p = q1 + 12;
        break;
      }
      case 0x0f: {
        need(b, p, 4);
        const n = b.readInt32LE(p);
        need(b, p, n);
        v = { _bson: 'code' };
        p += n;
        break;
      }
      case 0x10:
        need(b, p, 4);
        v = b.readInt32LE(p);
        p += 4;
        break;
      case 0x13:
        need(b, p, 16);
        v = { _bson: 'decimal', hex: b.toString('hex', p, p + 16) };
        p += 16;
        break;
      case 0xff:
      case 0x7f:
        v = { _bson: type === 0xff ? 'minkey' : 'maxkey' };
        break;
      default:
        throw new WireDesync(`bson: unknown element type 0x${type.toString(16)}`);
    }
    out[key] = v;
  }
  if (b[end - 1] !== 0) throw new WireDesync('bson: document not terminated');
  return [out, end];
}

/** The name of a document's first element (a command's name), without decoding the rest. */
export function firstKey(b: Buffer, at = 0): string {
  need(b, at, 5);
  if (b[at + 4] === 0) return '';
  return cstring(b, at + 5)[0];
}

/** Encode a document. Integers in int32 range are int32, other numbers double; Tagged binary and long are kept. */
export function encode(doc: Record<string, Bson>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (v === undefined) continue;
    const name = Buffer.from(`${k}\0`, 'utf8');
    const el = (type: number, body: Buffer) => parts.push(Buffer.from([type]), name, body);
    if (v === null) el(0x0a, Buffer.alloc(0));
    else if (typeof v === 'boolean') el(0x08, Buffer.from([v ? 1 : 0]));
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
        const b = Buffer.alloc(4);
        b.writeInt32LE(v);
        el(0x10, b);
      } else {
        const b = Buffer.alloc(8);
        b.writeDoubleLE(v);
        el(0x01, b);
      }
    } else if (typeof v === 'string') {
      const s = Buffer.from(v, 'utf8');
      const b = Buffer.alloc(4);
      b.writeInt32LE(s.length + 1);
      el(0x02, Buffer.concat([b, s, Buffer.from([0])]));
    } else if (Array.isArray(v)) el(0x04, encode(Object.fromEntries(v.map((x, i) => [String(i), x]))));
    else if (isTagged(v)) {
      if (v._bson === 'binary') {
        const data = Buffer.from(v.hex ?? '', 'hex');
        const b = Buffer.alloc(5);
        b.writeInt32LE(data.length);
        b[4] = v.sub ?? 0;
        el(0x05, Buffer.concat([b, data]));
      } else if (v._bson === 'long') {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(BigInt(v.value ?? '0'));
        el(0x12, b);
      } else if (v._bson === 'oid') el(0x07, Buffer.from(v.hex ?? '', 'hex'));
      else throw new Error(`bson: cannot encode ${v._bson}`);
    } else el(0x03, encode(v as Record<string, Bson>));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length + 5);
  return Buffer.concat([head, body, Buffer.from([0])]);
}
