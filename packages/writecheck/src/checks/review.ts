/**
 * Review-only clauses (spec 7.1, 8.2 rule 11). A person reads the captured evidence and answers a
 * stated question; the record is `self-attested` and carries the answer, who gave it and how. Two
 * ways to answer, both written down by the person who runs the tests:
 *
 *   a rule in the review block   e.g. "a conflict says the write was not applied when its text
 *                                matches /Nothing was written/": applied to every captured text
 *   an answer by question id     review.answers.<id>: true | false (`mcp-writecheck review` lists ids)
 *
 * With neither, the clause is `not tested`, with the question and where to answer it. A
 * self-attested answer is never turned into `violated` or `held`: it is the person's statement.
 */

import type { RequirementId } from '../requirements.js';
import { result, type Result, type WritePath } from '../report/verdicts.js';
import type { PlanContext } from './types.js';

export interface Question {
  /** Stable id: requirement, write path and clause (what the answers block is keyed by). */
  id: string;
  requirement: RequirementId;
  write_path: WritePath;
  question: string;
  /** What the person looks at: captured texts (short) and the steps they came from. */
  evidence: { step: string | null; text: string }[];
}

export const questionId = (req: RequirementId, w: WritePath, clause: string): string => `${req}:${w.resource}:${w.tool}:${clause}`;

/** The answer from a rule (every evidence text must match the pattern for "yes") or from an explicit answer. */
export function answerOf(ctx: PlanContext, q: Question, rule: string | null): { answer: boolean; by: string; how: string } | null {
  const rv = ctx.review;
  if (!rv) return null;
  const explicit = rv.answers[q.id];
  if (explicit) return { answer: explicit.answer, by: rv.by, how: `answered for question ${q.id}${explicit.note ? ` (${explicit.note})` : ''}` };
  if (rule !== null && q.evidence.length) {
    const re = new RegExp(rule, 'i');
    const miss = q.evidence.filter((e) => !re.test(e.text));
    return { answer: miss.length === 0, by: rv.by, how: `by the declared rule /${rule}/i over ${q.evidence.length} captured text(s)${miss.length ? `; ${miss.length} did not match` : ''}` };
  }
  return null;
}

export function reviewResult(scenario: { id: string; version: string }, q: Question, a: { answer: boolean; by: string; how: string } | null): Result {
  // why: the review-only clause is its own record (spec 8.1: one record per method), so it gets its own scenario id.
  const sc = { id: `${scenario.id}.review`, version: scenario.version };
  const steps = q.evidence.map((e) => e.step).filter((s): s is string => !!s).slice(0, 10);
  if (!a) return result(q.requirement, q.write_path, sc, 'not tested', `review-only clause, not answered: ${q.question} Answer it in the manifest's review block (question id ${q.id}); \`mcp-writecheck review <results folder>\` lists the questions with the captured evidence.`, { steps, notes: q.evidence.slice(0, 3).map((e) => `evidence: ${JSON.stringify(e.text.slice(0, 200))}`) });
  return result(q.requirement, q.write_path, sc, 'self-attested', `${q.question} Answer: ${a.answer ? 'yes' : 'no'} — the statement of ${a.by}, ${a.how}.`, { numbers: { answer: a.answer }, steps, notes: [`question id ${q.id}`, ...q.evidence.slice(0, 3).map((e) => `evidence: ${JSON.stringify(e.text.slice(0, 200))}`)] });
}
