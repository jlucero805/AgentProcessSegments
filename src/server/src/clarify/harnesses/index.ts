import type { Config } from '../../config.js';
import type { HarnessId } from '../../domain/harness.js';
import type { AgentHarness, HarnessRegistry } from '../harness.js';
import { ClaudeHarness } from './claude.js';
import { OpencodeHarness } from './opencode.js';

/** Builds and caches one adapter per harness named by the config. */
export function createHarnessRegistry(config: Config): HarnessRegistry {
  const adapters: Record<HarnessId, AgentHarness> = {
    claude: new ClaudeHarness(config.harnessBins.claude, config.brainUrl),
    opencode: new OpencodeHarness(config.harnessBins.opencode, config.brainUrl),
  };
  return {
    defaultId: config.harness,
    get: (id) => adapters[id],
  };
}
