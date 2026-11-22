import type { HarnessId } from '../domain/harness.js';
import { EFFORT_LEVELS } from '../domain/request.js';

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelsResult {
  models: ModelOption[];
  source: 'probe' | 'fallback';
  effortLevels: readonly string[];
}

/** What the catalog needs from the active agent harness. */
export interface ModelSource {
  probeModels(): Promise<ModelOption[] | null>;
  readonly fallbackModels: readonly ModelOption[];
}

/** Offline fallback for the Claude CLI. The probe wins whenever it answers. */
export const HARDCODED_MODELS: ModelOption[] = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2 (most capable)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (flagship)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (balanced)' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (fast)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const CACHE_MS = 10 * 60 * 1000;

export class ModelCatalog {
  private cached: { at: number; models: ModelOption[] } | null = null;

  constructor(private readonly source: ModelSource) {}

  async list(refresh = false): Promise<ModelsResult> {
    if (!refresh && this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return { models: this.cached.models, source: 'probe', effortLevels: EFFORT_LEVELS };
    }

    const probed = await this.source.probeModels();
    if (probed) {
      this.cached = { at: Date.now(), models: probed };
      return { models: probed, source: 'probe', effortLevels: EFFORT_LEVELS };
    }

    return {
      models: [...this.source.fallbackModels],
      source: 'fallback',
      effortLevels: EFFORT_LEVELS,
    };
  }
}

/** One catalog per harness so probe results and caches cannot bleed across adapters. */
export class HarnessModelCatalog {
  private readonly catalogs: Record<HarnessId, ModelCatalog>;

  constructor(sources: Record<HarnessId, ModelSource>) {
    this.catalogs = {
      claude: new ModelCatalog(sources.claude),
      opencode: new ModelCatalog(sources.opencode),
    };
  }

  list(harness: HarnessId, refresh = false): Promise<ModelsResult> {
    return this.catalogs[harness].list(refresh);
  }
}
