/**
 * The contract between the protocol-neutral wire gate (proxy.ts) and a protocol codec. A codec
 * session lives for one client connection: it frames the client's bytes into units (the smallest
 * message group the backend answers as one), names each unit (verb, target, write or not), frames
 * the backend's bytes into pieces attributed to the unit they answer, and writes the protocol's own
 * answers when the gate answers instead of the backend (an injected error, or the emulation that
 * keeps client and backend in step after one). See docs/WIRE-GATE.md.
 */

export type WireProtocol = 'postgres' | 'redis' | 'mongodb';

/** Transaction state, as the backend would report it after a unit. */
export type TxnState = 'idle' | 'in' | 'failed';

export interface Classified {
  /** The verb: an SQL keyword (UPDATE), a Redis command (SET), a Mongo command name (update). */
  verb: string;
  /** The target: a table, a key, `<db>.<collection>`; '' when there is none. */
  path: string;
  /** A write, or not known to be a read (rule: unknown counts as a write). */
  mutating: boolean;
  /** Why the classification is not certain; absent when it is. */
  uncertain?: string;
  /** The request with every value removed (SQL literals as ?, Redis key only, Mongo command and namespace). */
  statement: string;
  /** Statements in the unit, when more than one. */
  statements?: number;
}

export interface ClientUnit {
  bytes: Buffer;
  /** null: passthrough (startup, authentication, COPY data): not logged, matched or answered by the gate. */
  req: Classified | null;
  /** The transaction this unit belongs to: the connection for Postgres and Redis, the session (lsid) for Mongo. */
  txnKey?: string;
  /** The client expects no answer (Mongo moreToCome). */
  noReply?: boolean;
  /** The gate answers this itself and never forwards it (Postgres SSLRequest: N). */
  localReply?: Buffer;
  /** Codec-private framing data. */
  meta?: unknown;
}

export interface Outcome {
  /** HTTP-equivalent status (docs/WIRE-GATE.md §5.4). */
  status: number;
  /** The protocol's own answer class, values removed (CommandComplete UPDATE 1, -WRONGTYPE, ok:1 n:1). */
  reply: string;
  /** Transaction state of the unit's txnKey after the unit. */
  txn: TxnState;
  /** This unit ended a transaction (commit or rollback). */
  ended?: boolean;
  /** This unit ended a transaction by committing it. */
  committed?: boolean;
  /** The unit undid changes it or its transaction made (a ROLLBACK, ROLLBACK TO, PREPARE TRANSACTION, or a COMMIT answered ROLLBACK). */
  rolledBack?: boolean;
  /** Redis: the position of a command queued inside MULTI (its answer in the EXEC array). */
  queuedIndex?: number;
  /** Redis: positions in an EXEC answer that are errors. */
  failedItems?: number[];
}

export interface ServerPiece {
  bytes: Buffer;
  /** The unit (id given to sent()) this answers, or null: out of band (notices, pushes, startup). */
  unit: number | null;
  /** Set on the last piece of the unit's answer. */
  end?: Outcome;
}

/** The gate answers the unit itself (synth), or sends other bytes in its place and answers itself once they are answered. */
export type Intercept = { synth: Buffer; outcome: Outcome } | { forward: ClientUnit; answer: Buffer; outcome: Outcome };

export interface CodecSession {
  readonly protocol: WireProtocol;
  /** Client bytes in, complete units out (partial frames are kept). Throws WireDesync when the stream cannot be framed. */
  client(chunk: Buffer): ClientUnit[];
  /** The gate forwarded this unit to the backend under this id: its answer is expected. */
  sent(id: number, u: ClientUnit): void;
  /** Backend bytes in, pieces out. Throws WireDesync when the stream cannot be framed. */
  server(chunk: Buffer): ServerPiece[];
  /** Before a unit is forwarded: answer it instead, to stay in step after an injected error (null: forward it). */
  intercept(u: ClientUnit): Intercept | null;
  /**
   * The bytes that answer `u` with an injected error. `realTxn` is the backend's state for the unit's
   * transaction (after the unit when it was forwarded, before it when it was not). `note` says what
   * the gate could not emulate.
   */
  injectError(u: ClientUnit, message: string, realTxn: TxnState): { bytes: Buffer; note?: string };
  /** The backend's last reported transaction state for a txnKey. */
  txn(key: string | undefined): TxnState;
  /** Why an injected error cannot be answered for this unit without leaving client and backend out of step (null: it can). */
  cannotInject?(u: ClientUnit, realTxn: TxnState): string | null;
}

export class WireDesync extends Error {
  readonly code = 'WIRE_DESYNC';
}

export const INJECTED = 'injected by the mcp-writecheck gate';

/** Cut a statement for the record. */
export function cut(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
