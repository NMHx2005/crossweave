import { defineCommand } from 'citty';
import { loadConfig } from '../../core/config.js';
import { connectOrStart } from '../../client/rpc-client.js';
import { resolveMainProjectRoot } from './radar-hook.js';

interface StatusLineInput {
  cwd?: unknown;
  cost?: { total_cost_usd?: unknown };
  context_window?: { total_input_tokens?: unknown; total_output_tokens?: unknown };
}

export type ReportUsageFn = (
  cwd: string, sessionId: string, tokensUsed: number | undefined, costUsd: number | undefined,
) => Promise<void>;

function formatStatusLine(tokensUsed: number | undefined, costUsd: number | undefined): string {
  const parts: string[] = [];
  if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(4)}`);
  if (tokensUsed !== undefined) parts.push(`${(tokensUsed / 1000).toFixed(1)}k tokens`);
  return parts.join(' · ');
}

/**
 * Exported for direct testing — see tests/cli/session-usage-hook.test.ts. Never
 * throws: a broken statusLine command must not block the agent or crash Claude
 * Code's status line renderer (same "never block the agent" bar cw radar-hook meets).
 * `sessionId` is passed in already resolved (from CW_SESSION_ID by the caller below)
 * rather than read from process.env here, so the missing-session-id degrade path is
 * directly testable. `cwd` is read from the JSON payload itself, not process.cwd() —
 * same reasoning as runRadarHook: the statusLine command's own cwd could be reached
 * through a symlink or otherwise not match what resolveMainProjectRoot needs.
 */
export async function runSessionUsageHook(
  stdin: string,
  sessionId: string | undefined,
  report: ReportUsageFn,
): Promise<string> {
  let input: StatusLineInput;
  try {
    input = JSON.parse(stdin) as StatusLineInput;
  } catch {
    return '';
  }
  if (typeof input !== 'object' || input === null) return '';
  if (sessionId === undefined) return '';

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  if (cwd === undefined) return '';

  const costUsd = typeof input.cost?.total_cost_usd === 'number' ? input.cost.total_cost_usd : undefined;
  const inputTokens =
    typeof input.context_window?.total_input_tokens === 'number' ? input.context_window.total_input_tokens : undefined;
  const outputTokens =
    typeof input.context_window?.total_output_tokens === 'number' ? input.context_window.total_output_tokens : undefined;
  const tokensUsed = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;

  if (costUsd === undefined && tokensUsed === undefined) return '';

  try {
    await report(cwd, sessionId, tokensUsed, costUsd);
  } catch {
    return ''; // daemon unreachable, RPC failed, etc. — degrade silently, never crash the status line
  }

  return formatStatusLine(tokensUsed, costUsd);
}

export const sessionUsageHookCommand = defineCommand({
  meta: { name: 'session-usage-hook', description: "Internal: Claude Code's statusLine entry point" },
  async run() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const stdin = Buffer.concat(chunks).toString('utf8');

    const out = await runSessionUsageHook(stdin, process.env.CW_SESSION_ID, async (cwd, sessionId, tokensUsed, costUsd) => {
      const projectRoot = resolveMainProjectRoot(cwd);
      loadConfig(projectRoot);
      const client = await connectOrStart(projectRoot);
      try {
        await client.call('session.reportUsage', { sessionId, tokensUsed, costUsd });
      } finally {
        client.close();
      }
    });

    process.stdout.write(out);
  },
});
