# Skills in chat

Chats support slash commands and **skills**. Typing `/` at the start of a message
opens a menu; selecting a skill shows a `skill` badge and sending it invokes the skill.

## Discovery

The slash menu combines:

1. **Plugin commands** from installed plugins (`/plugin:command`).
2. **Plugin skills** (`/plugin:skill`), marked as skills.
3. **Discovered skills** from the standard directories:
   - Global: `$XDG_CONFIG_HOME/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`
   - Project and ancestors: `.opencode/skills`, `.claude/skills`, `.agents/skills`
   - For a request chat with a target repo: the request worktree (or target repo)
     replaces the brain’s project root for project-level discovery.

Both a nested `SKILL.md` (for example `skills/poteto-mode/SKILL.md`) and a flat
`skills/name.md` are accepted. The path-derived id is the slash name; the frontmatter
description is the menu description. Project roots win over global roots with the same
id.

> `poteto-mode` is only an example. It appears when a `poteto-mode` skill exists in one of
> the directories above on the VPS. This repo currently ships
> `codebase-refactor-audit`, so `/codebase-refactor-audit` is what the live menu shows.

## Invocation

Skills are model-invoked, not real CLI commands. Sending:

```text
/poteto-mode focus on the migration
```

is translated to:

```text
Use the poteto-mode skill now and follow its instructions.

focus on the migration
```

This works across the Claude and OpenCode harnesses because it is ordinary prompt text,
not a CLI-only slash command. Plugin commands such as `/demo:hello` are sent unchanged.

## API

```text
GET /api/commands
GET /api/skills
GET /api/skills?requestId=…   include that request’s worktree/target-repo skills
```

`GET /api/skills` returns `{ name, description, source, path }`. The SPA merges those with
`/api/commands` into one slash menu.

## Install a skill

Place a standard skill file where the agent CLI can see it, for example:

```text
~/.config/opencode/skills/poteto-mode/SKILL.md
```

```markdown
---
name: Poteto Mode
description: Maximum focus mode for hard implementation work
---

Follow these instructions…
```

Reload the SPA (or open a chat that refetches commands) and `/poteto-mode` appears in the
menu. The same skill is visible to OpenCode/Claude sessions because they read the same
directory.
