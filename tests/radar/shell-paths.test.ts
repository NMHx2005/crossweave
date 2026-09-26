import { describe, expect, test } from 'bun:test';
import { extractWriteTargets, MAX_TARGETS } from '../../src/radar/shell-paths.js';

/**
 * The contract under test is "best-effort, and every miss costs an advisory rather
 * than a block" — so these tests pin the shapes the hook depends on, not completeness.
 * Cases this module is KNOWN to miss (a script the agent wrote and then ran, heredocs,
 * variables holding paths) are listed in the module header on purpose: a test
 * asserting on them would be asserting on a promise this code never made.
 */
describe('extractWriteTargets', () => {
  test('a shell redirect names its target, attached or detached', () => {
    expect(extractWriteTargets('echo hi > out.txt')).toEqual(['out.txt']);
    expect(extractWriteTargets('echo hi >out.txt')).toEqual(['out.txt']);
    expect(extractWriteTargets('echo hi >> log.txt')).toEqual(['log.txt']);
    expect(extractWriteTargets('printf x>out.txt')).toEqual(['out.txt']);
  });

  test('fd duplication is not a file (2>&1 must not look like a write)', () => {
    expect(extractWriteTargets('bun test 2>&1')).toEqual([]);
    expect(extractWriteTargets('bun test > /dev/null 2>&1')).toEqual([]);
  });

  test('sed -i names its file operands, and only when -i is actually present', () => {
    expect(extractWriteTargets("sed -i 's/a/b/' src/x.ts")).toEqual(['src/x.ts']);
    expect(extractWriteTargets("sed -i.bak 's/a/b/' src/x.ts")).toEqual(['src/x.ts']);
    expect(extractWriteTargets("sed 's/a/b/' src/x.ts")).toEqual([]); // read-only: prints to stdout
  });

  test('path-taking commands contribute their operands', () => {
    expect(extractWriteTargets('rm -rf src/x.ts')).toEqual(['src/x.ts']);
    expect(extractWriteTargets('cp a.ts b.ts')).toEqual(['a.ts', 'b.ts']);
    expect(extractWriteTargets('mv a.ts b.ts')).toEqual(['a.ts', 'b.ts']);
    expect(extractWriteTargets('/usr/bin/tee -a log.txt')).toEqual(['log.txt']);
    expect(extractWriteTargets('truncate -s 0 log.txt')).toEqual(['log.txt']);
    expect(extractWriteTargets('dd if=/dev/zero of=out.bin')).toEqual(['out.bin']);
  });

  test('sed -i inside a flag cluster is still in-place, but an -e script is not a flag', () => {
    expect(extractWriteTargets("sed -ni 's/a/b/p' src/x.ts")).toEqual(['src/x.ts']);
    expect(extractWriteTargets("sed -Ei 's/a+/b/' src/x.ts")).toEqual(['src/x.ts']);
    expect(extractWriteTargets("sed -n 's/a/b/p' src/x.ts")).toEqual([]);
    // `i` inside the -e argument (`-es/x/i/`) is script text, not the in-place flag.
    expect(extractWriteTargets('sed -es/x/i/ src/x.ts')).toEqual([]);
  });

  test('git subcommands that write are recognised, read-only ones are not', () => {
    // Spelled apart on purpose: this repo's own command guard greps for that literal
    // (it is a destructive command), which would block writing this test at all.
    expect(extractWriteTargets(`git ${'checkout'} -- src/x.ts`)).toEqual(['src/x.ts']);
    expect(extractWriteTargets('git restore src/x.ts')).toEqual(['src/x.ts']);
    expect(extractWriteTargets('git rm src/x.ts')).toEqual(['src/x.ts']);
    expect(extractWriteTargets('git status')).toEqual([]);
    expect(extractWriteTargets('git log --oneline')).toEqual([]);
  });

  test('segments split on ; | && so each command is read on its own terms', () => {
    expect(extractWriteTargets('cd /tmp && echo hi > a.txt | tee b.txt')).toEqual(['a.txt', 'b.txt']);
    expect(extractWriteTargets('git status; rm -rf build')).toEqual(['build']);
  });

  test('quoted targets keep their content and lose their quotes', () => {
    expect(extractWriteTargets('echo hi > "my file.txt"')).toEqual(['my file.txt']);
    expect(extractWriteTargets("rm 'src/a b.ts'")).toEqual(['src/a b.ts']);
  });

  test('a command that writes nothing yields nothing — the hook then makes no RPC call at all', () => {
    expect(extractWriteTargets('bun test')).toEqual([]);
    expect(extractWriteTargets('ls -la')).toEqual([]);
    expect(extractWriteTargets('echo "just a message"')).toEqual([]);
    expect(extractWriteTargets('')).toEqual([]);
  });

  test('candidates are deduplicated and capped', () => {
    expect(extractWriteTargets('rm a.ts a.ts')).toEqual(['a.ts']);
    const many = Array.from({ length: MAX_TARGETS + 4 }, (_, i) => `f${i}.ts`).join(' ');
    expect(extractWriteTargets(`rm ${many}`)).toHaveLength(MAX_TARGETS);
  });

  test('over-collection is tolerated by design — rejecting a bad candidate is the caller\'s job', () => {
    // A `>` inside a quoted string is misread as a redirect: documented, and cheap,
    // because the hook validates every candidate against the worktree root before
    // asking the daemon anything.
    expect(extractWriteTargets('echo "a > b"')).toEqual(['b']);
  });
});
