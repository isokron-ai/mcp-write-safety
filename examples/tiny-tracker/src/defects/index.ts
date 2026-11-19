// The defect registry. Each defect is one file in this folder; see the README
// for the table of flags, requirements and expected results.

import { REQUIREMENTS, type RequirementId } from "../requirements.js";
import type { Defect } from "./types.js";
import { defect as updateAddsDefaults } from "./update-adds-defaults.js";
import { defect as labelByPosition } from "./label-by-position.js";
import { defect as forceByDefault } from "./force-by-default.js";
import { defect as deleteRefetchesVersion } from "./delete-refetches-version.js";
import { defect as readMergePut } from "./read-merge-put.js";
import { defect as conflictAsGenericError } from "./conflict-as-generic-error.js";
import { defect as ignoreProjectScope } from "./ignore-project-scope.js";
import { defect as emptyFilterDeletesAll } from "./empty-filter-deletes-all.js";
import { defect as createOverwrites } from "./create-overwrites.js";
import { defect as skipNullAssignee } from "./skip-null-assignee.js";
import { defect as errorAsText } from "./error-as-text.js";
import { defect as commentIdDropped } from "./comment-id-dropped.js";
import { defect as receiptMissingVersion } from "./receipt-missing-version.js";
import { defect as bulkMisreportsPartial } from "./bulk-misreports-partial.js";
import { defect as bulkWithoutTransaction } from "./bulk-without-transaction.js";
import { defect as noIdempotencyKey } from "./no-idempotency-key.js";
import { defect as idempotencyKeyDropped } from "./idempotency-key-dropped.js";
import { defect as idempotencyKeyIgnoresArgs } from "./idempotency-key-ignores-args.js";
import { defect as retryWithoutKey } from "./retry-without-key.js";
import { defect as keyStoreInMemory } from "./key-store-in-memory.js";
import { defect as coerceTypes } from "./coerce-types.js";
import { defect as dropUnknownArgs } from "./drop-unknown-args.js";
import { defect as skipLimits } from "./skip-limits.js";
import { defect as vagueValidationError } from "./vague-validation-error.js";
import { defect as readOnlyStrictTrue } from "./read-only-strict-true.js";
import { defect as unknownToolsIgnored } from "./unknown-tools-ignored.js";
import { defect as readOnlyByAnnotation } from "./read-only-by-annotation.js";
import { defect as commentMarkedReadOnly } from "./comment-marked-read-only.js";
import { defect as setLabelsNonDestructive } from "./set-labels-non-destructive.js";
import { defect as createMarkedIdempotent } from "./create-marked-idempotent.js";
import { defect as missingAnnotations } from "./missing-annotations.js";
import { defect as tokenInError } from "./token-in-error.js";
import { defect as conflictWithoutIsError } from "./conflict-without-iserror.js";
import { defect as staleUnannounced } from "./stale-unannounced.js";
import { defect as closeBeforeConfirm } from "./close-before-confirm.js";
import { defect as undeclaredTitleLimit } from "./undeclared-title-limit.js";
import { defect as convertNumericStrings } from "./convert-numeric-strings.js";
import { defect as unknownDeniedToolsIgnored } from "./unknown-denied-tools-ignored.js";
import { defect as addLabelReplacesList } from "./add-label-replaces-list.js";
import { defect as ignoreUnknownArgsWithNotice } from "./ignore-unknown-args-with-notice.js";
import { defect as shapeClaimsApplied } from "./shape-claims-applied.js";
import { defect as shapeUnknownAsFailed } from "./shape-unknown-as-failed.js";
import { defect as shapeTextSaysFailed } from "./shape-text-says-failed.js";
import { defect as shapeTextInvitesRetry } from "./shape-text-invites-retry.js";
import { defect as shapeWrongVersion } from "./shape-wrong-version.js";
import { defect as shapeMissingFailed } from "./shape-missing-failed.js";
import { defect as shapeTextSaysAllSaved } from "./shape-text-says-all-saved.js";
import { defect as lookupReexecutes } from "./lookup-reexecutes.js";
// ---- stream D: defects that need the inflight feature ----
import { defect as inProgressReportedNotApplied } from "./in-progress-reported-not-applied.js";
import { defect as settleMissReportedNotApplied } from "./settle-miss-reported-not-applied.js";
// ---- end stream D ----

export type { Defect } from "./types.js";

/** Every MCP-layer defect, in requirement order. */
export const DEFECTS: Defect[] = [
  updateAddsDefaults,
  labelByPosition,
  forceByDefault,
  deleteRefetchesVersion,
  readMergePut,
  conflictWithoutIsError,
  staleUnannounced,
  conflictAsGenericError,
  ignoreProjectScope,
  emptyFilterDeletesAll,
  createOverwrites,
  skipNullAssignee,
  shapeClaimsApplied,
  errorAsText,
  shapeUnknownAsFailed,
  shapeTextSaysFailed,
  shapeTextInvitesRetry,
  commentIdDropped,
  receiptMissingVersion,
  shapeWrongVersion,
  shapeMissingFailed,
  shapeTextSaysAllSaved,
  bulkMisreportsPartial,
  bulkWithoutTransaction,
  noIdempotencyKey,
  idempotencyKeyDropped,
  idempotencyKeyIgnoresArgs,
  retryWithoutKey,
  keyStoreInMemory,
  closeBeforeConfirm,
  coerceTypes,
  dropUnknownArgs,
  skipLimits,
  vagueValidationError,
  undeclaredTitleLimit,
  convertNumericStrings,
  ignoreUnknownArgsWithNotice,
  readOnlyStrictTrue,
  unknownDeniedToolsIgnored,
  readOnlyByAnnotation,
  unknownToolsIgnored,
  commentMarkedReadOnly,
  addLabelReplacesList,
  createMarkedIdempotent,
  missingAnnotations,
  setLabelsNonDestructive,
  tokenInError,
  lookupReexecutes,
  // ---- stream D (requires inflight) ----
  inProgressReportedNotApplied,
  settleMissReportedNotApplied,
];

/** The defects that need no feature: the 0.1 set (47), the whole of `--defect all` under profile 0.1. */
export function ungatedDefects(): Defect[] {
  return DEFECTS.filter((d) => !(d.requires ?? []).length);
}

/** True when every feature the defect needs is active. */
export function defectAvailable(d: Defect, features: readonly string[]): boolean {
  return (d.requires ?? []).every((f) => features.includes(f));
}

/**
 * Resolves --defect values: a defect name, a requirement ID (all defects for
 * it), or "all". Unknown names are an error (fail closed, as MWS-CFG-2 asks).
 * "all" and a requirement ID mean every such defect valid for the active
 * features; a defect named on its own whose features are not active is an
 * error, never silently skipped.
 */
export function resolveDefects(names: string[], features: readonly string[] = []): Defect[] {
  const out: Defect[] = [];
  for (const name of names) {
    let found: Defect[];
    if (name === "all") found = DEFECTS.filter((d) => defectAvailable(d, features));
    else if (name in REQUIREMENTS) found = DEFECTS.filter((d) => d.requirement === (name as RequirementId) && defectAvailable(d, features));
    else {
      found = DEFECTS.filter((d) => d.name === name);
      const missing = found.flatMap((d) => (d.requires ?? []).filter((f) => !features.includes(f)));
      if (missing.length > 0) throw new Error(`defect "${name}" needs the feature(s) ${missing.join(", ")}; name them with --features`);
    }
    if (found.length === 0) {
      throw new Error(`unknown defect "${name}"; use a name from the README's defect table, a requirement ID, or "all"`);
    }
    for (const d of found) if (!out.includes(d)) out.push(d);
  }
  return out;
}
