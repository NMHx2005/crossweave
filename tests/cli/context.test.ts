import { describe, it, expect } from 'bun:test';
import { fail } from '../../src/cli/context.js';
import { CrossweaveError } from '../../src/core/errors.js';

describe('fail', () => {
  // Regression: fail() collapses [\r\n] and trims. A lone \r with no adjacent \n is
  // exactly the case that distinguishes the real regex (/\s*[\r\n]+\s*/g) from the
  // mutated one (/\s*\n\s*/g): no wrapped subprocess error observed so far in the CLI
  // actually contains a bare \r (git never emits one, and it sanitizes \r out of a
  // worktree lock's --reason field too — see tests/cli/cli.test.ts), so an indirect,
  // git-driven repro cannot catch this. Only a direct call can.
  it('collapses a lone carriage return into one clean stderr line', () => {
    // bun:test's spyOn does not intercept process.exit or process.stderr.write here —
    // both are effectively no-ops under it (calls go untracked, verified separately).
    // Reassign directly instead.
    const originalWrite = process.stderr.write;
    const originalExit = process.exit;
    const writes: string[] = [];
    const exitCodes: Array<number | undefined> = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number): never => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit;

    try {
      fail(new CrossweaveError('SOME_CODE', 'line one\rline two'));
    } finally {
      process.stderr.write = originalWrite;
      process.exit = originalExit;
    }

    expect(exitCodes).toEqual([1]);
    expect(writes).toEqual(['SOME_CODE: line one line two\n']);
  });
});
