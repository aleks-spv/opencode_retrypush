---
slug: retrypush-pr2-pr3
status: awaiting-approval
intent: clear
review_required: false
pending-action: write .omo/plans/retrypush-pr2-pr3.md
approach: Merge PR #2 (fix agent/model preservation) into main first, then merge PR #3 (automatic retry-wait cap, stacked on #2) into main. Both PRs are from the same author (mahille), target main, and have passing local tests + clean builds. Post-merge verification on a worktree.
---

# Draft: retrypush-pr2-pr3

## Components (topology ledger)

| id | outcome (one line) | status: active | evidence path |
|----|--------------------|----------------|---------------|
| C1 | PR #2 fix: preserve original agent/model when replaying retrying sessions | active | github:aleks-spv/opencode_retrypush/pull/2 + diff src/index.ts:4-60, test/retry-now-plugin.test.ts:216-293 |
| C2 | PR #3 feat: configurable automatic retry-wait cap (maxRetryWaitMs) | active | github:aleks-spv/opencode_retrypush/pull/3 + diff src/index.ts:1-180, test/retry-now-plugin.test.ts:244-514 |
| C3 | Merge orchestration: order #2→#3, land to main, post-merge verification | active | repo main branch sha 139fe25c9 + PR base refs |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
|------------|-----------------|-----------|---------------|
| Merge method = squash | squash | each PR is one logical unit; #2 is 1 commit, #3 is 2 commits. Clean history, single SHA. | fully — can re-merge with merge/branch-and-merge |
| CI verification skipped (no CI exists) | no-op | checked: both PRs have 0 check runs; repo has no GitHub Actions/workflows. Local test/build claims are the only evidence. | reversible — if user wants CI, add before landing |
| No release/tag required in this plan | scope out release mechanics | user asked for fix plan, not release ops | can add later |

## Findings (cited - path:lines)

1. **Issue #1 is a real bug**: `/retry-now` replays subagent sessions via `promptAsync` with only `parts` — `info.agent`/`info.model` dropped → subagent resumes as orchestrator default agent/model.
   - Source: github issue #1 body, root-cause analysis at `src/index.ts` (before fix) lines 4-7.

2. **PR #2 fix is clean and correct**: renames `lastUserParts`→`lastUserPrompt`, returns `{ parts, agent?, model? }`, validates model shape `{ providerID, modelID }`, conditionally spreads into body. Back-compat: absent keys omitted entirely.
   - Source: `src/index.ts` diff:4-60 (new types + function), diff:53-94 (call sites). Tests: `test/retry-now-plugin.test.ts` diff:216-293 (3 new tests: agent+model preserved, agent-only preserved, absent fields omitted).
   - PR body claims 10/10 tests pass, build clean.

3. **PR #3 is a substantial feature stacked on #2**: `maxRetryWaitMs` option (default 300000ms), event-driven (no startup `session.status()` probe — avoids bootstrap deadlock), usage-limit exclusion, bounded 3-bounce budget, transient-idle guard, unref'd timers, `dispose()` cleanup.
   - Source: `src/index.ts` diff:1-180 (cap logic + event hook), diff:256-295 (manual retry path reused with `replayPrompt`). Tests: `test/retry-now-plugin.test.ts` diff:244-514 (34 test cases incl. fake-timer scenarios). README updated.
   - PR body claims 34/34 tests pass, build clean.

4. **Both branches diverge from same base** `fcfb791` → merging #2 first then #3 should auto-resolve the shared `lastUserPrompt` section (identical code in both diffs), with #3's cap additions landing cleanly on top.
   - Source: both PR diffs show base index `fcfb791`.

5. **Same author** (`mahille`) for issue + both PRs → coherent ownership, no external contributor coordination needed.

6. **No CI pipeline exists** in this repo — verified 0 check runs on both PRs, no workflows in the repo. Local test/build claims are the sole verification evidence.

## Decisions (with rationale)

| decision | choice | rationale |
|----------|--------|-----------|
| Merge order | #2 first, then #3 | #3's `replayPrompt` and `lastUserPrompt` are identical to #2 — merging #2 first makes #3 a clean atop. PR #3 body explicitly says "stacked on #2, please merge that first." |
| Merge method | squash-merge | each PR = one logical change; preserves single-SHA landings with full description. |

## Scope IN

- Land PR #2 (fix) and PR #3 (feature) into `main` in dependency order (#2 → #3).
- Resolve merge conflicts if any (expected: none — shared `lastUserPrompt` code is identical).
- Post-merge verification on a worktree: `npm install`, `npm test`, `npm run build` on `main` HEAD to confirm integration.

## Scope OUT (Must NOT have)

- No release tagging / changelog bump — out of scope for this fix plan.
- No changes to PR code or test modifications — review-only, no edits to product code.
- No additional feature work beyond what both PRs already ship.
- No backport branch creation unless user asks (no target version specified).

## Open questions

None that block the plan. The only optional fork (merge method: squash vs merge vs rebase) is defaulted to squash; user can override at the gate.

## Approval gate

status: awaiting-approval
approach: squash-merge PR #2 then PR #3 into main, resolve conflicts (expected none), run post-merge verification on worktree.
next workflow action: user approves → write `.omo/plans/retrypush-pr2-pr3.md` → Metis gap analysis → self-review → handoff.
