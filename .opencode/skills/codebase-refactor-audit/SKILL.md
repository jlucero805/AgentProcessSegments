---
name: Codebase Refactor Audit
description: Use when asked to research a codebase for refactors, cleanup, simplification, duplication, dead code, systemic issues, or bugs, and then implement the safe fixes. Runs a read-only audit first, categorizes findings by cause, then ships small green units with tests.
---

# Codebase Refactor Audit

A disciplined pass from "find things" to "fix things". Do not start editing until the
inventory and categorization are done.

## Principles

1. **Research before edits.** Read the entry points, not just the files named in the
   request.
2. **Behavior first.** A refactor keeps observable behavior; a bug fix changes it on
   purpose and gets a regression test.
3. **Fix causes, not symptoms.** If three call sites repeat a rule, put the rule in one
   place before touching the call sites.
4. **Small green units.** One concern per commit; typecheck and tests after each.
5. **Preserve contracts** unless the user agreed to break them. Schema, API, and file
   layout changes are product decisions.
6. **Leave a paper trail.** Record fixed vs. deferred items and the alternatives you
   rejected.

## Phase 1: inventory (read-only)

Start from a clean baseline:

```bash
git status -sb
npm test            # or the project's equivalent
npm run typecheck
npm run build
```

Then map the code:

```bash
# File sizes are a proxy for "too many responsibilities".
find src -type f \( -name '*.ts' -o -name '*.tsx' \) | xargs wc -l | sort -n

# Entry points and wiring.
sed -n '1,200p' src/server/src/app.ts
sed -n '1,260p' src/server/src/http/server.ts

# Suspicious markers.
grep -rn "TODO\|FIXME\|HACK\|eslint-disable\|@ts-ignore\|@ts-expect-error" src

# Duplicated domain literals and shapes.
grep -rn "as const\|Record<\|z.enum\|type .* = '" src | head -100

# Dead or unused exports (check each hit, not just the definition).
grep -rn "export function\|export const\|export interface\|export type" src
```

Read the core files top to bottom and write one line per file: what it owns, what it
leaks into other layers, and what is obviously copied.

## Phase 2: categorize

Put every finding in one of these buckets. The category determines the fix.

| Bucket | Symptoms | Usual fix |
| --- | --- | --- |
| Duplicated contract | Same union, state table, request shape, or event type in two packages | One pure source module; import/re-export it; add a compile-time guard |
| Duplicated rule | The same validation, URL builder, auth check, or formatting in several handlers | One helper at the boundary; callers pass only data |
| Duplicated plumbing | Copy-pasted file walking, JSON parsing, process spawning, error mapping | Extract a small module with a narrow interface |
| God component/file | One file mixes data loading, form state, transport, and rendering | Extract pure mapping/state helpers first, then presentation |
| Dead surface | Exports, fields, endpoints, or branches nothing calls | Remove when safe; defer stored/schema fields to a product decision |
| Correctness bug | Leaks, races, unresolved promises, wrong escaping, orphaned references | Regression test, then fix the lifecycle/validation point |
| UX/mobile bug | Controls only visible on hover, fixed-width panes, blocking waits | Make it responsive and non-blocking; verify at a phone width |
| Robustness gap | No timeout, unguarded parse, unbounded growth | Add the smallest guard and a test |

For each item record:

```text
Finding:       one sentence
Evidence:      file:line references
Cause:         which systemic bucket
Blast radius:  callers, data, public API
Fix:           smallest change that removes the cause
Risk:          what could regress
Test:          what proves it
```

## Phase 3: prioritize

1. **Lifecycle/leak/race bugs** that can hang a request or lose data.
2. **Duplicated contracts** that can drift silently.
3. **Boundary/validation bugs** that corrupt state.
4. **Blocking UX and mobile breakage**.
5. **Safe cleanup** (dead exports, extracted helpers, naming).
6. **Deferred items** that need a product or schema decision.

Do not bundle a schema migration into a "cleanup" commit.

## Phase 4: execute

For each unit:

1. Write the failing test first when fixing a bug. For a pure extraction, add a test
   around the extracted function's public behavior.
2. Make the smallest change that removes the cause. If a shared type is the fix, add a
   compile-time assertion that the runtime schema matches it.
3. Run in this order: workspace typecheck, focused test file, full test suite, build,
   then available smoke scripts.
4. Inspect the diff for accidental scope creep (`git diff --stat`).
5. Commit with a scoped message and explain the behavioral change and the trade-off.

Useful checks:

```bash
npm run typecheck
npm test
npm run build
git diff --stat
```

If the project has browser or protocol smokes, run them. If one cannot run because a
binary or credential is missing, say so explicitly and do not claim it passed.

## Phase 5: report

Write or update an audit document with:

- Systemic findings, each with the fix and the rejected alternative.
- Bugs fixed, each one sentence plus the regression that covers it.
- Cleanup with no behavior change.
- Deferred items with the reason (product decision, schema change, missing credential).
- How to repeat the audit.

Update status/decision docs in the same change. If the audit produced a reusable
pattern, add it to the project's agent notes or skills.

## Guardrails

- Treat unfamiliar files and uncommitted changes as the user's work; investigate before
  overwriting.
- Do not "clean up" formatting across unrelated files.
- Do not add a dependency to solve a ten-line problem.
- Do not silently change an API, database column, or on-disk format.
- Do not let a refactor hide a bug fix; separate commits make review possible.
- Verify cross-package imports in both dev and production builds, not just typecheck.
- Keep comments about *why*; delete comments that only restate the code.
