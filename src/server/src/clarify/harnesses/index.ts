import type { Config } from '../../config.js';
import type { HarnessId } from '../../domain/harness.js';
import type { AgentHarness, HarnessRegistry } from '../harness.js';
import { ClaudeHarness } from './claude.js';
import { OpencodeHarness } from './opencode.js';

/**
 * Builds and caches one adapter per harness. The default is read lazily so the
 * operator can switch it from app settings without a restart.
 */
export function createHarnessRegistry(
  config: Config,
  defaultHarness: () => HarnessId = () => config.harness,
): HarnessRegistry {
  const adapters: Record<HarnessId, AgentHarness> = {
    claude: new ClaudeHarness(config.harnessBins.claude, config.brainUrl),
    opencode: new OpencodeHarness(config.harnessBins.opencode, config.brainUrl),
  };
  return {
    get defaultId() {
      return defaultHarness();
    },
    get: (id) => adapters[id],
  };
}
