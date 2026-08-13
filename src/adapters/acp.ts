import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Agent, type Client, type RequestPermissionRequest, type RequestPermissionResponse,
  type SessionNotification, type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { EnforcementTier } from '../db/repositories/session.js';
import type { AgentAdapter, AgentProcess, SpawnOptions } from './types.js';

/**
 * Filled in by Task 4 with `resolveWorkspaceId`/`decideBlocked` — deliberately empty
 * here so Task 3's diff and Task 4's diff both touch this same, single declaration
 * rather than one renaming what the other introduced.
 */
export interface AcpAdapterDeps {}

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

class AcpProcess implements AgentProcess {
  readonly pid: number;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private exitCode: number | null = null;
  private readonly child: ChildProcess;
  private readonly connection: ClientSideConnection;
  private sessionId: string | undefined;
  private readonly pendingWrites: string[] = [];

  constructor(command: string, args: string[], opts: SpawnOptions, _deps: AcpAdapterDeps) {
    this.child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    this.pid = this.child.pid ?? -1;

    this.child.on('exit', (code) => {
      this.exitCode = code ?? 0;
      fanOut(this.exitListeners, this.exitCode);
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
        // Stub — Task 4 replaces this with the real decideBlocked-backed decision.
        const chosen = params.options.find((o) => o.kind === 'allow_once') ?? params.options[0];
        if (chosen === undefined) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
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
