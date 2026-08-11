import { defineCommand } from 'citty';
import { relative } from 'node:path';
import { withClient, currentWorkspaceId } from '../context.js';
import { assertContained } from '../../core/paths.js';
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
) => Promise<{ collisions: Collision[] }>;

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

function allow(additionalContext?: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    },
  });
}

/** Exported for direct testing — see tests/cli/radar-hook.test.ts. Never throws: a hook that crashes must not block the agent. */
export async function runRadarHook(stdin: string, check: RadarCheckFn): Promise<string> {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin) as PreToolUseInput;
  } catch {
    return allow();
  }

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined;
  if (toolName === undefined || !WATCHED_TOOLS.has(toolName)) return allow();

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const filePath = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : undefined;
  if (cwd === undefined || filePath === undefined) return allow();

  let repoRelative: string;
  try {
    repoRelative = relative(cwd, assertContained(cwd, filePath));
  } catch {
    return allow(); // path escapes the worktree — not this hook's problem, and never a block
  }

  try {
    const { collisions } = await check(cwd, repoRelative, undefined);
    if (collisions.length === 0) return allow();

    const notifiable = collisions.filter((c) => gate.shouldNotify(cwd, c.path, c.symbol));
    if (notifiable.length === 0) return allow();

    const names = [...new Set(notifiable.map((c) => c.sessionName))].join(', ');
    const symbols = [...new Set(notifiable.map((c) => c.symbol ?? '(whole file)'))].join(', ');
    return allow(`crossweave Radar: session(s) ${names} also have divergent changes to ${repoRelative} (${symbols}).`);
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
      return withClient(async (client) => {
        // A hook subprocess is handed `cwd`, not a workspaceId/sessionId —
        // both are resolved here: `workspace.init` is an idempotent
        // upsert-by-root-path (findProjectRoot walks up from `cwd` inside
        // withClient), and the session is whichever row's `worktreePath`
        // matches `cwd` exactly.
        const workspaceId = await currentWorkspaceId(client);
        const sessions = await client.call<{ id: string; worktreePath: string | null }[]>(
          'session.list', { workspaceId },
        );
        const session = sessions.find((s) => s.worktreePath === cwd);
        if (!session) return { collisions: [] };
        return client.call<{ collisions: Collision[] }>('radar.check', {
          workspaceId, sessionId: session.id, path, symbol,
        });
      });
    });

    process.stdout.write(out + '\n');
  },
});
