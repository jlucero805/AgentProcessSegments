export interface SkillInfo {
  /** Path-derived id, e.g. `poteto-mode`. This is the slash-menu name. */
  name: string;
  description: string;
  /** Global source such as `opencode`, `claude`, `agents`, or `project`. */
  source: string;
  /** Absolute SKILL.md (or flat skill markdown) path. */
  path: string;
}
