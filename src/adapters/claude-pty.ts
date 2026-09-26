import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnforcementTier } from '../db/repositories/session.js';
import { planSandbox } from '../isolation/sandbox.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';
import { spawnInPty } from './pty.js';

/**
 * The full shell command that invokes a `cw` subcommand — `spawn` runs inside
 * the daemon process, whose PATH is whatever the client forwarded (see
 * `clientEnv` in methods.ts), which may not include wherever `cw` itself was
 * installed, so this cannot just be the bare command name in every case.
 * Generalized from M3's `radarHookInvocation` (same three-tier resolution, now
 * parameterized by subcommand) so M6a's statusLine command can reuse it instead of
 * duplicating the resolution logic.
 *
 * Three tiers, most to least specific, mirroring `resolveDaemonEntry` in
 * `client/rpc-client.ts` (same compiled-vs-source problem, same fix):
 * 1. In a COMPILED build, `process.execPath` is this very `cwd` binary's own
 *    path (a Bun-compiled standalone executable reports itself, not the Bun
 *    runtime) — `scripts/build.ts` always places `cw` and `cwd` side by
 *    side, so a sibling `cw` next to it is the release layout, and that
 *    sibling IS directly executable.
 * 2. In DEV (`bun run`), `process.execPath` is wherever `bun` itself lives,
 *    which tier 1 would resolve wrongly — `import.meta.url` instead points
 *    at this module's own real source location, and `cw`'s entry point is
 *    the sibling `src/cli/index.ts`. That source file is checked into git
 *    WITHOUT an executable bit, so it cannot be run directly — the command
 *    must go through the interpreter that is currently running this very
 *    process (`process.execPath`, i.e. `bun`), with the source path passed
 *    as its argument, exactly like `resolveDaemonEntry` does for the
 *    daemon's own source-mode case.
 * 3. Neither guess matches (e.g. a global install with the two binaries in
 *    different directories) — fall back to the bare command name and let
 *    PATH resolve it, same as any other sibling-CLI convention.
 */
function cwInvocation(subcommand: string): string {
  const siblingOfExecutable = join(dirname(process.execPath), 'cw');
  if (existsSync(siblingOfExecutable)) return `${siblingOfExecutable} ${subcommand}`;

  const siblingSource = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  if (existsSync(siblingSource)) return `${process.execPath} ${siblingSource} ${subcommand}`;

  return `cw ${subcommand}`;
}

function radarHookSettings(): string {
  return JSON.stringify({
    hooks: {
      // Bash is watched too, but ADVISORY ONLY — its file effects are guessed from the
      // command string, and a guess must never deny. See
      // docs/superpowers/specs/2026-09-17-tier-coverage-honesty-design.md §3.1, and
      // src/adapters/coverage.ts for what the tier advertises.
      PreToolUse: [
        {
          matcher: '^(Edit|Write|Bash)$',
          hooks: [{ type: 'command', command: cwInvocation('radar-hook'), timeout: 5 }],
        },
      ],
      // PostToolUse closes the debounce window: the claim exists before the next tool
      // call can ask about it, with this call's own attribution attached (spec §3.4).
      PostToolUse: [
        {
          matcher: '^(Edit|Write|Bash)$',
          hooks: [{ type: 'command', command: `${cwInvocation('radar-hook')} post`, timeout: 5 }],
        },
      ],
    },
    // M6a: reuses the exact same --settings JSON crossweave already injects for the
    // PreToolUse hook (design doc §2) — no new spawn-time surface.
    statusLine: {
      type: 'command',
      command: cwInvocation('session-usage-hook'),
    },
  });
}

/**
 * Tier T2: drives Claude Code over a pty, but with a real interception point —
 * every invocation gets a `PreToolUse` hook (`radarHookSettings` below) that can
 * allow OR deny a tool call. That is exactly what the roadmap defines T2 to mean
 * (`docs/superpowers/specs/2026-08-09-crossweave-design.md` §4.10: "Claude Code
 * natively (hooks + headless SDK + MCP), giving T2") — this adapter was mislabeled
 * T3 from M0, before M3 wired the hook up; M5a corrects the label to match the
 * capability. T1 (ACP's structured permission boundary) is stronger still: the
 * hook's `matcher: 'Edit|Write'` cannot see a file write made through the `Bash`
 * tool, a blind spot ACP's boundary does not have.
 */
export class ClaudePtyAdapter implements AgentAdapter {
  readonly kind = 'claude';
  readonly enforcementTier: EnforcementTier = 'T2';

  constructor(
    private readonly command = 'claude',
    private readonly args: string[] = [],
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    // The settings JSON is part of THIS adapter's argv, so the sandbox line is
    // assembled here rather than in the daemon (see SpawnOptions.sandbox).
    // Radar's --settings stays last, after the user's flags (validateLaunchArgs
    // refuses a user --settings outright, so T2 cannot be switched off from here).
    const agentArgs = [
      ...this.args,
      ...(opts.extraArgs ?? []),
      ...(opts.resumeId === undefined ? [] : ['--resume', opts.resumeId]),
      '--settings', radarHookSettings(),
    ];
    const plan = opts.sandbox === undefined ? undefined : planSandbox(opts.sandbox, this.command, agentArgs);
    return spawnInPty(plan?.argv ?? [this.command, ...agentArgs], opts, plan?.cleanup);
  }
}
