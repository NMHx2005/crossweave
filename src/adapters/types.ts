import type { EnforcementTier } from '../db/repositories/session.js';

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
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
