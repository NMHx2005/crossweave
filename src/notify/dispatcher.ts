import type { NotificationGate } from '../radar/noise.js';
import type { MergeTrialResult } from '../db/repositories/merge-trial.js';
import type { NotifyEventKind } from '../db/repositories/notify-config.js';

export type NotifyEvent =
  | { kind: 'collision'; sessionA: string; sessionB: string; path: string; symbol: string | null; workspaceId: string }
  | { kind: 'blocked'; session: string; path: string; symbol: string | null; workspaceId: string }
  | { kind: 'land'; session: string; ok: true; baseBranch: string; workspaceId: string }
  | { kind: 'land'; session: string; ok: false; reason: string; workspaceId: string }
  | { kind: 'convergence'; sessionA: string; sessionB: string; from: MergeTrialResult; to: MergeTrialResult; workspaceId: string };

export interface NotifyDispatcherDeps {
  gate: NotificationGate;
  /** Reads notify_config live (Task 1) — never a cached CrossweaveConfig snapshot. */
  isEnabled: (workspaceId: string, kind: NotifyEventKind) => boolean;
  /** Injected so tests never spawn a real process — Task 3 provides the real one. */
  send: (title: string, message: string, clickCommand: string[] | undefined) => void;
}

let loggedSendFailureOnce = false;

function symbolSuffix(symbol: string | null): string {
  return symbol !== null ? ` (${symbol})` : '';
}

/**
 * Formats one event into (title, message, clickCommand). A pure function of the
 * event alone — no gating, no I/O — kept separate from `notify` so the "what does
 * this event look like" question is easy to unit test independently of throttling.
 */
function format(event: NotifyEvent): { title: string; message: string; clickCommand: string[] } {
  switch (event.kind) {
    case 'collision':
      return {
        title: 'crossweave',
        message: `${event.sessionA} ↔ ${event.sessionB}: ${event.path}${symbolSuffix(event.symbol)}`,
        clickCommand: ['cw', 'session', 'attach', event.sessionB],
      };
    case 'blocked':
      return {
        title: 'crossweave — blocked',
        message: `${event.session} blocked writing ${event.path}${symbolSuffix(event.symbol)}`,
        clickCommand: ['cw', 'session', 'attach', event.session],
      };
    case 'land':
      return event.ok
        ? {
            title: 'crossweave — land ok',
            message: `${event.session} landed into ${event.baseBranch}`,
            clickCommand: ['cw', 'session', 'list'],
          }
        : {
            title: 'crossweave — land failed',
            message: `${event.session} failed to land: ${event.reason}`,
            clickCommand: ['cw', 'session', 'list'],
          };
    case 'convergence':
      return {
        title: 'crossweave — convergence',
        message: `${event.sessionA} ↔ ${event.sessionB}: ${event.from} → ${event.to}`,
        clickCommand: ['cw', 'session', 'list'],
      };
  }
}

/**
 * Gate key per event kind (design doc §3.1). `collision` deliberately does NOT gate
 * here — the caller (background watcher path) already consulted the SAME gate
 * instance once, to decide whether to send its own advisory message, before ever
 * calling `notify`; gating it again under a different key would silently halve that
 * existing budget. `undefined` means "always send, no throttle" — collision's only
 * case.
 */
function gateKey(event: NotifyEvent): [string, string, string | null] | undefined {
  switch (event.kind) {
    case 'collision':
      return undefined;
    case 'blocked':
      return [event.session, event.path, event.symbol];
    case 'land':
      // '__land__' can never collide with a real file path.
      return [event.session, '__land__', null];
    case 'convergence':
      return [[event.sessionA, event.sessionB].sort().join('\0'), '__convergence__', null];
  }
}

/**
 * The one function every trigger point calls through (design doc §3.1) — mirrors
 * decideBlocked/recordUsage's established shape. Never throws: a formatting bug or a
 * send() failure is caught and logged once per daemon lifetime, because a
 * notification is observability, not a safety mechanism (design doc §3.5).
 */
export function notify(deps: NotifyDispatcherDeps, event: NotifyEvent): void {
  try {
    if (!deps.isEnabled(event.workspaceId, event.kind)) return;
    const key = gateKey(event);
    if (key !== undefined && !deps.gate.shouldNotify(...key)) return;
    const { title, message, clickCommand } = format(event);
    deps.send(title, message, clickCommand);
  } catch (err) {
    if (!loggedSendFailureOnce) {
      loggedSendFailureOnce = true;
      process.stderr.write(`crossweave: notify() failed (further failures this run are silent): ${String(err)}\n`);
    }
  }
}
