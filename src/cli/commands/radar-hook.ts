import { defineCommand } from 'citty';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { currentWorkspaceId } from '../context.js';
import { connectOrStart } from '../../client/rpc-client.js';
import { loadConfig } from '../../core/config.js';
import { assertContained, findProjectRoot } from '../../core/paths.js';
import { NotificationGate } from '../../radar/noise.js';

interface Collision {
  sessionId: string;
  sessionName: string;
  path: string;
  symbol: string | null;
  kind: string;
}

/**
 * `cwd` is all `runRadarHook` itself has to work with — it never sees a
 * workspaceId/sessionId directly. Resolving `cwd` into those is entirely
 * the caller's job (see `radarHookCommand.run()` below); this function
 * signature deliberately does not pretend otherwise.
 */
export type RadarCheckFn = (
  cwd: string, path: string, symbol: string | undefined,
) => Promise<{ collisions: Collision[]; blocked: boolean }>;

interface PreToolUseInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: { file_path?: unknown };
}

const WATCHED_TOOLS = new Set(['Edit', 'Write']);

// Module-scoped: one hook subprocess per tool call, but a session making
// several calls in quick succession within the same `cw radar-hook`
// PROCESS shares one gate. Cross-process persistence is out of scope for
// M3 — each `cw radar-hook` invocation is a fresh process, so this really
// only coalesces within a single invocation's lifetime; the daemon-side
// retroactive path (Task 5) is where cross-call rate limiting actually
// matters, since that gate lives for the daemon's whole lifetime.
const gate = new NotificationGate();

/**
 * A hook subprocess's `cwd` is the SESSION'S WORKTREE, not the main repo
 * root — `findProjectRoot` (`git rev-parse --show-toplevel`) run from
 * inside a linked worktree returns the worktree itself, which would
 * connect to (and auto-start) an unrelated, empty daemon at
 * `<worktree>/.crossweave/daemon.sock` instead of the real project's
 * daemon. `--git-common-dir` resolves to the MAIN repo's `.git` directory
 * even from inside a linked worktree, so its parent is the project root
 * this hook actually needs. Falls back to `findProjectRoot` for anything
 * that doesn't fit the expected shape (git unavailable, or a bare/unusual
 * layout where the common dir doesn't end in `.git`) as a defensive
 * default rather than guessing further.
 */
export function resolveMainProjectRoot(cwd: string): string {
  try {
    const out = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (basename(out) === '.git') return dirname(out);
  } catch {
    // fall through to the defensive default below
  }
  return findProjectRoot(cwd);
}

function allow(additionalContext?: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    },
  });
}

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function collisionMessage(collisions: Collision[], repoRelative: string, blocked: boolean): string {
  // Defensive: today's `radar.check` formula makes `blocked === true` with an
  // empty `collisions` array unreachable, but this function must not produce a
  // nonsensical "session(s)  also have..." string if that invariant is ever
  // broken by a future caller (e.g. an ACP handler in M5b).
  if (collisions.length === 0) {
    return `crossweave Radar: blocked a write to ${repoRelative} — conditions changed before this could be fully evaluated. Retry the edit.`;
  }
  const names = [...new Set(collisions.map((c) => c.sessionName))].join(', ');
  const symbols = [...new Set(collisions.map((c) => c.symbol ?? '(whole file)'))].join(', ');
  const base = `crossweave Radar: session(s) ${names} also have divergent changes to ${repoRelative} (${symbols}).`;
  return blocked ? `${base} Blocked — this workspace's Safe Mode does not allow write-write collisions.` : base;
}

/** Exported for direct testing — see tests/cli/radar-hook.test.ts. Never throws: a hook that crashes must not block the agent. */
export async function runRadarHook(stdin: string, check: RadarCheckFn): Promise<string> {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin) as PreToolUseInput;
  } catch {
    return allow();
  }
  // `JSON.parse` succeeds for `"null"` and any JSON scalar, none of which are an
  // object — touching `input.tool_name` below would throw a TypeError outside
  // any try/catch. This hook must never throw, full stop.
  if (typeof input !== 'object' || input === null) return allow();

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined;
  if (toolName === undefined || !WATCHED_TOOLS.has(toolName)) return allow();

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const filePath = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : undefined;
  if (cwd === undefined || filePath === undefined) return allow();

  let repoRelative: string;
  try {
    // `assertContained` internally realpath-canonicalizes `cwd` before comparing,
    // but the RAW `cwd` here can be reached through a symlink (e.g. macOS's
    // `/tmp` -> `/private/tmp`, the exact case `core/paths.ts` documents). Using
    // the raw `cwd` as the base for `relative()` against the canonicalized result
    // produces a path with leading `../` segments that can never match a
    // repo-relative `file_claim` row — collisions would silently stop being
    // found. Canonicalize `cwd` the same way before computing the relative path.
    repoRelative = relative(realpathSync(cwd), assertContained(cwd, filePath));
  } catch {
    return allow(); // path escapes the worktree — not this hook's problem, and never a block
  }

  try {
    const { collisions, blocked } = await check(cwd, repoRelative, undefined);

    // Checked BEFORE the empty-collisions shortcut, not after: `blocked` is the
    // daemon's verdict and must never be silently overridden by a client-side
    // "nothing to say" shortcut — even though today's server-side formula makes
    // blocked+empty unreachable in practice, this ordering is the seam a future
    // caller (e.g. an ACP handler) must not be able to break by accident.
    // Also bypasses the noise-control gate entirely: the gate exists to cap
    // ADVISORY token spend (§4.8), and must never suppress a safety-relevant
    // deny — an agent retrying the same blocked edit must be denied every time.
    if (blocked) return deny(collisionMessage(collisions, repoRelative, true));
    if (collisions.length === 0) return allow();

    const notifiable = collisions.filter((c) => gate.shouldNotify(cwd, c.path, c.symbol));
    if (notifiable.length === 0) return allow();

    return allow(collisionMessage(notifiable, repoRelative, false));
  } catch {
    return allow(); // daemon unreachable, RPC failed, etc. — degrade silently, never block
  }
}

export const radarHookCommand = defineCommand({
  meta: { name: 'radar-hook', description: "Internal: Claude Code's PreToolUse hook entry point" },
  async run() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const stdin = Buffer.concat(chunks).toString('utf8');

    const out = await runRadarHook(stdin, async (cwd, path, symbol) => {
      // `SessionRuntime.start` injects `CW_SESSION_ID` into the agent's own
      // environment, and this hook subprocess (spawned by Claude Code, spawned
      // by the agent) inherits it — the session identity is already right
      // there, with no need to scan `session.list` and match `worktreePath`
      // strings (fragile: symlinks, trailing slashes, etc.). Unset means either
      // a daemon predating this env var or a hook invoked outside a
      // crossweave-managed session — degrade to no RPC call rather than guess.
      const sessionId = process.env.CW_SESSION_ID;
      if (sessionId === undefined) return { collisions: [], blocked: false };

      // Deliberately not `withClient`: it hard-codes `findProjectRoot(process.cwd())`
      // with no override, and `process.cwd()` here is `cwd` — the session's
      // WORKTREE, not the main repo root (see `resolveMainProjectRoot`'s doc
      // comment). Mirrors what `withClient` does internally, but against the
      // correctly-resolved root.
      const projectRoot = resolveMainProjectRoot(cwd);
      loadConfig(projectRoot);
      const client = await connectOrStart(projectRoot);
      try {
        const workspaceId = await currentWorkspaceId(client);
        return await client.call<{ collisions: Collision[]; blocked: boolean }>('radar.check', {
          workspaceId, sessionId, path, symbol,
        });
      } finally {
        client.close();
      }
    });

    process.stdout.write(out + '\n');
  },
});
