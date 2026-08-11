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
  execFileSync('git', ['checkout', '-B', 'cw/trial', baseHead], {
    cwd: integrationPath, stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!;
    const isLast = i === branches.length - 1;
    const args = isLast
      ? ['merge', '--no-commit', '--no-ff', branch]
      : ['merge', '--no-ff', '--no-edit', branch];
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

/** Returns the integration worktree to a clean state at `baseHead`, ready for the next trial. */
export function resetIntegration(integrationPath: string, baseHead: string): void {
  try {
    execFileSync('git', ['merge', '--abort'], { cwd: integrationPath, stdio: 'ignore' });
  } catch {
    // Nothing was in progress — the common case after a clean trial.
  }
  execFileSync('git', ['reset', '--hard', baseHead], { cwd: integrationPath, stdio: 'ignore' });
}
