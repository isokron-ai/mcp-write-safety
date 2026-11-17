// The fixture layer (review S5). Everything here exists for harnesses that
// test other software against tiny-tracker: the evidence namespace, the
// control listener, fixture tokens, the build descriptor and run ids. The
// teaching server never imports this folder: the command line loads it with a
// dynamic import() only when a fixture feature or --fixture-control is named,
// and test/import-graph.test.ts proves that profile 0.1 and a build with no
// fixture feature never load any module from it.

import type { BackendExtension, BackendFaultHooks } from "../backend/http.js";
import type { CommitSink } from "../backend/commit.js";
import type { ServerExtras } from "../mcp/server.js";
import { BuildDescriptor, type DescriptorInput } from "./descriptor.js";
import { evidenceExtension } from "./evidence.js";
import { RunRegistry, startControl, type AttachedBackend, type RunningControl } from "./control.js";
import { Ledger } from "./ledger.js";
import { FaultController } from "./faults.js";
import { checkArgv, checkDistinct, loadToken } from "./tokens.js";
import { wallClock, type Clock } from "../clock.js";
import type { Principal } from "../principals.js";

export { BuildDescriptor } from "./descriptor.js";
export { TokenError } from "./tokens.js";
export { Ledger } from "./ledger.js";
export { FaultController } from "./faults.js";
export type { AttachedBackend } from "./control.js";

export interface FixtureOptions extends DescriptorInput {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  /** The backend token, when this process holds it: every token must differ from it. */
  backendToken?: string;
  /** The token folder (--token-dir): tokens the environment does not give are generated there. */
  tokenDir?: string;
  /**
   * The configured principals (TRACKER_BACKEND_TOKENS_FILE; stream A wires it). Their tokens join the distinctness and
   * argv checks in place of `backendToken`, and the control listener allocates runs only for their ids.
   * Default: one, p-default, holding `backendToken`.
   */
  principals?: Principal[];
  clock?: Clock;
}

export interface FixtureLayer {
  descriptor: BuildDescriptor;
  /** For startBackend: the evidence routes (when the evidence feature is on and this process runs the backend). */
  backendExtension?: BackendExtension;
  /** For startServer: attribution and the descriptor mirror (when the evidence feature is on). */
  serverExtras: ServerExtras;
  /** Starts the control listener (only with --fixture-control). */
  startControl(port: number): Promise<RunningControl>;
  /**
   * For startBackend: which principal a run belongs to (the backend refuses another principal's run tag, and a tag
   * never allocated). Give it to the backend only when the control listener allocates runs (--fixture-control).
   */
  runOwner(run: string): string | undefined;
  /** The run registry (the 0.3.0 journal sets `onAllocate` and calls `restore` at load). */
  runs: RunRegistry;
  /**
   * For startBackend: the ledger as a commit sink (role ledger, step 4 of the frozen commit path) and the backend fault
   * hooks. Empty when neither feature is on.
   */
  backendOptions: { sinks?: CommitSink[]; faults?: BackendFaultHooks };
  /** The execution ledger (feature ledger). */
  ledger?: Ledger;
  /** The fault controller (feature faults). */
  faults?: FaultController;
  /**
   * Hands the started backend to the fixture layer, for the run reset (RunningBackend.dropRun) and the record routes
   * (stream A's EvidenceReader). Call it once, right after the backend starts.
   */
  attachBackend(backend: AttachedBackend): void;
  /** Sends every held answer and fires no more faults (shutdown). */
  close(): void;
}

/** Loads tokens and builds the descriptor. Throws TokenError (start nothing) when a token is missing, unsafe or shared. */
export function createFixtureLayer(options: FixtureOptions): FixtureLayer {
  const evidence = options.features.includes("evidence");
  const evidenceToken = evidence ? loadToken("evidence", options.env, process.platform, options.tokenDir) : undefined;
  const controlToken = options.control ? loadToken("control", options.env, process.platform, options.tokenDir) : undefined;
  const backendTokens: Record<string, string | undefined> = options.principals
    ? Object.fromEntries(options.principals.map((p) => [`principal ${p.id}`, p.token]))
    : { backend: options.backendToken };
  checkDistinct({ ...backendTokens, evidence: evidenceToken, control: controlToken });
  checkArgv(options.argv, { ...backendTokens, evidence: evidenceToken, control: controlToken });
  const principalIds = options.principals?.map((p) => p.id) ?? ["p-default"];
  const clock = options.clock ?? wallClock;
  const descriptor = new BuildDescriptor(options, clock);
  const runs = new RunRegistry(descriptor.bootId, clock);
  // The compatibility table (CMP-30 to CMP-33) keeps these to `tiny-tracker all` with evidence and strict-input.
  const ledger = options.features.includes("ledger") && options.layout !== "server" ? new Ledger(descriptor.bootId, clock) : undefined;
  const faults = options.features.includes("faults") && ledger ? new FaultController(ledger, descriptor, clock, undefined, options.features) : undefined;
  let attached: AttachedBackend | undefined;
  return {
    descriptor,
    ledger,
    faults,
    backendExtension: evidenceToken && options.layout !== "server"
      ? evidenceExtension(evidenceToken, descriptor, { ledger, records: () => attached?.evidence, principals: principalIds }) : undefined,
    serverExtras: evidence && options.layout !== "backend"
      ? { attribution: true, mirror: descriptor, ...(faults ? { onResult: faults.onResult } : {}) } : {},
    startControl: (port) => {
      if (!controlToken) throw new Error("the control listener needs --fixture-control");
      return startControl({ token: controlToken, port, descriptor, runs, principals: principalIds, ledger, faults, backend: () => attached });
    },
    runOwner: (run) => runs.owner(run),
    runs,
    backendOptions: { ...(ledger ? { sinks: [ledger] } : {}), ...(faults ? { faults: faults.backendHooks } : {}) },
    attachBackend(backend) {
      if (attached) throw new Error("the backend is already attached");
      attached = backend;
    },
    close() {
      faults?.close();
    },
  };
}
