/**
 * The gateway's browser client. Served by `cw gateway serve` (transpiled from this
 * file at request time) and loaded by `index.html`.
 *
 * Deliberately import-free: it runs in a browser, where `DaemonClient` cannot (it
 * pulls in node:child_process and node:fs) — which is why the previous page, built on
 * it, never ran at all. Everything here is plain Web APIs (WebSocket, WebCrypto,
 * DOM), so the same module is unit-tested under Bun.
 */

/** The token from `#token=…` (preferred: a fragment never reaches a server or its logs) or `?token=…`. */
export function tokenFromLocation(loc: { hash: string; search: string }): string {
  const fromHash = new URLSearchParams(loc.hash.replace(/^#/, '')).get('token');
  if (fromHash) return fromHash;
  return new URLSearchParams(loc.search).get('token') ?? '';
}

export interface RpcError extends Error {
  code?: string;
}

export interface Rpc {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Feed one WebSocket message. Lines may be split across messages. */
  feed(text: string): void;
  onNotification(cb: (method: string, params: unknown) => void): void;
  /** Reject everything in flight (the socket closed). */
  failAll(message: string): void;
}

/**
 * Newline-delimited JSON-RPC over any `send`. Buffered: the gateway forwards the
 * daemon's socket chunks as they arrive, so one JSON line can span two messages.
 * The token rides on every call — the gateway strips it before the daemon sees it,
 * and a reconnect then needs no separate handshake.
 */
export function createRpc(send: (frame: string) => void, token: string): Rpc {
  let nextId = 1;
  let buffer = '';
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const handlers: Array<(method: string, params: unknown) => void> = [];

  const handleLine = (line: string): void => {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string; data?: { code?: string } } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) {
        const err: RpcError = new Error(msg.error.message ?? 'RPC error');
        err.code = msg.error.data?.code;
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      for (const h of handlers) h(msg.method, msg.params);
    }
  };

  return {
    call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, token } })}\n`);
      });
    },
    feed(text: string): void {
      buffer += text;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== '') handleLine(line);
        nl = buffer.indexOf('\n');
      }
    },
    onNotification(cb) {
      handlers.push(cb);
    },
    failAll(message: string): void {
      for (const p of pending.values()) p.reject(new Error(message));
      pending.clear();
    },
  };
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The session.data key, derived exactly as the daemon derives it (src/gateway/e2e.ts):
 * HKDF-SHA256 over the control token, salt = the workspace root, info =
 * "crossweave session.data". A remote viewer already holds the token it logged in
 * with, so this is the key path a browser has — it cannot read `.crossweave/`.
 */
export async function deriveSessionKey(token: string, workspaceRoot: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', utf8(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(workspaceRoot), info: utf8('crossweave session.data') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/**
 * A session.data chunk as text: a plain string as-is, a sealed blob opened with
 * `key` (the session id is its AAD), or undefined when it cannot be opened.
 */
export async function openChunk(chunk: unknown, key: CryptoKey | undefined, sessionId: string): Promise<string | undefined> {
  if (typeof chunk === 'string') return chunk;
  const blob = chunk as { nonce?: unknown; ct?: unknown; tag?: unknown } | null;
  if (key === undefined || typeof blob !== 'object' || blob === null) return undefined;
  if (typeof blob.nonce !== 'string' || typeof blob.ct !== 'string' || typeof blob.tag !== 'string') return undefined;
  try {
    const ct = fromBase64(blob.ct);
    const tag = fromBase64(blob.tag);
    const sealed = new Uint8Array(ct.length + tag.length);
    sealed.set(ct);
    sealed.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(blob.nonce), additionalData: utf8(sessionId) },
      key,
      sealed,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

export interface WebSession {
  id: string;
  name: string;
  status: string;
  branch: string | null;
}

interface Workspace {
  id: string;
  name: string;
  rootPath: string;
}

/** The subset of xterm.js this page uses. */
export interface TerminalLike {
  open(el: HTMLElement): void;
  write(data: string): void;
  reset(): void;
  onData(cb: (data: string) => void): void;
  /** Resize to the container (xterm's fit addon), when available. */
  fit?(): void;
  cols: number;
  rows: number;
}

/**
 * Wire the page. Not unit-tested (it is DOM glue); everything it decides with is
 * above. Every failure lands in the status bar in words — a remote viewer has no
 * console to read.
 */
export async function startWebApp(opts: {
  doc: Document;
  loc: Location;
  makeTerminal: () => TerminalLike;
}): Promise<void> {
  const { doc } = opts;
  const $ = (id: string): HTMLElement => doc.getElementById(id)!;
  const status = (text: string, kind: 'ok' | 'warn' | 'error' = 'ok'): void => {
    const el = $('status');
    el.textContent = text;
    el.dataset.kind = kind;
  };

  const showLogin = (error?: string): void => {
    $('app').hidden = true;
    $('login').hidden = false;
    if (error !== undefined) {
      $('login-error').textContent = error;
      $('login-error').hidden = false;
    }
    ($('login-token') as HTMLInputElement).focus();
  };
  ($('login-form') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault();
    const value = (($('login-token') as HTMLInputElement).value ?? '').trim();
    if (value !== '') {
      opts.loc.hash = `token=${encodeURIComponent(value)}`;
      opts.loc.reload();
    }
  });

  const token = tokenFromLocation(opts.loc);
  if (token === '') {
    showLogin();
    return;
  }

  $('app').hidden = false;
  const scheme = opts.loc.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${opts.loc.host}/ws`);
  const rpc = createRpc((f) => ws.send(f), token);
  ws.addEventListener('message', (e) => rpc.feed(String(e.data)));
  ws.addEventListener('close', (e) => {
    rpc.failAll('Disconnected from the gateway');
    status(e.code === 1008 ? 'Refused by the gateway (origin not allowed).' : 'Disconnected — reload to reconnect.', 'error');
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not reach the gateway')), { once: true });
  }).catch((err: Error) => {
    status(err.message, 'error');
    throw err;
  });

  let workspaces: Workspace[];
  try {
    workspaces = await rpc.call<Workspace[]>('workspace.list');
  } catch (err) {
    const msg = (err as Error).message;
    if (/Unauthorized/.test(msg)) {
      showLogin('That token was rejected. Copy it again from `cw gateway token`.');
    } else {
      status(msg, 'error');
    }
    return;
  }
  const workspace = workspaces[0];
  if (workspace === undefined) {
    status('No workspace yet — run `cw init` in the repository.', 'warn');
    return;
  }
  $('workspace').textContent = workspace.name;
  const key = await deriveSessionKey(token, workspace.rootPath).catch(() => undefined);

  const term = opts.makeTerminal();
  term.open($('term'));
  term.fit?.();
  let active: WebSession | undefined;
  let undecryptableNoticeFor: string | undefined;
  let readOnlyNoticeShown = false;

  const sendResize = (): void => {
    if (active === undefined) return;
    void rpc.call('session.resize', { workspaceId: workspace.id, idOrName: active.id, cols: term.cols, rows: term.rows }).catch(() => undefined);
  };

  term.onData((data) => {
    if (active === undefined) return;
    rpc.call('session.input', { workspaceId: workspace.id, idOrName: active.id, data }).catch((err: Error) => {
      if (/Forbidden/.test(err.message)) {
        if (!readOnlyNoticeShown) status('Read-only token: you can watch, not type.', 'warn');
        readOnlyNoticeShown = true;
      } else {
        status(`Input failed: ${err.message}`, 'error');
      }
    });
  });

  rpc.onNotification((method, params) => {
    const p = params as { sessionId?: string; chunk?: unknown; code?: number };
    if (active === undefined || p.sessionId !== active.id) return;
    if (method === 'session.exit') {
      term.write(`\r\n\x1b[2m[session exited with code ${String(p.code)}]\x1b[0m\r\n`);
      return;
    }
    if (method !== 'session.data') return;
    void openChunk(p.chunk, key, active.id).then((text) => {
      if (text !== undefined) {
        term.write(text);
      } else if (undecryptableNoticeFor !== active?.id) {
        undecryptableNoticeFor = active?.id;
        status('This output is end-to-end encrypted with the control token; this token cannot open it.', 'warn');
      }
    });
  });

  const attach = async (s: WebSession): Promise<void> => {
    active = s;
    undecryptableNoticeFor = undefined;
    term.reset();
    renderSessions();
    if (s.status !== 'running' && s.status !== 'waiting') {
      term.write(`\x1b[2m${s.name} is ${s.status}. Start it with \`cw session start ${s.name}\`.\x1b[0m\r\n`);
      status(`${s.name} is ${s.status}`, 'warn');
      return;
    }
    try {
      await rpc.call('session.attach', { workspaceId: workspace.id, idOrName: s.id });
      sendResize();
      status(`Attached to ${s.name}`);
    } catch (err) {
      status(`Could not attach to ${s.name}: ${(err as Error).message}`, 'error');
    }
  };

  let sessions: WebSession[] = [];
  const renderSessions = (): void => {
    const list = $('sessions');
    list.replaceChildren();
    if (sessions.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No sessions. Create one with `cw session new <name>`.';
      list.append(empty);
      return;
    }
    for (const s of sessions) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'session';
      if (active?.id === s.id) item.setAttribute('aria-current', 'true');
      const name = doc.createElement('span');
      name.className = 'session__name';
      name.textContent = s.name;
      const badge = doc.createElement('span');
      badge.className = 'session__status';
      badge.dataset.status = s.status;
      badge.textContent = s.status;
      item.append(name, badge);
      item.addEventListener('click', () => { void attach(s); });
      list.append(item);
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      sessions = await rpc.call<WebSession[]>('session.list', { workspaceId: workspace.id });
      renderSessions();
      if (active === undefined) {
        const first = sessions.find((s) => s.status === 'running') ?? sessions[0];
        if (first !== undefined) await attach(first);
        else status('Connected');
      }
    } catch (err) {
      status(`Could not list sessions: ${(err as Error).message}`, 'error');
    }
  };

  await refresh();
  // Polled rather than pushed: the change feed (daemon.subscribe) is not exposed
  // through the gateway, and a 3 s list is cheap.
  setInterval(() => { void refresh(); }, 3000);
  doc.defaultView?.addEventListener('resize', () => {
    term.fit?.();
    sendResize();
  });
}
