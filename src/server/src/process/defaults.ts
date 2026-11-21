import { z } from 'zod';
import { STATES, canTransition, type State } from '../domain/request.js';
import type { MasterConfig } from '../master/types.js';
import {
  SEGMENT_IDS,
  SEGMENT_STATES,
  type ProcessConfig,
  type SegmentConfig,
  type SegmentId,
} from './definition.js';

export const READY_FOR_IMPLEMENTATION = 'READY FOR IMPLEMENTATION';
export const READY_FOR_REVIEW = 'READY FOR REVIEW';
export const READY_TO_FINALIZE = 'READY TO FINALIZE';
export const READY_TO_INDEX = 'READY TO INDEX';
export const DEFAULT_FOLLOW_UP_MARKER = 'FOLLOW-UP:';

const PLAN_PROMPT = [
  'Continue grooming this ticket.',
  'Update the title, body, acceptance criteria, or context with `update_request` when the',
  'human gives you something that belongs there. Ask one question at a time.',
  'When the ticket is fully planned, finish your reply with the exact line:',
  READY_FOR_IMPLEMENTATION,
].join('\n');

const REVIEW_PROMPT = [
  'Review this implementation request against its acceptance criteria.',
  `If it is ready to finalize, finish with the exact line: ${READY_TO_FINALIZE}`,
  `If it needs more implementation, finish with the exact line: ${READY_FOR_IMPLEMENTATION}`,
  'Explain what you checked. Do not push or open a change request.',
].join('\n');

const FINALIZE_PROMPT = [
  'Prepare the final digest for this request.',
  'Summarize the decision, the change, and anything future work should know.',
  'Finish with the exact line:',
  READY_TO_INDEX,
  'Do not close the request; a human approves indexing into the knowledge base.',
].join('\n');

export const DEFAULT_SEGMENT_PROMPTS: Record<SegmentId, string> = {
  intake: '',
  plan: PLAN_PROMPT,
  implement: '',
  review: REVIEW_PROMPT,
  finalize: FINALIZE_PROMPT,
};

const followUpSchema = z.object({
  enabled: z.boolean(),
  marker: z.string().min(1).max(80),
});

export const segmentSchema = z.object({
  id: z.enum(SEGMENT_IDS),
  label: z.string().min(1).max(80),
  purpose: z.string().min(1).max(2000),
  enabled: z.boolean(),
  idleMinutes: z.number().int().min(1).max(24 * 60),
  maxPerCycle: z.number().int().min(1).max(50),
  prompt: z.string().max(8000),
  readyMarker: z.string().min(1).max(200).nullable(),
  advanceTo: z.enum(STATES).nullable(),
  followUps: followUpSchema,
});

const processShape = z.object({
  version: z.literal(1),
  segments: z.array(segmentSchema),
});

/**
 * Validate the full document: every segment appears once, and an advancement is a
 * legal state transition with a marker that triggers it.
 */
export const processSchema: z.ZodType<ProcessConfig> = processShape.superRefine((value, ctx) => {
  const seen = new Set<SegmentId>();
  for (const [index, segment] of value.segments.entries()) {
    if (seen.has(segment.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'id'],
        message: `duplicate segment ${segment.id}`,
      });
    }
    seen.add(segment.id);

    const from = SEGMENT_STATES[segment.id];
    if (segment.advanceTo !== null && !canTransition(from, segment.advanceTo)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'advanceTo'],
        message: `cannot advance from ${from} to ${segment.advanceTo}`,
      });
    }
    if (segment.advanceTo !== null && segment.readyMarker === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'readyMarker'],
        message: 'an advancement requires a ready marker',
      });
    }
    if ((segment.id === 'intake' || segment.id === 'finalize') && segment.advanceTo !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments', index, 'advanceTo'],
        message:
          segment.id === 'finalize'
            ? 'finalize is closed by the human index action'
            : 'intake moves to plan by starting clarification',
      });
    }
  }

  for (const id of SEGMENT_IDS) {
    if (!seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: `missing segment ${id}`,
      });
    }
  }
});

export const processPatchSchema = z.object({ segments: z.array(segmentSchema) });

/** Conservative defaults: only the existing implement prod/review loop is on. */
export function defaultProcess(master: MasterConfig): ProcessConfig {
  const segment = (
    id: SegmentId,
    label: string,
    purpose: string,
    options: Partial<SegmentConfig> = {},
  ): SegmentConfig => ({
    id,
    label,
    purpose,
    enabled: false,
    idleMinutes: master.idleMinutes,
    maxPerCycle: 5,
    prompt: DEFAULT_SEGMENT_PROMPTS[id],
    readyMarker: null,
    advanceTo: null,
    followUps: { enabled: false, marker: DEFAULT_FOLLOW_UP_MARKER },
    ...options,
  });

  return {
    version: 1,
    segments: [
      segment('intake', 'Requests', 'Capture a raw request before planning starts.'),
      segment(
        'plan',
        'Plan',
        'Groom the request into a buildable plan with acceptance criteria.',
        { readyMarker: READY_FOR_IMPLEMENTATION, advanceTo: 'dispatch' },
      ),
      segment(
        'implement',
        'Implement',
        'Build the change in a worktree and report when it is ready for review.',
        {
          enabled: true,
          maxPerCycle: 10,
          prompt: master.prompt,
          ...(master.autoReview
            ? { readyMarker: READY_FOR_REVIEW, advanceTo: 'review' as State }
            : {}),
        },
      ),
      segment(
        'review',
        'Review',
        'Check the implementation and decide whether to finalize or send it back.',
        { readyMarker: READY_TO_FINALIZE, advanceTo: 'finalize' },
      ),
      segment(
        'finalize',
        'Finalize',
        'Produce the digest that closes the request and feeds the knowledge base.',
        { readyMarker: READY_TO_INDEX },
      ),
    ],
  };
}
