import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { relative } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Agent, type Client, type RequestPermissionRequest, type RequestPermissionResponse,
  type SessionNotification, type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { EnforcementTier } from '../db/repositories/session.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';
import { assertContained } from '../core/paths.js';
import type { DecideBlockedParams, DecideBlockedResult } from '../radar/decision.js';
import { CrossweaveError } from '../core/errors.js';
import type { RecordUsageParams } from '../domain/usage.js';
import type { NotifyEvent } from '../notify/dispatcher.js';

export interface AcpAdapterDeps {
  resolveWorkspaceId(sessionId: string): string;
  decideBlocked(params: DecideBlockedParams): DecideBlockedResult;
  recordUsage(params: RecordUsageParams): void;
  notify(event: NotifyEvent): void;
}

/** Deliver to every listener even when one of them throws — same fan-out contract as ClaudePtyAdapter's. */
function fanOut<T>(listeners: ReadonlyArray<(value: T) => void>, value: T): void {
  for (const cb of listeners) {
    try {
      cb(value);
    } catch {
      // The subscriber owns its own failure; the stream keeps going.
    }
  }
}

/**
 * Translates one ACP `session/update` into the plain text `AgentProcess.onData` expects.
 * Text-bearing chunks pass through verbatim; tool-call variants become one readable
 * bracketed line — richer structured rendering (a live tool-call panel, etc.) is M6 (TUI)
 * territory, not this adapter's job (design doc §3.1, §1 non-goals).
 */
function renderSessionUpdate(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return update.content.type === 'text' ? update.content.text : '';
    case 'tool_call':
      return `[cursor: ${update.kind ?? 'tool'} ${update.title}]\n`;
    case 'tool_call_update':
      return `[cursor: ${update.status ?? 'update'} ${update.toolCallId}]\n`;
    default:
      return '';
  }
}

/**
 * M6a: ACP's usage_update is native to the protocol (design doc §2) — used/size are
 * context-window tokens, cost is optional and agent-dependent. Reported in-process,
 * no RPC, mirroring decideRequestPermission's own reasoning for calling decideBlocked
 * directly. Unlike decideRequestPermission, this is NOT a safety decision — a missing
 * session id or a recordUsage failure is a silent no-op, never surfaced to the agent,
 * because usage accounting is best-effort observability and must never break a turn.
 */
/**
 * `cost.currency` is a required field of ACP's `Cost` type whenever `cost` is present
 * (ISO 4217, e.g. "USD", "EUR") — crossweave's `cost_spent_usd` column has no currency
 * of its own (it is USD-denominated by construction, matching Claude Code's own
 * `cost.total_cost_usd`), so a non-USD report is skipped rather than silently
 * mislabeled as dollars. Case-insensitive: the schema doesn't mandate a case, and
 * treating "usd"/"USD" differently would be a needless footgun.
 */
function usdCostAmount(update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>): number | undefined {
  if (update.cost === undefined || update.cost === null) return undefined;
  return update.cost.currency.toUpperCase() === 'USD' ? update.cost.amount : undefined;
}

function reportUsageUpdate(update: SessionUpdate, sessionId: string | undefined, deps: AcpAdapterDeps): void {
  if (update.sessionUpdate !== 'usage_update' || sessionId === undefined) return;
  try {
    deps.recordUsage({ sessionId, tokensUsed: update.used, costUsd: usdCostAmount(update) });
  } catch {
    // Best-effort — see the doc comment above.
  }
}

type PermissionDecision = 'allow_once' | 'reject_once';

/**
 * Fails CLOSED on any internal error (missing session id, decideBlocked throwing) —
 * deliberately the OPPOSITE of the Claude Code hook's fail-open posture
 * (docs/superpowers/specs/2026-08-12-m5a-known-limitations.md). The hook is a separate
 * subprocess with real daemon-unreachable/timeout failure modes it must degrade
 * through gracefully; this handler runs in-process, in the same daemon, so an error
 * here is a genuine internal bug, not legitimate unreachability — and T1 is supposed
 * to be the STRONG enforcement tier. A location outside the worktree root, or a
 * decideBlocked call that throws, denies rather than silently allowing.
 */
// Kinds that never write — the underlying policy is specifically about write-write
// collisions (the hook's own deny reason says so, and M5a only ever matched
// Edit|Write), so these are let through without consulting decideBlocked at all. A
// kind not in this set (including an unset `kind`) is treated conservatively — checked,
// not assumed safe.
const NON_MUTATING_KINDS = new Set<string>(['read', 'search', 'fetch', 'think', 'switch_mode']);

function decideRequestPermission(
  params: RequestPermissionRequest,
  cwd: string,
  sessionId: string | undefined,
  deps: AcpAdapterDeps,
): PermissionDecision {
  if (sessionId === undefined) return 'reject_once';
  if (params.toolCall.kind != null && NON_MUTATING_KINDS.has(params.toolCall.kind)) return 'allow_once';

  const locations = params.toolCall.locations ?? [];
  if (locations.length === 0) return 'allow_once'; // nothing to check against

  try {
    const workspaceId = deps.resolveWorkspaceId(sessionId);
    const realCwd = realpathSync(cwd);
    for (const location of locations) {
      let relPath: string;
      try {
        relPath = relative(realCwd, assertContained(cwd, location.path));
      } catch (err) {
        // Only a genuine "outside the worktree" escape is skipped (matches the Claude
        // Code hook's precedent — that's not this adapter's problem to police). Any
        // OTHER failure (a symlink loop `assertContained` refuses to resolve, an
        // fs error) is NOT the same as "nothing to check" and must not be treated as
        // one — it denies, keeping this handler's fail-closed guarantee honest.
        if (err instanceof CrossweaveError && err.code === 'PATH_ESCAPE') continue;
        return 'reject_once';
      }
      const result = deps.decideBlocked({ workspaceId, sessionId, path: relPath });
      if (result.blocked) {
        // Only the genuine "decideBlocked said blocked" case notifies — the
        // catch below (an internal error: resolveWorkspaceId/decideBlocked
        // throwing) also fails closed but is NOT a collision block, and firing
        // a "blocked" notification there would misreport what actually
        // happened (design doc §2 lists this as a policy decision, not an
        // error path).
        deps.notify({ kind: 'blocked', session: sessionId, path: relPath, symbol: null, workspaceId });
        return 'reject_once';
      }
    }
    return 'allow_once';
  } catch {
    return 'reject_once';
  }
}

class AcpProcess implements AgentProcess {
  readonly pid: number;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private exitCode: number | null = null;
  private readonly child: ChildProcess;
  private readonly connection: ClientSideConnection;
  private sessionId: string | undefined;
  private readonly pendingWrites: string[] = [];

  constructor(command: string, args: string[], opts: SpawnOptions, deps: AcpAdapterDeps) {
    this.child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    this.pid = this.child.pid ?? -1;

    this.child.on('exit', (code) => {
      this.exitCode = code ?? 0;
      fanOut(this.exitListeners, this.exitCode);
    });

    // Node's `spawn` emits 'error' asynchronously (e.g. ENOENT when the command isn't on
    // PATH) — an EventEmitter's unhandled 'error' event throws and would crash the whole
    // host process, not just this adapter. Route it through the same exit-notification
    // path 'exit' uses instead; `?? 1` avoids double-notifying if both somehow fire.
    this.child.on('error', () => {
      this.exitCode = this.exitCode ?? 1;
      fanOut(this.exitListeners, this.exitCode);
    });

    // Piped but otherwise unread by default (stdout/stdin are wired to the ACP JSON-RPC
    // stream, stderr is not part of that protocol) — an agent process that logs errors
    // to stderr (e.g. an unauthenticated `cursor-agent`, which per the design doc needs
    // a live account) would otherwise give the user no signal at all, AND could block on
    // write once the pipe's buffer fills, wedging the whole process with no timeout. A
    // pty (ClaudePtyAdapter's transport) never had this exposure because it merges the
    // streams; surfacing stderr through onData is the closest equivalent here.
    this.child.stderr?.on('data', (chunk: Buffer) => {
      fanOut(this.dataListeners, chunk.toString('utf8'));
    });

    // Web Streams, not Node streams — ndJsonStream's contract (verified against the
    // SDK's own examples, not guessed): (output-we-write-to, input-we-read-from).
    const input = Writable.toWeb(this.child.stdin!);
    // `as unknown as`, not a direct `as` — Task 2 hit this exact cast rejection first:
    // `node:stream`'s `Readable.toWeb()` returns a `node:stream/web` ReadableStream, a
    // structurally distinct declaration from the global DOM-lib ReadableStream this
    // project's tsconfig resolves. TS 7.0.2 (this repo's pinned compiler) correctly
    // refuses the direct cast as "neither type sufficiently overlaps" even though the
    // two are runtime-compatible — this is the standard idiom for that case, zero
    // runtime effect (type assertions never affect emitted JS).
    const output = Readable.toWeb(this.child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const clientImpl: Client = {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const decision = decideRequestPermission(params, opts.cwd, opts.env.CW_SESSION_ID, deps);
        // Never fall back across the allow/deny boundary: if the agent didn't offer
        // the exact option kind decided on, fall back only within the SAME class
        // (any other allow_*/reject_* option) — never to an arbitrary options[0],
        // which could silently turn a deny into an allow depending on option order.
        const wantReject = decision === 'reject_once';
        const chosen = params.options.find((o) => o.kind === decision)
          ?? params.options.find((o) => o.kind.startsWith(wantReject ? 'reject' : 'allow'));
        if (chosen === undefined) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        reportUsageUpdate(params.update, opts.env.CW_SESSION_ID, deps);
        fanOut(this.dataListeners, renderSessionUpdate(params.update));
      },
    };

    // ClientSideConnection (not the newer client({name}).connectWith(...) fluent
    // builder): the fluent builder's connectWith callback owns one single async
    // function for the whole session's lifetime, which doesn't fit an adapter whose
    // write()/onData() are called imperatively, at unpredictable times, from outside —
    // ClientSideConnection's plain async methods (initialize/newSession/prompt) do.
    this.connection = new ClientSideConnection((_agent: Agent) => clientImpl, stream);
    // Captured into a local: TS's definite-assignment analysis for a `readonly` class
    // field doesn't look inside a nested closure to see that `this.connection` was
    // already assigned above (verified against both this repo's pinned TS 7.0.2 and
    // stable TS 5.7 with an isolated repro — TS2565 "used before being assigned" fires
    // on both, so this is standard strict-mode behavior, not a version-specific quirk).
    // A local `const` sidesteps the analysis gap without an escape hatch (`!`, etc.).
    const connection = this.connection;

    // `.catch(() => {})`: this handshake is fire-and-forget from the constructor's
    // perspective, and `kill()` can legitimately race it (e.g. immediately after
    // `spawn()`, before `initialize`/`session/new` ever resolve) — the SDK's own
    // `close()` then rejects the in-flight request. Without a handler here, that
    // rejection has nowhere to land and surfaces as an unhandled rejection that
    // crashes the process; there is nothing further to do once killed, so it is
    // swallowed the same way `fanOut`'s per-listener errors are.
    void (async () => {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await connection.newSession({ cwd: opts.cwd, mcpServers: [] });
      this.sessionId = sessionId;
      for (const text of this.pendingWrites.splice(0)) {
        void connection.prompt({ sessionId, prompt: [{ type: 'text', text }] }).catch(() => {});
      }
    })().catch(() => {});
  }

  onData(cb: (chunk: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    if (this.exitCode !== null) cb(this.exitCode);
    else this.exitListeners.push(cb);
  }

  write(data: string): void {
    // The handshake (initialize + session/new) is async; a write() that arrives before
    // it settles is queued and flushed once `sessionId` is known, rather than dropped.
    if (this.sessionId === undefined) {
      this.pendingWrites.push(data);
      return;
    }
    void this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text: data }] }).catch(() => {});
  }

  resize(_cols: number, _rows: number): void {
    // No-op — ACP has no terminal concept.
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal);
  }
}

/**
 * Tier T1: ACP's `session/request_permission` sits below EVERY tool call the agent
 * makes — including shell execution — not just `Edit`/`Write` the way the Claude Code
 * hook's matcher does (see docs/superpowers/specs/2026-08-12-m5a-known-limitations.md).
 * That is the actual gap T1 closes over T2.
 */
export class AcpAdapter implements AgentAdapter {
  readonly kind = 'cursor';
  readonly enforcementTier: EnforcementTier = 'T1';

  constructor(
    private readonly deps: AcpAdapterDeps,
    private readonly command = 'cursor-agent',
    private readonly args: string[] = ['agent', 'acp'],
  ) {}

  spawn(opts: SpawnOptions): AgentProcess {
    return new AcpProcess(this.command, this.args, opts, this.deps);
  }
}
