import { defineCommand } from 'citty';
import {
  createCliRenderer,
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  TextRenderable,
  type KeyEvent,
  type SelectOption,
} from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { findProjectRoot } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { connectOrStart, type DaemonClient } from '../../client/rpc-client.js';
import { fail } from '../context.js';
import type { SessionRow } from '../../db/repositories/session.js';
import { humanBytes } from '../../isolation/disk-guard.js';
import { format, type NotifyEvent } from '../../notify/dispatcher.js';

interface WorkspaceInit { id: string; name: string }
interface Workspace { id: string; name: string; rootPath: string; safeModeTier: string }
interface DiskInfo { usedBytes: number; limitBytes: number }
// `disk` is an RPC-layer enrichment (see 'workspace.info' in src/daemon/methods.ts) —
// `WorkspaceManager.info()` itself still only returns `{workspace, sessions}`.
interface WorkspaceInfo { workspace: Workspace; sessions: SessionRow[]; disk: DiskInfo }
interface ConvergeStatus {
  pairwise: { a: string; b: string; result: string }[];
  fullIntegration: { result: string; ts: string; detail: string | null } | null;
  recommendedOrder: string[];
  // The RPC handler (src/daemon/methods.ts 'converge.status') has always returned
  // this — the degree-0 subset of `recommendedOrder`, i.e. sessions with no known
  // conflict. Not declared here until now because nothing in this file read it;
  // land-all (Task 7) is that first reader.
  conflictFree: string[];
  degraded: boolean;
}

// Populated by the initial fetch in `run()` below and read by the panes Tasks 4-6
// add (session list, convergence matrix, workspace/budget info).
let latestSessions: SessionRow[] = [];
let latestConvergeStatus: ConvergeStatus | null = null;
let latestWorkspaceInfo: WorkspaceInfo | null = null;

// Unlike the three `latestX` above, this isn't refetched by `refresh()` — it only
// ever grows from live `'tui.event'` notifications (see `appendFeedLine` below).
// Kept module-level (not just on the pane) for the same reason `latestSessions`
// etc. are: `'tui.event'` notifications can arrive before `feedPane` is mounted
// (the gap between `daemon.subscribe` and `createCliRenderer` below), so the text
// must survive until the pane exists to read it.
const FEED_MAX_LINES = 200;
let latestFeedLines: string[] = [];

/**
 * Pure data → string formatting, kept separate from the OpenTUI wiring below so it
 * is unit-testable without a real terminal (see tests/cli/tui-panes.test.ts).
 *
 * Dot mapping follows the same live/idle/terminal grouping already used elsewhere
 * in the domain layer (src/domain/bus.ts groups 'running'+'waiting' as live;
 * src/domain/gc.ts and src/domain/session.ts group 'dead'+'landed' as terminal),
 * not an invented one.
 */
export function formatSessionRow(row: SessionRow): { text: string; dot: '●' | '○' | '✕' } {
  const dot: '●' | '○' | '✕' =
    row.status === 'running' || row.status === 'waiting' ? '●' :
    row.status === 'dead' || row.status === 'landed' ? '✕' : '○';
  const text = `${row.name}  ${row.status}  ${row.enforcementTier}  $${row.costSpentUsd.toFixed(2)}`;
  return { text, dot };
}

/**
 * `disk` comes from `workspace.info`'s RPC-layer enrichment (src/daemon/methods.ts),
 * backed by `measureWorktrees` (M1's Disk Guard, src/isolation/disk-guard.ts) —
 * `WorkspaceManager.info()` itself doesn't carry it, only the RPC response does.
 */
export function formatStatusBar(
  ws: { name: string },
  sessions: SessionRow[],
  disk: { usedBytes: number; limitBytes: number },
): string {
  const totalCost = sessions.reduce((sum, s) => sum + s.costSpentUsd, 0);
  const count = sessions.length;
  return (
    `${ws.name}  |  ${count} session${count === 1 ? '' : 's'}  |  ` +
    `$${totalCost.toFixed(2)} spent  |  disk ${humanBytes(disk.usedBytes)}/${humanBytes(disk.limitBytes)}`
  );
}

/**
 * `converge.status`'s `pairwise` entries carry branch names (`trial.branches`,
 * see the `'converge.status'` handler in src/daemon/methods.ts), not session
 * names — the RPC never resolves them. `branchToSessionName` (built from the
 * same `session.list` rows already fetched for the session-list pane, via
 * `SessionRow.branch`) does that resolution here, so the matrix reads by
 * session name like every other pane instead of leaking raw branch names.
 * An unresolvable branch (session gone, or literally not found) falls back to
 * showing the pair as unknown rather than crashing or guessing.
 */
export function formatConvergenceMatrix(
  sessionNames: string[],
  pairwise: { a: string; b: string; result: string }[],
  branchToSessionName: Map<string, string>,
): string[][] {
  const grid: string[][] = sessionNames.map((_, i) => sessionNames.map((_, j) => (i === j ? '—' : '?')));
  for (const p of pairwise) {
    const i = sessionNames.indexOf(branchToSessionName.get(p.a) ?? p.a);
    const j = sessionNames.indexOf(branchToSessionName.get(p.b) ?? p.b);
    if (i === -1 || j === -1 || i === j) continue;
    // Only clean/not-clean is shown — 'test_fail' and 'unverified' trials still
    // mean "don't land this pair together", same practical signal as 'conflict'.
    const cell = p.result === 'clean' ? 'clean' : 'conflict';
    grid[i]![j] = cell;
    grid[j]![i] = cell;
  }
  return grid;
}

/**
 * Thin wrapper around `format()` (src/notify/dispatcher.ts) — a timestamp prefixed
 * onto the exact same title/message text the desktop notification uses. Deliberately
 * not a parallel reimplementation: reusing `format()` verbatim is what keeps the
 * feed pane and the OS notification from drifting apart (design doc §3.2).
 */
export function formatFeedLine(event: NotifyEvent): string {
  const { title, message } = format(event);
  return `${new Date().toLocaleTimeString()}  ${title}: ${message}`;
}

/**
 * Pure ordering loop for `L` (land all) — mirrors `cw land all`'s existing logic
 * (src/cli/commands/land.ts's `allCommand`) but takes an injected `land` function
 * instead of a `DaemonClient`, so it's testable without a real RPC call (see
 * tests/cli/tui-actions.test.ts). Stops at the first failure rather than
 * continuing past it, same as the CLI command.
 */
export async function landAllInOrder(
  names: string[],
  land: (name: string) => Promise<void>,
): Promise<{ landed: string[]; failedAt: string | undefined }> {
  const landed: string[] = [];
  for (const name of names) {
    try {
      await land(name);
      landed.push(name);
    } catch {
      return { landed, failedAt: name };
    }
  }
  return { landed, failedAt: undefined };
}

function branchToSessionNameMap(sessions: SessionRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sessions) {
    if (s.branch) map.set(s.branch, s.name);
  }
  return map;
}

/** Renders `formatConvergenceMatrix`'s grid as a monospaced text table, matching
 * how `cw converge status` (src/cli/commands/converge.ts) already reports pairs. */
function renderConvergenceMatrixText(sessionNames: string[], grid: string[][]): string {
  if (sessionNames.length === 0) return 'no active sessions';
  const colWidth = Math.max(...sessionNames.map((n) => n.length), 'conflict'.length) + 1;
  const pad = (s: string) => s.padEnd(colWidth);
  const header = pad('') + sessionNames.map(pad).join('');
  const rows = sessionNames.map((name, i) => pad(name) + grid[i]!.map(pad).join(''));
  return [header, ...rows].join('\n');
}

function convergenceMatrixText(sessions: SessionRow[], convergeStatus: ConvergeStatus): string {
  const sessionNames = sessions.map((s) => s.name);
  const grid = formatConvergenceMatrix(sessionNames, convergeStatus.pairwise, branchToSessionNameMap(sessions));
  return renderConvergenceMatrixText(sessionNames, grid);
}

function sessionsToOptions(sessions: SessionRow[]): SelectOption[] {
  return sessions.map((row) => {
    const { text, dot } = formatSessionRow(row);
    return { name: `${dot} ${text}`, description: row.branch ?? row.worktreePath ?? row.id, value: row.id };
  });
}

/**
 * Duck-typed subset of `CliRenderer` this needs — narrow enough that a test can
 * fake it without spinning up a real renderer (which needs a real TTY).
 */
interface QuitAwareRenderer {
  on(event: string, listener: () => void): void;
  keyInput: { on(event: 'keypress', listener: (key: { name: string }) => void): void };
  destroy(): void;
}

/**
 * Resolves once the renderer is actually destroyed — whether that's triggered by
 * 'q' here or by the library's own signal-triggered `exitHandler` (SIGINT/SIGTERM/
 * etc., see `createCliRenderer`'s call site) — never by `renderer.stop()`, which
 * only clears internal timers/control-state and never restores the terminal
 * (no `stdin.setRawMode(false)`, no alternate-screen teardown — verified against
 * `node_modules/@opentui/core`'s actual `cleanupBeforeDestroy`/`finalizeDestroy`).
 * Using the renderer's own 'destroy' event as the single completion signal means
 * every path that ends in a real terminal restore also lets `run()` reach its
 * `finally` and close the daemon connection, instead of only 'q' being able to.
 */
export function waitForQuit(renderer: QuitAwareRenderer): Promise<void> {
  return new Promise<void>((resolve) => {
    renderer.on(CliRenderEvents.DESTROY, () => resolve());
    renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'q') renderer.destroy();
    });
  });
}

export const tuiCommand = defineCommand({
  meta: { name: 'tui', description: 'Live dashboard — sessions, radar, convergence, budget' },
  async run() {
    // Deliberately NOT withClient (src/cli/context.ts) — that closes the connection
    // right after one call. This command holds one connection for its whole
    // lifetime, closing it only on quit. See plan Global Constraints.
    const projectRoot = findProjectRoot(process.cwd());
    loadConfig(projectRoot);
    let client: DaemonClient | undefined;
    try {
      client = await connectOrStart(projectRoot);
      // Narrowed, non-optional binding: `refresh` below is a nested function, and TS
      // does not carry the `client is DaemonClient` narrowing from the assignment
      // above across a closure boundary.
      const conn = client;

      const ws = await conn.call<WorkspaceInit>('workspace.init', {});

      let sessionListPane: SelectRenderable | undefined;
      let convergenceMatrixPane: TextRenderable | undefined;
      let statusBarPane: TextRenderable | undefined;
      let feedPane: TextRenderable | undefined;

      /**
       * Appends one line per `'tui.event'`, capped at `FEED_MAX_LINES` so a
       * long-running `cw tui` process never grows this pane's backing text
       * unboundedly. Scrolled to the bottom on every append so the newest line
       * (design doc §4.1: "newest at the bottom") is always the one visible.
       */
      function appendFeedLine(event: NotifyEvent): void {
        latestFeedLines.push(formatFeedLine(event));
        if (latestFeedLines.length > FEED_MAX_LINES) latestFeedLines = latestFeedLines.slice(-FEED_MAX_LINES);
        if (feedPane) {
          feedPane.content = latestFeedLines.join('\n');
          feedPane.scrollY = feedPane.maxScrollY;
        }
      }

      /**
       * Both the initial data load and every `'tui.invalidate'`-triggered reload run
       * through this one function — it always updates the module-level `latestX`
       * state, and updates the rendered panes too whenever they've been mounted
       * (they haven't yet the first time this runs, before `createCliRenderer`).
       */
      async function refresh(): Promise<void> {
        const [sessions, convergeStatus, workspaceInfo] = await Promise.all([
          conn.call<SessionRow[]>('session.list', { workspaceId: ws.id }),
          conn.call<ConvergeStatus>('converge.status', { workspaceId: ws.id }),
          conn.call<WorkspaceInfo>('workspace.info', { id: ws.id }),
        ]);
        latestSessions = sessions;
        latestConvergeStatus = convergeStatus;
        latestWorkspaceInfo = workspaceInfo;
        if (sessionListPane) sessionListPane.options = sessionsToOptions(sessions);
        if (convergenceMatrixPane) convergenceMatrixPane.content = convergenceMatrixText(sessions, convergeStatus);
        if (statusBarPane) statusBarPane.content = formatStatusBar(workspaceInfo.workspace, sessions, workspaceInfo.disk);
      }

      // Registered before daemon.subscribe (matching attach.ts's established
      // register-before-subscribe pattern) so an invalidate broadcast that lands the
      // instant subscription takes effect — even before the panes below exist — is
      // never missed.
      conn.onNotification((method, params) => {
        // A refresh failure (daemon restart, workspace deleted mid-session) must not
        // become an unhandled rejection in this long-running interactive command —
        // matches watcher.ts/convergence-scheduler.ts's own fire-and-forget
        // background-tick pattern (log and keep the dashboard up, don't crash it).
        if (method === 'tui.invalidate') {
          void refresh().catch((err: unknown) => {
            process.stderr.write(`crossweave: tui refresh failed: ${String(err)}\n`);
          });
        } else if (method === 'tui.event') {
          // `params` is the full notify()-event payload (design doc §3.2) — the
          // daemon broadcasts it verbatim (src/daemon/methods.ts), so it's trusted
          // to already match `NotifyEvent`'s shape without further validation here.
          appendFeedLine(params as NotifyEvent);
        }
      });
      await conn.call('daemon.subscribe', {});
      await refresh();

      // No `exitSignals` override: the library's own default (SIGINT/SIGTERM/SIGHUP/
      // etc.) must stay wired up, or none of those signals ever restore the terminal
      // — `renderer.destroy()` is the only thing that calls `stdin.setRawMode(false)`
      // and tears down the alternate screen, and an empty `exitSignals` array disables
      // the library's own signal-triggered call to it entirely.
      const renderer = await createCliRenderer({ exitOnCtrlC: false });
      const root = new BoxRenderable(renderer, {
        id: 'root',
        width: '100%',
        height: '100%',
        borderStyle: 'rounded',
        title: `crossweave — ${ws.name}`,
        titleAlignment: 'left',
        flexDirection: 'column',
      });
      renderer.root.add(root);

      sessionListPane = new SelectRenderable(renderer, {
        id: 'session-list',
        width: '100%',
        flexGrow: 1,
        options: sessionsToOptions(latestSessions),
      });
      root.add(sessionListPane);
      // Narrowed, non-optional binding: the keymap actions below are nested
      // functions, and TS does not carry the assignment-above narrowing of the
      // module-level `sessionListPane` across a closure boundary (same reason
      // `conn` exists alongside `client` above).
      const sessionList = sessionListPane;
      // Explicit, not relying on `CliRenderer`'s own `autoFocus` default: the
      // keymap layer below is scoped to `sessionList`'s focus (`targetMode:
      // 'focus'`), so it only ever fires if this renderable actually holds
      // focus. `closeForm()` further down restores focus here the same way
      // after the new-session form closes.
      sessionList.focus();

      const convergenceBox = new BoxRenderable(renderer, {
        id: 'convergence-matrix-box',
        width: '100%',
        height: 'auto',
        borderStyle: 'single',
        title: 'Convergence',
        titleAlignment: 'left',
      });
      root.add(convergenceBox);
      convergenceMatrixPane = new TextRenderable(renderer, {
        id: 'convergence-matrix',
        width: '100%',
        height: 'auto',
        content: latestConvergeStatus ? convergenceMatrixText(latestSessions, latestConvergeStatus) : '',
      });
      convergenceBox.add(convergenceMatrixPane);

      const radarFeedBox = new BoxRenderable(renderer, {
        id: 'radar-feed-box',
        width: '100%',
        height: 8,
        borderStyle: 'single',
        title: 'Radar feed',
        titleAlignment: 'left',
      });
      root.add(radarFeedBox);
      feedPane = new TextRenderable(renderer, {
        id: 'radar-feed',
        width: '100%',
        height: '100%',
        content: latestFeedLines.join('\n'),
      });
      radarFeedBox.add(feedPane);
      feedPane.scrollY = feedPane.maxScrollY;

      statusBarPane = new TextRenderable(renderer, {
        id: 'status-bar',
        width: '100%',
        height: 1,
        content: latestWorkspaceInfo
          ? formatStatusBar(latestWorkspaceInfo.workspace, latestSessions, latestWorkspaceInfo.disk)
          : '',
      });
      root.add(statusBarPane);

      // One-line pane for keymap-action feedback: the y/n confirm prompt text
      // (destructive ops, design doc §5.4) and the outcome of every action below
      // (created/landed/killed/gc'd, or an error) — so a failure is shown, never
      // silently swallowed (plan Step 5). Placed above the status bar so it reads
      // as transient, unlike the persistent panes above it.
      const actionStatusPane = new TextRenderable(renderer, {
        id: 'action-status',
        width: '100%',
        height: 1,
        content: '',
      });
      root.add(actionStatusPane, root.getChildren().indexOf(statusBarPane));

      function setActionStatus(text: string): void {
        actionStatusPane.content = text;
      }

      // Guards every action below against re-entrancy: a keymap binding stays
      // "active" (still matched against `sessionList`'s focus) for the whole
      // duration of a y/n confirm, since the confirm prompt deliberately doesn't
      // move focus off `sessionList` (brief: "a simple TextRenderable ... plus a
      // one-shot keypress listener, not a full modal component"). Without this
      // flag, e.g. pressing 'n' while a kill confirm is showing would ALSO open
      // the new-session form — `preventDefault` on the matched binding does not
      // stop a directly-attached `renderer.keyInput` listener (confirm's own,
      // or `waitForQuit`'s) from receiving the same raw keypress, since that's
      // just another EventEmitter subscriber, not something the keymap library
      // can suppress. This flag is the actual guarantee, not event ordering.
      let uiBusy = false;

      function getSelectedSession(): SessionRow | undefined {
        return latestSessions[sessionList.getSelectedIndex()];
      }

      /** One-shot y/n confirm, per design doc §5.4 — any key other than 'y' cancels. */
      function confirmDestructive(prompt: string): Promise<boolean> {
        setActionStatus(`${prompt} (y/n)`);
        return new Promise<boolean>((resolve) => {
          renderer.keyInput.once('keypress', (key: KeyEvent) => {
            resolve(key.name === 'y');
          });
        });
      }

      async function openNewSessionForm(): Promise<void> {
        if (uiBusy) return;
        uiBusy = true;

        const formBox = new BoxRenderable(renderer, {
          id: 'new-session-form',
          width: '100%',
          height: 'auto',
          borderStyle: 'single',
          title: 'New session — name, Enter, agent, Enter (Esc to cancel)',
          titleAlignment: 'left',
        });
        const nameInput = new InputRenderable(renderer, {
          id: 'new-session-name',
          width: '100%',
          placeholder: 'session name',
        });
        const agentInput = new InputRenderable(renderer, {
          id: 'new-session-agent',
          width: '100%',
          placeholder: 'agent',
          value: 'claude',
        });
        formBox.add(nameInput);
        formBox.add(agentInput);
        root.add(formBox, root.getChildren().indexOf(actionStatusPane));

        const closeForm = (): void => {
          root.remove(formBox);
          formBox.destroyRecursively();
          sessionList.focus();
          uiBusy = false;
        };
        const onEscape = (key: KeyEvent): void => {
          if (key.name === 'escape') closeForm();
        };
        nameInput.onKeyDown = onEscape;
        agentInput.onKeyDown = onEscape;

        nameInput.on(InputRenderableEvents.ENTER, (name: string) => {
          if (!name.trim()) {
            setActionStatus('session name is required');
            return;
          }
          agentInput.focus();
        });

        agentInput.on(InputRenderableEvents.ENTER, (agent: string) => {
          const name = nameInput.value.trim();
          if (!name) {
            setActionStatus('session name is required');
            nameInput.focus();
            return;
          }
          const agentKind = agent.trim() || 'claude';
          closeForm();
          void conn
            .call('session.new', { workspaceId: ws.id, name, agent: agentKind })
            .then(() => setActionStatus(`created session ${name}`))
            .catch((err: unknown) => setActionStatus(`create session failed: ${(err as Error).message}`));
        });

        nameInput.focus();
      }

      async function landSelected(): Promise<void> {
        if (uiBusy) return;
        const session = getSelectedSession();
        if (!session) {
          setActionStatus('no session selected');
          return;
        }
        uiBusy = true;
        try {
          await conn.call('land.session', { workspaceId: ws.id, idOrName: session.name });
          setActionStatus(`landed ${session.name}`);
        } catch (err) {
          setActionStatus(`land failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      async function landAll(): Promise<void> {
        if (uiBusy) return;
        uiBusy = true;
        try {
          const status = await conn.call<ConvergeStatus>('converge.status', { workspaceId: ws.id });
          if (status.conflictFree.length === 0) {
            setActionStatus('nothing to land');
            return;
          }
          const result = await landAllInOrder(status.conflictFree, async (name) => {
            await conn.call('land.session', { workspaceId: ws.id, idOrName: name });
          });
          setActionStatus(
            result.failedAt
              ? `landed ${result.landed.join(', ') || '(none)'}; stopped at ${result.failedAt}`
              : `landed ${result.landed.join(', ')}`,
          );
        } catch (err) {
          setActionStatus(`land all failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      async function killSelected(): Promise<void> {
        if (uiBusy) return;
        const session = getSelectedSession();
        if (!session) {
          setActionStatus('no session selected');
          return;
        }
        uiBusy = true;
        try {
          const confirmed = await confirmDestructive(`kill ${session.name}?`);
          if (!confirmed) {
            setActionStatus('cancelled');
            return;
          }
          await conn.call('session.kill', { workspaceId: ws.id, idOrName: session.name });
          setActionStatus(`killed ${session.name}`);
        } catch (err) {
          setActionStatus(`kill failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      async function runGc(): Promise<void> {
        if (uiBusy) return;
        uiBusy = true;
        try {
          const confirmed = await confirmDestructive('run gc?');
          if (!confirmed) {
            setActionStatus('cancelled');
            return;
          }
          await conn.call('workspace.gc', { id: ws.id });
          setActionStatus('gc complete');
        } catch (err) {
          setActionStatus(`gc failed: ${(err as Error).message}`);
        } finally {
          uiBusy = false;
        }
      }

      // `createDefaultOpenTuiKeymap`, not the bare `createOpenTuiKeymap`: the
      // core keymap ships with zero binding parsers registered (confirmed
      // against node_modules/@opentui/keymap/src/index.js — a bare keymap
      // throws "No keymap binding parsers are registered" for any string-keyed
      // binding, caught per-binding and turned into a silently-dropped
      // 'binding-compile-error'). `createDefaultOpenTuiKeymap` registers
      // `registerDefaultKeys` first, which is what actually parses plain keys
      // like 'n'/'l'/'L'/'k'/'g'.
      //
      // Scoped to `sessionList`'s own focus (targetMode: 'focus'), not a global
      // layer: this is what keeps these 5 keys from firing while the new-session
      // form has focus (letters typed into the name/agent fields must reach the
      // `InputRenderable`s, not this layer) — the keymap re-checks the focused
      // target on every keypress, so moving focus off `sessionList` deactivates
      // the whole layer without any manual enable/disable bookkeeping.
      const keymap = createDefaultOpenTuiKeymap(renderer);
      keymap.registerLayer({
        target: sessionList,
        targetMode: 'focus',
        bindings: [
          { key: 'n', cmd: () => void openNewSessionForm() },
          { key: 'l', cmd: () => void landSelected() },
          // Not 'L': this library's own key names are lowercase with a separate
          // `shift` flag (confirmed against @opentui/core's own default Textarea
          // bindings, e.g. `{ name: 'a', ctrl: true, shift: true }` for
          // ctrl+shift+a) — `'L'` would compile to `{name:'L', shift:false}`,
          // which a real capital-L keypress (`{name:'l', shift:true}`) never
          // matches. `'shift+l'` is this library's spelling for "capital L".
          { key: 'shift+l', cmd: () => void landAll() },
          { key: 'k', cmd: () => void killSelected() },
          { key: 'g', cmd: () => void runGc() },
        ],
      });

      renderer.start();

      await waitForQuit(renderer);
    } catch (err) {
      fail(err);
    } finally {
      client?.close();
    }
  },
});
