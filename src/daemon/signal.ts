import { CrossweaveError } from '../core/errors.js';
import type { SignalKind } from './session-status.js';

const KINDS: ReadonlySet<string> = new Set(['done', 'ask']);
const MAX_MESSAGE = 200;

/**
 * The params of `session.notify`. The message is only ever DISPLAYED (a notification, a tooltip), never run
 * or interpreted, but it comes from a caller nobody authenticates, so it is one plain line of bounded length:
 * control characters (an escape sequence, a newline) become spaces, and an over-long one is refused, not cut.
 */
export function parseSignal(params: Record<string, unknown>): { kind: SignalKind; message: string } {
  const kind = params['kind'] ?? 'done';
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new CrossweaveError('INVALID_PARAMS', 'kind must be done or ask');
  const raw = params['message'] ?? '';
  if (typeof raw !== 'string') throw new CrossweaveError('INVALID_PARAMS', 'message must be text');
  const message = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (message.length > MAX_MESSAGE) throw new CrossweaveError('INVALID_PARAMS', `message must be at most ${MAX_MESSAGE} characters`);
  return { kind: kind as SignalKind, message };
}
