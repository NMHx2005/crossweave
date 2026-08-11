// src/convergence/trial.ts
import { execFileSync } from 'node:child_process';

export interface TrialResult {
  result: 'clean' | 'conflict';
  detail: string | null;
}

/**
 * Checks out a fresh `cw/trial` branch at `baseHead` in `integrationPath`
 * and merges `branches` into it in order, stopping at the first branch that
 * conflicts.
 *
 * Git will not let a second `--no-commit` merge start while a prior one's
 * `MERGE_HEAD` is still around ("You have not concluded your merge"), so
 * every branch but the last is merged with a real (if throwaway) commit —
 * `--no-ff --no-edit` — purely to clear `MERGE_HEAD` before the next merge.
 * Only the final branch is merged `--no-commit`, leaving its result staged
 * for inspection. None of this is meant to survive: `resetIntegration`'s
 * `git reset --hard` discards every trial commit, intermediate or not.
 *
 * Deliberately does NOT reset the worktree on either outcome — the caller
 * decides when to reset (Task 4's scheduler resets pairwise trials
 * immediately, but leaves a clean FULL-integration trial's merged state in
 * place long enough to run the test command against it). Call
 * `resetIntegration` explicitly once done with the result.
 */
export async function runMergeTrial(
  integrationPath: string,
  baseHead: string,
  branches: string[],
): Promise<TrialResult> {
  try {
    // Best-effort: clears a MERGE_HEAD left behind by a prior trial whose
    // caller never got around to calling resetIntegration (e.g. it kept a
    // clean full-integration result checked out to run tests against, and
    // that path was skipped). Without this, checkout -B below does not
    // clear stale merge state, and the next merge call silently misreports
    // as a conflict. Not a reset to base — just clearing in-progress state.
    execFileSync('git', ['merge', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
  } catch {
    // Nothing was in progress — the common case.
  }
  try {
    // Same reasoning as the `merge --abort` above, but for a `REBASE_HEAD` left
    // behind by a `cw land` rebase-strategy attempt whose `resetIntegration` never
    // got to run — e.g. the daemon crashed mid-rebase. Without this, a caller whose
    // OWN cleanup path never runs (`ConvergenceScheduler`'s pairwise trial loop has
    // no try/finally around `runMergeTrial`/`resetIntegration`) would otherwise find
    // this worktree stuck on every future tick, since `merge --abort` alone cannot
    // clear `REBASE_HEAD`.
    execFileSync('git', ['rebase', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
  } catch {
    // No rebase was in progress — the common case.
  }

  execFileSync('git', ['checkout', '-B', 'cw/trial', baseHead], {
    cwd: integrationPath, stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!;
    const isLast = i === branches.length - 1;
    // Non-final branches: --no-verify --no-gpg-sign is a deliberate, narrow
    // carve-out from the project's general "never bypass hooks/signing"
    // posture. It applies ONLY to this throwaway commit, made purely to
    // clear MERGE_HEAD before the next merge and erased immediately by
    // resetIntegration's hard reset. Without it, a repo's commit-msg/
    // pre-merge-commit hooks or commit.gpgsign config can reject the
    // auto-generated merge commit and silently misreport a clean trial as
    // a conflict. `cw land`'s real merge into base (a later task) must
    // keep running hooks and signing normally — this bypass never applies
    // there.
    const args = isLast
      ? ['merge', '--no-commit', '--no-ff', branch]
      : ['merge', '--no-verify', '--no-gpg-sign', '--no-ff', '--no-edit', branch];
    try {
      execFileSync('git', args, { cwd: integrationPath, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      const conflicted = execFileSync(
        'git', ['diff', '--name-only', '--diff-filter=U'],
        { cwd: integrationPath, encoding: 'utf8' },
      ).trim();
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
      } catch {
        // Nothing to abort — an unexpected non-conflict failure already left no merge in progress.
      }
      return { result: 'conflict', detail: conflicted.length > 0 ? conflicted : null };
    }
  }

  return { result: 'clean', detail: null };
}

/**
 * Returns the integration worktree to a clean state at `baseHead`, ready for the next
 * trial or land attempt.
 *
 * Both aborts are independent, best-effort attempts — a plain merge trial never
 * leaves a rebase in progress, and `cw land`'s rebase strategy (which runs entirely
 * in this worktree) never leaves a merge in progress, so at most one of the two ever
 * has anything to actually abort. `merge --abort` cannot clear `REBASE_HEAD` and
 * `rebase --abort` cannot clear `MERGE_HEAD`, so both are needed for this function to
 * self-heal from either kind of leftover in-progress state.
 */
export function resetIntegration(integrationPath: string, baseHead: string): void {
  try {
    execFileSync('git', ['merge', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
  } catch {
    // Nothing was in progress — the common case after a clean trial.
  }
  try {
    execFileSync('git', ['rebase', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
  } catch {
    // No rebase was in progress — the common case; only a failed `cw land`
    // rebase-strategy attempt leaves one behind here.
  }
  execFileSync('git', ['reset', '--hard', baseHead], { cwd: integrationPath, stdio: 'ignore' });
}
