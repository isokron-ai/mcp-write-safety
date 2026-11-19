/** The checks, in the order a run takes them for each resource, and the server-wide checks that run once at the end. */

import { annotationsCheck } from './annotations.js';
import { createsCheck } from './creates.js';
import { gatedCheck } from './gated.js';
import { idempotencyCheck } from './idempotency.js';
import { in5SearchCheck } from './in5search.js';
import { inputRequiredCheck } from './inputrequired.js';
import { launchCheck } from './launch.js';
import { listEditCheck } from './listedit.js';
import { multiCheck } from './multi.js';
import { pairsCheck } from './pairs.js';
import { readbackCheck } from './readback.js';
import { schemaCheck } from './schema.js';
import { secretsCheck } from './secrets.js';
import { staleCheck } from './stale.js';
import { targetingCheck } from './targeting.js';
import type { CheckModule, GlobalCheck } from './types.js';
import { writeFaultsCheck } from './writefaults.js';

export const CHECKS: CheckModule[] = [readbackCheck, staleCheck, pairsCheck, gatedCheck, schemaCheck, annotationsCheck, idempotencyCheck, targetingCheck, multiCheck, listEditCheck, createsCheck, inputRequiredCheck, writeFaultsCheck, in5SearchCheck];

/** Launch settings restart the server and the credential scan reads everything before it: both run last. */
export const GLOBAL_CHECKS: GlobalCheck[] = [launchCheck, secretsCheck];

export const checkById = (id: string): CheckModule | GlobalCheck | undefined => CHECKS.find((c) => c.id === id) ?? GLOBAL_CHECKS.find((c) => c.id === id);
