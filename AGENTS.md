# Agent handoff

Formerly Sandbox Harness.

You are picking up a rebuild of the Agent Process Segments brain. Read this file first,
then `docs/01-system-spec.md`. Code beats docs when they disagree; when code is wrong
against the spec, say so rather than silently following either.

## What this is

A local Node/TS service that drives headless agent sessions through
Intake → Plan → Implement → Review → Finalize. The agent substrate is swappable
(`APS_HARNESS=claude` is the default; `opencode` is supported). One port serves
`/api`, `/ws`, and the built SPA. Requests live in SQLite, one persistent agent session
per request, one git worktree per request, and a knowledge base fed by human-approved
digests.

## Ground truth

1. `src/server/src/**` is the system.
2. `docs/01-system-spec.md` is the governing contract.
3. `docs/02-status.md` is built versus not built, and it goes stale fast. Check it
   against `git log`.
4. `docs/03-decisions.md` explains choices that look arbitrary until you read them.
5. `docs/04-design-liberties.md` lists the autonomous choices made after the handoff,
   with alternatives, for operator review.
6. `docs/06-refactor-audit.md` records the duplication/bug audit, what was fixed, and
   what was deliberately deferred.
7. `docs/07-process-segments.md` is the process.json contract and automation semantics.
8. `docs/08-user-workflows.md` is the operator workflow: cells, process choices, master
   observation, requests, review, and finalize.
9. `docs/09-backlog.md` holds scoped but unbuilt work (external budget delivery, hard-cap
   refinements, and pricing maintenance at scale). Usage rollups, budget alerts, hard
   caps, and estimated pricing are built.
10. `docs/10-error-log.md` is the error-only log contract: path, format, rotation, sites.
11. `docs/11-skills.md` is slash-command/skill discovery and invocation in chats.
12. `docs/12-terminals.md` is the server-owned PTY lifecycle, session list, and API.
13. `docs/13-cell-wizard.md` is the cell creation chat and policy setup workflow.
14. `docs/14-webhook-payloads.md` is the receiver-facing webhook payload reference:
    budget alerts and event notifications, their discriminators, fields, and ids.

## State at handoff

- `main` is deployed to the remote; every unit below was committed as it passed.
- 1557 vitest cases: 1117 server across 59 files (one environmental root-skip) and 440 web across 30 files, all green.
- Five proof scripts: `scripts/smoke.sh` (built brain over a socket),
  `scripts/mcp-smoke.mjs` (built brain plus built MCP server over real stdio),
  `scripts/claude-mock-smoke.mjs` (real Claude binary against a mock Anthropic API),
  `scripts/e2e.mjs` (built brain + deterministic mock Claude, isolated DB, dedicated E2E
  cell, no KB indexing), and `scripts/systemd-sandbox-probe.mjs` (manual transient-unit
  sandbox exercise; never in lint or CI).
- Built: db and migrations, domain, request/cells/KB repositories, HTTP surface with
  NDJSON streams, engine with reattach and resume, stream parsers, worktrees, MCP server,
  plugin manager, models with fallback, the SPA (board, drawer, chat, cells, skills,
  knowledge base), a mobile shell, durable chat with URL route restore, queued messages
  and stop/interject, one thread across workflow segments, a Config page with XDG
  settings and a structured process editor, configurable global and per-cell process
  segments with per-cell tickers, follow-up callouts, event log, per-cell master chats,
  a first-class Cell master detail with prompts/activity/chat, configurable per-cell
  scorecards over a trailing window (persisted reports, read-only summary session,
  polling scheduler with catch-up and backoff, a dedicated page for browsing reports
  per cell with a generation-time period filter — presets plus a custom date-and-time range,
  with the applied period kept in the URL and restored on reload — keyset paging, one
  latest-per-cell all-cells feed or one flat cross-cell feed with
  server-side paging, and the Cell master drawer's latest-five view scoped by the same
  selectable generation-time period, including Custom), a cell creation flow that
  defines the policy up front with an editable setup chat, per-cell concurrency caps,
  model/effort defaults, auto-compaction thresholds, advisory overall/per-cell spend
  budgets with durable alerts, opt-in hard caps that pause new work and stop in-flight
  turns in the paused scope including a strict unknown-cost mode, time-boxed operator
  overrides that release a pause without changing the cap, a read-only override history,
  an in-app alert/pause banner,
  opt-in signed webhook, SMTP email, and native
  Slack/Discord bot delivery with per-scope routing, an optional single-worker Merge step
  with per-segment caps, an in-app Help docs viewer, a desktop-only maximizable PTY
  terminal independent of agent sessions, bounded turn/MCP waits with stderr diagnostics,
  a systemd user unit for a VPS, an opt-in brain heartbeat lock that
  `migrate-paths` reads when the HTTP port is unreachable, a reviewed live-VPS cutover
  script
  (`deploy/cutover-vps.sh`, `npm run cutover:vps`) that detaches, drains, moves, verifies,
  prunes older `~/.aps-cutover/runs/` evidence, and rolls back, a self-hosted upgrade
  script (`deploy/upgrade-vps.sh`,
  `npm run upgrade:vps`) that detaches, drains, fast-forwards, rebuilds, restarts,
  verifies, rolls back in place, and prunes older `~/.aps-cutover/upgrades/` evidence
  with `--keep-runs`/`--keep-days`/`--no-prune` or on demand with
  `npm run prune:upgrades`, with owner-only `0700` run directories
  for both scripts and a `0600` upgrade snapshot, a harness seam with `claude` and
  `opencode` adapters,
  OpenCode plugin parity (skills and slash commands), chat slash-menu skill discovery
  with per-request
  target-repo skills, per-turn token/cost usage tracking with a Usage dashboard with
  per-cell/per-segment cost and wall-clock/active cycle time, and
  request-level card, configurable master-activity retention for `master_events`,
  configurable scorecard-history retention for `cell_summaries`, configurable
  budget-alert and delivery-outbox retention, configurable spend-cap override retention,
  cell-delete cleanup for
  activity and reserved master/summary session directories,
  configurable retention for terminal request workdirs and leftover worktrees,
  effective-dated operator-maintained model pricing with reported-versus-estimated cost
  accounting, and a GitHub Actions CI workflow published at `.github/workflows/ci.yml`
  from the `deploy/ci-workflow.yml` template. User MCP servers are merged into request sessions for both.
  OpenCode and Claude are both verified end to end (turn, MCP tools, resume across a
  brain restart); Claude runs against a local mock API, OpenCode against its live CLI.
- Not built: KB embeddings, fan-out to multiple chat
  destinations per scope, webhook/email per-scope routing, interactive acknowledgement,
  and pricing maintenance at scale such as bulk import, tiers, or non-USD currencies
  (scoped in `docs/09-backlog.md`). Usage retention with daily rollups is built.
  Review automation is configurable per cell, but Finalize is manual-only: the master
  never schedules it and the human indexes into the KB.

## Commands

```bash
npm ci --include=dev           # keeps devDependencies under an inherited NODE_ENV=production;
                               # use npm install --include=dev when the lockfile changes
# The root dev commands, direct workspace test/typecheck/build/dev/preview, and
# lint:js/lint:md preflight the project-local tsc/vitest/eslint/markdownlint-cli2/
# vite/concurrently/tsx binaries; a missing install prints the `npm ci --include=dev`
# hint instead of a raw "not found".
npm run typecheck              # server src + tests + vitest config, then web app + config; must print nothing
npm run lint                   # eslint + shell + actionlint + systemd unit (sandbox) + markdownlint, zero warnings
npm run probe:sandbox           # manual: boot the brain under one candidate systemd
                               # directive and exercise PTY/turns/worktrees; needs a
                               # user manager and agent CLI, never part of lint or CI
npm test                       # 1117 server + 440 web, plus the e2e env guard
npm run check:docs             # local Markdown links, images, Help anchors, manifest pages,
                               # served screenshots, SPA Help targets
npm run check:docs:external    # manual/periodic: fetch external Markdown links; never a gate
npm run test:e2e-env           # node:test guards for the proof scripts' spawn env, the
                               # webhook receiver example, missing-Puppeteer policy,
                               # interrupt cleanup, the native-module preflight, the
                               # GitHub scope preflight/grant, and the external-link
                               # classifier
npm run check:native           # native modules load; Linux toolchain + npm/python floor
npm run check:github-scope     # token scopes for pushes under .github/workflows/ (0 = safe)
npm run grant:github-scope     # interactive: add the workflow scope to the host gh credential
npm run e2e                    # build + isolated API workflow (mock agent, dedicated E2E cell)
npm run test:web-stress        # manual: web suite 3x under 4 CPU hogs; fails on a failed
                               # iteration, a dead hog, or a missing result report
npm run test:server-stress     # same contract for the server suite (`--suite server`)
npm run build                  # vite into src/web/dist, then tsc into src/server/dist
npm run dev                    # brain plus the Vite dev server (proxies /api and /ws)
APS_HARNESS=opencode APS_DB=/tmp/agent-process-segments.sqlite node src/server/dist/app.js
./scripts/smoke.sh             # health, create, list, 400, 404 over a real socket
node scripts/mcp-smoke.mjs     # tools over stdio, persisted into SQLite
node scripts/claude-mock-smoke.mjs  # real claude binary + mock Anthropic API
node scripts/ui-smoke.mjs      # optional real-browser check; fails without Puppeteer
                               # (--allow-missing-puppeteer skips deliberately)
UI_MOBILE=1 node scripts/ui-smoke.mjs  # same smoke at 390x844
node scripts/screenshots.mjs   # refresh README/Help screenshots; needs a built SPA
                               # and optional Puppeteer; fails without Puppeteer
                               # (--allow-missing-puppeteer skips deliberately)
                               # SIGINT/SIGTERM close the browser, brain, and temp dir
node scripts/clean-test-tmp.mjs  # dry-run: stale test temp dirs; --apply to delete
npm run migrate:paths           # move legacy paths; refuses while a brain unit, process,
                                # answering health endpoint, or fresh brain lock is present
npm run migrate:branches        # dry-run/manual recovery for legacy sbox/* refs;
                                # terminal transitions retire them automatically.
                                # --prune-orphans also retires refs with no request row
npm run repair:permissions      # tighten old request workdirs (dry run first)
npm run repair:upgrades         # tighten old upgrade run dirs/snapshots (dry run first)
npm run repair:runs             # tighten the cutover root and old run dirs (dry run first)
npm run prune:cutover -- --dry-run  # prune old cutover runs by hand; keeps
                                    # latest, newest success, newest 10, 30 days
npm run prune:upgrades -- --dry-run # prune old upgrade runs by hand; keeps
                                    # latest, newest success, newest 10, 30 days
npm run cutover:vps -- --help   # live self-hosted migration; run --dry-run first
                                # prunes older runs by default; --no-prune opts out
npm run upgrade:vps -- --dry-run  # pull + rebuild + restart; --detach inside the brain
                                  # prunes older upgrade runs; --no-prune opts out
# on a VPS, the brain runs as a systemd user unit:
systemctl --user restart agent-process-segments
journalctl --user -u agent-process-segments -n 50 --no-pager
```

## Environment facts that will bite

- **The web Vitest config pins `NODE_ENV=test`.** The brain unit exports
  `NODE_ENV=production` and agent shells inherit it, so a bare `vitest` run would load
  React's production build and fail every render with `act(...) is not supported in
  production builds of React`. `src/web/vite.config.ts` sets `test.env.NODE_ENV`, and
  `src/web/src/viteConfig.test.ts` guards it; keep both. The regression check is
  `NODE_ENV=production npm test --workspace src/web`, which the published CI workflow
  (`.github/workflows/ci.yml`) runs as its own step. The manual stress runners
  (`npm run test:web-stress`, `npm run test:server-stress`) pin `NODE_ENV=test` through
  `buildPinnedEnv` for the same reason, independent of the config pin.
- **The web suite runs in `pool: 'vmThreads'`.** It creates one jsdom environment per
  worker instead of one per test file (29 files), which roughly halves wall time while
  keeping per-file isolation. A VM context has no `ReadableStream`/`TransformStream`, so
  `src/web/src/test/setup.ts` seeds them from `node:stream/web`; `viteConfig.test.ts`
  guards both the pool and the `NODE_ENV=test` pin. Do not switch to `isolate: false`:
  it shares one environment across files and breaks the HelpPanel Mermaid and ClarifyChat
  queue suites.
- **Every JavaScript proof script's child env is hermetic.** `scripts/e2e/env.mjs` is the shared
  builder: `scrubEnv` drops every inherited `APS_*`, `SBOX_*`, `ANTHROPIC_*`, `CLAUDE_*`,
  and `OPENAI_*` variable, then `buildPinnedEnv` applies validated pins so a pin always
  wins. `scripts/e2e.mjs`, `scripts/claude-mock-smoke.mjs`, `scripts/mcp-smoke.mjs`, and
  `scripts/screenshots.mjs` all spawn through it; none spreads `process.env`. Without
  that, a host `APS_TURN_TIMEOUT_MS`, `APS_PLUGINS_DIR`, or legacy `SBOX_HARNESS_BIN`
  silently changes what a proof proves. The screenshot tool also pins its capture
  browser (`SCREENSHOT_BROWSER_PINS`, `--lang=en-US`): the master drawer formats clock
  text in the browser, so an inherited `LANG`/`TZ` would otherwise change the committed
  image. The Claude and MCP smokes keep deliberate
  `SBOX_*` pins to prove the legacy aliases: scrubbing inherited `APS_*` first is what
  makes those pins authoritative. The Claude smoke pins its legacy
  `SBOX_CONFIG`/`SBOX_PROCESS`/`SBOX_ERROR_LOG` paths; the MCP smoke pins the canonical
  `APS_*` paths. Both pin `XDG_CONFIG_HOME`/`XDG_STATE_HOME`, and the MCP smoke also pins
  `OPENCODE_CONFIG_DIR`, because `loadConfig()` and `SkillCatalog` read those directories
  directly, outside `readEnv`. `scripts/e2e/env.test.mjs` guards the builders and
  each script's call site (`npm run test:e2e-env`); the pin builders reject missing or
  relative paths so a dropped mock or port cannot fall back to a real CLI on `PATH`.
  CI's E2E, MCP stdio, and Claude mock smoke steps export the same hostile sentinels
  (`SBOX_HARNESS_BIN=/bin/false`, `APS_HARNESS=opencode`,
  `APS_BRAIN_URL=http://127.0.0.1:1`, `APS_REQUEST_ID=hostile-request`, ...);
  reproduce it with `npm run build`, then `env SBOX_HARNESS_BIN=/bin/false
  APS_HARNESS=opencode node scripts/e2e.mjs`, and the same env with
  `node scripts/mcp-smoke.mjs` or `node scripts/claude-mock-smoke.mjs`.
  `src/server/test/ci-workflow.test.ts` covers every proof step, keeps the E2E
  and MCP blocks identical, and fails if the published workflow drifts from the template.
- **No live Anthropic account here.** `opencode` is authenticated, and a cached Claude
  Code binary can be supplied to the brain with `APS_CLAUDE_BIN`.
  `scripts/claude-mock-smoke.mjs` verifies the Claude harness against a local mock
  Anthropic API (stream, MCP tool, `--resume`, model probe) and skips when no binary is
  found. Its own binary discovery is script-scoped: `--claude-bin <path>` or
  `CLAUDE_MOCK_SMOKE_BIN`, then `claude` on `PATH`. Inherited `APS_CLAUDE_BIN` and the
  legacy `SBOX_CLAUDE_BIN` are ignored so production config cannot choose the binary
  under test. The chosen file must answer `--version` with "Claude Code" within 5 s: a
  wrong explicit choice fails the run, while a wrong `claude` on `PATH` is skipped.
  Do not infer live Claude model behavior from the mock.
- **OpenCode is one-shot per message.** The adapter starts
  `opencode run --format json --auto --standalone` per turn, carries the `ses_…` session
  id, and maps `text`, `tool_use`, `step_finish`, and `error` events. MCP tools surface
  as `execute` code calling `tools.<server>.<tool>()`. Do not add a persistent-child
  assumption to this harness.
- **OpenCode user config is JSONC.** The global `opencode.json` and `opencode.jsonc` are
  both read with `parseJsonc` (comments, trailing commas, and a leading BOM); the
  generated config stays strict JSON. Only those relaxations are accepted, not JSON5
  syntax; project/ancestor files are ignored (see the next bullet).
- **The generated OpenCode config is harness-owned.** `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_CONTENT` are stripped from the child environment and the
  `opencode models` probe. OpenCode layers both above the generated config, so either
  could replace the reserved `aps` server or a read-only deny rule. A set variable warns
  once by name; never log its value.
- **Project OpenCode config is ignored.** Every OpenCode child and the `opencode models`
  probe set `OPENCODE_CONFIG_PROJECT_DISABLE=1`; project and ancestor
  `opencode.json(c)`/`.opencode` config cannot add MCP servers, plugins, skills, agents,
  or permissions. A file found at the session cwd or an ancestor is named once on
  stderr by path only, never by its contents, so a repo can tell its config is ignored.
  User settings come from the global config directory the harness merges. Never describe
  `OPENCODE_CONFIG_DIR` as outranking project config.
- **Claude allow rules support MCP wildcards.** User servers merged from
  `~/.claude.json` and `<cwd>/.mcp.json` are allowed with `mcp__<server>__*`, alongside
  the explicit harness tools. Merge order follows Claude's local > project > user
  precedence; a same-named server keeps the highest-precedence entry whole, and the
  reserved-`aps` warning names the winning file and scope.
- **Pin a child's `PWD` to its cwd.** OpenCode resolves its project root from `PWD`; an
  inherited value points it at the brain's directory and breaks per-request config and
  commands. Both harness adapters set it on spawn.
- **App settings are not env config.** Scheduler policy lives in
  `$XDG_CONFIG_HOME/agent-process-segments/config.json` (`APS_CONFIG`), and process segments
  live in `process.json` (`APS_PROCESS`). Both are zod-validated and written atomically.
  Each settings block and notification channel validates on its own: one invalid unit
  falls back to that unit's defaults, is reported as `settings.invalid` with its `block`
  name, and leaves every other block intact; only an unreadable or non-JSON file falls
  back to all defaults. Loading never writes. Before the first save after an unusable
  load, the raw file is copied to a sibling `config.json.invalid-<UTC>` (owner-only,
  never overwriting an earlier copy); a failed copy refuses the save and reports
  `settings.backupFailed`. The same load reports are returned as `warnings` by
  `GET/PATCH /api/config`; the Config page names each reset block in a banner until the
  next successful save and shows the path of the preserved copy (`preservedPath`) after
  the save that makes it, plus every existing copy (`preservedCopies`, newest first).
  `process.json` follows the same preserve-before-overwrite rule,
  keeps at most the five newest `process.json.invalid-*` copies (pruning older ones after
  a successful save; a prune failure reports `process.pruneFailed` without refusing the
  save), and reports `process.backupFailed` for a failed copy. `process.json` is re-read on
  every `get()`, so a valid on-disk edit takes effect without a restart; an unusable file
  still reports once per distinct state. `GET/PATCH /api/process`
  return this process's copy as `preservedPath` and every existing
  `process.json.invalid-*` copy as `preservedCopies` (newest first), and the global
  process editor lists them, including copies left by earlier runs; `preservedPath`
  itself is still in memory. Env still owns paths, ports, and the harness.
- **APS is canonical, SBOX is legacy.** Read every runtime variable through
  `readEnv()` in `src/server/src/env.ts`: `APS_*` wins when defined (including an empty
  string), then the old `SBOX_*` alias. Resolve default paths through `loadConfig`; it
  prefers an existing `agent-process-segments` location and falls back to an existing
  `sandbox-harness` one. Do not add a fresh `process.env.SBOX_*` read or a new hardcoded
  default outside `config.ts`. Startup warns once, with names only and never values, when
  any `SBOX_*` name is still set; `legacyEnvNames` and `legacyEnvWarning` in `env.ts` build
  that line. Operators move data with `npm run migrate:paths` and rename variables to
  `APS_*` to clear the warning.
  Path-valued settings (`DATA_DIR`, `CONFIG`, `PROCESS`, `ERROR_LOG`, `DB`, `WEB_DIR`,
  `DOCS_DIR`, `PLUGINS_DIR`, `TERMINAL_CWD`, and the harness binaries) are read through
  `readNonEmptyEnv()`: a blank or whitespace-only value is ignored, the lookup continues
  with a non-blank `SBOX_*` alias and then the default/legacy location, and startup warns
  once with the blank names only. Non-blank paths are used verbatim; `APS_DB=':memory:'`
  stays valid. `XDG_CONFIG_HOME` and `XDG_STATE_HOME` have no APS/SBOX alias; they are
  read through `readNonBlankEnv()`, and a blank or whitespace-only base falls back to
  `~/.config` / `~/.local/state` before the same default/legacy choice. The startup
  warning names those exact variables too. Do not apply this to settings where `''` is
  meaningful (`APS_DEFAULT_MODEL`), which keep using `readEnv()`.
- **Errors are the only persisted logs.** `$XDG_STATE_HOME/agent-process-segments/errors.log`
  (`APS_ERROR_LOG`, `APS_ERROR_LOG_MAX_BYTES`) is NDJSON, size-rotated to `.1`, and
  written only by explicit error paths. Never add routine logging to it.
- **The browser terminal is a real PTY.** `APS_TERMINAL=0` disables creation;
  `APS_TERMINAL_CWD` sets its starting directory. Sessions are server-owned and listed
  in the UI; hiding the panel only detaches, closing a session tab kills it. It is
  desktop-only in the UI, but the session API is live. Never expose the brain beyond
  loopback without auth/proxy controls, because the terminal is a direct shell.
- **Puppeteer is not a project dependency.** `scripts/ui-smoke.mjs` and
  `scripts/screenshots.mjs` both fail without it unless `--allow-missing-puppeteer`
  is passed.
  A headless Chromium on this host needs the usual shared libraries (`libnss3`,
  `libnspr4`, `libatk*`, `libgbm1`, `libasound2`, …).
- **The UI smoke asserts structure, not copy.** `scripts/ui-smoke.mjs` locates
  elements through `data-testid` hooks, accessible `aria-label`s, and Help `data-slug`s;
  `scripts/ui-smoke.test.mjs` fails when one it uses is missing from `src/web/src` or
  the Help manifest, so locator drift is caught without Puppeteer. The request drawer
  step requires the harness to have resolved (`harness-effective[data-resolved="true"]`)
  and the Model select to have at least one option (`model-select[data-model-count]`
  other than `0`), not merely the Harness field to be mounted.
  The smoke also removes its request and cell on success, failure, and interrupt.
- **Node 22.7.** `app.inject()` throws because `light-my-request` requires ESM-only
  `cookie` v2. Tests listen on port 0 and use `fetch`. Do not "fix" this by pinning
  `cookie`.
- **`NODE_ENV=production` hides devDependencies from npm.** The brain unit exports it and
  agent shells inherit it, so a bare `npm install` or `npm ci` installs production
  dependencies only: `typescript`, `vite`, `vitest`, ESLint, and the rest of the
  devDependencies never land. `npm run typecheck` then fails with `tsc: not found`,
  `npm test` with `vitest: not found`, `npm run lint` with `eslint: not found`, and
  `npm run build` cannot find `vite`/`tsc`. Recover with `npm ci --include=dev` (or
  `NODE_ENV=development npm ci`); a fresh `npm ci` under the inherited env prunes them
  again, so pass the flag every time. `npm config get omit` printing `dev` confirms the
  cause. Use `npm install --include=dev` when you are changing the lockfile, not for a
  fresh checkout. The root `typecheck`/`test`/`lint`/`build`/`dev`/`e2e` commands, direct
  workspace `test`/`typecheck`/`build`/`dev`/`preview`, and `npm run lint:js`/`lint:md`
  run `scripts/check-dev-deps.mjs` first and print this hint when a project-local binary
  is missing.
- **Native modules need a Linux toolchain.** `better-sqlite3` is v13 (N-API with bundled
  prebuilds, Node >= 22) and `node-pty` is 1.1.0, which ships no Linux prebuild and compiles
  on every install. `npm ci` also runs npm's implicit `node-gyp` pass for `better-sqlite3`
  even though it ships a prebuild, so `make`, `g++`, and `python3` are required on Linux.
  Python 3.14 needs npm >= 11.7 (bundled node-gyp >= 12); upgrade with
  `npm install -g npm@latest`. A full disk (`ENOSPC`) surfaces as a gyp `write` error, not
  as a disk error. `npm run check:native` reports both halves.
- **systemd user units need a user manager.** In a non-login shell set
  `XDG_RUNTIME_DIR=/run/user/<uid>` before `systemctl --user`. Linger starts the user
  manager at boot; the brain's unit is in `deploy/`.
- **macOS temp paths differ**: `os.tmpdir()` returns `/var/...` while `git rev-parse`
  returns `/private/var/...`. Compare real paths or existence, never strings, in
  worktree code.
- **The remote is public.** Anything you commit is published. Do not add internal host
  names, auth providers, or account identifiers. `AGENTS.md`, docs, and code comments
  are all public.

## Invariants

1. **Transition table is data.** Add states in `domain/request.ts`; never branch on
   state elsewhere without going through `canTransition`.
2. **`__kb__`, `__master__:<cellId>`, and `__summary__:<cellId>` are sentinel session
   ids with no rows.** A cell master uses `__master__:<cellId>`; the bare `__master__`
   is not a session and unassigned work has no master. The internal
   `__summary__:<cellId>` generator writes scorecards and is not exposed as a chat.
   Routes special-case them before touching the request repository. All reserved
   sessions are read-only; the master scope gets board read tools in addition to the KB
   tools.
3. **MCP tool names must match the harness allowlist.** Registering a tool does not
   grant it. Build the string with `mcpTool()` from `mcp/identity.ts`, add it to
   `REQUEST_TOOLS`, `KB_TOOLS`, `MASTER_TOOLS`, or `SETUP_TOOLS` in
   `clarify/harness.ts`, or the Claude agent cannot call it under auto-approve. OpenCode
   request sessions use `--auto`; its read-only/setup sessions use explicit deny
   permissions. The bundled server key is `aps`; "harness" is the agent adapter.
4. **One turn at a time per id.** `start`/`send`/`dispatch`/`finalize` return the
   existing `LiveTurn` while one is in flight. Do not start a second.
5. **A finished turn is dropped.** `attach()` returns false after completion; clients
   fall back to `GET /clarify`.
6. **Agent status is independent of state.** `working` on turn start, `idle` plus
   `unchecked` on finish, cleared by `/seen`.
7. **Terminal transitions dispose.** `done` and `dropped` must call `engine.dispose(id)`,
   which kills the child, removes the worktree, and then retires a legacy `sbox/<id>`
   ref once the checkout is gone. A startup/hourly sweep catches terminal rows left by
   older builds or a transient git failure; cleanup is best-effort and must never fail
   the transition. `npm run migrate:branches` remains the dry-run/manual recovery
   command. Orphan `sbox/*` refs require `--prune-orphans`, are archived under
   `refs/sbox-pruned/` before deletion, and are never touched while checked out.
8. **Plugins contribute skills and commands only.** `install` strips `hooks`,
   `mcpServers`, `hooks/`, and `.mcp.json`. Never re-add them.
9. **Guards at the boundary.** zod validates HTTP and MCP input. Repositories trust
   their arguments. No route reads `request.body` without a schema. A non-null `cellId`
   is checked against `CellRepository` before it is written.
10. **The SPA imports the pure server contract.** `src/web/src/types.ts` re-exports
    `domain/request`, `domain/sessions`, `master/types`, `plugins/types`, and
    `clarify/models`. Keep those modules free of Node imports so Vite can bundle them; do
    not restate workflow tables, session ids, or request shapes in the SPA.
11. **Process segments are data.** `process.json` is the global template. A cell can
    store its own snapshot in `cells.process_json` and an optional
    `master_interval_minutes`; its master uses that policy and ticker, or the global
    template and interval when absent. The master evaluates enabled schedulable segments
    from the right of the pipeline to the left (`merge` first, `intake` last), uses the
    segment prompt, and advances only on the exact marker through `canTransition`.
    Finalize is manual-only and is never scheduled, whatever `finalize.enabled` says. Do
    not hardcode a prod/review rule in a route or UI.
12. **Master chats and notes are per cell.** `masterSessionId(cellId)` returns
    `__master__:<cellId>`. Unassigned requests have no master and no chat; notes from a
    cell cycle go only to that cell’s session.
13. **Stop keeps the session.** `Engine.cancel` kills the child, resolves the turn, and
    finishes with the partial transcript; it does not clear `session.json`, so the next
    message resumes. Stop clears the client queue; normal completion drains it in order.
    Queues live per request under `aps-queue:<id>`; a queue written by the old
    `sbox-queue:<id>` key is adopted once on load, copied to the new key, and removed.
    A restored queue waits for the `/clarify` snapshot to say whether a turn is live, so
    a reload mid-turn drains only after that turn's `done`. `POST /clarify/send` refuses
    with `409 turn_active` while a turn runs; the client requeues the text at the front
    and reattaches instead of surfacing an error. Every outbound message is journaled
    under `aps-queue-inflight:<id>` before its POST starts: a queued item is claimed from
    storage under a Web Lock first, so two tabs cannot deliver it twice (without Web
    Locks one tab still drains, but the cross-tab guarantee is lost), and a direct
    composer send journals itself as `kind: "direct"` without touching the queue. A claim
    clears when the send is proven accepted and is reconciled against the `/clarify`
    transcript on the next mount, so a tab crash does not lose a queued or directly typed
    message. Queue and direct claims reconcile separately, so one kind never deletes the
    other.
14. **Dispose ends a live turn.** `Engine.dispose` kills the child, marks the turn
    cancelled, and finishes it so the partial transcript is saved; never delete a live
    turn's maps without resolving its promise. `finishTurn` is the single settlement
    point and resolves `turn.promise` in a `finally`, including when `runTurn` throws an
    engine exception. `Engine.discardSession` is the cell-delete variant: cancel, wait
    for the `runTurn` continuation, then remove the reserved session directory and
    refuse new turns for that id.
15. **Finalize stays human-gated.** `intake` and `finalize` cannot auto-advance; indexing
    into the KB is a human action. The master never schedules a finalize turn, even when
    an old policy says `finalize.enabled: true`; a person presses **Finalize** to propose
    the digest. The Finalize column's **Index all** is an explicit
    human bulk action: keep it scoped to `finalize` and skip working requests or requests
    with no digest instead of closing them silently. Do not add an automatic finalize
    transition without an explicit indexing path.
16. **Follow-ups are deduplicated.** A `FOLLOW-UP:` line creates one request per source
    request/title; the `followup` event is the dedupe key. `master_events` retention and
    cell deletion never delete `followup` rows, so pruning activity or deleting a cell
    cannot resurrect a duplicate.
17. **Terminal sessions are server-owned and visible.** A WebSocket attaches/detaches; it
    must never kill the PTY on close. Hide detaches, an explicit close kills, and
    `GET /api/terminals` lists every session. Keep scrollback bounded and the UI
    desktop-only; `APS_TERMINAL=0` disables creation.
18. **Concurrency is per cell, and cycles are bounded.** The master counts `working`
    requests in the cell and stops starting turns at `max_concurrent` (default 3). Each
    cycle selects at most that spare capacity, latest schedulable segments first and
    oldest request first inside a segment; it must not scan or note every queue.
    Unassigned requests are manual-only and never enter a bucket.
19. **Cell model/effort are fallbacks.** A turn uses the request’s model/effort first,
    then the cell defaults; persist cell changes on the cell, not in memory.
20. **Usage is recorded after completion; reported cost wins; retention and budgets are
    advisory.** Parsers expose a normalized `TurnUsage`; the engine writes one
    `usage_events` row only when the harness emitted a final event and reported usage.
    Cancelled, timed-out, and usage-less turns write nothing. `usage_events.cost_usd` is
    harness-reported only and is never rewritten. An unreported turn may be estimated at
    query time from the exact model's latest `model_pricing` row with
    `effective_from <= created_at`; prices are explicit USD-per-million rows with a
    source, and an unmatched model stays unpriced, never zero. Claude reports cumulative
    usage on resumed sessions, so persist the last cumulative totals in `session.json`
    and record per-turn deltas. `usage.retentionDays` (default 90, `0` = keep raw forever)
    drives the startup/hourly retention job. That job first rolls raw days into
    `usage_daily` in bounded UTC-day chunks, advances the `usage_rollup_state` watermark
    atomically with each chunk, and only then deletes raw rows strictly before the
    day-aligned cutoff; delete usage rows only through that job. Queries read raw rows at
    or after the watermark and daily rows before it, so all-time totals never double count
    or lose history. Daily estimates are
    frozen at rollup time; raw days keep query-time estimates. Budget status reads
    `UsageRepository.totals` (the same merged view). Advisory status and alerts compare
    reported cost only; opt-in hard caps compare reported plus estimated cost and mark
    unpriced spend as a lower bound. Strict caps can also refuse work while any turn is
    unpriced. Do not add guessed prices or partial usage writes.
    External delivery, a hard-cap snooze/replay, and pricing maintenance at
    scale follow `docs/09-backlog.md`.
21. **Merge is serialized.** The optional `merge` state defaults to `maxConcurrent: 1`;
    the master must check segment caps in addition to the cell cap. Its prompt rebases,
    tests, and pushes one request at a time before advancing to Finalize.
22. **Wizard chat can edit its draft.** `__setup__:<draftId>` has no request row; setup
    scope gets only `Read` plus `get_cell_draft`/`update_cell_draft`, not board/KB tools.
    The bundled `aps` MCP server uses `codemode: false` so calls are visible tool cards.
    The prompt and tool errors carry `SEGMENT_FLOW_GUIDE`; prefer one `segmentUpdates` update
    per segment. The chat refreshes the form after each successful update. The draft is
    server-backed, validated, deleted on close, and any live turn is stopped. An enabled
    intake prompt is included in the first clarification turn.
23. **Errors go through the error sink.** Use the injected `ErrorSink` on genuine failure
    paths; it appends NDJSON to the XDG state log and must never throw. Keep context to
    ids/method/URL, never prompts, bodies, transcripts, tokens, or secrets. Expected 4xx
    responses stay out of the file.
24. **Skills are prompt instructions, not CLI slashes.** Discover them from the standard
    OpenCode/Claude directories (`docs/11-skills.md`). The composer may show `/name`, but
    sending it must translate to `Use the <name> skill now…`; only plugin commands may be
    sent as raw slash commands.
25. **Help docs are manifest-only.** Add pages to `src/server/src/docs/manifest.ts`; the
    server reads that list through `docs/service.ts`. Never join a user slug onto a
    filesystem path. Assets are limited to `docs/screenshots/**` and the MIME types in
    `src/server/src/docs/assets.ts`; a served page may reference only those assets. An
    empty docs directory must render the unavailable state, not an error.
26. **Brain agent runs are non-interactive.** Never allow a harness to wait for a UI
    question. OpenCode's `question` tool is denied in every scope; prompts must ask in
    plain text. The setup chat answers simple messages directly instead of touring tools.
27. **Waits are bounded.** Every turn has `config.turnTimeoutMs`; a timeout must emit
    `error`, finish with `done`, kill the child, and log `engine.timeout`. Harness MCP
    calls must time out with an `isError` result. Wizard draft sync failures belong inline
    in the modal, not only in the page-level banner.
28. **NDJSON POSTs must declare JSON.** `streamNdjson` sets
    `content-type: application/json` whenever it sends a body. A browser string body
    otherwise becomes `text/plain` and Fastify rejects the chat action validation.
29. **Model defaults are brain-level.** `APS_DEFAULT_MODEL` applies when neither the
    request nor its cell names a model. OpenCode defaults to
    `opencode-go/deepseek-v4.1-flash`; do not silently fall back to its slower free tier.
    Expose the default through `GET /api/models` so the wizard can show it.
30. **The master starts a batch and returns.** `runBucket` selects up to the cell’s spare
    concurrency, counts already-selected candidates against segment caps, starts the batch
    with `Promise.all`, records the prods, and returns. Completion handling (transcript,
    follow-ups, marker advancement) runs in background promises and mutates the cycle
    result/events. Do not block the cycle on `turn.promise`; per-cell scheduler
    coalescing still prevents overlapping dispatch cycles. A tick that lands during an
    active cell cycle is skipped and retried on the next interval.
31. **Scorecards are observational and separate from the master.** The summary service
    gathers facts, writes one `cell_summaries` row, and never transitions requests or
    writes to `__master__:<cellId>`. Generation uses `__summary__:<cellId>` with the
    read-only master tool scope. Keep the schedule in `summary` settings, throttle
    generations to one at a time, and back off failures instead of scanning every 30 s.
    `retention.cellSummariesDays` (default 90, `0` = forever) prunes older report rows
    but always keeps the newest row per cell, so `latest()` and the scheduler's due-ness
    never flip to "never summarized".
32. **Harness choice is per cell or request and pinned per session.** A request session
    uses `requests.harness`, then its cell's `cells.harness`, then `config.harness`.
    Cell masters and summary sessions use their cell; setup, KB, and unassigned
    sessions use the process default. `session.json` stores the harness with the session
    id and usage, and an id from another adapter is never resumed. A cross-harness
    request skips the cell's model and effort defaults, and a patch that changes the
    effective harness clears a stale request model unless a replacement is supplied.
33. **Auto-compaction is harness-native and per cell.** A request session compacts at
    its cell’s `autocompactPercent` (default 80, range 1–99); unassigned requests use 80.
    Pass it into OpenCode as `compaction.buffer: "<100 - percent>%"` with `auto: true`,
    and into Claude as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` plus
    `autoCompactEnabled: true`. Note that Claude cannot raise its built-in threshold.
    KB, master, setup, and summary sessions keep the harness/global behavior.
34. **Hard spend caps are opt-in admission checks and in-flight stops.**
    `budget.pauseOnExceeded` and `cells.pause_on_exceeded` default false. Cap spend is
    reported plus estimated cost; warning thresholds and acknowledgement never pause.
    `budget.pauseOnUnknownCost` and `cells.pause_on_unknown_cost` add a strict mode that
    pauses while any current-month turn has neither a reported nor an estimated cost, even
    below the budget. A reached cap wins the reason (`cap_reached` over `unknown_cost`);
    strict mode is inert without `pauseOnExceeded` and a budget. Adding an effective-dated
    price, clearing the budget, disabling enforcement, or a new UTC month resumes; raising
    a budget does not clear an unknown-cost pause. A ledger read failure still fails open
    and is logged. An overall pause refuses every new agent turn and stops every live one;
    a cell pause is cell-scoped for both. Check admission before `clarifyStarted`, state
    transitions, `agentStatus`, session writes, or spawning. `SpendCapEnforcer.check()` runs
    after a usage row is written and after budget evaluation: it cancels paused-scope turns
    through `Engine.cancelForSpendCap`, which keeps the saved session, appends a `⏸`
    transcript line, and emits `paused` before `done`. A cap stop records
    harness-reported usage it already has; user stop, dispose, and timeout still write
    none. Master/summary schedulers skip paused cells without failure backoff and never
    advance or write a scorecard from a stopped turn. Refuse with `SpendCapError` / HTTP
    `409 spend_cap` carrying the reason; never log an expected refusal or cap stop as an
    error. A time-boxed override (`spend_cap_overrides`) releases the admission refusal
    and suppresses the in-flight stop for its scope: an overall override admits and keeps
    every scope, a cell override admits only its cell, and neither changes `paused`,
    `pauseReason`, alerts, or the budget. Overrides are clamped before the next UTC
    period, are revocable, and must fail open if the override store cannot be read. A
    grant does not re-run evaluation: it only relaxes admission and cannot require a stop,
    and statuses are read live. A revoke does re-run evaluation so the enforcer stops live
    turns in a scope that is still over its cap; an expiry refuses new turns at once and is
    observed by the next evaluation (within 60 seconds). Retained rows are also readable
    through a read-only history route/card; state is derived at read time
    (`revoked` > `expired` > `active`), `extended_at`/`extension_count` move only when a
    re-grant pushes the expiry later, and history never changes budgets, alerts, pauses,
    admission, or enforcement.
    `active` is a lifecycle state, not proof the scope is still a configured hard cap.
    When `notifications.events.spendOverrides` is enabled, a grant or extension while the
    scope is still `paused` and an expiry that leaves it `paused` with no other active
    override are delivered as `spend.override` events (granted/extended/expired). A
    revoke, a pre-authorized grant while not paused, and an expiry still covered by
    another override do not notify. Expiry is observed once via
    `spend_cap_overrides.expiry_handled_at` on the next evaluation; a later extension
    clears it. The overall-scope event is not cell-filtered by event routes. This is
    advisory only: it never changes budgets, alerts, pauses, admission, or the banner.
    Retained override rows are pruned by the startup/hourly `DataRetention` pass under
    `retention.spendCapOverridesDays` (default 400, `0` = forever): delete by
    `period_start` in whole UTC budget months, never prune the current month, and rely on
    `idx_spend_cap_overrides_period` rather than adding a `created_at` index.
35. **Alert delivery is advisory, idempotent, authenticated, and auditable.** One
    `budget_alert_deliveries` row per `(alert_id, destination_id)` is the dedupe record;
    never send a delivered alert twice. Webhook/email destination ids are their channel
    names; chat ids are `<provider>:<channelId>`. Rows carry the `destination_hash` they
    were enqueued under so a URL/format/secret or bot-token/channel change skips pending
    rows instead of sending them with new credentials. Each row also snapshots its alert
    (`scope`, `scope_id`, `threshold`, `alert_at_percent`, `budget_usd`, `spend_usd`,
    `unknown_cost_turns`, `alert_period_start`, `alert_created_at`,
    `alert_acknowledged_at`) at enqueue; the snapshot is immutable except for the ack
    stamp, and history never joins `budget_alerts`. There is deliberately no foreign key to
    `budget_alerts`, so deleting an alert leaves history behind; a pending row whose alert
    is gone is marked `skipped` by the drain and is never sent. Slack returns HTTP 200 with
    `{ok:false}` for failures, and Discord rate limits put `retry_after` in the body; both
    are classified explicitly. Delivery retries are bounded, failures go to
    `budget.notify` with ids only, and a notifier failure must never throw into budget
    evaluation, an HTTP handler, or a turn. Tests inject the sender; no external network
    traffic. Delivery history is a read-only view that never returns a destination,
    secret, recipient, or payload. Manual resend only re-queues `failed`/`skipped` rows for
    an unacknowledged current-month alert on an enabled, configured channel; it re-stamps
    the destination and preserves the one-row-per-alert dedupe. A delivered row is never
    resent. A row whose alert was deleted returns `409 alert_deleted` and can never be
    resent. Resend failures reuse `budget.notify` with delivery/alert ids and phase only.
    Operational events use the sibling `notification_event_deliveries` outbox, keyed
    `UNIQUE(dedupe_key, channel)` with a configurable failure window, drain through
    `notifications/service.ts`, and send classification-only payloads to the enabled
    webhook/email routes. Failed request turns, master errors, scorecard failures, and
    spend-cap override transitions are the event kinds; a scorecard cap stop, the
    already-running guard, and a deleted cell do not notify. The `kind` CHECK is extended
    by a one-time table rebuild in `db.ts`.
    Both outboxes feed one read-only history with a `source` discriminator; event rows
    expose only the safe title/text, classifications, ids, cell name, and occurrence
    time, never the raw payload. The shared resend route looks up either row; event
    resend additionally requires the kind/channel route flag and returns
    `event_disabled` when it is off, so a per-event opt-out is never bypassed. The window
    is an epoch-anchored tumbling bucket (`notifications.events.coalesceMinutes`, default
    60, allowed 1–1440), and the key includes its length and start. Optional
    `notifications.events.routes` entries limit a kind/channel to exact cell ids; no entry
    for that pair means every cell. Narrowing a route skips pending rows for excluded
    cells, and routes/windows never backfill. A delivered event is never resent; event
    failures use `notifications.event` with ids and a short reason only.
    `retention.budgetAlertsDays`
    (default 400, `0` = forever) prunes terminal delivery rows and acknowledged alerts in
    the hourly `DataRetention` pass. The effective cutoff is capped at the current UTC
    period start, so the current month is never pruned: a delivery row is the idempotency
    record and an acknowledged alert suppresses a lower-severity alert in the same
    period. Never prune `pending`/`delivering` rows, and never delete an unacknowledged
    alert through retention; reconciliation owns those. Deleting an expired acknowledged
    alert leaves its snapshotted delivery history in place; terminal delivery rows are
    bounded by the same retention setting, and orphaned pending rows are skipped by the
    notifier drain. `retention.notificationEventsDays` (default 400, `0` = forever)
    bounds terminal `notification_event_deliveries` rows in the same hourly pass; never
    prune `pending` or `delivering` event rows, and rely on `created_at` with no
    period cap because the dedupe window is at most one day while retention is whole
    days.
36. **Request workdirs are owner-only.** `$APS_DATA_DIR/requests` and each per-session
    workdir are `0700`; `transcript.json` and `session.json` are written atomically as
    `0600` through `writePrivateFile`, and the dirs through `ensurePrivateDir`. A loose
    workdir or file left by an older version is repaired on the next write. Existing
    installs are repaired in bulk with `npm run repair:permissions` (dry run by default;
    `--apply` to change); it tightens only the known `requests/` artifacts and never
    recurses into `cwd/` checkouts. Never write conversation state with a bare
    `writeFileSync`; transcripts can contain tool output and secrets.
37. **A harness-reported error result fails the turn once, visibly.** A parser `error`
    event sets `turn.failure` (first one wins), broadcasts one `error`, persists one
    `⚠` line, and logs `engine.result` with session/harness ids. Do not re-broadcast it
    from `runTurn` or retry inside the turn. `error` results include `is_error: true` and
    `error*` subtypes. The warning text is the capped provider result, never a transcript.
    A harness stdin that closes while a write is in flight (EPIPE/ECONNRESET) is the same
    turn failure, not an unhandled process error: the Claude adapter listens for stdin
    errors and refuses writes to a destroyed or ended stream, reporting once through this
    path.
38. **Terminal request artifacts expire; live work never does.**
    `retention.requestArtifactsDays` (default 30, `0` = forever) deletes
    `requests/<id>/` only for `done`/`dropped` requests older than the window, never for
    a non-terminal request, a live turn, or a reserved session id
    (`__kb__`, `__master__:*`, `__summary__:*`, `__setup__:*`). Leftover
    `worktrees/<id>` are removed with `git worktree remove --force` (the branch is kept);
    a failed sweep is one `retention.artifacts` record, not a crash.
39. **The lint gate is zero-warning and guarded.** `npm run lint` composes
    `eslint . --max-warnings=0`, `bash -n` plus `shellcheck --severity=warning` over
    `deploy/*.sh` and `scripts/*.sh`,
    `actionlint deploy/ci-workflow.yml .github/workflows/ci.yml`,
    the unit gate over `deploy/agent-process-segments.service` (`systemd-analyze verify`,
    the reviewed sandboxing directives, and the offline `systemd-analyze security`
    exposure ceiling), and
    `markdownlint-cli2 "**/*.md"`, so an ESLint or ShellCheck warning, a shell syntax
    error, a workflow error, a non-zero verify exit, any verify diagnostic naming the
    unit, a missing, changed, or forbidden hardening directive (forbidden boolean
    directives in any accepted spelling), a duplicate
    list-directive assignment, an exposure level above 4.8, or a Markdown finding fails
    the gate just like an error. The unit gate
    treats diagnostics as fatal because `systemd-analyze` exits 0 for unknown keys and
    invalid values, needs systemd 250 or newer for the security review (failing closed
    below that), is skipped with a visible line on non-Linux hosts, and fails on Linux
    when the tool is missing. The scripts, root lint devDependencies, flat-config scope
    (`src/**/*.{ts,tsx}` plus JS/MJS/CJS tooling and `.opencode` plugin sources,
    `dist`/`node_modules` ignored, unused suppressions fatal), the Markdown config
    (`.markdownlint-cli2.jsonc`: a 120-column prose cap with tables, fences, and headings
    exempt from MD013), the pinned actionlint CI install (v1.7.12 release with a SHA-256
    check; a missing local binary fails closed), the unit wrapper and parser test, the
    manual sandbox probe and its pure-helper test (never in lint or CI), and the
    CI lint step are guarded by `src/server/test/lint-gate.test.ts`,
    `src/server/test/dev-preflight.test.ts`, `scripts/verify-systemd-unit.test.mjs`, and
    `scripts/systemd-sandbox-probe.test.mjs`.
    The published `.github/workflows/ci.yml` copy is guarded against template drift by
    `src/server/test/ci-workflow.test.ts`.
    Do not weaken any of them without updating the guards and this invariant.
40. **SQLite files are owner-only.** `openDb` forces the database, `-wal`, `-shm`, and
    any `-journal` sidecar to `0600` on every open. The database is tightened before
    `journal_mode=WAL` so SQLite creates new sidecars with the same private mode, and a
    second pass repairs sidecars already on disk. A missing database parent is created
    `0700`; an existing parent (usually the repo/cwd) is never chmodded. `:memory:` keeps
    no files. A chmod failure propagates unless the caller explicitly opts out with
    `harden: false`. Maintenance paths that must not migrate use `openExistingDb`, which
    applies the same sweep before and after opening by default. A dry run passes
    `{ readonly: true, harden: false }`: SQLite cannot write content or recover/checkpoint
    the WAL, and no chmod is attempted, so an operator with read access can inspect a
    database they do not own. `--apply` opens read-write, keeps hardening, and still fails
    closed on a chmod error. This is not encryption at rest; root can still read the
    files.
41. **Never overwrite conversation state you could not parse.** A missing
    `session.json` or `transcript.json` is empty state. A file that exists but cannot be
    read (`EACCES`, `EISDIR`, ...), is invalid JSON, or has the wrong root shape is
    reported once per path per process as `engine.session.unreadable` or
    `engine.transcript.unreadable` with `session`, `file`, and a safe reason
    (`unreadable: <code>`, `invalid JSON`, `not a JSON object|array`), then moved to
    `<name>.unreadable-<timestamp>-<random>` (`0600`) before the next write. Reads
    return the empty fallback and never move or create a file. If the quarantine rename
    fails, skip the write and log `preserved: false`; never overwrite the old bytes. Do
    not log file contents, prompts, or raw parser text: transcripts can contain secrets.
    The bulk `npm run repair:permissions` scan stays exact-name and does not include
    quarantine files.
42. **Upgrade run directories and snapshots are owner-only.** `deploy/upgrade-vps.sh`
    creates (or tightens) every run directory to `0700`, and the `VACUUM INTO`
    `db-backup.sqlite` is forced to `0600`. A local `umask 077` covers creation, then
    `chmod` makes the result independent of the caller's umask and repairs a retried run;
    both fail closed. A missing `~/.aps-cutover`/`upgrades` ancestor chain is created
    `0700`; an existing shared root is not silently chmodded by the deploy script. The
    snapshot remains a normal, manually restorable SQLite database. This is not encryption
    at rest; older run directories, snapshots, and the shared root are tightened with
    `npm run repair:upgrades` (dry run by default; `--apply` to change), which scans
    `~/.aps-cutover` and `~/.aps-cutover/upgrades`, never follows a symlinked `upgrades/`,
    skips a symlinked root while still scanning through it, and never chmods `latest`.
43. **Only `db.ts` opens SQLite directly.** Under `src/server/src`, no other module may
    import `better-sqlite3` or construct `new Database(...)`. Production calls `openDb`;
    maintenance paths that must not migrate or reconcile a live brain call
    `openExistingDb`, which hardens the database and sidecars by default without touching
    schema or request state; `openExistingDb(dbPath, { readonly: true, harden: false })`
    is the non-mutating, non-chmodding open for dry runs that must inspect a database
    owned by another user. Test fixtures and the proof scripts are exempt because they use
    throwaway temp roots. `src/server/test/db.test.ts` guards the rule.
44. **The runtime dependency audit is high-severity and guarded.** CI runs
    `npm audit --omit=dev --audit-level=high` after `npm ci` and before lint, so a high
    or critical advisory in the production dependency tree fails the build; dev-only
    advisories are reported but do not gate. The step is fail-closed (no
    `continue-on-error` or shell fallback), and its exact command, runtime scope,
    threshold, and order are guarded by `src/server/test/ci-workflow.test.ts`. Do not
    weaken any of them without updating the guard and this invariant.
45. **Cutover evidence is owner-only.** `deploy/cutover-vps.sh` creates (or tightens)
    every cutover run directory under `~/.aps-cutover/runs/` to `0700`, on both the
    detached launch and the internal `--run --run-dir` path. A local `umask 077` covers
    creation, including a missing `~/.aps-cutover`/`runs` ancestor chain, and a
    `point_latest` root mkdir; existing ancestors are left alone. The explicit `chmod`
    makes the leaf independent of the caller's umask and repairs a retried run; mode
    failures fail closed. Files inside keep their current modes because the directory is
    the protection boundary. The shared `~/.aps-cutover` root is `0700` too: a missing
    root is created that way, and an existing root is repaired explicitly with either
    `npm run repair:runs` or `npm run repair:upgrades` (dry run by default; `--apply` to
    change). `repair:runs` tightens the root, `~/.aps-cutover/runs`, and each direct run
    directory, one level deep. It never follows a symlinked `runs/`, deletes, or reads run
    contents, and leaves `latest` and `upgrades/` alone; a symlinked root is skipped while
    `runs/` is still scanned through the link. `latest` needs no mode of its own because
    the `0700` root and its `0700` target run directory are the boundary. This is not
    encryption at rest.
46. **Documentation links resolve in Help.** Every local link, image, and `#fragment` in
    the root Markdown, `docs/`, `deploy/vps.md`, and `.opencode/skills` must resolve.
    `src/web/src/doc-links.test.ts` walks that corpus (`.git`, `node_modules`, and `dist`
    excluded), skips fenced blocks and inline code, and fails on a missing file, a path
    escaping the repository, a fragment on a non-Markdown target, an undefined reference
    label, or a fragment that is not an `extractHeadings` id for the target. Anchors are
    the in-app Help ids (h2/h3 only), not GitHub slugs, because Help renders these pages
    and assigns ids only to those headings. External schemes and bare `?query` targets are
    never fetched. The same test imports `HELP_MANIFEST` and checks links on pages that
    Help serves: a served page may only link another manifest page or a `?help=<slug>`
    target whose slug and `#fragment` exist in `src/server/src/docs/manifest.ts`, and the
    manifest itself must keep unique lowercase slugs, existing Markdown sources, and
    `slugForDocPath(source) === slug`. The SPA's own Help targets live in
    `src/web/src/links.ts` (`SPA_HELP_TARGETS`), and `checkSpaHelpLinks` requires every
    declared slug to be a `HELP_MANIFEST` entry and every non-null anchor an
    `extractHeadings` id of that entry's source. It also rejects a literal `?help=<slug>`
    or a quoted `HELP_MANIFEST` slug anywhere else in `src/web/src` (comments included, so
    refer to the constant by name), because components must use the typed constants rather
    than duplicating a target; `docs.ts` derives the README alias from
    `GETTING_STARTED_HELP`. Served images and local non-Markdown links must resolve to a
    regular `docs/screenshots/**` file of a type in `src/server/src/docs/assets.ts`, and
    `resolveDocImage`/`resolveDocHref` must map it to the exact `/api/docs/assets/...` URL
    for that file; any other local target fails, so use an absolute URL or inline code.
    Internal-only docs (`05-plan`, `06-refactor-audit`,
    `09-backlog`, `AGENTS.md`, skills) never render in Help, so a served page refers to
    them as inline code or an absolute GitHub URL. Run it alone with `npm run check:docs`;
    it is part of `npm test`, not `npm run lint`. External HTTP(S) destinations are
    checked only by the manual `npm run check:docs:external` (D124), which is never part
    of `npm test`, `npm run lint`, `npm run check:docs`, or CI.
47. **Workflow-file pushes need a `workflow`-scoped credential.** GitHub rejects a push
    that adds or edits a file under `.github/workflows/` from a token without the
    `workflow` scope (`refusing to allow an OAuth App to create or update workflow ...`).
    Run `npm run check:github-scope` before such a push: exit 0 is the only green light,
    exit 1 means a classic token is missing `workflow` or `repo`/`public_repo`, and exit 2
    means the credential could not be classified. The harness host's `gh` OAuth token
    currently carries only `gist`, `read:org`, and `repo`. From an interactive terminal
    run `npm run grant:github-scope`, which wraps
    `gh auth refresh -h github.com -s workflow` and re-verifies; outside a TTY it prints
    the command and exits 1 instead of blocking on the device-flow approval. Alternatively
    export `GH_TOKEN`/`GITHUB_TOKEN` with a classic PAT holding `repo` and `workflow` (or a
    fine-grained PAT with Contents and Workflows read/write). Do not add a deploy key,
    switch `origin` to SSH, or push through the API to work around the rejection; stop and
    report instead. The check lives in `scripts/check-github-scope.mjs` (tests in
    `scripts/check-github-scope.test.mjs`); the grant helper lives in
    `scripts/grant-github-scope.mjs` (tests in `scripts/grant-github-scope.test.mjs`).
48. **The suite stress run is fail-closed and leaves no suite or hog process behind.**
    `npm run test:web-stress` and `npm run test:server-stress` (`scripts/web-stress.mjs`,
    `--suite web|server`) run the full web or server suite `--runs` times (default 3)
    while `--hogs` busy-loop processes (default 4) compete. An iteration fails on a
    non-zero suite exit, a missing, empty, unparsable, or zero-test Vitest JSON report,
    or the per-iteration `--timeout` (default 600 s); the run also fails when a hog exits
    early. Do not turn any of those into a warning or a pass. Each iteration runs under
    `scripts/web-stress/suite-supervisor.mjs`, a detached group leader: the runner
    signals the recorded group on timeout or interrupt, and the supervisor SIGKILLs its
    own group when its parent disappears, so a `SIGKILL` of the runner cannot leave npm,
    its shell, or the Vitest workers running. Hogs are stopped on every exit path and
    each hog exits by itself when the runner dies; the `aps-web-stress-hog` and
    `aps-server-stress-hog` markers keep a leak findable. Keep all three layers. It is
    manual only: do not add it to `npm test` or CI, and keep its `node:test` guard in
    `test:e2e-env`.
49. **The three maintenance permission repairs share one engine.** `PermissionRepair` in
    `src/server/src/maintenance/permission-repair.ts` owns `PRIVATE_DIR_MODE`/
    `PRIVATE_FILE_MODE`, `formatMode`, the `lstat`/`stat` and kind checks, the
    symlink/`ENOENT` policy, the dry-run counters, and the only `chmod` under
    `src/server/src/maintenance`. `repair-cli.ts` owns the shared
    `--apply`/`--dry-run`/`--help` parsing, the report, the exit code, and the
    direct-run bootstrap. `repair-permissions.ts`, `repair-upgrade-permissions.ts`, and
    `repair-run-permissions.ts` only describe their trees; their CLIs only hold the
    usage text, default target, and missing-root message. Commands, flags, output, exit
    codes, and traversal must not change. A new repair uses the same scanner; the guard
    in `src/server/test/repair-permissions.test.ts` fails if another maintenance module
    mentions `chmodSync`.
50. **The top-level shell owns the single deploy rollback.** `deploy/upgrade-vps.sh` and
    `deploy/cutover-vps.sh` keep `set -E` so a failure inside a shell function reaches the
    `ERR` trap, but the trap is inherited by the redirected `npm`/build/migration
    subshells. Both `on_error()` bodies therefore exit immediately with the failing status
    when `BASH_SUBSHELL > 0`, without logging or rolling back, so the parent reports the
    line once and rolls back once; both `rollback()` bodies are one-shot (`ROLLED_BACK`),
    and upgrade's `retention_after` keeps its `PRUNED`/`BASH_SUBSHELL` single-prune guard.
    Do not drop `-E` to simplify this: it would skip rollback inside functions. The
    build-failure cases in `src/server/test/upgrade.test.ts` and
    `src/server/test/cutover.test.ts` pin exactly one failure line, rollback, restore, and
    prune.

## Extension recipes

**Add an HTTP route.** Schema in `http/server.ts` next to its neighbours, handler that
calls a repository, then a test in `test/http.test.ts` over the socket. Error mapping is
central; throw `RequestError`, `CellNotFoundError`, or `PluginError` rather than sending
status codes by hand.

**Add an MCP tool.** Register it in `src/mcp/server.ts` with a zod raw shape and an
annotation, add `mcpTool('<name>')` from `src/mcp/identity.ts` to the engine allowlist,
then a test in `test/mcp.test.ts` asserting the recorded HTTP method, path, and body.

**Add a column.** Add it to `BASE_SCHEMA` and to `COLUMNS` in `db.ts`. Indexes go after
the migrations. Add a legacy-database test in `test/db.test.ts`, because that ordering is
where it broke before.

**Add a notification channel.** Reuse `budget_alert_deliveries` rather than a second
outbox: add the channel value, a destination identity, and a sender with the same
timeout/retry/error classification. Redact every credential from `redactSettings` (the
webhook secret, SMTP password, and Slack/Discord bot tokens are redacted today), never log
a URL, recipient list, channel ID, or secret, and inject the transport in tests. Webhook,
SMTP email, and Slack/Discord bots are the current budget channels; see
`usage/budget-chat.ts` for the chat payload/classification seam and `usage/budget-email.ts`
for nodemailer. Operational event notifications use the sibling
`notification_event_deliveries` outbox and deliberately route only to webhook and email;
add a new event kind in `domain/notifications.ts`, its `EventChannelSettings` pair, the
`EventRoute` kind union, the engine/master/summary hook that observes it, a `db.ts`
migration when the `kind` CHECK changes, and the safe history projection in
`notifications/service.ts` (ids/classification only, no raw payload). The coalescing
window is global to event notifications; per-kind windows are not supported.

**Add a scorecard fact.** Extend `SummaryStats` in `summary/types.ts`, fill it in
`collectSummaryStats`, and assert it in `test/summary.test.ts`. The prompt already points
the model at the snapshot; do not let it invent a number that is not in the JSON. If the
fact needs history the database does not have, scope a durable activity log instead of
reading transcripts.

**Change the agent contract.** Extend each harness parser with a fixture test, then
route the new event through `Engine.broadcast`. Nothing in a parser may touch a process
or disk.

**Add a harness.** Implement `AgentHarness` in `clarify/harnesses/<id>.ts` (`prepare`,
`spawn`, `createParser`, `probeModels`, `fallbackModels`), add it to `HARNESS_IDS` in
`domain/harness.ts`, register it in the cached registry in `clarify/harnesses/index.ts`
behind `APS_HARNESS` (legacy `SBOX_HARNESS` alias), and add prepare plus parser tests in
`test/harness.test.ts` and a stream test. Keep per-session files inside `session.dir`,
and pin `session.json` to the adapter id so a harness switch cannot resume the wrong
session.

**Add or change a process segment.** Update `process/definition.ts`, `process/defaults.ts`
(defaults plus prompt), the UI labels, and `test/process.test.ts`. Advancement must be a
legal `canTransition` from the segment’s state; `intake` and `finalize` stay manual. A
cell policy is a snapshot: edit `cells.process_json` through `PATCH /api/cells/:id`, not
by mutating the global file.

## Next units, in order

1. **Optional chaining.** A segment can advance a request but the next segment waits for
   its idle window; add a `chain` flag only if operators want same-cycle handoff.
2. **KB embeddings.** Search is now ranked literal terms (`GET /api/kb?q=`); semantic
   recall still needs an embedding provider.

## Conventions

- ESM, `NodeNext` resolution, and `.js` suffixes on relative imports in source.
- Repositories own SQL. Handlers own validation. The engine owns process and disk.
- Tests assert behavior a client can observe, not internal calls, except MCP where the
  HTTP request is the behavior.
- Server tests must not use wall-clock `setTimeout`/`setInterval` to wait; await an
  observable condition or use fake timers. A bounded fail-fast guard needs an adjacent
  `eslint-disable-next-line no-restricted-syntax -- <reason>` exemption; the
  `no-restricted-syntax` override in `eslint.config.mjs` enforces this for
  `src/server/test`.
- Commit each green unit. Message shape: `type(scope): subject`.
- `src/web/src` is linted with the `react-hooks` `recommended-latest` preset, and
  `--max-warnings=0` makes it fatal. Keep synchronous `setState` out of effect bodies:
  call a loader inside an async closure (`void (async () => { await load(); })()`) and
  never write state before its first `await`; reset state from a changed prop with the
  guarded render-phase adjustment (`if (seen !== prop) { setSeen(prop); ... }`) instead
  of an effect. Do not add a suppression to dodge these rules.
- Update `docs/02-status.md` in the same commit that changes what is built.
- The suite totals in `AGENTS.md`, `README.md`, and `docs/02-status.md` (cases, files,
  total) are guarded by `test/doc-counts.test.ts`; update all three and the `npm test`
  comment when the totals change.
