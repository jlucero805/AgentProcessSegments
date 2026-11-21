import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EFFORT_LEVELS } from '../domain/request.js';

const exec = promisify(execFile);

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelsResult {
  models: ModelOption[];
  source: 'probe' | 'fallback';
  effortLevels: readonly string[];
}

/** Offline fallback. The probe wins whenever the CLI answers. */
export const HARDCODED_MODELS: ModelOption[] = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2 (most capable)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (flagship)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (balanced)' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (fast)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const PROBE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    models: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id', 'label'],
      },
    },
  },
  required: ['models'],
});

export function parseProbeOutput(stdout: string): ModelOption[] | null {
  try {
    const outer: unknown = JSON.parse(stdout);
    const record = typeof outer === 'object' && outer !== null ? (outer as Record<string, unknown>) : {};
    const inner: unknown = typeof record['result'] === 'string' ? JSON.parse(record['result']) : record;
    const models = (inner as Record<string, unknown>)['models'];
    if (!Array.isArray(models)) return null;

    const parsed: ModelOption[] = [];
    for (const item of models) {
      const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
      if (typeof entry['id'] !== 'string') continue;
      parsed.push({
        id: entry['id'],
        label: typeof entry['label'] === 'string' ? entry['label'] : entry['id'],
      });
    }
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function probeModels(bin: string): Promise<ModelOption[] | null> {
  try {
    const { stdout } = await exec(
      bin,
      [
        '-p',
        'List every Claude model this CLI can run. Return an id and a short human label for each.',
        '--output-format',
        'json',
        '--model',
        'haiku',
        '--json-schema',
        PROBE_SCHEMA,
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseProbeOutput(stdout);
  } catch {
    return null;
  }
}

const CACHE_MS = 10 * 60 * 1000;

export class ModelCatalog {
  private cached: { at: number; models: ModelOption[] } | null = null;

  constructor(private readonly bin: string) {}

  async list(refresh = false): Promise<ModelsResult> {
    if (!refresh && this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return { models: this.cached.models, source: 'probe', effortLevels: EFFORT_LEVELS };
    }

    const probed = await probeModels(this.bin);
    if (probed) {
      this.cached = { at: Date.now(), models: probed };
      return { models: probed, source: 'probe', effortLevels: EFFORT_LEVELS };
    }

    return { models: HARDCODED_MODELS, source: 'fallback', effortLevels: EFFORT_LEVELS };
  }
}
