import { defineCommand } from 'citty';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import {
  installHooks, removeHooks, cwHookPrefix, DONE_NOTIFY_ARGS, ASK_NOTIFY_ARGS,
  nodeHooksIo, agentWiring, SUPPORTED_AGENTS,
  type HookInstallOutcome, type HookRemoveOutcome, type HooksIo,
} from '../../core/agent-hooks.js';
import { fail } from '../context.js';
import { CrossweaveError } from '../../core/errors.js';

/**
 * `cw hooks install <agent>` — write the entries that make an agent's own hooks call
 * `cw notify`, so status is exact instead of guessed from the screen. Everything the
 * command would write is printed first; nothing user-typed is interpolated (the
 * entries are fixed strings; only the cw binary's own path is resolved).
 * Safety rules: docs/superpowers/specs/2026-10-01-ai-debug-loop-design.md §1.
 */
export const hooksCommand = defineCommand({
  meta: {
    name: 'hooks',
    description: "Install (or take back) the hook entries that make an agent's own hooks call `cw notify` — exact done/ask marks on the rail. The agent's own config is merged, backed up, and never rewritten wholesale.",
  },
  args: {
    action: { type: 'positional', required: true, description: 'install or remove' },
    agent: { type: 'positional', required: true, description: 'claude or codex' },
    yes: { type: 'boolean', alias: 'y', description: 'Skip the confirmation (needed when output is piped)' },
  },
  async run({ args }) {
    try {
      await runHooksAction(
        typeof args.action === 'string' ? args.action : '',
        typeof args.agent === 'string' ? args.agent : '',
        args.yes === true,
        { home: homedir() },
      );
    } catch (err) {
      fail(err);
    }
  },
});

/** The whole action, one level down so tests (and the citty shell) can drive it with an explicit home. */
export async function runHooksAction(
  action: string,
  agent: string,
  yes: boolean,
  deps: { home: string; prefix?: string },
): Promise<void> {
  if (action !== 'install' && action !== 'remove') {
    throw new CrossweaveError('INVALID_ARGUMENTS', 'the action is install or remove');
  }
  const wiring = agentWiring(agent);
  if (wiring === 'unknown') {
    throw new CrossweaveError('INVALID_ARGUMENTS', `unknown agent '${agent}'. Supported: ${SUPPORTED_AGENTS.join(', ')}`);
  }
  if (wiring === 'no-hooks') {
    throw new CrossweaveError('AGENT_NO_HOOKS', `${agent} has no hook system to wire${action === 'remove' ? '; nothing to remove' : ''}`);
  }
  const prefix = deps.prefix ?? cwHookPrefix(process.argv[1]);
  const io = nodeHooksIo();
  if (action === 'install') {
    printPlan(agent, io, prefix, deps.home);
    await confirm({ yes }, 'Write these entries?');
    reportInstall(installHooks(agent, { prefix, home: deps.home }));
    return;
  }
  await confirm({ yes }, 'Remove the entries crossweave added?');
  reportRemove(removeHooks(agent, { prefix, home: deps.home }));
}

function printPlan(agent: string, io: HooksIo, prefix: string, home: string): void {
  const claude = `${home}/.claude/settings.json`;
  const codex = `${home}/.codex/config.toml`;
  const say = (line: string): void => { process.stdout.write(line + "\n"); };
  say('Will add (merge; existing entries and keys are untouched, the original file is backed up to ~/.crossweave/hooks-backup first):');
  if (agent === 'claude') {
    say(`  ${claude} — hooks.Stop         += ${JSON.stringify({ matcher: '', hooks: [{ type: 'command', command: `${prefix} ${DONE_NOTIFY_ARGS}` }] })}`);
    say(`  ${claude} — hooks.Notification += ${JSON.stringify({ matcher: '', hooks: [{ type: 'command', command: `${prefix} ${ASK_NOTIFY_ARGS}` }] })}`);
  } else {
    say(`  ${codex} — notify = ["sh", "-c", "<${prefix} ${DONE_NOTIFY_ARGS} as one TOML string>"] (only when no "notify" key is there yet; refuses one that is not crossweave's)`);
  }
  say('The session resolves itself from $CW_SESSION_ID, which crossweave sets in every session shell and pane.');
}

async function confirm(args: { yes?: boolean }, question: string): Promise<void> {
  if (args.yes === true) return;
  // Both ends must be a terminal: the answer comes from stdin; a stdout that is a pipe
  // but a stdin that is not would hang or read EOF mid-question.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    // Piped/scripted: the printed plan could never be answered.
    throw new CrossweaveError('CONFIRM_REQUIRED', 'pass --yes to run without a terminal');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new CrossweaveError('CANCELLED', 'nothing was written');
  } finally {
    rl.close();
  }
}

function reportInstall(out: HookInstallOutcome): void {
  const say = (line: string): void => { process.stdout.write(line + "\n"); };
  if (out.status === 'ok') {
    for (const add of out.adds) say(`installed: ${out.agent} — ${add}`);
    return;
  }
  if (out.status === 'noop') {
    say(`${out.agent}: already installed (${out.file})`);
    return;
  }
  throw new CrossweaveError(out.code, out.message);
}

function reportRemove(out: HookRemoveOutcome): void {
  const say = (line: string): void => { process.stdout.write(line + "\n"); };
  if (out.status === 'ok') {
    say(`removed: ${out.agent} (${out.file})`);
    return;
  }
  if (out.status === 'noop') {
    say(`${out.agent}: nothing of crossweave's to remove`);
    return;
  }
  throw new CrossweaveError(out.code, out.message);
}
