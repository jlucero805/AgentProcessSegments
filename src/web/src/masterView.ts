import type { MasterEvent, MasterResult } from './types';

export const ACTION_TONES = {
  cycle: 'neutral',
  start: 'blue',
  prod: 'blue',
  review: 'green',
  advance: 'green',
  followup: 'purple',
  skip: 'amber',
} as const;

export function eventDetail(event: MasterEvent): string {
  if (event.action !== 'cycle') return event.detail;
  try {
    const parsed = JSON.parse(event.detail) as {
      dispatch?: number;
      started?: number;
      prodded?: number;
      advanced?: number;
      followUps?: number;
      skipped?: number;
    };
    const parts = [
      `${parsed.dispatch ?? 0} selected`,
      `${parsed.started ?? 0} started`,
      `${parsed.prodded ?? 0} prodded`,
      `${parsed.advanced ?? 0} advanced`,
      `${parsed.followUps ?? 0} follow-ups`,
      `${parsed.skipped ?? 0} skipped`,
    ];
    return parts.join(' · ');
  } catch {
    return event.detail;
  }
}

export function resultSummary(result: MasterResult): string {
  const queues = result.cells === 1 ? 'queue' : 'queues';
  return [
    `${result.started} started`,
    `${result.prodded} prodded`,
    `${result.advanced} advanced`,
    `${result.followUps} follow-ups`,
    `${result.skipped} skipped`,
    `across ${result.cells} ${queues}`,
  ].join(' · ');
}
