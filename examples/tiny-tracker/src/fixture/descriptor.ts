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

import { randomBytes } from "node:crypto";
import { canonicalize, domainDigest, DOMAINS } from "../digest.js";
import { CONTRACT, META_KEYS } from "../fixture-properties.js";
import { wallClock, type Clock } from "../clock.js";
import { PACKAGE_VERSION, type ProfileName } from "../profile.js";
import type { ProcessLayout } from "../compat.js";

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
  build_hash: string;
  descriptor_hash: string;
}

export class BuildDescriptor {
  readonly bootId = randomBytes(8).toString("hex");
  readonly startedAt: string;
  restartCount = 0;
  armedFaults: string[] = [];
  clockOffsetMs = 0;
  journalHead: string | null = null;
  /** Set by the command line once the MCP server has loaded its settings (before the state line is printed). */
  serverSettings: ServerSettings | null = null;

  constructor(private readonly input: DescriptorInput, readonly clock: Clock = wallClock) {
    this.startedAt = clock.wallNow().toISOString();
  }

  /** The configuration part, hashed into build_hash. */
  private configuration() {
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
      config: this.serverSettings === null ? null : {
        ...this.serverSettings,
        tools: this.serverSettings.tools === null ? null : [...this.serverSettings.tools].sort(),
        deny_tools: this.serverSettings.deny_tools === null ? null : [...this.serverSettings.deny_tools].sort(),
      },
      durability: { mode: "memory" as const, journal_format: null },
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
      journal: { head: this.journalHead },
      faults: { armed: [...this.armedFaults] },
      clock: { domain: this.clockOffsetMs === 0 ? "wall" as const : "fixture" as const, offset_ms: this.clockOffsetMs },
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
