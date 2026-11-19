// The build descriptor (design rule 6, reviews G1 and G9): what a run ran
// against, served read-only at GET /build and mirrored in the MCP
// instructions and in every tool result's _meta.
//
// Two hashes. `build_hash` covers the configuration, the part that is the same
// on every start with the same settings: package version, profile, features,
// defects of both layers, variants, control on or off, durability mode, the
// process layout and the pinned contract commit. Known-answer files are keyed
// by it. `descriptor_hash` covers the whole descriptor, including the state of
// this process (boot id, restart count, journal head, armed faults, clock
// offset), so two snapshots with the same descriptor_hash are the same in
// every field. Both are SHA-256 over RFC 8785 canonical bytes under their own
// domain tags (src/digest.ts).
//
// Process state (0.3.0, G9): `boot_id` is new on every process start; under
// `tiny-tracker all --supervise` each child has its own, `restart_count` is
// how often the supervisor restarted this child, and the `supervision` member
// names the supervisor and both children (read live from the supervisor's
// state folder, so /build is the readiness endpoint a harness polls). The
// clock block names the clock's domain and offset (G7); armed faults are read
// from the arming store the fault controller writes to.

import { randomBytes } from "node:crypto";
import { canonicalize, domainDigest, DOMAINS } from "../digest.js";
import { CONTRACT, META_KEYS } from "../fixture-properties.js";
import { wallClock, type Clock } from "../clock.js";
import { PACKAGE_VERSION, type ProfileName } from "../profile.js";
import type { ProcessLayout } from "../compat.js";
import { memoryArming, readChildren, readJson, settingsPath, type ArmingStore, type ChildContext, type ChildInfo, type ChildRole } from "../supervision.js";

export const DESCRIPTOR_VERSION = "build-descriptor/1";
export const FIXTURE_API_VERSION = "fixture-api/1"; // ---- stream B: the control API ships (fault arming, run reset), R7 ----

export interface DescriptorInput {
  layout: ProcessLayout;
  profile: ProfileName;
  features: readonly string[];
  /** null where this process does not hold that layer (the other layer runs in another process). */
  mcpDefects: readonly string[] | null;
  backendDefects: readonly string[] | null;
  variants: readonly string[] | null;
  control: boolean;
  /** Durability mode (stream D sets the journal). Default: memory, no journal format. Part of build_hash. */
  durability?: { mode: "memory" | "journal"; journal_format: string | null };
}

/** The MCP-layer settings that change what a run sees (review fix 1). The key journal's path is a machine detail: only whether one is set. */
export interface ServerSettings {
  read_only: boolean;
  tools: string[] | null;
  deny_tools: string[] | null;
  default_project: string;
  key_journal: boolean;
}

export interface BuildDescriptorJson {
  descriptor: typeof DESCRIPTOR_VERSION;
  package: { name: string; version: string };
  fixture_api: typeof FIXTURE_API_VERSION;
  profile: ProfileName;
  features: string[];
  defects: { mcp: string[] | null; backend: string[] | null };
  variants: string[] | null;
  control: { enabled: boolean };
  config: ServerSettings | null;
  durability: { mode: "memory" | "journal"; journal_format: string | null };
  contract: { repo: string; commit: string };
  process: { layout: ProcessLayout; boot_id: string; restart_count: number; started_at: string };
  journal: { head: string | null };
  faults: { armed: string[] };
  clock: { domain: "wall" | "fixture"; offset_ms: number };
  /**
   * Present only under `tiny-tracker all --supervise` (0.3.0; a top-level addition, allowed in build-descriptor/1).
   * `role` is the child this descriptor comes from; `children` gives both children's boot ids and restart counts.
   */
  supervision?: SupervisionJson;
  build_hash: string;
  descriptor_hash: string;
}

export interface SupervisionJson {
  supervisor_boot_id: string;
  role: ChildRole;
  children: Record<ChildRole, { boot_id: string | null; restart_count: number }>;
}

export class BuildDescriptor {
  readonly bootId = randomBytes(8).toString("hex");
  readonly startedAt: string;
  /** How often the supervisor restarted this process (0 when not supervised). */
  restartCount = 0;
  /** Where armed faults are read from. In memory by default; the supervised children share the supervisor's folder. */
  arming: ArmingStore;
  /** The journal head (stream D): a value, or a function read at every snapshot. */
  journalHead: string | null | (() => string | null) = null;
  private settings: ServerSettings | null = null;
  /** Set by the command line in a supervised child. */
  private supervised: ChildContext | null = null;

  constructor(private readonly input: DescriptorInput, readonly clock: Clock = wallClock) {
    this.startedAt = clock.wallNow().toISOString();
    this.arming = memoryArming(() => clock.wallNow());
  }

  /** What the fault controller (stream B) published: `<id> <point> <selector>` for each armed non-crash fault. */
  private published: string[] = [];

  /**
   * The armed faults, each `<id> <point> <selector>` (FX-BLD-1): the controller's, then the arming store's crash points
   * (`S-<n>`, armed at start by the supervisor or on the control listener; shared by both supervised children).
   */
  get armedFaults(): string[] {
    const stored = this.arming.list().map((f, i) => `S-${i + 1} ${f.point} ${JSON.stringify({ once: f.once })}`);
    return [...this.published, ...stored];
  }

  /** Set by the fault controller when its armed set changes. The arming store is not touched. */
  set armedFaults(entries: string[]) {
    this.published = [...entries];
  }

  /** The clock's offset (0 on the wall clock). */
  get clockOffsetMs(): number {
    return this.clock.offsetMs();
  }

  /**
   * The MCP-layer settings. Set by the command line once the MCP server has loaded them (before the state line is
   * printed). In the supervised backend child, which runs no MCP server, they are read from the MCP child's
   * settings.json until set.
   */
  get serverSettings(): ServerSettings | null {
    if (this.settings !== null) return this.settings;
    if (this.supervised?.role === "backend") return readJson<ServerSettings>(settingsPath(this.supervised.stateDir)) ?? null;
    return null;
  }

  set serverSettings(value: ServerSettings | null) {
    this.settings = value;
  }

  /** Marks this process as one child of `tiny-tracker all --supervise`. */
  supervise(child: ChildContext): void {
    this.supervised = child;
    this.restartCount = child.restartCount;
  }

  private supervision(): SupervisionJson | undefined {
    const c = this.supervised;
    if (!c) return undefined;
    const file = readChildren(c.stateDir);
    const info = (role: ChildRole): { boot_id: string | null; restart_count: number } => {
      if (role === c.role) return { boot_id: this.bootId, restart_count: this.restartCount };
      const other: ChildInfo | undefined = file?.children?.[role];
      return { boot_id: other?.boot_id ?? null, restart_count: other?.restart_count ?? 0 };
    };
    return { supervisor_boot_id: c.supervisorBootId, role: c.role, children: { backend: info("backend"), mcp: info("mcp") } };
  }

  /** The configuration part, hashed into build_hash. */
  private configuration() {
    const settings = this.serverSettings;
    const sorted = (v: readonly string[] | null) => (v === null ? null : [...v].sort());
    return {
      descriptor: DESCRIPTOR_VERSION as typeof DESCRIPTOR_VERSION,
      package: { name: "@mcp-write-safety/tiny-tracker", version: PACKAGE_VERSION },
      fixture_api: FIXTURE_API_VERSION as typeof FIXTURE_API_VERSION,
      profile: this.input.profile,
      features: [...this.input.features].sort(),
      defects: { mcp: sorted(this.input.mcpDefects), backend: sorted(this.input.backendDefects) },
      variants: sorted(this.input.variants),
      control: { enabled: this.input.control },
      config: settings === null ? null : {
        ...settings,
        tools: settings.tools === null ? null : [...settings.tools].sort(),
        deny_tools: settings.deny_tools === null ? null : [...settings.deny_tools].sort(),
      },
      durability: this.input.durability ? { ...this.input.durability } : { mode: "memory" as const, journal_format: null },
      contract: { repo: CONTRACT.repo, commit: CONTRACT.commit },
      layout: this.input.layout,
    };
  }

  get buildHash(): string {
    return domainDigest(DOMAINS.build, canonicalize(this.configuration()));
  }

  toJSON(): BuildDescriptorJson {
    const { layout, ...config } = this.configuration();
    const body = {
      ...config,
      process: { layout, boot_id: this.bootId, restart_count: this.restartCount, started_at: this.startedAt },
      journal: { head: typeof this.journalHead === "function" ? this.journalHead() : this.journalHead },
      faults: { armed: this.armedFaults },
      clock: { domain: this.clock.domain, offset_ms: this.clock.offsetMs() },
      ...(this.supervised ? { supervision: this.supervision() } : {}),
      build_hash: this.buildHash,
    };
    return { ...body, descriptor_hash: domainDigest(DOMAINS.buildDescriptor, canonicalize(body)) };
  }

  /** The sentence for the MCP instructions: the facts a client that reaches only the MCP port needs, in one JSON line. */
  instructions(): string {
    const d = this.toJSON();
    const banner = d.defects.backend && d.defects.backend.length > 0
      ? `TEACHING BACKEND WITH DELIBERATE DEFECTS (${d.defects.backend.map((n) => `backend:${n}`).join(", ")}). Do not use for real data. ` : "";
    const facts = {
      build_hash: d.build_hash, profile: d.profile, features: d.features, defects: d.defects, variants: d.variants,
      faults_armed: d.faults.armed, clock_offset_ms: d.clock.offset_ms, control: d.control.enabled,
    };
    return `${banner}Fixture build (${DESCRIPTOR_VERSION}; full descriptor at GET /build on the backend, evidence token): ${JSON.stringify(facts)}`;
  }

  /** The _meta member for every tool result. */
  meta(): Record<string, unknown> {
    const d = this.toJSON();
    return { [META_KEYS.build]: { build_hash: d.build_hash, descriptor_hash: d.descriptor_hash, boot_id: d.process.boot_id } };
  }
}
