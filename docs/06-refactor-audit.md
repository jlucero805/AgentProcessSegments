# Refactor audit

A full-codebase pass over the brain and SPA: find duplication, weak abstractions, dead
code, and bugs, group the findings by cause, then fix the safe, high-value items. The
list below records what changed, what was deliberately left alone, and how to repeat the
audit.

## Systemic findings

### 1. The SPA duplicated the server contract

`src/web/src/types.ts` restated the workflow table, `Request`, `Cell`, `KbEntry`,
`TranscriptMsg`, `ClarifyEvent`, the master shapes, and the plugin shapes. The state
machine test even called itself a "mirror of the server transition table". That is a
drift trap: a new state or field lands on one side and the other silently disagrees.

**Fixed.** The web now type-imports the pure server modules (`domain/request`,
`master/types`, `plugins/types`, `clarify/models`) and re-exports them from
`types.ts`. `settings.ts` statically checks its zod schema against `MasterConfig`. The
only web-owned data left is presentation (`STATE_LABELS`, `COLUMN_*`, `columnOf`,
`AGENT_BADGE`, `timeAgo`). Vite bundles the shared modules; they must stay free of Node
imports.

**Alternative considered.** A separate `src/shared` workspace with its own build. It is
the cleaner long-term packaging, but it adds a build step and project references for one
consumer, so the direct type import is the smaller change. Revisit if a third package
needs the contract.

### 2. Sentinel sessions and MCP tool registration were copy-pasted

`KB_SESSION_ID` / `MASTER_SESSION_ID` were checked in three route handlers, and
`list_requests` / `get_request` were registered twice in the MCP server with slightly
different schemas and query builders.

**Fixed.** One `sessionTurn` helper routes start/send to the reserved sessions, one
`isVirtualSession` predicate replaces the checks, and one `registerBoardTools` helper
serves request and master scope (the only difference is the default request id). The
MCP list filter schema and query builder are now single definitions, and `STATES` /
`EFFORT_LEVELS` are imported rather than restated.

### 3. Plugin markdown/fs helpers were duplicated

`plugins/manager.ts` and `clarify/harnesses/plugin-assets.ts` each had their own recursive
walk and frontmatter description parser.

**Fixed.** `util/files.ts` owns `walkFiles`, `splitMarkdown`, `frontmatterField`, and
`markdownDescription`; both callers use it. `util/json.ts` owns the shared record guards
that were previously split between `harness.ts` and `stream.ts`.

### 4. Web transport error parsing was duplicated

`api.ts` parsed error bodies separately for JSON requests and NDJSON streams, so the two
could report different messages. NDJSON also aborted the whole turn on one non-JSON line.

**Fixed.** One `toApiError` mapper feeds both paths. Non-JSON stream lines are skipped as
transport noise.

### 6. The request drawer carried too much

`RequestDetail.tsx` mixed form mapping, patch construction, a transcript renderer, and
the workflow actions.

**Fixed.** `requestForm.ts` owns `RequestFormState`, `formFromRequest`, and
`patchFromForm` with unit tests; `TranscriptList.tsx` owns the terminal transcript.
The drawer is now focused on wiring and layout.

### 7. Both harness processes repeated line/exit plumbing

Claude and OpenCode each stored line and exit handlers, piped stderr, attached readline,
and translated child errors into a synthetic line.

**Fixed.** `clarify/harnesses/line-process.ts` owns handler storage, readline, stderr,
exit dispatch, and the error hook. Subclasses own only their spawn/write/kill lifecycle
and error-event shape.

## Bugs fixed

1. **Disposing a live turn leaked a pending promise.** A terminal transition during a
   turn killed the child and deleted the maps but never resolved `turn.promise`, so
   `finishTurn` never ran and attached streams never ended. `dispose` now cancels and
   resolves the turn; `finishTurn` saves the partial transcript and broadcasts `done`.
2. **Board drags waited for the whole agent turn.** Moving a card to Plan/Implement/
   Finalize used the streaming endpoint and awaited the turn. Workflow kickoffs now use
   `?detach=1`: the server starts the turn, returns `{started:true}`, and the chat
   reattaches to the live stream.
3. **Board allowed illegal workflow jumps.** The client now uses the shared
   `canTransition` table before calling the API, so a Clarify → Finalize drop is refused
   locally instead of producing a server 409.
4. **Requests could reference a missing cell.** Create and patch now validate a non-null
   `cellId` through `CellRepository.require`, so deleting a cell cannot leave orphaned
   filters.
5. **Slash commands rendered with two slashes.** The server returns `/plugin:command`
   while the composer added another `/`. The composer now normalizes either shape.
6. **KB search mishandled backslashes.** `escapeLike` escaped `%` and `_` but not `\`,
   which is the `ESCAPE` character; searching a Windows path matched the wrong text.
7. **A finishing turn could overwrite drawer edits.** The drawer reloaded the whole
   request after every stream, including a clean `done` that already carried fresh data.
   It now resyncs only when the stream ends without `done`.
8. **Cell rename/delete were invisible on touch.** The icon buttons relied on
   `group-hover`; they are now visible below `md`.
9. **The knowledge-base page had a fixed 22rem sidebar on phones.** The list and detail
   panes now stack vertically below `md`.
10. **Unmounting a chat left a stream applying events to a dead component.** Chat
    hydration and sends now use an `AbortController` cleaned up on unmount or prop change.
11. **An engine exception left the turn promise pending.** `finishTurn` marked the turn
    done and deleted its maps without resolving `turn.promise`, so a `runTurn` throw
    leaked the HTTP stream continuation, master settlement, and the serialized summary
    drain. `finishTurn` now resolves the promise in a `finally`, so every completion path
    settles it.

## Cleanup without behaviour change

- `RequestRepository` writes go through one helper that owns `updated_at` and column
  encoding; `edit`, transitions, status, branch, and run ids all reuse it.
- `MasterService` uses `shouldSkip`, `lastAgentText`, `note`, and `record` helpers
  instead of three copied skip branches and four copied event/note pairs.
- `respondTurn` owns the stream-or-detach choice for all four workflow kickoff routes;
  `util/errors.ts` owns the thrown-unknown message format.
- Claude and OpenCode share `LineProcess` for readline, stderr, exit, and error piping.
- `isTerminal` lives in the domain and is used by the HTTP routes and the drawer.
- Read-only OpenCode sessions now strip user `plugin`, `agent`, `command`, and `skills`
  entries, matching the "no user plugins" claim for KB/master.
- Git worktree calls have a 30 s timeout so a wedged git cannot hang a turn.
- Removed dead exports: `KB_REQUEST_ID`, the unused web `sendClarify`, the duplicated
  web `TRANSITIONS`/`STATES` constants, and the unused `AGENT_BADGE.dot`.
- `App` parses the URL once; `KbEntries` no longer issues duplicate initial searches.
- `util/preserved-copies.ts` owns the `*.invalid-<UTC>` prefix, stamp/suffix ordering,
  exclusive creation, and preserved-copy listing for both `SettingsStore` and
  `ProcessStore`; each store keeps its own flag, error key, in-memory pinning, and (for
  process) pruning.
- `maintenance/permission-repair.ts` owns the owner-only mode decision, the symlink/kind/
  `ENOENT` policy, the counters, and the only repair `chmod`; `maintenance/repair-cli.ts`
  owns argument parsing, reporting, exit codes, the cutover root parser and command
  runner, and the direct-run bootstrap for `repair:permissions`, `repair:upgrades`, and
  `repair:runs`, whose engines and CLIs are now thin tree/usage descriptions. The
  `repair:runs`/`repair:upgrades` CLIs share the runner; `repair:permissions` keeps its
  own data-directory resolution. `permission-repair.test.ts` pins the root and
  missing-child policies.

## Deferred, with reasons

- **Shared npm package vs. type-importing server sources.** See Systemic finding 1.
- **`hcRunIds` and `crUrl`.** They are persisted and exposed but nothing writes them.
  Removing them is a schema/API change, so it is left for a product decision.
- **`groomed`.** It is a manual checkbox with no enforcement. Keep until the clarify
  workflow defines what grooming gates.
- **`fastify.inject` tests.** The documented Node 22 `cookie` issue remains; tests keep
  using a real socket.
- **CI activation.** Still needs a `workflow`-scoped token; the template is ready.

## How to repeat this audit

1. Read the entry points first: `app.ts`, `http/server.ts`, the engine, the drawers.
2. Inventory duplicated literals and shapes (`grep` for state/tool/session lists, type
   names, and URL builders).
3. Look for invariants that exist in prose or tests but not in one implementation.
4. Run the suite and every smoke script before changing anything; keep a clean baseline.
5. Fix systemic causes before individual symptoms, but keep each unit small and green.
6. Add a regression test for every bug and a compile-time/shared type for every mirror.
7. Update this file and `docs/02-status.md` in the same commit.
