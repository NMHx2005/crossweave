import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { makeGitFixture, type GitFixture } from '../helpers/git-fixture.js';
import { createWorktree } from '../../src/isolation/worktree.js';
import {
  SANDBOX_EXEC, buildSeatbeltProfile, decideSandbox, isSandboxAvailable, planSandbox,
  resolveGitDir, sandboxTmpDir, type SandboxSpec,
} from '../../src/isolation/sandbox.js';

let fx: GitFixture;
let spec: SandboxSpec;
let home: string;

beforeEach(async () => {
  fx = await makeGitFixture();
  const wt = await createWorktree(fx.root, 's_one', 'cw/one');
  home = mkdtempSync(join(tmpdir(), 'cw-home-'));
  spec = {
    worktreePath: wt.path,
    projectRoot: fx.root,
    network: false,
    sessionId: 's_one',
    branch: 'cw/one',
    platform: 'darwin',
    home,
  };
});
afterEach(async () => {
  await fx.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('isSandboxAvailable', () => {
  it('is available on darwin, and gated on bwrap for linux', () => {
    expect(isSandboxAvailable('darwin')).toBe(true);
    expect(isSandboxAvailable('linux', { hasBwrap: true })).toBe(true);
    expect(isSandboxAvailable('linux', { hasBwrap: false })).toBe(false);
    expect(isSandboxAvailable('win32')).toBe(false);
  });
});

describe('decideSandbox', () => {
  it('builds a spec when enabled on a provider platform with a worktree', () => {
    const d = decideSandbox({
      enabled: true, network: false, projectRoot: fx.root,
      worktreePath: '/tmp/wt', branch: 'cw/one', sessionId: 's_one', platform: 'darwin',
    });
    expect(d.skip).toBeUndefined();
    expect(d.spec?.worktreePath).toBe('/tmp/wt');
    expect(d.spec?.sessionId).toBe('s_one');
  });

  it('reports WHY it skipped, never silently', () => {
    const base = {
      network: false, projectRoot: fx.root, branch: 'cw/one',
      sessionId: 's_one', platform: 'darwin' as NodeJS.Platform,
    };
    expect(decideSandbox({ ...base, enabled: false, worktreePath: '/tmp/wt' }).skip).toBe('disabled');
    expect(decideSandbox({ ...base, enabled: true, worktreePath: null }).skip).toBe('no-worktree');
    expect(decideSandbox({
      ...base, enabled: true, worktreePath: '/tmp/wt', platform: 'linux', hasBwrap: false,
    }).skip).toBe('no-provider');
  });

  it('is available on linux when bwrap is present', () => {
    const d = decideSandbox({
      enabled: true, network: false, projectRoot: fx.root,
      worktreePath: '/tmp/wt', branch: 'cw/one', sessionId: 's_one', platform: 'linux', hasBwrap: true,
    });
    expect(d.skip).toBeUndefined();
    expect(d.spec?.worktreePath).toBe('/tmp/wt');
  });

  it('has no skip reason when disabled — the user asked for it, so it is not a gap', () => {
    const d = decideSandbox({
      enabled: false, network: false, projectRoot: fx.root,
      worktreePath: null, branch: null, sessionId: 's_one', platform: 'linux',
    });
    expect(d.skip).toBe('disabled');
    expect(d.spec).toBeUndefined();
  });
});

describe('buildSeatbeltProfile', () => {
  const profile = (): string => buildSeatbeltProfile(spec, home, sandboxTmpDir(fx.root, 's_one'));

  it('denies by default and grants reads', () => {
    const p = profile();
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read*)');
  });

  it('grants write to the worktree and its private temp dir', () => {
    const p = profile();
    expect(p).toContain(`(allow file-write* (subpath "${spec.worktreePath}"))`);
    expect(p).toContain(`(allow file-write* (subpath "${sandboxTmpDir(fx.root, 's_one')}"))`);
  });

  it('names the agent state in $HOME instead of all of $HOME', () => {
    const p = profile();
    expect(p).toContain(`(literal "${home}/.claude")`);
    expect(p).toContain(`(literal "${home}/.claude.json")`);
    // The blanket form is what the narrow rules exist to avoid.
    expect(p).not.toContain(`(subpath "${home}")`);
  });

  // The object store is the interesting part: a worktree commits through the MAIN
  // repo's `.git`, so a blanket read-only bind outside the worktree would break every
  // commit. These assertions pin the shape that makes commits work without opening
  // the store to arbitrary names.
  it('opens only the object path shapes git actually writes', () => {
    const gitDir = resolveGitDir(spec.worktreePath);
    expect(gitDir).toBe(join(fx.root, '.git'));
    const p = profile();
    expect(p).toContain(`(regex "^${gitDir}/objects/[0-9a-f][0-9a-f]/`);
    // tmp_obj_* is created then unlinked; a loose object is create+data only.
    expect(p).toContain('tmp_obj_[A-Za-z0-9]+$');
    const loose = /\(allow file-write-create file-write-data \(regex "\^[^"]*objects\/\[0-9a-f\]\[0-9a-f\]\//.exec(p);
    expect(loose?.[0]).toBeDefined();
    expect(loose?.[0]).not.toContain('file-write-unlink');
  });

  it('opens exactly this session\'s branch ref, not refs/heads wholesale', () => {
    const gitDir = resolveGitDir(spec.worktreePath)!;
    const p = profile();
    expect(p).toContain(`(literal "${gitDir}/refs/heads/cw/one")`);
    expect(p).not.toContain(`(subpath "${gitDir}/refs/heads")`);
  });

  it('does not open the whole .git directory', () => {
    const gitDir = resolveGitDir(spec.worktreePath)!;
    const p = profile();
    expect(p).not.toContain(`(allow file-write* (subpath "${gitDir}"))`);
    // config and hooks are the two escape hatches a sandbox must not hand over.
    expect(p).not.toMatch(/file-write\*?[^)]*\(literal "[^"]*\.git\/config"/);
    expect(p).not.toMatch(/file-write\*?[^)]*\.git\/hooks/);
  });

  it('allows the keychain mach services a logged-in agent needs', () => {
    const p = profile();
    expect(p).toContain('(allow mach-lookup');
    expect(p).toContain('com.apple.SecurityServer');
    expect(p).toContain('com.apple.securityd');
  });

  // A (deny default) profile refuses connect() on a unix socket even though the
  // socket is a file — measured. The daemon socket is how the agent's hooks reach the
  // daemon, so the session would break without this rule.
  it('allows the daemon and MCP unix sockets as connect targets', () => {
    const p = profile();
    expect(p).toContain(`(allow network-outbound (remote unix-socket (literal "${join(fx.root, '.crossweave', 'daemon.sock')}")))`);
    expect(p).toContain('cw-mcp-s_one.sock');
  });

  it('adds the network clause only when the workspace opted in', () => {
    expect(profile()).not.toContain('(allow network*)');
    const open = buildSeatbeltProfile({ ...spec, network: true }, home, sandboxTmpDir(fx.root, 's_one'));
    expect(open).toContain('(allow network*)');
  });

  it('never puts a LITERAL hyphen inside a bracket expression (sandbox-exec refuses it)', () => {
    // macOS 26.x rejects `[A-Za-z0-9._-]` with "unterminated bracket expression",
    // which made the first version of this profile fail to parse at all. A hyphen that
    // forms a range (`[0-9a-f]`, `[A-Za-z]`) is fine; a literal one — leading or
    // trailing — is not.
    const classes = profile().match(/\[[^\]]*\]/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).not.toMatch(/\[-\]]/);
      expect(cls).not.toMatch(/\[\[/);
      expect(cls).not.toContain('[-');
    }
  });

  it('falls back to resolving the branch when the caller did not pass one', async () => {
    const wt = await createWorktree(fx.root, 's_two', 'cw/two');
    const { branch: _dropped, ...withoutBranch } = spec;
    const p = buildSeatbeltProfile(
      { ...withoutBranch, worktreePath: wt.path }, home, sandboxTmpDir(fx.root, 's_two'),
    );
    expect(p).toContain('/refs/heads/cw/two');
  });

  it('omits the git rules for a path git cannot resolve', () => {
    const p = buildSeatbeltProfile(
      { ...spec, worktreePath: fx.root, branch: '' }, home, sandboxTmpDir(fx.root, 's_one'),
    );
    // FX root is a real repo, so this asserts the branch-less shape instead: no ref
    // rule is emitted when there is no branch to name.
    expect(p).not.toContain('/refs/heads/');
  });
});

describe('planSandbox', () => {
  it('returns undefined off a provider platform without a provider', () => {
    expect(planSandbox({ ...spec, platform: 'linux' } as unknown as typeof spec & { hasBwrap: boolean }, 'claude', [])).toBeUndefined();
    expect(planSandbox({ ...spec, platform: 'win32' }, 'claude', [])).toBeUndefined();
  });

  // Gated on the binary, not on `process.platform`: these two exercise "a provider
  // IS present, here is the argv it builds", which cannot be asserted on a host that
  // has no `sandbox-exec` (Linux CI). Passing `platform: 'darwin'` while running on
  // Linux describes the spec, not the machine, so `planSandbox` correctly returns
  // undefined there — and that path is already covered by the test above.
  const hasProvider = existsSync(SANDBOX_EXEC);

  it.skipIf(!hasProvider)('wraps the agent argv in sandbox-exec with a written profile', () => {
    const plan = planSandbox(spec, 'claude', ['--settings', '{}']);
    expect(plan).toBeDefined();
    expect(plan!.argv[0]).toBe(SANDBOX_EXEC);
    expect(plan!.argv[1]).toBe('-f');
    expect(plan!.argv[3]).toBe('claude');
    expect(plan!.argv.slice(4)).toEqual(['--settings', '{}']);
    expect(existsSync(plan!.argv[2]!)).toBe(true);
    expect(readFileSync(plan!.argv[2]!, 'utf8')).toContain('(deny default)');
    plan!.cleanup();
    expect(existsSync(plan!.argv[2]!)).toBe(false);
  });

  it.skipIf(!hasProvider)('lists the writable roots, and cleanup is idempotent', () => {
    const plan = planSandbox(spec, 'claude', [])!;
    expect(plan.writable).toContain(spec.worktreePath);
    expect(plan.writable).toContain(sandboxTmpDir(fx.root, 's_one'));
    expect(plan.writable).toContain(join(home, '.claude'));
    expect(existsSync(sandboxTmpDir(fx.root, 's_one'))).toBe(true);
    plan.cleanup();
    // Both the profile and the private temp dir go, or every stop/resume cycle would
    // leave one behind; planSandbox recreates the dir on the next start.
    expect(existsSync(sandboxTmpDir(fx.root, 's_one'))).toBe(false);
    plan.cleanup();
  });
});

/**
 * The profile is only as good as what it DENIES, and that is invisible from a test of
 * the text above — so these run the real `sandbox-exec` and try the escapes.
 *
 * Probed, not assumed: `sandbox-exec` cannot nest inside another sandbox (this suite
 * runs under one in some environments), so when the probe itself is refused the block
 * skips rather than reporting a red that means "the harness, not the profile".
 */

describe('bwrap (pure, no binary needed)', () => {
  it('builds a bwrap argv on linux when bwrap is present, with network gated', async () => {
    const { buildBwrapArgs } = await import('../../src/isolation/sandbox.js');
    const argsOffline = buildBwrapArgs({ ...spec, platform: 'linux', network: false } as any, home, '/tmp/cw-tmp-one');
    const flat = argsOffline.join(' ');
    expect(argsOffline[0]).toBe('bwrap');
    expect(flat).toContain('--die-with-parent');
    expect(flat).toContain('--unshare-net');
    expect(flat).toContain('--chdir');
    expect(flat).toMatch(/--bind .*\/worktrees|worktree/);
    // sockets (daemon + MCP) are bound so hooks can dial
    expect(flat).toContain('daemon.sock');
    // private tmp
    expect(flat).toContain('--bind');
    expect(flat).toContain('/tmp');

    const argsOnline = buildBwrapArgs({ ...spec, platform: 'linux', network: true } as any, home, '/tmp/cw-tmp-one');
    expect(argsOnline.join(' ')).not.toContain('--unshare-net');
  });

  it('planSandbox on linux produces a bwrap argv and is gated on hasBwrap', () => {
    const linuxSpec = { ...spec, platform: 'linux' as const, hasBwrap: true };
    const plan = planSandbox(linuxSpec as any, 'claude', ['--help']);
    expect(plan).toBeDefined();
    expect(plan!.argv[0]).toBe('bwrap');
    expect(plan!.argv).toContain('--');
    expect(plan!.argv.slice(plan!.argv.indexOf('--') + 1)).toEqual(['claude', '--help']);
    expect(plan!.writable).toContain(spec.worktreePath);

    const noBwrap = planSandbox({ ...spec, platform: 'linux', hasBwrap: false } as any, 'claude', []);
    expect(noBwrap).toBeUndefined();
  });
});

const canRunSeatbelt = (() => {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return false;
  const dir = mkdtempSync(join(tmpdir(), 'cw-probe-'));
  try {
    // Must carry the same read allowances the real profile grants: without
    // `sysctl-read`/`file-read*`, even `/bin/echo` aborts (SIGABRT) and the probe would
    // conclude the sandbox is unusable when the environment is fine.
    writeFileSync(
      join(dir, 'p.sb'),
      '(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read*)\n' +
      '(allow file-write* (subpath "' + dir + '"))\n',
    );
    execFileSync(SANDBOX_EXEC, ['-f', join(dir, 'p.sb'), '/bin/echo', 'ok'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe.skipIf(!canRunSeatbelt)('seatbelt integration (real sandbox-exec)', () => {
  /** Runs `cmd` under the session's profile and returns its exit code (non-zero = refused). */
  const run = (cmd: string, network = false): { code: number; out: string } => {
    // A fresh profile per call: planSandbox's cleanup removes the file.
    const plan = planSandbox({ ...spec, network }, '/bin/sh', ['-c', cmd])!;
    try {
      const out = execFileSync(plan.argv[0]!, plan.argv.slice(1), {
        cwd: spec.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: sandboxTmpDir(fx.root, 's_one') },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? -1, out: e.stdout ?? '' };
    } finally {
      plan.cleanup();
    }
  };

  it('allows a write inside the worktree', () => {
    const r = run(`echo hi > "${spec.worktreePath}/inside.txt" && echo WROTE`);
    expect(r.code).toBe(0);
    expect(r.out).toContain('WROTE');
  });

  it('refuses a write outside the worktree', () => {
    const outside = join(fx.root, 'escape.txt');
    const r = run(`echo no > "${outside}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  it('refuses a write into the main checkout even though it shares the repo', () => {
    const r = run(`echo no > "${fx.root}/README.md"`);
    expect(r.code).not.toBe(0);
  });

  it('refuses deleting the main checkout\'s files', () => {
    const r = run(`rm -f "${fx.root}/README.md"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(fx.root, 'README.md'))).toBe(true);
  });

  it('refuses touching the git config and planting a hook', () => {
    expect(run(`echo no >> "${fx.root}/.git/config"`).code).not.toBe(0);
    expect(run(`echo no > "${fx.root}/.git/hooks/pre-commit"`).code).not.toBe(0);
  });

  it('refuses junk at the object store root, but lets a commit land', async () => {
    expect(run(`echo no > "${fx.root}/.git/objects/evil.txt"`).code).not.toBe(0);

    const before = (await $`git rev-parse HEAD`.cwd(spec.worktreePath).quiet().text()).trim();
    const commit = run(
      `printf 'x\\n' > a.txt && git add a.txt && ` +
      `git -c user.email=t@e.dev -c user.name=t commit -q -m sandboxed && git rev-parse HEAD`,
    );
    expect(commit.code).toBe(0);
    const after = (await $`git rev-parse HEAD`.cwd(spec.worktreePath).quiet().text()).trim();
    expect(after).not.toBe(before);
  });

  it('denies the internet by default and permits it when opted in', () => {
    if (!canRunSeatbelt) return;
    // Only meaningful if curl exists; otherwise the assertion is about the harness.
    const hasCurl = (() => { try { execFileSync('/usr/bin/which', ['curl'], { stdio: 'ignore' }); return true; } catch { return false; } })();
    if (!hasCurl) return;
    // A refused connect shows up as a non-zero curl exit (6: could not resolve host).
    const closed = run('curl -s --max-time 4 -o /dev/null https://example.com');
    expect(closed.code).not.toBe(0);
  });
});
const canRunBwrap = (() => {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('which', ['bwrap'], { stdio: 'ignore' });
    // Probe that bwrap itself works (not nested in another bwrap without --unshare)
    execFileSync('bwrap', ['--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '/bin/echo', 'ok'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

describe.skipIf(!canRunBwrap)('bwrap integration (real bwrap)', () => {
  const run = (cmd: string, network = false): { code: number; out: string } => {
    const ls = { ...spec, platform: 'linux' as const, hasBwrap: true, network };
    const plan = planSandbox(ls as any, '/bin/sh', ['-c', cmd])!;
    try {
        const out = execFileSync(plan.argv[0]!, plan.argv.slice(1), {
        cwd: spec.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: '/tmp' },
      });
      return { code: 0, out };
    } catch (err: any) {
      return { code: err.status ?? -1, out: err.stdout ?? '' };
    } finally { plan.cleanup(); }
  };
  it('allows a write inside the worktree', () => {
    const r = run(`echo hi > "${spec.worktreePath}/inside.txt" && echo WROTE`);
    expect(r.code).toBe(0);
  });
  it('refuses a write outside the worktree', () => {
    const outside = join(fx.root, 'escape.txt');
    const r = run(`echo no > "${outside}"`);
    expect(r.code).not.toBe(0);
  });
});

