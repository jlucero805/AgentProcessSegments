import type { Config } from '../../config.js';
import type { HarnessId } from '../../domain/harness.js';
import type { AgentHarness } from '../harness.js';
import { ClaudeHarness } from './claude.js';
import { OpencodeHarness } from './opencode.js';

/**
 * One cached adapter per harness id. Sessions resolve an id and ask this
 * registry for the adapter; never construct a harness per turn.
 */
export class HarnessRegistry {
  readonly defaultId: HarnessId;
  private readonly adapters = new Map<HarnessId, AgentHarness>();

  constructor(private readonly config: Config) {
    this.defaultId = config.harness;
  }

  get(id: HarnessId): AgentHarness {
    const cached = this.adapters.get(id);
    if (cached) return cached;

    const adapter =
      id === 'opencode'
        ? new OpencodeHarness(this.config.opencodeBin, this.config.brainUrl)
        : new ClaudeHarness(this.config.claudeBin, this.config.brainUrl);
    this.adapters.set(id, adapter);
    return adapter;
  }
}
