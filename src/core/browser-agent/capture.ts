import { originOf } from './origin.js';
import { redact } from './redact.js';
import { RingBuffer, clip } from './ring.js';

export interface ConsoleEntry { t: number; level: 'error' | 'warn' | 'info'; text: string; url?: string; line?: number }
export interface NetworkEntry { t: number; method: string; url: string; status: number; type: string; ms: number; bytes: number; failed: boolean; error?: string }

const CONSOLE_CAP = 500;
const NETWORK_CAP = 300;
const TEXT_CAP = 2048;
const URL_CAP = 2048;

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function levelOf(type: string | undefined): ConsoleEntry['level'] {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning' || type === 'warn') return 'warn';
  return 'info';
}

function remoteText(arg: unknown): string {
  const a = obj(arg);
  if (a === null) return '';
  if (a['value'] !== undefined) return typeof a['value'] === 'string' ? a['value'] : JSON.stringify(a['value']) ?? '';
  return str(a['description']) ?? str(a['type']) ?? '';
}

/**
 * The page's console and requests, kept in bounded ring buffers, from Chrome DevTools Protocol events.
 * Everything that comes out has passed `redact` and a size cut, and network entries are metadata only:
 * no headers, no bodies (there is nothing here to leak them from). A top-level navigation to a
 * DIFFERENT origin clears both — what one site logged is not the next site's history.
 */
export class Capture {
  private readonly consoleLog = new RingBuffer<ConsoleEntry>(CONSOLE_CAP);
  private readonly netLog = new RingBuffer<NetworkEntry>(NETWORK_CAP);
  private readonly open = new Map<string, { entry: NetworkEntry; started: number }>();
  private origin: string | null = null;

  constructor(private readonly now: () => number) {}

  console(): ConsoleEntry[] { return this.consoleLog.toArray(); }
  network(): NetworkEntry[] { return this.netLog.toArray(); }

  /** The page's origin when capture starts, so the first cross-origin navigation is noticed. */
  setOrigin(url: string): void { this.origin = originOf(url); }

  clear(): void {
    this.consoleLog.clear();
    this.netLog.clear();
    this.open.clear();
    this.origin = null;
  }

  event(method: string, params: unknown): void {
    const p = obj(params);
    if (p === null) return;
    switch (method) {
      case 'Runtime.consoleAPICalled': return this.onConsole(p);
      case 'Runtime.exceptionThrown': return this.onException(p);
      case 'Log.entryAdded': return this.onLog(p);
      case 'Network.requestWillBeSent': return this.onRequest(p);
      case 'Network.responseReceived': return this.onResponse(p);
      case 'Network.loadingFinished': return this.onFinished(p);
      case 'Network.loadingFailed': return this.onFailed(p);
      case 'Page.frameNavigated': return this.onNavigated(p);
    }
  }

  private pushConsole(level: ConsoleEntry['level'], text: string, url?: string, line?: number): void {
    this.consoleLog.push({
      t: this.now(), level, text: clip(redact(text), TEXT_CAP),
      ...(url === undefined || url === '' ? {} : { url: clip(redact(url), URL_CAP) }),
      ...(line === undefined ? {} : { line }),
    });
  }

  private onConsole(p: Record<string, unknown>): void {
    const type = str(p['type']);
    if (type === undefined || !Array.isArray(p['args'])) return;
    const frame = obj(Array.isArray(obj(p['stackTrace'])?.['callFrames']) ? (obj(p['stackTrace'])?.['callFrames'] as unknown[])[0] : null);
    const line = num(frame?.['lineNumber']);
    this.pushConsole(levelOf(type), p['args'].map(remoteText).join(' '), str(frame?.['url']), line === undefined ? undefined : line + 1);
  }

  private onException(p: Record<string, unknown>): void {
    const d = obj(p['exceptionDetails']);
    if (d === null) return;
    const line = num(d['lineNumber']);
    this.pushConsole('error', str(obj(d['exception'])?.['description']) ?? str(d['text']) ?? 'Uncaught exception', str(d['url']), line === undefined ? undefined : line + 1);
  }

  private onLog(p: Record<string, unknown>): void {
    const e = obj(p['entry']);
    if (e === null) return;
    this.pushConsole(levelOf(str(e['level'])), str(e['text']) ?? '', str(e['url']));
  }

  private onRequest(p: Record<string, unknown>): void {
    const id = str(p['requestId']);
    const req = obj(p['request']);
    const url = str(req?.['url']);
    if (id === undefined || req === null || url === undefined) return;
    const timestamp = num(p['timestamp']) ?? 0;
    const previous = this.open.get(id);
    const redirect = obj(p['redirectResponse']);
    if (previous !== undefined && redirect !== null) {
      previous.entry.status = num(redirect['status']) ?? 0;
      previous.entry.ms = Math.max(0, Math.round((timestamp - previous.started) * 1000));
    }
    const entry: NetworkEntry = {
      t: this.now(), method: str(req['method']) ?? 'GET', url: clip(redact(url), URL_CAP), status: 0,
      type: str(p['type']) ?? 'Other', ms: 0, bytes: 0, failed: false,
    };
    this.netLog.push(entry);
    this.open.set(id, { entry, started: timestamp });
    // Bounded like the log: a page that never finishes requests cannot grow this map without limit.
    if (this.open.size > NETWORK_CAP * 2) this.open.delete(this.open.keys().next().value as string);
  }

  private onResponse(p: Record<string, unknown>): void {
    const hit = this.open.get(str(p['requestId']) ?? '');
    if (hit === undefined) return;
    hit.entry.status = num(obj(p['response'])?.['status']) ?? 0;
    const type = str(p['type']);
    if (type !== undefined) hit.entry.type = type;
  }

  private onFinished(p: Record<string, unknown>): void {
    const id = str(p['requestId']) ?? '';
    const hit = this.open.get(id);
    if (hit === undefined) return;
    hit.entry.bytes = num(p['encodedDataLength']) ?? 0;
    hit.entry.ms = Math.max(0, Math.round(((num(p['timestamp']) ?? hit.started) - hit.started) * 1000));
    this.open.delete(id);
  }

  private onFailed(p: Record<string, unknown>): void {
    const id = str(p['requestId']) ?? '';
    const hit = this.open.get(id);
    if (hit === undefined) return;
    hit.entry.failed = true;
    hit.entry.error = clip(str(p['errorText']) ?? 'failed', 200);
    hit.entry.ms = Math.max(0, Math.round(((num(p['timestamp']) ?? hit.started) - hit.started) * 1000));
    this.open.delete(id);
  }

  private onNavigated(p: Record<string, unknown>): void {
    const frame = obj(p['frame']);
    const url = str(frame?.['url']);
    if (frame === null || url === undefined || str(frame['parentId']) !== undefined) return;
    const next = originOf(url);
    if (next === this.origin) return;
    this.consoleLog.clear();
    this.netLog.clear();
    this.open.clear();
    this.origin = next;
  }
}

export const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const limitOf = (limit: number | undefined): number => Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));

/** Text the PAGE wrote is data, never instructions: every row says so, for the agent framework that reads it. */
export type Untrusted<T> = T & { untrusted: true };

export function queryConsole(entries: readonly ConsoleEntry[], opts: { level?: 'error' | 'warn' | 'info' | 'all'; since?: number; limit?: number }): Array<Untrusted<ConsoleEntry>> {
  const level = opts.level ?? 'all';
  const rows = entries.filter((e) => (level === 'all' || e.level === level) && (opts.since === undefined || e.t >= opts.since));
  return rows.slice(-limitOf(opts.limit)).map((e) => ({ ...e, untrusted: true as const }));
}

export function queryNetwork(entries: readonly NetworkEntry[], opts: { failed?: boolean; since?: number; limit?: number }): Array<Untrusted<NetworkEntry>> {
  const rows = entries.filter((e) => (opts.failed !== true || e.failed) && (opts.since === undefined || e.t >= opts.since));
  return rows.slice(-limitOf(opts.limit)).map((e) => ({ ...e, untrusted: true as const }));
}
