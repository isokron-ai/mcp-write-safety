/**
 * What a conforming test must not flag (the non-findings). A check that sets a candidate aside
 * names the rule in the result's notes, with the evidence, so the set-aside is visible and testable;
 * nothing is dropped silently.
 */

export const RULES = {
  RAW_API_CONTROL: 'When the platform\'s own API shows the same behaviour, it is the backend (`platform`), not the server.',
  CONSERVATIVE_ANNOTATION: 'An over-cautious annotation is never a violation: readOnlyHint false or unset on a tool that only read, destructiveHint true or unset on a tool that never removed anything, idempotentHint false or unset.',
  STATUS_IN_RESULT: 'An HTTP status inside a successful result can be the tool\'s documented contract; such a case is set aside, not judged.',
  PLATFORM_PASSTHROUGH: 'Platform behaviour passed through unchanged is not a server finding.',
  EMPTY_NOOP_CONTROL: 'An empty value the platform\'s API also ignores is not the server\'s silent no-op.',
  PRESERVED_BY_DESIGN: 'A field a write left out that keeps its value is not a defect.',
  VERSION_REQUIRED: 'A write refused for a missing or stale version is the contract working.',
  NOT_REPRODUCED: 'A claimed change that does not occur on re-read is not reproduced, not a finding.',
  SETTLE_WINDOW: 'A change that appears within the declared settle window is read as applied (eventual consistency is not a lost write).',
} as const;
export type RuleId = keyof typeof RULES;

export const ruleNote = (id: RuleId, detail: string): string => `set aside (${id}): ${detail} — ${RULES[id]}`;
