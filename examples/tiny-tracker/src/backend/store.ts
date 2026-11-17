// The tracker's data and its operations, in memory.
//
// This backend is deliberately correct: every write is atomic (no await
// between reading and writing a record), every ticket carries a version that
// is its ETag, conditional writes are checked, keyed requests are replayed
// rather than repeated, and batches are all-or-nothing. The MCP layer in
// src/mcp talks to it over HTTP only.

import { wallClock, type Clock } from "../clock.js";
import { randomBytes } from "node:crypto";
import {
  CommitSinkError, JournalError, objectsOf,
  type AppliedWrite, type CommitSink, type CommittedTransaction, type IdCounters, type ObjectOwner, type ObjectRef,
  type RefusedTransaction, type ReplayedTransaction, type SeedState, type TxMeta,
} from "./commit.js";
import type { KeyRecordSeam, KeyScope } from "./seams.js";

export type Status = "open" | "in_progress" | "closed" | "archived";
export const STATUSES: readonly Status[] = ["open", "in_progress", "closed", "archived"];

export interface Label {
  id: string;
  name: string;
}

export interface Comment {
  id: string;
  body: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  project: string;
  title: string;
  status: Status;
  assignee: string | null;
  priority: number;
  /** Free text; may be empty. */
  description: string;
  /** A nested object; a PATCH sets only the sub-fields it names. */
  details: Details;
  labels: Label[];
  comments: Comment[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Project {
  key: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Details {
  component: string | null;
  severity: "low" | "medium" | "high" | null;
}
const SEVERITIES = ["low", "medium", "high"];

/** The scalar fields a PATCH or PUT may set, the nested details (PATCH only), plus the label list by name. */
export interface TicketFields {
  title?: string;
  status?: Status;
  assignee?: string | null;
  priority?: number;
  description?: string;
  details?: Partial<Details>;
  labels?: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A write's result: the ticket after the write and the fields that changed. */
export interface WriteResult {
  ticket: Ticket;
  changed: string[];
  replayed: boolean;
  /** When replayed: the commit that applied the write this repeat matches (its applied-write entry's seq). */
  originalSeq?: number;
}

/** A Map that tells its owner which keys were set or deleted (the post-state of a commit is collected this way). */
class TrackedMap<K, V> extends Map<K, V> {
  onChange: ((key: K) => void) | undefined = undefined;
  override set(key: K, value: V): this {
    this.onChange?.(key);
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    this.onChange?.(key);
    return super.delete(key);
  }
}

/** What the commit section in progress has touched: its one clock read and the objects and log entries it changed. */
interface Section {
  meta: TxMeta;
  seq: number;
  committedAt: string;
  projects: Set<string>;
  tickets: Set<string>;
  owners: ObjectOwner[];
  applied: AppliedWrite[];
}

/** A reply from a commit section. `replayOf` set: a re-sent conditional write already applied by commit `replayOf`. */
export interface SectionReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  replayOf?: number;
}

const clone = <T>(value: T): T => structuredClone(value);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---- validation (the backend's own rules; the MCP layer may be stricter) ----

const PROJECT_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

function fieldError(field: string, reason: string): ApiError {
  return new ApiError(422, "validation", `${field}: ${reason}`, { field, reason });
}

export function validateFields(fields: TicketFields, { partial }: { partial: boolean }): void {
  const has = (k: keyof TicketFields) => Object.prototype.hasOwnProperty.call(fields, k);
  for (const key of Object.keys(fields)) {
    if (!["title", "status", "assignee", "priority", "description", "details", "labels"].includes(key)) {
      throw fieldError(key, "unknown field");
    }
  }
  if (!partial) {
    for (const k of ["title", "status", "assignee", "priority"] as const) {
      if (!has(k)) throw fieldError(k, "required for a full replace");
    }
  }
  if (has("title") && (typeof fields.title !== "string" || fields.title.length < 1 || fields.title.length > 1000)) {
    throw fieldError("title", "must be a string of 1 to 1000 characters");
  }
  if (has("status") && !STATUSES.includes(fields.status as Status)) {
    throw fieldError("status", `must be one of ${STATUSES.join(", ")}`);
  }
  if (has("assignee") && fields.assignee !== null) {
    if (typeof fields.assignee !== "string" || fields.assignee.length < 1 || fields.assignee.length > 64) {
      throw fieldError("assignee", "must be null or a string of 1 to 64 characters");
    }
  }
  if (has("priority") && (!Number.isInteger(fields.priority) || fields.priority! < 1 || fields.priority! > 5)) {
    throw fieldError("priority", "must be an integer from 1 to 5");
  }
  if (has("description") && (typeof fields.description !== "string" || fields.description.length > 2000)) {
    throw fieldError("description", "must be a string of at most 2000 characters (empty is allowed)");
  }
  if (has("details")) {
    const d = fields.details as Record<string, unknown> | null;
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw fieldError("details", "must be an object");
    for (const [k, v] of Object.entries(d)) {
      if (k === "component") {
        if (v !== null && (typeof v !== "string" || v.length < 1 || v.length > 64)) throw fieldError("details.component", "must be null or a string of 1 to 64 characters");
      } else if (k === "severity") {
        if (v !== null && !SEVERITIES.includes(v as string)) throw fieldError("details.severity", `must be null or one of ${SEVERITIES.join(", ")}`);
      } else throw fieldError(`details.${k}`, "unknown field");
    }
  }
  if (has("labels")) {
    if (!Array.isArray(fields.labels) || fields.labels.length > 20) {
      throw fieldError("labels", "must be a list of at most 20 names");
    }
    for (const name of fields.labels) {
      if (typeof name !== "string" || name.length < 1 || name.length > 32) {
        throw fieldError("labels", "each label must be a string of 1 to 32 characters");
      }
    }
  }
}

// ---- the store ----

export class Store {
  /**
   * The fields whose values are the store's state: a journal failure puts every one of them back (snapshot/restore),
   * and test/interfaces.test.ts fails when the class has a field in neither list. A stream that adds state adds the
   * field here; one that adds wiring adds it to WIRING_FIELDS.
   */
  static readonly STATE_FIELDS = ["projects", "tickets", "applied", "seq", "owners", "commitSeq"] as const;
  /** The applied-write log keeps this many entries per ticket (INTERFACES 1.1). */
  static readonly APPLIED_CAP = 20;
  /** Fields that are configuration or bookkeeping, not state: never snapshotted. */
  static readonly WIRING_FIELDS = ["clock", "bootId", "seed", "journal", "sinks", "stopped", "section", "keyRecords", "runOwner"] as const;

  readonly projects = new TrackedMap<string, Project>();
  readonly tickets = new TrackedMap<string, Ticket>();
  private applied = new Map<string, AppliedWrite[]>();
  private seq: IdCounters = { ticket: 0, label: 0, comment: 0 };
  /** Who created each project and ticket ("project:<key>", "ticket:<id>"): the run reset and ownership checks read it. */
  private owners = new Map<string, ObjectOwner>();
  /** The commit sequence: one per commit, from 1. Replays, refusals and aborted writes take none. */
  private commitSeq = 0;
  /** The seed, as created (the journal header carries it, so a restart keeps the seed's created_at). */
  readonly seed: SeedState;
  private journal: CommitSink | undefined = undefined;
  private readonly sinks: CommitSink[] = [];
  /** Set when a sink after the journal failed: the store answers nothing more (fail-stop). */
  private stopped: CommitSinkError | undefined = undefined;
  /** The commit section in progress, if any. */
  private section: Section | undefined = undefined;
  /** The key-record seam, set by startBackend: a run reset drops one run's key records through it. */
  keyRecords: KeyRecordSeam | undefined = undefined;
  /** Which principal a run belongs to, when the fixture layer allocated it (undefined: unknown run). Set by startBackend. */
  runOwner: ((run: string) => string | undefined) | undefined = undefined;

  constructor(seedProjects: string[] = ["inbox"], readonly clock: Clock = wallClock, readonly bootId: string = randomBytes(8).toString("hex")) {
    for (const key of seedProjects) this.createProject(key, key);
    this.seed = { projects: [...this.projects.values()].map(clone), counters: { ...this.seq } };
    this.projects.onChange = (k) => this.section?.projects.add(k);
    this.tickets.onChange = (k) => this.section?.tickets.add(k);
  }

  /** The record time: inside a commit section the section's one clock read, else (only the seed) the clock. */
  private now(): string {
    return this.section?.committedAt ?? this.clock.now().toISOString();
  }

  /** The commit sequence of the last commit (0 before any). */
  get lastSeq(): number {
    return this.commitSeq;
  }

  /** The id counters now. */
  counters(): IdCounters {
    return { ...this.seq };
  }

  /** The owner of a project or ticket, if this store created it in a commit (the seed has none). */
  ownerOf(ref: { type: "ticket" | "project"; id: string }): ObjectOwner | undefined {
    const o = this.owners.get(`${ref.type}:${ref.id}`);
    return o && { ...o };
  }

  // ---- the commit point (src/backend/commit.ts) ----

  /** Adds a sink. At most one has role "journal"; it is told first, the others after the write is visible. */
  addSink(sink: CommitSink): void {
    if (sink.role === "journal") {
      if (this.journal) throw new Error(`a journal sink is already set (${this.journal.name})`);
      this.journal = sink;
    } else {
      this.sinks.push(sink);
    }
  }

  /** Every STATE_FIELDS value, deep-copied. Taken only when a journal is set (to undo a write its journal refused). */
  captureState(): Record<string, unknown> {
    const self = this as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of Store.STATE_FIELDS) {
      const v = self[f];
      out[f] = v instanceof Map ? structuredClone([...v]) : structuredClone(v);
    }
    return out;
  }

  private restoreState(s: Record<string, unknown>): void {
    const self = this as unknown as Record<string, unknown>;
    for (const f of Store.STATE_FIELDS) {
      const v = self[f];
      if (v instanceof Map) {
        v.clear();
        for (const [k, x] of s[f] as Array<[unknown, unknown]>) Map.prototype.set.call(v, k, x);
      } else {
        self[f] = s[f];
      }
    }
  }

  /** Throws the stored sink failure once a sink has failed. */
  checkRunning(): void {
    if (this.stopped) throw this.stopped;
  }

  private event(meta: TxMeta, status: number) {
    return { ...meta, bootId: this.bootId, at: this.clock.wallNow().toISOString(), clockOffsetMs: this.clock.offsetMs(), status };
  }

  /** Tells the ledger sinks, then the observers, each group in the order added (frozen). */
  private notify(fn: (sink: CommitSink) => void): void {
    const ordered = [...this.sinks.filter((s) => s.role === "ledger"), ...this.sinks.filter((s) => s.role !== "ledger")];
    for (const sink of ordered) {
      try {
        fn(sink);
      } catch (e) {
        this.stopped = new CommitSinkError(sink.name, e);
        throw this.stopped;
      }
    }
  }

  /**
   * Runs one write, in one synchronous section, in this order (frozen; docs/INTERFACES.md 1.1):
   *   1. validate and compute: `mutate` runs on the store; a refusal (an ApiError) changes nothing and is reported;
   *      a reply with `replayOf` (a re-sent conditional write already applied) changes nothing and goes to replay();
   *   2. journal: the journal sink appends the committed post-state; if it throws, the store is put back as it was,
   *      nothing is applied, the ledger is told of a 503 journal_unavailable refusal, and the caller gets a
   *      JournalError (503);
   *   3. apply: the write is now in effect, and `afterJournal` records what goes with it (the key record); if it
   *      throws, the ledger and observers are still told, then the store stops (fail-stop);
   *   4. ledger, then observers: if one throws, the store stops (fail-stop: the journal and memory agree, the
   *      evidence does not);
   *   5. reply (the caller sends it, after the after-commit fault hook).
   * `mutate` receives the commit sequence number the write will get, and must not await. Every record time it stores
   * is the section's one clock read (tx.committedAt).
   */
  commit<R extends SectionReply>(meta: TxMeta, mutate: (seq: number) => R, afterJournal?: (tx: CommittedTransaction, reply: R) => void, kind: CommittedTransaction["kind"] = "write"): { reply: R; tx?: CommittedTransaction } {
    this.checkRunning();
    if (this.section) throw new Error("commit sections do not nest");
    const before = this.journal ? this.captureState() : undefined;
    const seq = this.commitSeq + 1;
    const section: Section = { meta, seq, committedAt: this.clock.now().toISOString(), projects: new Set(), tickets: new Set(), owners: [], applied: [] };
    this.section = section;
    let reply: R;
    try {
      reply = mutate(seq);
      if ((reply as unknown as { then?: unknown }).then !== undefined) throw new Error("a commit section must be synchronous (await in a before step instead)");
    } catch (e) {
      this.section = undefined;
      if (e instanceof ApiError) this.refuse(meta, e.status, e.code);
      throw e;
    }
    this.section = undefined;
    if (reply.replayOf !== undefined) {
      if (section.projects.size || section.tickets.size) throw new Error("a replayed write changed the store");
      this.replay(meta, reply.status, reply.body, reply.replayOf);
      return { reply };
    }
    if (reply.status >= 300) {
      this.refuse(meta, reply.status, "refused");
      return { reply };
    }
    const tx: CommittedTransaction = {
      ...this.event(meta, reply.status), kind, seq, committedAt: section.committedAt, body: reply.body, headers: { ...(reply.headers ?? {}) },
      objects: kind === "run-reset" ? [...((reply.body as { objects?: ObjectRef[] })?.objects ?? [])] : objectsOf(meta.request?.path ?? "", reply.body),
      post: this.postState(section),
    };
    if (kind === "run-reset") tx.reset = { principal: meta.principal, run: meta.attribution.run!, objects: [...tx.objects], keys: null };
    if (this.journal) {
      try {
        this.journal.onCommit(tx);
      } catch (e) {
        this.restoreState(before!);
        this.refuse(meta, 503, "journal_unavailable");
        throw new JournalError(this.journal.name, e);
      }
    }
    this.commitSeq = seq;
    // The write is journalled and applied from here on. An exception in afterJournal (completing the key record) must
    // not skip the ledger: the ledger and observers are still told of the commit, then the store stops (fail-stop),
    // exactly as when a sink throws (seams v2.1).
    let afterFailed = false;
    let afterError: unknown;
    try {
      afterJournal?.(tx, reply);
    } catch (e) {
      afterFailed = true;
      afterError = e;
    }
    this.notify((s) => s.onCommit(tx));
    if (afterFailed) {
      this.stopped = new CommitSinkError("afterJournal", afterError);
      throw this.stopped;
    }
    return { reply, tx };
  }

  private postState(section: Section): CommittedTransaction["post"] {
    const post: CommittedTransaction["post"] = {
      upserts: { projects: [], tickets: [] }, deletes: { projects: [], tickets: [] }, counters: { ...this.seq },
      owners: section.owners.filter((o) => (o.type === "ticket" ? this.tickets : this.projects).has(o.id)), applied: section.applied,
    };
    for (const k of section.projects) {
      const p = this.projects.get(k);
      if (p) post.upserts.projects.push(clone(p)); else post.deletes.projects.push(k);
    }
    for (const k of section.tickets) {
      const t = this.tickets.get(k);
      if (t) post.upserts.tickets.push(clone(t)); else post.deletes.tickets.push(k);
    }
    return post;
  }

  /** Records the creator of an object made in the current section. */
  private own(type: "ticket" | "project", id: string): void {
    const s = this.section;
    if (!s) return;
    const o: ObjectOwner = { type, id, principal: s.meta.principal, run: s.meta.attribution.run };
    this.owners.set(`${type}:${id}`, o);
    s.owners.push(o);
  }

  /** Marks a ticket changed in place (the TrackedMap sees only set and delete). */
  private touch(ticket: Ticket): void {
    this.section?.tickets.add(ticket.id);
  }

  /** A keyed repeat answered from its record, or a re-sent conditional write: nothing applied. `originalSeq` is the commit that made it. */
  replay(meta: TxMeta, status: number, body: unknown, originalSeq: number): ReplayedTransaction {
    this.checkRunning();
    const tx: ReplayedTransaction = { ...this.event(meta, status), body, originalSeq };
    this.notify((s) => s.onReplay?.(tx));
    return tx;
  }

  /** A write refused before any effect. */
  refuse(meta: TxMeta, status: number, code: string): RefusedTransaction {
    const tx: RefusedTransaction = { ...this.event(meta, status), code };
    this.notify((s) => s.onRefusal?.(tx));
    return tx;
  }

  /**
   * Run reset (contract 1.8): removes the projects and tickets one principal's run created, and that run's key
   * records, as one commit (kind "run-reset"): journalled, so a restart does not bring them back, and told to the
   * ledger with tx.reset. A project that still holds a ticket of another run is kept. Refused with 403 run_not_owned
   * when the run is known to belong to another principal, and with 404 run_not_allocated when a run registry is
   * wired (runOwner) and never allocated it. Its meta has `request: null` (no client request; the ledger entry's
   * request is null). The key-record seam's dropRun also fences the run's pending key records (src/backend/seams.ts).
   */
  dropRun(scope: KeyScope, run: string): { objects: number; keys: number; tx: CommittedTransaction } {
    const owner = this.runOwner?.(run);
    const meta: TxMeta = { principal: scope.principal, attribution: { run, operation: null }, request: null };
    if (owner !== undefined && owner !== scope.principal) {
      this.refuse(meta, 403, "run_not_owned");
      throw new ApiError(403, "run_not_owned", `run ${run} belongs to another principal`);
    }
    if (this.runOwner && owner === undefined) {
      this.refuse(meta, 404, "run_not_allocated");
      throw new ApiError(404, "run_not_allocated", `run ${run} was never allocated by this fixture`);
    }
    let removed: ObjectRef[] = [];
    const { tx } = this.commit(meta, () => {
      removed = [];
      const mine = (o: ObjectOwner | undefined) => o !== undefined && o.principal === scope.principal && o.run === run;
      for (const t of [...this.tickets.values()]) {
        if (mine(this.owners.get(`ticket:${t.id}`))) {
          this.tickets.delete(t.id);
          this.applied.delete(t.id);
          this.owners.delete(`ticket:${t.id}`);
          removed.push({ type: "ticket", id: t.id });
        }
      }
      for (const p of [...this.projects.values()]) {
        if (mine(this.owners.get(`project:${p.key}`)) && ![...this.tickets.values()].some((t) => t.project === p.key)) {
          this.projects.delete(p.key);
          this.owners.delete(`project:${p.key}`);
          removed.push({ type: "project", id: p.key });
        }
      }
      return { status: 200, body: { run, principal: scope.principal, objects: removed } };
    }, (t) => {
      t.reset!.keys = this.keyRecords?.dropRun(scope, run) ?? 0;
    }, "run-reset");
    return { objects: removed.length, keys: tx!.reset!.keys!, tx: tx! };
  }

  // projects

  createProject(key: string, name: string): Project {
    if (typeof key !== "string" || !PROJECT_KEY.test(key)) {
      throw fieldError("key", "must match ^[a-z0-9][a-z0-9-]{0,62}$");
    }
    if (typeof name !== "string" || name.length < 1 || name.length > 100) {
      throw fieldError("name", "must be a string of 1 to 100 characters");
    }
    if (this.projects.has(key)) {
      throw new ApiError(409, "exists", `project ${key} already exists`, { current: clone(this.projects.get(key)) });
    }
    const t = this.now();
    const project: Project = { key, name, version: 1, created_at: t, updated_at: t };
    this.projects.set(key, project);
    this.own("project", key);
    return clone(project);
  }

  /** PUT semantics: create or replace. The correct MCP layer never uses it to create. */
  upsertProject(key: string, name: string): { project: Project; created: boolean } {
    const existing = this.projects.get(key);
    if (!existing) return { project: this.createProject(key, name), created: true };
    if (typeof name !== "string" || name.length < 1 || name.length > 100) {
      throw fieldError("name", "must be a string of 1 to 100 characters");
    }
    existing.name = name;
    existing.version += 1;
    existing.updated_at = this.now();
    this.section?.projects.add(key);
    return { project: clone(existing), created: false };
  }

  getProject(key: string): Project {
    const project = this.projects.get(key);
    if (!project) throw new ApiError(404, "not_found", `project ${key} not found`);
    return clone(project);
  }

  deleteProject(key: string): void {
    this.getProject(key);
    const count = [...this.tickets.values()].filter((t) => t.project === key).length;
    if (count > 0) {
      throw new ApiError(409, "not_empty", `project ${key} still has ${count} tickets`, { ticket_count: count });
    }
    this.projects.delete(key);
    this.owners.delete(`project:${key}`);
  }

  // tickets

  listTickets(filter: { project?: string; status?: string; title_prefix?: string }): Ticket[] {
    return [...this.tickets.values()]
      .filter((t) => (filter.project === undefined || t.project === filter.project)
        && (filter.status === undefined || t.status === filter.status)
        && (filter.title_prefix === undefined || t.title.startsWith(filter.title_prefix)))
      .map(clone);
  }

  getTicket(id: string): Ticket {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    return clone(ticket);
  }

  createTicket(input: TicketFields & { project?: string; comment?: string }): Ticket {
    const { project, comment, ...fields } = input;
    if (typeof project !== "string") throw fieldError("project", "required");
    this.getProject(project);
    if (fields.title === undefined) throw fieldError("title", "required");
    validateFields(fields, { partial: true });
    if (comment !== undefined && (typeof comment !== "string" || comment.length < 1 || comment.length > 5000)) {
      throw fieldError("comment", "must be a string of 1 to 5000 characters");
    }
    const t = this.now();
    const ticket: Ticket = {
      id: `T-${++this.seq.ticket}`,
      project,
      title: fields.title!,
      status: fields.status ?? "open",
      assignee: fields.assignee ?? null,
      priority: fields.priority ?? 3,
      description: fields.description ?? "",
      details: { component: fields.details?.component ?? null, severity: fields.details?.severity ?? null },
      labels: [...new Set(fields.labels ?? [])].map((name) => ({ id: `L-${++this.seq.label}`, name })),
      comments: comment ? [{ id: `C-${++this.seq.comment}`, body: comment, created_at: t }] : [],
      version: 1,
      created_at: t,
      updated_at: t,
    };
    this.tickets.set(ticket.id, ticket);
    this.own("ticket", ticket.id);
    return clone(ticket);
  }

  /** The principal of the write in progress (the commit section's); "" outside a section. */
  private principal(): string {
    return this.section?.meta.principal ?? "";
  }

  /**
   * Checks an If-Match precondition. Returns a replay result when the
   * precondition is stale only because this very write was already applied
   * from that version, by the same principal, and nothing has changed since.
   * Another principal sending the same write gets the normal 412 (seams v2.1).
   */
  private precondition(ticket: Ticket, ifMatch: number | "*" | undefined, fingerprint: string): WriteResult | undefined {
    if (ifMatch === undefined || ifMatch === "*" || ifMatch === ticket.version) return undefined;
    const last = this.applied.get(ticket.id)?.at(-1);
    if (last && last.fromVersion === ifMatch && last.toVersion === ticket.version && last.fingerprint === fingerprint
      && last.principal === this.principal()) {
      return { ticket: clone(ticket), changed: [], replayed: true, originalSeq: last.seq };
    }
    throw new ApiError(412, "precondition_failed",
      `ticket ${ticket.id} is at version ${ticket.version}, not ${ifMatch}`, { current: clone(ticket) });
  }

  private record(ticket: Ticket, fromVersion: number, fingerprint: string): void {
    const entry: AppliedWrite = { ticket: ticket.id, principal: this.principal(), fromVersion, toVersion: ticket.version, fingerprint, seq: this.section?.seq ?? 0 };
    const list = this.applied.get(ticket.id) ?? [];
    list.push(entry);
    this.applied.set(ticket.id, list.slice(-Store.APPLIED_CAP));
    this.section?.applied.push({ ...entry });
  }

  /** Applies fields to a ticket in place and returns the names of the fields that changed. */
  private applyFields(ticket: Ticket, fields: TicketFields): string[] {
    const changed: string[] = [];
    for (const key of ["title", "status", "assignee", "priority", "description"] as const) {
      if (fields[key] !== undefined && fields[key] !== ticket[key]) {
        (ticket as unknown as Record<string, unknown>)[key] = fields[key];
        changed.push(key);
      }
    }
    // Nested: only the sub-fields named change (a merge), so a write to one sub-field keeps the others (MWS-UPD-1).
    if (fields.details !== undefined) {
      for (const [k, v] of Object.entries(fields.details) as [keyof Details, never][]) {
        if (ticket.details[k] !== v) {
          ticket.details[k] = v;
          if (!changed.includes("details")) changed.push("details");
        }
      }
    }
    if (fields.labels !== undefined) {
      const wanted = [...new Set(fields.labels)];
      const current = ticket.labels.map((l) => l.name);
      if (canonicalJson(wanted) !== canonicalJson(current)) {
        ticket.labels = wanted.map((name) => ticket.labels.find((l) => l.name === name)
          ?? { id: `L-${++this.seq.label}`, name });
        changed.push("labels");
      }
    }
    return changed;
  }

  private bump(ticket: Ticket): void {
    ticket.version += 1;
    ticket.updated_at = this.now();
    this.touch(ticket);
  }

  /** Per-field update. Only the fields present are touched. */
  patchTicket(id: string, fields: TicketFields, ifMatch?: number | "*"): WriteResult {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    validateFields(fields, { partial: true });
    const fingerprint = `PATCH ${canonicalJson(fields)}`;
    const replay = this.precondition(ticket, ifMatch, fingerprint);
    if (replay) return replay;
    const from = ticket.version;
    const changed = this.applyFields(ticket, fields);
    if (changed.length > 0) {
      this.bump(ticket);
      this.record(ticket, from, fingerprint);
    }
    return { ticket: clone(ticket), changed, replayed: false };
  }

  /** Whole-object replace of the scalar fields. Needs If-Match unless forced. */
  putTicket(id: string, fields: TicketFields, ifMatch: number | "*" | undefined, force: boolean): WriteResult {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    validateFields(fields, { partial: false });
    if (ifMatch === undefined && !force) {
      throw new ApiError(428, "precondition_required",
        "a full replace needs If-Match with the version you read (or force=true to overwrite)");
    }
    const fingerprint = `PUT ${canonicalJson(fields)}`;
    const replay = force ? undefined : this.precondition(ticket, ifMatch, fingerprint);
    if (replay) return replay;
    const from = ticket.version;
    const changed = this.applyFields(ticket, fields);
    if (changed.length > 0) {
      this.bump(ticket);
      this.record(ticket, from, fingerprint);
    }
    return { ticket: clone(ticket), changed, replayed: false };
  }

  deleteTicket(id: string, ifMatch?: number | "*"): void {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    this.precondition(ticket, ifMatch, "DELETE");
    this.tickets.delete(id);
    this.applied.delete(id);
    this.owners.delete(`ticket:${id}`);
  }

  addComment(id: string, body: string): { ticket: Ticket; comment: Comment } {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    if (typeof body !== "string" || body.length < 1 || body.length > 5000) {
      throw fieldError("body", "must be a string of 1 to 5000 characters");
    }
    const comment: Comment = { id: `C-${++this.seq.comment}`, body, created_at: this.now() };
    ticket.comments.push(comment);
    this.bump(ticket);
    return { ticket: clone(ticket), comment: clone(comment) };
  }

  /** Adds a label by name. Adding a name the ticket already has changes nothing. */
  addLabel(id: string, name: string): { ticket: Ticket; label: Label; created: boolean } {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    validateFields({ labels: [name] }, { partial: true });
    const existing = ticket.labels.find((l) => l.name === name);
    if (existing) return { ticket: clone(ticket), label: clone(existing), created: false };
    if (ticket.labels.length >= 20) throw fieldError("labels", "a ticket has at most 20 labels");
    const label = { id: `L-${++this.seq.label}`, name };
    ticket.labels.push(label);
    this.bump(ticket);
    return { ticket: clone(ticket), label: clone(label), created: true };
  }

  removeLabel(id: string, labelId: string): Ticket {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ApiError(404, "not_found", `ticket ${id} not found`);
    const index = ticket.labels.findIndex((l) => l.id === labelId);
    if (index < 0) throw new ApiError(404, "not_found", `ticket ${id} has no label ${labelId}`);
    ticket.labels.splice(index, 1);
    this.bump(ticket);
    return clone(ticket);
  }

  /**
   * All-or-nothing batch. Every operation is checked against the state as it
   * would be after the earlier ones; only if all pass is anything applied.
   */
  batch(ops: BatchOp[]): { results: Array<{ id: string; op: string; version?: number; changed?: string[] }> } {
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100) throw fieldError("ops", "must be a list of 1 to 100 operations");
    // Dry run on copies first (restoring the id counters afterwards, so a refused batch uses up nothing).
    const seq = { ...this.seq };
    const shadow = new Map([...this.tickets].map(([k, v]) => [k, clone(v)]));
    try {
      ops.forEach((op, index) => {
        const at = (e: ApiError) => new ApiError(e.status, e.code, `operation ${index} (${op.id}): ${e.message}`,
          { ...e.extra, index, id: op.id });
        const ticket = shadow.get(op.id);
        if (!ticket) throw at(new ApiError(404, "not_found", `ticket ${op.id} not found`));
        if (op.project !== undefined && ticket.project !== op.project) {
          throw at(new ApiError(404, "not_found", `ticket ${op.id} is not in project ${op.project}`));
        }
        if (op.if_match !== undefined && op.if_match !== ticket.version) {
          throw at(new ApiError(412, "precondition_failed", `ticket ${op.id} is at version ${ticket.version}, not ${op.if_match}`,
            { current: clone(ticket) }));
        }
        if (op.op === "patch") {
          try { validateFields(op.set ?? {}, { partial: true }); } catch (e) { throw at(e as ApiError); }
          if (this.applyFields(ticket, op.set ?? {}).length > 0) ticket.version += 1;
        } else if (op.op === "delete") {
          shadow.delete(op.id);
        } else {
          throw at(fieldError("op", "must be patch or delete"));
        }
      });
    } finally {
      this.seq = seq;
    }
    // Every operation passed: apply for real.
    const results = ops.map((op) => {
      if (op.op === "delete") {
        this.tickets.delete(op.id);
        this.applied.delete(op.id);
        this.owners.delete(`ticket:${op.id}`);
        return { id: op.id, op: op.op };
      }
      const r = this.patchTicket(op.id, op.set ?? {});
      return { id: op.id, op: op.op, version: r.ticket.version, changed: r.changed };
    });
    return { results };
  }

  export(): { projects: Project[]; tickets: Ticket[] } {
    return { projects: [...this.projects.values()].map(clone), tickets: [...this.tickets.values()].map(clone) };
  }

  // ---- stream D: journal replay ----
  // Stream D fills this block (and only this block of store.ts). Contract (docs/INTERFACES.md 1.8): no clock call, no
  // operation re-run; times, ids, counters, owners and applied-write entries come from the journal as committed.

  /** Replaces the constructor's seed with a journal header's (so the seed keeps its first created_at). Stream D. */
  applySeed(_seed: SeedState): void {
    throw new Error("Store.applySeed is built by stream D (0.3.0, feature durable)");
  }

  /**
   * Restores one committed transaction's post-state: upserts and deletes, counters, owners, applied-write entries,
   * and the commit sequence (lastSeq becomes tx.seq). Key records are rebuilt by the journal from the same line
   * (storedReplyOf(tx); a run-reset line drops tx.reset's key records). Stream D.
   */
  applyPostState(_tx: CommittedTransaction): void {
    throw new Error("Store.applyPostState is built by stream D (0.3.0, feature durable)");
  }
  // ---- end stream D ----
}

export interface BatchOp {
  op: "patch" | "delete";
  id: string;
  project?: string;
  if_match?: number;
  set?: TicketFields;
}
