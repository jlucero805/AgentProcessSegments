import type { Config } from '../../config.js';
import type { AgentHarness } from '../harness.js';
import { ClaudeHarness } from './claude.js';
import { OpencodeHarness } from './opencode.js';

/** Builds the harness named by `APS_HARNESS` (default: claude). */
export function createHarness(config: Config): AgentHarness {
  if (config.harness === 'opencode') {
    return new OpencodeHarness(config.harnessBin, config.brainUrl);
  }
  return new ClaudeHarness(config.harnessBin, config.brainUrl);
}
