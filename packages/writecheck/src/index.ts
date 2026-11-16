/** Library entry: the pieces a wrapper (the GitHub Action, a test harness) may want. */
export { REQUIREMENTS, SPEC_VERSION, requirement, type RequirementId } from './requirements.js';
export { SUITE_NAME, SUITE_VERSION } from './version.js';
export { VERDICTS, type Verdict, type Result } from './report/verdicts.js';
export { loadManifest, parseManifestText, type Manifest } from './core/manifest.js';
export { buildPlan, planHash } from './core/plan.js';
export { runCommand } from './cli/run.js';
export { planCommand, cleanupCommand, recheckCommand } from './cli/commands.js';
export { draftManifest } from './cli/init.js';
export type { Gate } from './gate/gate.js';
