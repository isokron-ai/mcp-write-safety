/**
 * The requirement registry: every MWS requirement ID the suite knows, with its level, area, test
 * methods and a one-line summary. This is the only place IDs are written out; checks, reports and
 * tests import them from here. IDs are permanent and never reused (a removed requirement keeps its
 * entry with status `removed`). The normative text lives in the spec (`spec/`); the summary here is
 * for reports only and is not normative.
 */

export const SPEC_VERSION = '0.9';
/** The text this release follows: spec/0.9-review at commit 15f71e5 (37 requirements, 26 MUST, 11 SHOULD; decision rows to R15-4). */
export const SPEC_TEXT = 'spec/0.9-review@15f71e5';
/** Requirements whose entry lists the verdict platform (spec 8.2, rule 2): their violated and platform records carry an attribution line (rule 3). */
export const PLATFORM_LISTED: readonly string[] = ['MWS-UPD-1', 'MWS-UPD-2', 'MWS-CONC-2', 'MWS-CONC-3', 'MWS-TGT-1', 'MWS-TGT-3', 'MWS-RES-1'];

/** Where a requirement's normative text is: the spec document in the MWS repository, at the requirement's heading. */
export const SPEC_DOC = 'spec/mws.md';
export const requirementLink = (id: string): string => `${SPEC_DOC}#${id.toLowerCase()}`;

export type Level = 'MUST' | 'SHOULD';
export type Method = 'black-box' | 'control' | 'gate' | 'launch' | 'review';
export type Status = 'draft' | 'active' | 'deprecated' | 'removed';

export interface Requirement {
  id: string;
  area: string;
  level: Level;
  status: Status;
  methods: Method[];
  summary: string;
}

const R = (id: string, level: Level, methods: Method[], summary: string): Requirement => ({ id, area: id.split('-')[1]!, level, status: 'draft', methods, summary });

export const REQUIREMENTS = [
  // Annex C of spec/0.9-review (aa53e2e): short forms (an index only; the requirement is the sentence in the spec) and methods,
  // with proxy-assisted as gate, review-only as review, black-box (launch) as launch, and control where the entry lists platform or a control arm.
  R('MWS-UPD-1', 'MUST', ['black-box', 'control'], 'A field patch changes only the named fields'),
  R('MWS-UPD-2', 'MUST', ['black-box', 'control'], 'A list edit, move or removal lands on the element the caller read at that address, or is refused'),
  R('MWS-CONC-1', 'MUST', ['black-box', 'gate', 'control'], 'Do not bypass the backend\'s concurrency control by default'),
  R('MWS-CONC-2', 'MUST', ['black-box', 'control'], 'Refuse a stale write where the backend can detect it'),
  R('MWS-CONC-3', 'MUST', ['black-box', 'gate', 'control'], 'Concurrent writes to different parts do not both succeed with one lost'),
  R('MWS-CONC-4', 'MUST', ['black-box', 'review'], 'A conflict is an error, is not applied and says so'),
  R('MWS-CONC-5', 'SHOULD', ['review'], 'The description discloses stale writes the backend cannot detect'),
  R('MWS-CONC-6', 'SHOULD', ['black-box', 'review'], 'A conflict tells the caller to read again before retrying, or carries the current state'),
  R('MWS-TGT-1', 'MUST', ['black-box', 'control'], 'Honor or reject a scope argument'),
  R('MWS-TGT-2', 'MUST', ['black-box'], 'An empty or match-all selector does not mean everything'),
  R('MWS-TGT-3', 'MUST', ['black-box', 'control'], 'A create does not overwrite'),
  R('MWS-RES-1', 'MUST', ['black-box', 'control'], 'Success only when the state asked for is in effect'),
  R('MWS-RES-2', 'MUST', ['black-box', 'gate'], 'A failed write is not a success, says what remains applied, and is a tool execution error where the backend or a rule refused it'),
  R('MWS-RES-3', 'MUST', ['black-box', 'gate'], 'A create returns its identifier, even on later failure'),
  R('MWS-RES-4', 'SHOULD', ['black-box'], 'A write returns a receipt'),
  R('MWS-ATOM-1', 'MUST', ['black-box', 'gate'], 'A partial outcome is not success, and names what was applied'),
  R('MWS-ATOM-2', 'SHOULD', ['black-box', 'gate'], 'Multi-object writes are all-or-nothing'),
  R('MWS-RETRY-1', 'SHOULD', ['black-box'], 'A non-idempotent create accepts an idempotency key'),
  R('MWS-RETRY-2', 'MUST', ['black-box', 'gate', 'launch'], 'An idempotency key is honored: applied at most once and answered with the first outcome where the server can establish it, new key new write, changed arguments refused'),
  R('MWS-RETRY-3', 'MUST', ['black-box', 'gate'], 'The write asked for is not in effect before an `input_required` result'),
  R('MWS-IN-1', 'MUST', ['black-box'], 'No coercion that changes the meaning of a value'),
  R('MWS-IN-2', 'MUST', ['black-box'], 'Arguments the schema does not define are not dropped silently'),
  R('MWS-IN-3', 'MUST', ['black-box'], 'A call that breaks a declared constraint is rejected'),
  R('MWS-IN-4', 'MUST', ['black-box', 'review'], 'A validation failure is an error naming the argument and reason'),
  R('MWS-IN-5', 'SHOULD', ['black-box'], 'The schema declares the fixed single-argument constraints that are enforced'),
  R('MWS-IN-6', 'SHOULD', ['black-box'], 'Wrong types are rejected, not converted or dropped'),
  R('MWS-IN-7', 'SHOULD', ['black-box'], 'Arguments the schema does not define are rejected'),
  R('MWS-CFG-1', 'MUST', ['launch'], 'An unrecognized safety setting never leaves writes enabled'),
  R('MWS-CFG-2', 'MUST', ['launch'], 'An unknown tool name in a deny-list stops the server or disables its writes'),
  R('MWS-CFG-3', 'MUST', ['launch'], 'Read-only mode refuses every write tool'),
  R('MWS-CFG-4', 'SHOULD', ['launch'], 'An unknown tool name in an allow-list stops the server'),
  R('MWS-ANN-1', 'MUST', ['black-box'], '`readOnlyHint: true` means no state change'),
  R('MWS-ANN-2', 'MUST', ['black-box'], '`destructiveHint: false` means no deletion and no change to data the caller did not name'),
  R('MWS-ANN-3', 'MUST', ['black-box'], '`idempotentHint: true` means no further effect on repeat'),
  R('MWS-ANN-4', 'SHOULD', ['black-box'], '`readOnlyHint` and `destructiveHint` are declared explicitly'),
  R('MWS-ANN-5', 'SHOULD', ['black-box'], '`destructiveHint: false` means additive only (at risk)'),
  R('MWS-SEC-1', 'MUST', ['black-box'], 'No credentials in tool results, other than one the tool exists to issue'),
] as const satisfies readonly Requirement[];

export type RequirementId = (typeof REQUIREMENTS)[number]['id'];

const BY_ID = new Map<string, Requirement>(REQUIREMENTS.map((r) => [r.id, r]));

export function requirement(id: string): Requirement {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`unknown requirement id ${id}`);
  return r;
}

export const isRequirementId = (id: string): id is RequirementId => BY_ID.has(id);

/** Annex A (informative): measured and printed, never judged. Not requirements; no verdict. */
export const ANNEX_A = {
  'A-1': 'round trips per declared job',
  'A-2': 'catalog size',
  'A-3': 'result size',
  'A-4': 'catalog hygiene',
} as const;

/**
 * What this preview executes for each requirement (spec section 1: the tool is a preview covering a stated
 * subset). `partial`: the part not built is reported `not tested` with the reason. The README's coverage table
 * is checked against this list by a unit test.
 */
export const COVERAGE: Record<string, { check: 'yes' | 'partial' | 'no'; not_built: string }> = {
  'MWS-UPD-1': { check: 'yes', not_built: '' },
  'MWS-UPD-2': { check: 'partial', not_built: 'the control arm (insertion, removal and reordering are all forced)' },
  'MWS-CONC-1': { check: 'partial', not_built: 'a control that is not a version precondition, such as a lock held by another user (the lock branch, with its unengaged baseline and the rule that a refusal must show the control, R10-10); a client that declares the elicitation capability and declines a confirmation (spec 7.3, rule 10): the tester declares none, so no confirmation is asked' },
  'MWS-CONC-2': { check: 'partial', not_built: 'tools other than the update, delete and `versioned` tools' },
  'MWS-CONC-3': { check: 'yes', not_built: '' },
  'MWS-CONC-4': { check: 'yes', not_built: '' },
  'MWS-CONC-5': { check: 'yes', not_built: '' },
  'MWS-CONC-6': { check: 'yes', not_built: '' },
  'MWS-TGT-1': { check: 'partial', not_built: 'update and delete tools that take a scope argument (an object of the same name in each scope), except the selector tool, which is tested only with `selector.narrow` and `selector.send_empty_forms`' },
  'MWS-TGT-2': { check: 'partial', not_built: 'a client that declares the elicitation capability and declines a confirmation (spec 7.3, rule 10). The forms are destructive by design and run only with `selector.send_empty_forms: true`, on a backend where every object is disposable' },
  'MWS-TGT-3': { check: 'partial', not_built: 'a client that declares the elicitation capability and declines a confirmation (spec 7.3, rule 10)' },
  'MWS-RES-1': { check: 'partial', not_built: 'a write tool with no declared effect (`effects`, an `input_required` effect, or a `multi` block) other than the update and delete tools; the control arm for those effects (`platform`)' },
  'MWS-RES-2': { check: 'partial', not_built: 'write tools other than the update tool and the declared failures; judging an `input_required` result after the retry, or a task on what the terminal task carries; the settled-outcome runs of provoked failures through the interposer (the run without a fault and the lost-answer trial are built); the follow-through for an error that names the version (R10-11)' },
  'MWS-RES-3': { check: 'yes', not_built: '' },
  'MWS-RES-4': { check: 'yes', not_built: '' },
  'MWS-ATOM-1': { check: 'partial', not_built: 'a multi-item delete that takes the scope argument, unless it is the selector tool and its MWS-TGT-1 is held in the run (spec 7.3, rule 1); a multi-item delete with no container of the tester\'s own. A multi-item bulk update is called in the tester\'s container without an MWS-TGT-1 of its own' },
  'MWS-ATOM-2': { check: 'partial', not_built: 'as MWS-ATOM-1' },
  'MWS-RETRY-1': { check: 'yes', not_built: '' },
  'MWS-RETRY-2': { check: 'partial', not_built: 'an append (`idempotency.kind: append`); judging a task or `input_required` answer on its final result; seeing at the interposer that the server undid an update after the cut (the delete of a created object is seen)' },
  'MWS-RETRY-3': { check: 'partial', not_built: 'deciding whether a backend write before the result was staged state the retry completes' },
  'MWS-IN-1': { check: 'partial', not_built: 'tools other than the read and update tools' },
  'MWS-IN-2': { check: 'partial', not_built: 'tools other than the read and update tools; nested levels; a notice the default "not used" pattern cannot decide is `not tested` (declare `patterns.not_used`)' },
  'MWS-IN-3': { check: 'partial', not_built: 'tools other than the read and update tools; nested levels' },
  'MWS-IN-4': { check: 'partial', not_built: 'tools other than the read and update tools' },
  'MWS-IN-5': { check: 'partial', not_built: 'the run-wide search of every refused call (only the declared `try_values` are searched); `violated` needs a declared fixed constraint (`fixed_constraints`, R10-8), otherwise refusals are listed, seen, not judged' },
  'MWS-IN-6': { check: 'partial', not_built: 'tools other than the read and update tools' },
  'MWS-IN-7': { check: 'partial', not_built: 'tools other than the read and update tools; nested levels' },
  'MWS-CFG-1': { check: 'partial', not_built: 'settings applied with a request (sent with `tools/list` and a call to each write tool)' },
  'MWS-CFG-2': { check: 'partial', not_built: 'settings applied with a request (sent with `tools/list` and a call to each write tool); a declared tool that exists and is switched off' },
  'MWS-CFG-3': { check: 'partial', not_built: 'settings applied with a request (sent with each call)' },
  'MWS-CFG-4': { check: 'partial', not_built: 'settings applied with a request (sent with `tools/list`)' },
  'MWS-ANN-1': { check: 'yes', not_built: '' },
  'MWS-ANN-2': { check: 'yes', not_built: '' },
  'MWS-ANN-3': { check: 'yes', not_built: '' },
  'MWS-ANN-4': { check: 'yes', not_built: '' },
  'MWS-ANN-5': { check: 'yes', not_built: '' },
  'MWS-SEC-1': { check: 'yes', not_built: '' },
};

/** One sentence for stdout and the report: the tool is a preview, and what it covers. */
export function previewSentence(): string {
  const all = REQUIREMENTS.length;
  const yes = REQUIREMENTS.filter((r) => COVERAGE[r.id]?.check === 'yes').length;
  const part = REQUIREMENTS.filter((r) => COVERAGE[r.id]?.check === 'partial').length;
  const no = all - yes - part;
  return `mcp-writecheck is a preview: of the ${all} requirements of MWS ${SPEC_VERSION} it executes the test of ${yes} in full and of ${part} in part${no ? `, and of ${no} not at all` : ''}; what is not built is reported "not tested" with the reason (README: Coverage in this preview).`;
}
