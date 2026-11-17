// The tracker's data and its operations, in memory.
//
// This backend is deliberately correct: every write is atomic (no await
// between reading and writing a record), every ticket carries a version that
// is its ETag, conditional writes are checked, keyed requests are replayed
// rather than repeated, and batches are all-or-nothing. The MCP layer in
// src/mcp talks to it over HTTP only.

import { wallClock, type Clock } from "../clock.js";
import { CommitSinkError, JournalError, objectsOf, type CommitSink, type CommittedTransaction, type RefusedTransaction, type ReplayedTransaction, type TxMeta } from "./commit.js";

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
}

/** One entry per applied write, used to recognize a replayed conditional write. */
interface AppliedWrite {
  fromVersion: number;
  toVersion: number;
  fingerprint: string;
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
  readonly projects = new Map<string, Project>();
  readonly tickets = new Map<string, Ticket>();
  private readonly applied = new Map<string, AppliedWrite[]>();
  private seq = { ticket: 0, label: 0, comment: 0 };
  /** The commit sequence: one per applied write, from 1 (the journal line number from 0.3.0). Replays and refusals take none. */
  private commitSeq = 0;
  private journal: CommitSink | undefined;
  private readonly sinks: CommitSink[] = [];
  /** Set when a sink after the journal failed: the store answers nothing more (fail-stop). */
  private stopped: CommitSinkError | undefined;

  constructor(seedProjects: string[] = ["inbox"], readonly clock: Clock = wallClock) {
    for (const key of seedProjects) this.createProject(key, key);
  }

  private now(): string {
    return this.clock.now().toISOString();
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

  /** The whole state, for undoing a write whose journal append failed. Taken only when a journal is set. */
  private snapshot() {
    return { projects: structuredClone([...this.projects]), tickets: structuredClone([...this.tickets]), applied: structuredClone([...this.applied]), seq: { ...this.seq } };
  }

  private restore(s: ReturnType<Store["snapshot"]>): void {
    this.projects.clear();
    for (const [k, v] of s.projects) this.projects.set(k, v);
    this.tickets.clear();
    for (const [k, v] of s.tickets) this.tickets.set(k, v);
    this.applied.clear();
    for (const [k, v] of s.applied) this.applied.set(k, v);
    this.seq = s.seq;
  }

  /** Throws the stored sink failure once a sink has failed. */
  checkRunning(): void {
    if (this.stopped) throw this.stopped;
  }

  private event(meta: TxMeta, status: number) {
    return { ...meta, at: this.clock.wallNow().toISOString(), clockOffsetMs: this.clock.offsetMs(), status };
  }

  private notify(fn: (sink: CommitSink) => void): void {
    for (const sink of this.sinks) {
      try {
        fn(sink);
      } catch (e) {
        this.stopped = new CommitSinkError(sink.name, e);
        throw this.stopped;
      }
    }
  }

  /**
   * Runs one write, in one synchronous section, in this order (frozen; docs/INTERFACES.md):
   *   1. validate and compute: `mutate` runs on the store; a refusal (an ApiError) changes nothing and is reported;
   *   2. journal: the journal sink appends the committed post-state; if it throws, the store is put back as it was,
   *      nothing is applied, and the caller gets a JournalError (503);
   *   3. apply: the write is now in effect, and `afterJournal` records what goes with it (the key record);
   *   4. ledger and other sinks: if one throws, the store stops (fail-stop: the journal and memory agree, the
   *      evidence does not);
   *   5. reply (the caller sends it).
   * `mutate` receives the commit sequence number the write will get, and must not await.
   */
  commit<R extends { status: number; body?: unknown }>(meta: TxMeta, mutate: (seq: number) => R, afterJournal?: (tx: CommittedTransaction, reply: R) => void): { reply: R; tx?: CommittedTransaction } {
    this.checkRunning();
    const before = this.journal ? this.snapshot() : undefined;
    let reply: R;
    try {
      reply = mutate(this.commitSeq + 1);
    } catch (e) {
      if (e instanceof ApiError) this.refuse(meta, e.status, e.code);
      throw e;
    }
    if ((reply as unknown as { then?: unknown }).then !== undefined) throw new Error("a commit section must be synchronous (await in a before step instead)");
    if (reply.status >= 300) {
      this.refuse(meta, reply.status, "refused");
      return { reply };
    }
    const tx: CommittedTransaction = { ...this.event(meta, reply.status), seq: this.commitSeq + 1, body: reply.body, objects: objectsOf(meta.request.path, reply.body) };
    if (this.journal) {
      try {
        this.journal.onCommit(tx);
      } catch (e) {
        this.restore(before!);
        throw new JournalError(this.journal.name, e);
      }
    }
    this.commitSeq = tx.seq;
    afterJournal?.(tx, reply);
    this.notify((s) => s.onCommit(tx));
    return { reply, tx };
  }

  /** A keyed repeat answered from its record: nothing applied. `originalSeq` is the commit that made the record. */
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
    return clone(ticket);
  }

  /**
   * Checks an If-Match precondition. Returns a replay result when the
   * precondition is stale only because this very write was already applied
   * from that version and nothing has changed since.
   */
  private precondition(ticket: Ticket, ifMatch: number | "*" | undefined, fingerprint: string): WriteResult | undefined {
    if (ifMatch === undefined || ifMatch === "*" || ifMatch === ticket.version) return undefined;
    const last = this.applied.get(ticket.id)?.at(-1);
    if (last && last.fromVersion === ifMatch && last.toVersion === ticket.version && last.fingerprint === fingerprint) {
      return { ticket: clone(ticket), changed: [], replayed: true };
    }
    throw new ApiError(412, "precondition_failed",
      `ticket ${ticket.id} is at version ${ticket.version}, not ${ifMatch}`, { current: clone(ticket) });
  }

  private record(ticket: Ticket, fromVersion: number, fingerprint: string): void {
    const list = this.applied.get(ticket.id) ?? [];
    list.push({ fromVersion, toVersion: ticket.version, fingerprint });
    this.applied.set(ticket.id, list.slice(-20));
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
}

export interface BatchOp {
  op: "patch" | "delete";
  id: string;
  project?: string;
  if_match?: number;
  set?: TicketFields;
}
