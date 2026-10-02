---
name: shipping-issues
description: >
  Use when explicitly asked to ship a GitHub issue, implement the next priority issue,
  or clear an issue backlog through reviewed PRs and verified merges. Covers P0-P3
  ranking, dependency ordering, isolated worktrees for an authorized parallel batch, CI
  failures, linked issue closure, follow-up findings, and cleanup.
---

# Shipping Issues

**Owns:** shipping explicitly requested issues through verified PRs and merges. **Does
not own:** issue vocabulary (`triaging-issues`), release consequences
(`release-impact`), or landing dependency bot PRs (`merge-dependabot`).

Completion requires a merged PR on the default branch, the linked issue closed, and the
required gates preserved. Record the remote-write scope authorized in the current
conversation before starting. An explicit request to invoke this shipping workflow
covers its in-scope labels, branches, pushes, PRs, follow-up issues, design comments,
and merges; a request to create only a PR stops at the PR. Reading this skill during
analysis supplies no authorization. Green CI proves readiness within that scope.

**REQUIRED:** `triaging-issues` when changing issue labels; `release-impact` for every
PR body. In Codex, load `managing-git-github-workflows` first and use the connected
GitHub integration for supported remote operations. Bundled scripts using `gh` are a
fallback when the integration cannot perform the operation.

## Modes and working rules

- No argument: ship the highest-priority ready issue, then eligible output produced by
  that run, to depth one.
- `all`: ship ready issues in dependency-then-priority order.
- An issue number: ship that issue once its dependencies are satisfied.
- A user-specified count or concurrency sets the batch limit. Parallel implementation
  needs explicit authorization and a separate checkout per issue; keep Git mutations, PR
  operations, merges, and cleanup serialized in the parent.
- Preserve unrelated changes. Determine who owns an unexpected change before acting.
- Keep artifacts and logs in the run-state directory outside the checkout, as described
  in [run-record.md](references/run-record.md).
- Obey the host's permissions and repository rules. Preserve source and evidence when an
  action is denied; do not replace it with another spelling or move.
- Every command runs with its working directory set to the intended checkout. Use
  `git <subcommand>` there, and preserve hooks.
- Resolve the bundled scripts relative to the directory containing this loaded SKILL.md.
  References that use `CLAUDE_SKILL_DIR` assume Claude Code; on another host substitute
  that resolved skill directory.

## Workflow

### 1. Plan — one call

Run the bundled `plan.py` with `--mode <all|single|N>` and `--record`; pass the
requested filters and concurrency. Interpret its output using
[plan-output.md](references/plan-output.md).

A blocked preflight stops the run. Confirm the proposed verification command against the
actual project gate and run a minimal ordinary check to discover output and hook
destinations before lengthy work. Read current issue bodies and dependency edges.

### 2. Label the unlabeled — only when the plan says so

Use [priority-rubric.md](references/priority-rubric.md) and
[dependency-triage.md](references/dependency-triage.md). A few clear cases can be ranked
inline; intertwined priorities may use an authorized research worker from
[priority-research.md](references/agents/priority-research.md). Apply only labels within
the recorded write scope and refresh the plan.

### 2b. Decide a design that gates the pick

A design-blocked issue is implemented only when explicitly selected or included. Resolve
it using [dependency-triage.md](references/dependency-triage.md#deciding-a-held-design).
A product decision without evidence remains a question for the user.

### 2c. Confirm the proposed batch

Review actual paths, shared configuration, generated outputs, and dependency edges. Use
the narrower grouping when research and the planner disagree. Provision the first
worktree and inspect its baseline before provisioning the rest. The viability decision
belongs to the caller: [worktree-parallelism.md](references/worktree-parallelism.md).

### 3. Implement

One issue produces one branch and one PR, starting from the verified default branch. Run
the confirmed baseline once per checkout and save the log. Use
[implementation.md](references/agents/implementation.md) for authorized delegation, with
[delegation-templates.md](references/delegation-templates.md) and
[cost-discipline.md](references/cost-discipline.md). Use models available on the host;
Claude model names in references are specific to Claude Code.

Judge every returned acceptance criterion and unresolved decision. Reuse a worker rather
than spawning a replacement when its report is missing. At most two repair turns follow
its first attempt; an unmet acceptance criterion remains outstanding.

### 4. Review the branch

Review before creating the PR. Use the host's available review capability or
[review-fallback.md](references/agents/review-fallback.md). Check that the reviewer
actually read test and gate changes before accepting an empty report.

Number findings before handing them to [review-fix.md](references/agents/review-fix.md).
Triage against issue scope, inspect the resulting diff, and rerun affected checks after
repairs. Each parallel repair stays in its own worktree. Preserve out-of-scope findings
for step 8.

### 5. Open the PR

Within the authorized scope, commit through the hooks, push, and create the PR against
the default branch. Use the repository's PR template, the implementation summary,
`Closes #N`, validation evidence, and the required release-impact statement. Verify the
head, base, and closing link. Attach the created PR to the current task when the host
supports that attachment.

### 6. CI to green

Wait for checks belonging to the current PR head. The bundled `ci_watch.sh` is the
fallback watcher; save its output and inspect the verdict rather than raw log dumps. A
pass requires every expected check to be registered and successful.

Handle failures through [recovery.md](references/recovery.md#ci-fails) and
[ci-repair.md](references/agents/ci-repair.md), with at most three repairs. `NO_CHECKS`,
`ERROR`, and stale results supply no merge evidence.

### 7. Merge and confirm the issue closed

Merge only within the recorded authorization, after checking the current head and
required reviews. The bundled `land_pr.sh` is a fallback; interpret every result using
[landing-outcomes.md](references/landing-outcomes.md). Verify the PR merged, its base
branch, the linked issue closed, and the default branch updated.

Bring remaining parallel branches up to date in their own checkout before creating their
PRs. Inspect conflicts rather than resetting or force-pushing.

### 8. Close out the findings the run turned up

Use [filing-followups.md](references/filing-followups.md) before filing anything. Fix an
in-scope finding in the current diff; file an authorized follow-up for the rest, or
report it when remote writes are unavailable. Assign its priority and readiness contract
using [ship-contract.md](references/ship-contract.md).

### 8b. Unblock held designs in the background

When delegation and design comments are authorized, use
[design-decision.md](references/agents/design-decision.md). Cap in-flight design work at
the available host slots. A deferred decision keeps its block and returns the open
question; it does not block unrelated implementation.

### 8c. Take the run's own output back into the queue

Refresh the plan and consider only ready output produced by this run, to depth one and
within its remaining budget. Follow-ups of follow-ups wait for a later run. Single mode
does not expand into an unrelated backlog.

### 9. Clean up

Use [closing-out.md](references/closing-out.md#cleanup-scope). Preview cleanup and
restrict it to branches and worktrees created by this run. Pass every branch explicitly
to `cleanup_run.sh`; never rely on its broader default selection.

Preserve ignored files that are still needed. Check each reported failure and verify
worktree registration after cleanup. An exit-zero summary with partial failures is
incomplete. Ask only for a necessary action outside the recorded authorization.

### 10. Report

State verified PR and issue outcomes, acceptance criteria still unmet, findings left
open, deferred design questions, and retained source or evidence. Reporting details:
[closing-out.md](references/closing-out.md#what-the-report-must-not-omit).

## Stop conditions

Stop for a blocked preflight, an unresolved dependency cycle or product decision,
unexpected changes owned by someone else, or the same CI failure beyond the repair
ceiling on two issues. Preserve the checkout and evidence. In `all` mode, one failed
issue may be recorded while unrelated ready issues continue.
