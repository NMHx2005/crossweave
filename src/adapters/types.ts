import type { EnforcementTier } from '../db/repositories/session.js';
import type { SandboxSpec } from '../isolation/sandbox.js';

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /**
   * The OS boundary to wrap this session in, or `undefined` to spawn as before.
   *
   * A SPEC, not a built plan: each adapter knows its own argv (`--settings`, `--trust
   * agent acp`, …), so the final `sandbox-exec -f … <command> <args>` line can only be
   * assembled at the spawn site. The daemon decides WHETHER to sandbox (config +
   * platform); the adapter decides HOW its own command is wrapped. Absent means no
   * boundary — the daemon says so out loud and the session runs as it always did.
   */
  sandbox?: SandboxSpec;
  /** Reopen this conversation instead of starting a new one (see adapters/catalog.ts). */
  resumeId?: string;
  /** The session's own launch flags (`--model opus`), after the configured command. */
  extraArgs?: string[];
}

export interface AgentProcess {
  readonly pid: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface AgentAdapter {
  readonly kind: string;
  readonly enforcementTier: EnforcementTier;
  spawn(opts: SpawnOptions): AgentProcess;
}
