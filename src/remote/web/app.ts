/**
 * The phone's page, served by the remote server (src/remote/server.ts) and transpiled
 * from this file on request. Import-free at the top level, so the pure helpers below
 * run under `bun test`; xterm is loaded from the Mac (`./vendor/xterm.mjs`) only when
 * the page starts in a browser.
 *
 * It holds a device token, so it never builds HTML from data: every string reaches
 * the page through `textContent`, and session output only through xterm. The CSP
 * allows no inline script.
 */

// ── Pure helpers (tested) ──────────────────────────────────────────────────────

export type Session = {
  id: string;
  name: string;
  status?: string;
  activity?: string;
  rang?: boolean;
  agent?: string | null;
  note?: string;
  latestWords?: string;
  cols?: number;
  rows?: number;
  usage?: { input: number; output: number; cacheWrite: number; cacheRead: number; folder?: boolean };
};

export type Project = { root: string; name: string };
export type Launcher = { id: string; label: string; available: boolean };

/** The pairing code from `#pair=…`: a fragment never reaches a server, its logs or a Referer. */
export function pairCodeFromHash(hash: string): string {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get('pair') ?? '';
  return /^[A-Za-z0-9-]{1,20}$/.test(code) ? code : '';
}

/** A name for Settings' device list, from the user agent; the user can change it. */
export function guessDeviceName(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

/** What the page says when the Mac closed the socket (codes from src/remote/server.ts). */
export function closeMessage(code: number): { text: string; retry: boolean; unpair: boolean } {
  switch (code) {
    case 4000: return { text: 'Remote access was turned off on the Mac.', retry: true, unpair: false };
    case 4003: return { text: 'This phone is not paired any more. Pair it again from the Mac.', retry: false, unpair: true };
    case 4009: return { text: 'This page was opened again on this phone; this copy stopped.', retry: false, unpair: false };
    case 4029: return { text: 'Too many failed attempts from this network. Try again in a few minutes.', retry: true, unpair: false };
    case 1008: return { text: 'The Mac refused this page’s address.', retry: false, unpair: false };
    case 1013: return { text: 'The connection could not keep up with the output. Reconnecting…', retry: true, unpair: false };
    default: return { text: 'Lost the connection to the Mac. Reconnecting…', retry: true, unpair: false };
  }
}

/** The row's title: the user's note, else what the agent last said, else the session's name. */
export function sessionTitle(s: Session): string {
  return s.note ?? s.latestWords ?? s.name;
}

export type Tone = 'working' | 'asked' | 'ready' | 'failed' | 'stopped';

export function sessionState(s: Session): { tone: Tone; label: string } {
  if (s.status !== 'running') return { tone: 'stopped', label: s.status === 'landed' ? 'Landed' : 'Stopped' };
  switch (s.activity) {
    case 'working': return { tone: 'working', label: 'Working' };
    case 'asked': return s.rang === true ? { tone: 'asked', label: 'Needs you' } : { tone: 'ready', label: 'Done' };
    case 'failed': return { tone: 'failed', label: 'Failed' };
    default: return { tone: 'ready', label: 'Idle' };
  }
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function usageLabel(s: Session): string | undefined {
  const u = s.usage;
  if (u === undefined) return undefined;
  const total = u.input + u.output + u.cacheWrite + u.cacheRead;
  return total > 0 ? `${formatTokens(total)} tokens` : undefined;
}

/**
 * The font size that fits `cols` columns in `width` pixels (a monospace cell is about
 * 0.6 em wide), kept between 5 and 14: below 5 nothing is legible, so the terminal
 * scrolls sideways instead.
 */
export function fitFontSize(width: number, cols: number): number {
  if (!(width > 0) || !(cols > 0)) return 12;
  return Math.max(5, Math.min(14, Math.floor(width / (cols * 0.6))));
}

/** The bytes a quick key types, as a terminal would send them. */
export const KEYS: Record<string, { label: string; data: string }> = {
  enter: { label: '⏎', data: '\r' },
  esc: { label: 'Esc', data: '\x1b' },
  ctrlc: { label: '⌃C', data: '\x03' },
  tab: { label: 'Tab', data: '\t' },
  up: { label: '↑', data: '\x1b[A' },
  down: { label: '↓', data: '\x1b[B' },
  yes: { label: 'y', data: 'y' },
  no: { label: 'n', data: 'n' },
  one: { label: '1', data: '1' },
  two: { label: '2', data: '2' },
  three: { label: '3', data: '3' },
};

export type Rpc = {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  receive(text: string): void;
  failAll(message: string): void;
};

export type RpcError = Error & { code?: string };

/** One JSON object per WebSocket message; replies by id, pushes by method. */
export function createRpc(send: (text: string) => void, onPush: (method: string, params: Record<string, unknown>) => void): Rpc {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>();
  return {
    call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send(JSON.stringify({ id, method, params }));
      });
    },
    receive(text: string): void {
      let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: string; message?: string } };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        if (msg.error !== undefined) {
          const err: RpcError = new Error(msg.error.message ?? 'Something went wrong');
          err.code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (typeof msg.method === 'string') {
        onPush(msg.method, typeof msg.params === 'object' && msg.params !== null ? msg.params as Record<string, unknown> : {});
      }
    },
    failAll(message: string): void {
      for (const p of pending.values()) p.reject(new Error(message));
      pending.clear();
    },
  };
}

/** Storage that may be missing or throw (private mode): the page works without it. */
export function store(s: Storage | undefined): { get(key: string): string | undefined; set(key: string, value: string | undefined): void } {
  return {
    get(key) {
      try {
        return s?.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        if (value === undefined) s?.removeItem(key);
        else s?.setItem(key, value);
      } catch {
        /* storage unavailable: the phone pairs again next time */
      }
    },
  };
}

// ── The page (DOM glue; driven in a browser, not unit-tested) ──────────────────

const TOKEN_KEY = 'crossweave.remote.token';

type XtermLike = {
  open(el: HTMLElement): void;
  write(data: string): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  options: { fontSize?: number };
  dispose(): void;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function startRemoteApp(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const storage = store(window.localStorage);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';

  let rpc: Rpc | undefined;
  let socket: WebSocket | undefined;
  let projects: Project[] = [];
  const sessions = new Map<string, Session[]>();
  /** The session on screen, and its terminal. */
  let open: { project: string; session: Session; term: XtermLike; host: HTMLElement } | undefined;
  let retryMs = 1000;
  let banner: { text: string; kind: 'info' | 'error' } | undefined;
  let view: 'list' | 'session' | 'pair' = 'list';

  let code = pairCodeFromHash(location.hash);
  if (code !== '') history.replaceState(null, '', location.pathname);
  // Scanning a new code while the page is open only changes the fragment: no reload.
  window.addEventListener('hashchange', () => {
    const next = pairCodeFromHash(location.hash);
    if (next === '') return;
    history.replaceState(null, '', location.pathname);
    code = next;
    showPair();
  });

  function setBanner(text: string | undefined, kind: 'info' | 'error' = 'info'): void {
    banner = text === undefined ? undefined : { text, kind };
    const b = document.getElementById('banner');
    if (b === null) return;
    b.textContent = banner?.text ?? '';
    b.hidden = banner === undefined;
    b.dataset.kind = banner?.kind ?? 'info';
  }

  function frame(title: string, back?: () => void): HTMLElement {
    root.replaceChildren();
    const header = el('header', { class: 'bar' });
    if (back !== undefined) {
      const b = el('button', { class: 'icon', type: 'button', 'aria-label': 'Back' }, '‹');
      b.addEventListener('click', back);
      header.append(b);
    }
    header.append(el('h1', {}, title));
    const dot = el('span', { class: 'conn', id: 'conn', 'aria-label': 'Connection' });
    dot.dataset.on = socket?.readyState === WebSocket.OPEN ? 'true' : 'false';
    header.append(dot);
    const b = el('p', { id: 'banner', class: 'banner', role: 'status' });
    b.hidden = true;
    const main = el('main');
    root.append(header, b, main);
    if (banner !== undefined) setBanner(banner.text, banner.kind);
    return main;
  }

  // ── Pairing ──
  function showPair(message?: string): void {
    view = 'pair';
    const main = frame('Pair with your Mac');
    const form = el('form', { class: 'card' });
    form.append(el('p', { class: 'muted' }, 'On the Mac: crossweave → Settings → Remote → Pair a phone. Scan the code, or type it here.'));
    const codeInput = el('input', { id: 'pair-code', name: 'code', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCDE-FGHJK', 'aria-label': 'Pairing code' }) as HTMLInputElement;
    codeInput.value = code;
    const nameInput = el('input', { id: 'pair-name', name: 'name', autocomplete: 'off', maxlength: '40', 'aria-label': 'This phone’s name' }) as HTMLInputElement;
    nameInput.value = guessDeviceName(navigator.userAgent);
    const error = el('p', { class: 'error', role: 'alert' });
    error.hidden = message === undefined;
    if (message !== undefined) error.textContent = message;
    const button = el('button', { class: 'primary', type: 'submit' }, 'Pair');
    form.append(el('label', { for: 'pair-code' }, 'Code'), codeInput, el('label', { for: 'pair-name' }, 'Name this phone'), nameInput, error, button);
    if (location.protocol === 'https:') {
      const cert = el('p', { class: 'muted small' }, 'Your phone warned about this page’s certificate because it was made by your Mac. To stop the warning, ');
      const link = el('a', { href: './ca.cer' }, 'install the Mac’s certificate');
      cert.append(link, document.createTextNode(', then trust it in Settings → General → About → Certificate Trust Settings.'));
      form.append(cert);
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      button.disabled = true;
      error.hidden = true;
      void (async () => {
        try {
          const res = await fetch('./api/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: codeInput.value, name: nameInput.value }),
          });
          const body = await res.json().catch(() => ({})) as { token?: string; error?: string };
          if (!res.ok || typeof body.token !== 'string') throw new Error(body.error ?? 'Could not pair');
          storage.set(TOKEN_KEY, body.token);
          code = '';
          connect();
        } catch (err) {
          error.textContent = (err as Error).message;
          error.hidden = false;
          button.disabled = false;
        }
      })();
    });
    main.append(form);
    (code === '' ? codeInput : button).focus();
  }

  // ── Connection ──
  function connect(): void {
    const token = storage.get(TOKEN_KEY);
    if (token === undefined) {
      showPair();
      return;
    }
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    socket = ws;
    const client = createRpc((t) => ws.send(t), onPush);
    ws.addEventListener('message', (e) => client.receive(String(e.data)));
    ws.addEventListener('open', () => {
      void (async () => {
        try {
          const hello = await client.call<{ projects: Project[] }>('hello', { token });
          rpc = client;
          retryMs = 1000;
          setBanner(undefined);
          projects = hello.projects;
          const dot = document.getElementById('conn');
          if (dot !== null) dot.dataset.on = 'true';
          await Promise.all(projects.map((p) => loadSessions(p.root)));
          if (open !== undefined) await watch(open.project, open.session);
          else if (view !== 'session') renderList();
        } catch {
          /* the close handler explains it */
        }
      })();
    });
    ws.addEventListener('close', (e) => {
      if (socket !== ws) return;
      rpc = undefined;
      client.failAll('Disconnected');
      const dot = document.getElementById('conn');
      if (dot !== null) dot.dataset.on = 'false';
      const why = closeMessage(e.code);
      if (why.unpair) {
        storage.set(TOKEN_KEY, undefined);
        open?.term.dispose();
        open = undefined;
        showPair(why.text);
        return;
      }
      setBanner(why.text, 'error');
      if (why.retry) {
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      }
    });
  }

  function onPush(method: string, p: Record<string, unknown>): void {
    if (method === 'output' && open !== undefined && p.project === open.project && p.session === open.session.id && typeof p.data === 'string') {
      open.term.write(p.data);
    } else if (method === 'exit' && open !== undefined && p.session === open.session.id) {
      open.term.write('\r\n\x1b[2m[the session’s shell exited]\x1b[0m\r\n');
    } else if (method === 'changed' && typeof p.project === 'string') {
      void loadSessions(p.project).then(() => { if (view === 'list') renderList(); else refreshSessionHeader(); });
    } else if (method === 'projects' && Array.isArray(p.projects)) {
      projects = p.projects as Project[];
      if (view === 'list') renderList();
    }
  }

  async function loadSessions(project: string): Promise<void> {
    if (rpc === undefined) return;
    try {
      const r = await rpc.call<{ sessions: Session[] }>('sessions', { project });
      sessions.set(project, r.sessions);
    } catch (err) {
      setBanner((err as Error).message, 'error');
    }
  }

  // ── The list ──
  function renderList(): void {
    view = 'list';
    const main = frame('crossweave');
    if (projects.length === 0) {
      main.append(el('p', { class: 'muted empty' }, 'No project is open in crossweave on the Mac.'));
      return;
    }
    for (const p of projects) {
      const section = el('section', { class: 'project' });
      const head = el('div', { class: 'project__head' });
      head.append(el('h2', {}, p.name));
      const add = el('button', { class: 'ghost', type: 'button' }, '+ New');
      add.addEventListener('click', () => void showCreate(p));
      head.append(add);
      section.append(head);
      const list = sessions.get(p.root) ?? [];
      if (list.length === 0) section.append(el('p', { class: 'muted empty' }, 'No sessions.'));
      for (const s of list) {
        const state = sessionState(s);
        const row = el('button', { class: 'row', type: 'button' });
        row.dataset.tone = state.tone;
        const dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
        const text = el('span', { class: 'row__text' });
        text.append(el('span', { class: 'row__title' }, sessionTitle(s)));
        // The name leads the meta line only when the title is something else.
        const meta = [sessionTitle(s) === s.name ? undefined : s.name, s.agent ?? undefined, usageLabel(s)].filter((x): x is string => typeof x === 'string' && x !== '');
        text.append(el('span', { class: 'row__meta' }, meta.join(' · ')));
        row.append(dot, text, el('span', { class: 'pill' }, state.label));
        row.addEventListener('click', () => void openSession(p.root, s));
        section.append(row);
      }
      main.append(section);
    }
  }

  // ── New session ──
  async function showCreate(p: Project): Promise<void> {
    if (rpc === undefined) return;
    let launchers: Launcher[] = [];
    try {
      launchers = (await rpc.call<{ launchers: Launcher[] }>('launchers', { project: p.root })).launchers;
    } catch (err) {
      setBanner((err as Error).message, 'error');
      return;
    }
    view = 'pair';
    const main = frame(`New in ${p.name}`, renderList);
    const form = el('form', { class: 'card' });
    const name = el('input', { id: 'new-name', name: 'name', autocomplete: 'off', maxlength: '64', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Session name' }) as HTMLInputElement;
    name.value = `phone-${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
    const select = el('select', { id: 'new-run', name: 'run', 'aria-label': 'Run' }) as HTMLSelectElement;
    select.append(el('option', { value: 'terminal' }, 'Just a shell'));
    for (const l of launchers) {
      const o = el('option', { value: l.id }, l.available ? l.label : `${l.label} (not installed)`) as HTMLOptionElement;
      o.disabled = !l.available;
      select.append(o);
    }
    const error = el('p', { class: 'error', role: 'alert' });
    error.hidden = true;
    const button = el('button', { class: 'primary', type: 'submit' }, 'Start');
    form.append(el('label', { for: 'new-name' }, 'Name'), name, el('label', { for: 'new-run' }, 'Run'), select, error, button);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      button.disabled = true;
      void (async () => {
        try {
          const created = await (rpc as Rpc).call<{ id: string }>('create', { project: p.root, name: name.value.trim(), launcher: select.value });
          await loadSessions(p.root);
          const s = sessions.get(p.root)?.find((x) => x.id === created.id) ?? { id: created.id, name: name.value.trim() };
          await openSession(p.root, s);
        } catch (err) {
          error.textContent = (err as Error).message;
          error.hidden = false;
          button.disabled = false;
        }
      })();
    });
    main.append(form);
  }

  // ── One session ──
  function refreshSessionHeader(): void {
    if (open === undefined) return;
    const s = sessions.get(open.project)?.find((x) => x.id === open?.session.id);
    if (s === undefined) return;
    open.session = s;
    const state = sessionState(s);
    const pill = document.getElementById('state');
    if (pill !== null) {
      pill.textContent = state.label;
      pill.dataset.tone = state.tone;
    }
    fit();
  }

  function fit(): void {
    if (open === undefined) return;
    const cols = open.session.cols ?? 80;
    const rows = open.session.rows ?? 24;
    open.term.resize(cols, rows);
    open.term.options.fontSize = fitFontSize(open.host.clientWidth - 8, cols);
  }

  async function watch(project: string, s: Session): Promise<void> {
    if (rpc === undefined || open === undefined) return;
    // Cleared first: the attach replays the recent scrollback onto a blank screen.
    open.term.reset();
    try {
      await rpc.call('watch', { project, session: s.id });
    } catch (err) {
      setBanner((err as Error).message, 'error');
    }
  }

  async function openSession(project: string, s: Session): Promise<void> {
    view = 'session';
    const previous = open;
    if (previous !== undefined && rpc !== undefined) void rpc.call('unwatch', { project: previous.project, session: previous.session.id }).catch(() => undefined);
    previous?.term.dispose();
    const main = frame(s.name, () => {
      if (open !== undefined && rpc !== undefined) void rpc.call('unwatch', { project: open.project, session: open.session.id }).catch(() => undefined);
      open?.term.dispose();
      open = undefined;
      renderList();
    });
    main.classList.add('session');
    const state = sessionState(s);
    const pill = el('span', { class: 'pill', id: 'state' }, state.label);
    pill.dataset.tone = state.tone;
    const head = el('div', { class: 'session__head' });
    head.append(el('span', { class: 'row__title' }, sessionTitle(s)), pill);
    const host = el('div', { class: 'term' });
    const keys = el('div', { class: 'keys' });
    for (const k of Object.values(KEYS)) {
      const b = el('button', { type: 'button', class: 'key' }, k.label);
      b.addEventListener('click', () => void send(k.data));
      keys.append(b);
    }
    const form = el('form', { class: 'answer' });
    const input = el('input', { name: 'reply', 'aria-label': 'Type to the session', placeholder: 'Reply…', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'send' }) as HTMLInputElement;
    const sendButton = el('button', { class: 'primary', type: 'submit' }, 'Send');
    form.append(input, sendButton);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      // The text, then Enter as its own write: a TUI that reads a paste as one chunk
      // would otherwise take the newline as part of the text rather than a submit.
      void send(text).then(() => send('\r'));
    });
    const running = s.status === 'running';
    if (running) main.append(head, host, keys, form);
    else main.append(head, stoppedBar(project, s), host);

    const { Terminal } = await import('./vendor/xterm.mjs' as string) as { Terminal: new (o: Record<string, unknown>) => XtermLike };
    const term = new Terminal({
      cols: s.cols ?? 80,
      rows: s.rows ?? 24,
      fontSize: 11,
      fontFamily: 'ui-monospace, Menlo, monospace',
      scrollback: 3000,
      cursorBlink: false,
      theme: { background: '#16191d', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#67769660' },
    });
    term.open(host);
    // Typing into the terminal itself works too (a hardware keyboard, or tapping it).
    term.onData((d) => void send(d));
    open = { project, session: s, term, host };
    fit();
    if (running) await watch(project, s);
  }

  /** A stopped session: its shell reopened, just a shell or one of the Mac's launchers. */
  function stoppedBar(project: string, s: Session): HTMLElement {
    const bar = el('form', { class: 'card stopped' });
    bar.append(el('p', { class: 'muted' }, 'This session’s shell is closed.'));
    const select = el('select', { name: 'run', 'aria-label': 'Run' }) as HTMLSelectElement;
    select.append(el('option', { value: 'terminal' }, 'Just a shell'));
    void rpc?.call<{ launchers: Launcher[] }>('launchers', { project }).then((r) => {
      for (const l of r.launchers) {
        const o = el('option', { value: l.id }, l.available ? l.label : `${l.label} (not installed)`) as HTMLOptionElement;
        o.disabled = !l.available;
        select.append(o);
      }
    }, () => undefined);
    const error = el('p', { class: 'error', role: 'alert' });
    error.hidden = true;
    const button = el('button', { class: 'primary', type: 'submit' }, 'Open the shell');
    bar.append(select, error, button);
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      if (rpc === undefined) return;
      button.disabled = true;
      void (async () => {
        try {
          await (rpc as Rpc).call('start', { project, session: s.id, launcher: select.value });
          await loadSessions(project);
          await openSession(project, sessions.get(project)?.find((x) => x.id === s.id) ?? { ...s, status: 'running' });
        } catch (err) {
          error.textContent = (err as Error).message;
          error.hidden = false;
          button.disabled = false;
        }
      })();
    });
    return bar;
  }

  async function send(data: string): Promise<void> {
    if (data === '' || open === undefined) return;
    if (rpc === undefined) {
      setBanner('Not connected — waiting for the Mac…', 'error');
      return;
    }
    try {
      await rpc.call('send', { project: open.project, session: open.session.id, data });
    } catch (err) {
      setBanner((err as Error).message, 'error');
    }
  }

  window.addEventListener('resize', fit);
  // iOS suspends a page in the background and drops its socket: reconnect on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (socket === undefined || socket.readyState === WebSocket.CLOSED) && storage.get(TOKEN_KEY) !== undefined) {
      retryMs = 1000;
      connect();
    }
  });

  if (code !== '' || storage.get(TOKEN_KEY) === undefined) showPair();
  else {
    renderList();
    connect();
  }
}

if (typeof document !== 'undefined' && document.getElementById('app') !== null) void startRemoteApp();
