import type { CellRepository } from '../cells/repository.js';
import type { Engine, LiveTurn } from '../clarify/engine.js';
import { isStaleSessionLocationFailure } from '../clarify/harness.js';
import {
  type SummaryFailureNotification,
  type SummaryFailureSource,
  type TurnFailureSource,
} from '../domain/notifications.js';
import { summarySessionId } from '../domain/sessions.js';
import {
  AGENT_STATUSES,
  STATES,
  isTerminal,
  type Request,
  type State,
} from '../domain/request.js';
import type { ErrorSink } from '../logging/errors.js';
import type {
  ActivityWindow,
  MasterEventRepository,
} from '../master/events.js';
import type { MasterAction } from '../master/types.js';
import type { CellDetail } from '../process/definition.js';
import type { RequestRepository } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';
import { SpendCapError } from '../usage/spend-cap.js';
import type { SummaryRepository } from './repository.js';
import {
  SUMMARY_DERIVED_NOTE,
  type Summary,
  type SummaryActivity,
  type SummaryPreviousActivity,
  type SummaryStats,
} from './types.js';

export interface StatsInput {
  requests: Request[];
  activity: ActivityWindow;
  previousActivity: ActivityWindow;
  cell: Pick<CellDetail, 'id' | 'name'>;
  now: number;
  windowMinutes: number;
  idleMinutes: number;
}

function activityCount(window: ActivityWindow, action: MasterAction): number {
  return window.counts[action];
}

function currentActivity(window: ActivityWindow): SummaryActivity {
  return {
    cycles: activityCount(window, 'cycle'),
    started: activityCount(window, 'start'),
    prodded: activityCount(window, 'prod'),
    reviewed: activityCount(window, 'review'),
    advanced: activityCount(window, 'advance'),
    followUps: activityCount(window, 'followup'),
    skipped: activityCount(window, 'skip'),
    followUpTitles: window.followUpTitles,
    skipReasons: window.skipReasons,
  };
}

function previousActivity(window: ActivityWindow): SummaryPreviousActivity {
  return {
    cycles: activityCount(window, 'cycle'),
    started: activityCount(window, 'start'),
    prodded: activityCount(window, 'prod'),
    reviewed: activityCount(window, 'review'),
    advanced: activityCount(window, 'advance'),
    followUps: activityCount(window, 'followup'),
    skipped: activityCount(window, 'skip'),
  };
}

/** Pure fact collection so the scorecard numbers are easy to test. */
export function collectSummaryStats(input: StatsInput): SummaryStats {
  const windowMs = input.windowMinutes * 60_000;
  const windowStart = input.now - windowMs;
  const windowEnd = input.now;
  const previousStart = windowStart - windowMs;

  const byState = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  const agentStatus = Object.fromEntries(
    AGENT_STATUSES.map((status) => [status, 0]),
  ) as Record<(typeof AGENT_STATUSES)[number], number>;

  let created = 0;
  let updated = 0;
  let completed = 0;
  let dropped = 0;
  let unchecked = 0;
  let previousCreated = 0;
  let previousCompleted = 0;
  let previousDropped = 0;

  for (const request of input.requests) {
    byState[request.state] += 1;
    agentStatus[request.agentStatus] += 1;
    if (request.unchecked) unchecked += 1;

    const createdNow = request.createdAt >= windowStart && request.createdAt < windowEnd;
    const updatedNow = request.updatedAt >= windowStart && request.updatedAt < windowEnd;
    if (createdNow) created += 1;
    if (updatedNow) updated += 1;
    if (updatedNow && request.state === 'done') completed += 1;
    if (updatedNow && request.state === 'dropped') dropped += 1;

    const createdBefore =
      request.createdAt >= previousStart && request.createdAt < windowStart;
    const updatedBefore =
      request.updatedAt >= previousStart && request.updatedAt < windowStart;
    if (createdBefore) previousCreated += 1;
    if (updatedBefore && request.state === 'done') previousCompleted += 1;
    if (updatedBefore && request.state === 'dropped') previousDropped += 1;
  }

  const stalledBefore = input.now - input.idleMinutes * 60_000;
  const stalled = input.requests
    .filter(
      (request) =>
        !isTerminal(request.state) &&
        request.agentStatus !== 'working' &&
        request.updatedAt < stalledBefore,
    )
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, 20)
    .map((request) => ({
      id: request.id,
      title: request.title,
      state: request.state,
      ageMinutes: Math.max(0, Math.floor((input.now - request.updatedAt) / 60_000)),
    }));

  return {
    windowStart,
    windowEnd,
    windowMinutes: input.windowMinutes,
    cell: { id: input.cell.id, name: input.cell.name },
    requests: {
      total: input.requests.length,
      byState,
      created,
      updated,
      completed,
      dropped,
      stalled,
      unchecked,
      agentStatus,
    },
    activity: currentActivity(input.activity),
    previous: {
      created: previousCreated,
      completed: previousCompleted,
      dropped: previousDropped,
      activity: previousActivity(input.previousActivity),
    },
  };
}

export interface SummaryServiceDeps {
  repo: RequestRepository;
  cells: CellRepository;
  engine: Engine;
  settings: SettingsStore;
  events: MasterEventRepository;
  summaries: SummaryRepository;
  errors?: ErrorSink;
  /** Advisory notification for a failed scorecard generation. Never changes the outcome. */
  onSummaryFailure?: (event: SummaryFailureNotification) => void;
}

export function summaryFailureSource(source: TurnFailureSource): SummaryFailureSource {
  switch (source) {
    case 'engine.result':
      return 'summary.result';
    case 'engine.exit':
      return 'summary.exit';
    case 'engine.timeout':
      return 'summary.timeout';
    case 'engine.turn':
      return 'summary.turn';
  }
}

/** Gathers facts, asks the read-only summary session for narrative, and stores it. */
export class SummaryService {
  constructor(private readonly deps: SummaryServiceDeps) {}

  statsFor(cellId: string, now = Date.now()): SummaryStats {
    const cell = this.deps.cells.require(cellId);
    const settings = this.deps.settings.get();
    const windowMs = settings.summary.windowMinutes * 60_000;
    const windowStart = now - windowMs;
    const requests = this.deps.repo.list({ cellId });
    return collectSummaryStats({
      requests,
      activity: this.deps.events.activityWindow(cell.id, windowStart, now),
      previousActivity: this.deps.events.activityWindow(cell.id, windowStart - windowMs, windowStart),
      cell,
      now,
      windowMinutes: settings.summary.windowMinutes,
      idleMinutes: settings.master.idleMinutes,
    });
  }

  async generate(cellId: string): Promise<Summary> {
    const cell = this.deps.cells.require(cellId);
    const settings = this.deps.settings.get();
    const sessionId = summarySessionId(cellId);
    if (this.deps.engine.hasLive(sessionId)) {
      return this.fail(cellId, new Error(`a scorecard is already running for cell ${cellId}`));
    }

    const stats = this.statsFor(cellId);
    const context = [
      `Cell: ${cell.name} (${cell.id}).`,
      `Window: ${new Date(stats.windowStart).toISOString()} to ` +
        `${new Date(stats.windowEnd).toISOString()} (${stats.windowMinutes} minutes).`,
    ].join('\n');
    const prompt = [
      `Write the scorecard for cell "${cell.name}".`,
      '',
      'Deterministic facts (authoritative; do not invent numbers):',
      '```json',
      JSON.stringify(stats, null, 2),
      '```',
      '',
      settings.summary.prompt.trim(),
    ].join('\n');

    // At most two attempts. A stale OpenCode session location is cleared and
    // retried once as a fresh session; the recorded directory can be gone after
    // a data-directory move. Every other failure keeps the normal path.
    for (let attempt = 0; ; attempt += 1) {
      // Take the boundary per attempt: the failed first turn leaves its warning
      // in the transcript and it must not become part of the scorecard.
      const before = this.deps.engine.transcript(sessionId).length;
      let turn: LiveTurn;
      try {
        turn = await this.deps.engine.startSummary(prompt, sessionId, context);
        await turn.promise;
      } catch (error) {
        if (error instanceof SpendCapError) throw error;
        this.notifyFailure(cellId, 'summary.turn', 'engine error');
        throw error;
      }
      // finishTurn persists the transcript one tick after the promise settles.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // A cap stop is a pause, not a failed scorecard: no row and no error log.
      if (turn.stoppedBy) throw new SpendCapError(turn.stoppedBy);
      if (turn.failure) {
        if (
          attempt === 0 &&
          isStaleSessionLocationFailure(turn.harnessId, turn.failure) &&
          this.deps.engine.clearSavedSession(sessionId)
        ) {
          continue;
        }
        const failure = turn.failureEvent;
        this.notifyFailure(
          cellId,
          failure ? summaryFailureSource(failure.source) : 'summary.turn',
          failure?.reason ?? 'engine error',
        );
        return this.fail(cellId, new Error(turn.failure));
      }
      const body = this.deps.engine
        .transcript(sessionId)
        .slice(before)
        .filter((message) => message.role === 'agent' && message.kind === 'text')
        .map((message) => message.text.trim())
        .filter((text) => text !== '')
        .join('\n\n')
        .trim();
      if (body === '') {
        this.notifyFailure(cellId, 'summary.empty', 'scorecard returned no text');
        return this.fail(cellId, new Error('the scorecard model returned no text'));
      }
      // The cell can be deleted while the model is running. Do not leave an
      // orphan report behind after CellRepository has already cleaned up.
      if (!this.deps.cells.get(cellId)) {
        throw new Error(`cell ${cellId} no longer exists`);
      }
      // Accuracy note is not optional; add it if the model omitted it.
      const content = body.includes(SUMMARY_DERIVED_NOTE)
        ? body
        : `${body}\n\n_${SUMMARY_DERIVED_NOTE}_`;

      try {
        return this.deps.summaries.record({
          cellId,
          windowStart: stats.windowStart,
          windowEnd: stats.windowEnd,
          windowMinutes: stats.windowMinutes,
          content,
          stats,
        });
      } catch (error) {
        this.notifyFailure(cellId, 'summary.store', 'could not save scorecard');
        throw error;
      }
    }
  }

  private notifyFailure(
    cellId: string,
    source: SummaryFailureSource,
    reason: string,
  ): void {
    try {
      this.deps.onSummaryFailure?.({
        cellId,
        source,
        reason,
        occurredAt: Date.now(),
      });
    } catch (error) {
      this.deps.errors?.error('notifications.event', error, {
        kind: 'summary.failed',
        cellId,
      });
    }
  }

  private fail(cellId: string, error: Error): never {
    this.deps.errors?.error('summary.generate', error, { cellId });
    throw error;
  }
}
