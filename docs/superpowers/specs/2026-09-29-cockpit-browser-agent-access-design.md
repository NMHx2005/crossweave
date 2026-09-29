# Cockpit browser — let the session's agent see and drive the page

**Date:** 2026-09-29
**Status:** Planned (design approved in chat 2026-09-29)
**Scope:** `src/core/browser-agent/` (new, pure: permission, origin, redaction, ring
buffer), `apps/cockpit/electron/browser-agent.ts` (new, the only file touching
`webContents.debugger`), `apps/cockpit/src/ui/BrowserPane.tsx` (the switch + activity
line), `src/cli/commands/browser.ts` (new).
**Branch:** `feat/browser-agent`
**Depends on:** `2026-09-29-cockpit-command-bridge-design.md` (lands first).

## Problem

The Browser pane (`BrowserPane.tsx`) is a locked-down `<webview>`: no Node, no preload,
sandboxed, http(s) only, its own cookie partition (`main.ts:286-320`). It shows a dev
server beside the terminals — but the agent running in the session's shell cannot see it.
Debugging a UI means the person copies console errors out of a real browser and pastes
them back. The goal is for the agent to read the page's console, failed requests, DOM and
a screenshot, and to drive it, so it can debug without a human relay.

Decisions taken in chat (2026-09-29): the agent **reads and controls**; the channel is
**`cw browser` through the daemon** (no TCP port, no CDP endpoint, no MCP server — see
`AGENTS.md` "decisions already made"); permission is a **per-pane switch**, off by
default, control confined to local origins unless the person confirms.

## Goals / non-goals

**Goals**
- `cw browser console|network|dom|shot|navigate|click|type|eval|list`.
- Everything that leaves the pane is bounded and redacted by default.
- The person always sees what an agent did.

**Non-goals**
- A CDP port, an MCP server, video, performance traces, multiple tabs per pane, saved
  logins, or general browser automation.
- Protecting a page's content from an agent that was given *read*: that is what the
  switch is for.
- Any change to the webview lockdown. The debugger is attached from the main process,
  which never gives the page a preload or Node.

## Design

### Path

```
agent shell → cw browser <cmd> → daemon bridge.call {kind:'browser.<cmd>'}
   → cockpit main: browser-agent.ts (permission → origin → confirm → CDP)
   → webContents.debugger on the pane's webview
```

The daemon only forwards (command bridge spec). **Every decision is taken in the
cockpit main process**, so a compromised daemon path cannot exceed what the switch
allows.

### Permission

A pane has an **access level**: `off` | `read` | `control`. Default `off` every time a
pane is created or the cockpit starts; it is view state and is never persisted, never
sent to the daemon, and never saved in a layout.

| Command | Needs | Notes |
|---|---|---|
| `list` | — | Panes of the **caller's session** only (see Commands); never touches a page |
| `console`, `network`, `dom`, `shot` | `read` | |
| `navigate`, `click`, `type` | `control` | Origin rule below |
| `eval` | `control` | **Always confirmed, on every origin** — arbitrary JS is a wider grant than a click |

**Renderer surface (new — nothing exists in `channels.ts` today).** The renderer owns the
switch and the badge; main owns enforcement. Two entries in the allowlist
(`apps/cockpit/electron/channels.ts`):
- invoke `browser.setAccess` `{paneId, webContentsId, level}` — renderer → main when the
  switch changes (and when a pane mounts, to register its webview at `off`);
- event `browser.activity` `{t, command, target}` — main → renderer, for the activity line.
The confirmation dialog is **native** (`dialog.showMessageBox` from main), so it needs no
renderer channel. The webview cannot call `browser.setAccess`: it has no preload and is
sandboxed. Main validates that `webContentsId` is a `webview` guest hosted by the cockpit
window (`webContents.fromId(id)?.getType() === 'webview'` and its `hostWebContents` is the
window's), keeps `paneId → {webContentsId, level}`, drops the entry when the webview is
destroyed, and treats an unknown pane as `off`.

### Origin rule for `control`

`navigate`, `click` and `type` run without asking only when the pane's **current** origin
is `localhost`, `127.0.0.1` or `[::1]`. On any other origin — and for `eval` on **every**
origin — the cockpit shows a modal confirmation naming the command, the origin and (for
`eval`) the script text ("An agent wants to `click` on example.com"); allow is **for that
one command**, nothing is remembered, and no answer in 20 s is a denial
(`BROWSER_NEEDS_CONFIRM`). The CLI calls the bridge with `timeoutMs` 30 s for `control`
commands and 10 s for reads, so the bridge never times out before the dialog does
(command bridge spec: a kind's confirm timeout stays below its CLI's). Prompts queue one at a time. `navigate` is
checked against the origin it *leaves*, and only accepts `http(s)` URLs (as the webview
already does). The origin is read from the live page at execution time, never from the
request.

### Capture: ring buffers

Started when a pane goes above `off`, cleared when it returns to `off`, when the webview
is destroyed, and when the page navigates to a **different origin**.

- **Console:** last 500 entries `{t, level, text, url?, line?}`; each text cut at 2 KB.
- **Network:** last 300 requests, metadata only `{t, method, url, status, type, ms,
  bytes, failed, error?}`. No request or response bodies.

Attach is lazy and refcounted per webContents; detach on `off`, and on `detach` events
(a DevTools session opened by the person is unaffected — `debugger.attach` failing
because DevTools owns the target returns `BROWSER_DEBUGGER_BUSY`, not a crash).

### Redaction (default on)

Applied to `console` text and to `network` URLs before anything leaves main: any query
parameter or JSON-ish `key=value` whose name matches
`/token|key|secret|passw|auth|session/i` becomes `[redacted]`. Network capture holds **no
headers** (only the metadata listed above), so there are none to redact. Redaction is best effort on text. **`dom`, `eval` results and screenshots
are not redactable** — they are the page. That is why control is local-only by default,
and it is a stated limitation.

### Commands and output

All accept `--pane <id|name>`; default is the only Browser pane of the caller's session
(`CW_SESSION_ID` is a *hint for the default*, not authority — spoofing it only widens what
`list` shows, which is why `list` shows just the caller's session unless a pane is named).
Output is JSON, one object per line, with `--limit` (default 50).

- `console [--since <ms>] [--level error|warn|info|all]`
- `network [--failed] [--since <ms>]`
- `dom [--selector <css>] [--max <chars>]` — the subtree's rendered text (`innerText`),
  default cap 20 000 chars; not raw HTML and not the accessibility tree.
- `shot [--selector <css>]` — the **cockpit main process writes the PNG** (never sent over
  the bridge) to `<projectRoot>/.crossweave/shots/<timestamp>.png` — the workspace state
  directory, already gitignored, path checked with `assertContained` — keeps the newest 20,
  caps one image at 8 MB, and returns the path, which the CLI prints.
- `navigate <url>`, `click <selector>`, `type <selector> <text>`, `eval <js>` — `eval`
  uses `Runtime.evaluate` with `awaitPromise` and `returnByValue`; a non-serialisable or
  cyclic result (a DOM node) is `BROWSER_EVAL_UNSERIALIZABLE`, not a crash. Result cap
  64 KB, script timeout 5 s.

Untrusted content: everything read from a page is **data the page authored**. Every
output object from `console`, `network` and `dom` carries a top-level `"untrusted": true`
so an agent framework can treat the text as data, and `cw browser --help` says so.
(Indirect prompt injection through page text is the realistic attack on this feature.)

Errors follow the CLI's one-line `CODE: message`: `BROWSER_PANE_OFF`,
`BROWSER_NEEDS_CONFIRM`, `BROWSER_NO_PANE`, `BROWSER_DEBUGGER_BUSY`,
`BROWSER_TIMEOUT`, `BROWSER_BAD_SELECTOR`, `BROWSER_EVAL_UNSERIALIZABLE`, plus the
bridge's own codes.

### What the person sees

- The pane shows the level as a badge in its chrome; the switch is one control with the
  three levels.
- An **activity line** (last 50 actions, in memory) lists each agent action:
  time, command, selector/url. Reading commands are logged too, without their output.
- The confirmation dialog is the only interruption.

## Security

- Threat model: a prompt-injected agent in a session (it can reach the daemon socket and
  therefore the bridge — bridge spec) and hostile page content reaching the agent through
  `dom`/`console`. Not in scope: other malware running as the user.
- **The per-pane switch does not defend integrity against a same-user process that
  registers on the bridge first** (it could swallow requests and forge `cw browser`
  output). The bridge refuses a second registration and the cockpit tells the person when
  the slot is taken; the residual risk is stated in both known-limitations files.
- The switch defaulting to `off`, main-process enforcement, the live-origin check and
  per-command confirmation are the controls. There is **no** "remember this" and no
  session-wide grant.
- No new listener, no CDP port; `debugger` is attached only while a pane is above `off`.
- Redaction and caps bound what a read exposes and what a page can cost in memory.
- The lockdown in `hardenWebviews()` is unchanged; a test asserts the webview still has
  no preload and sandbox on.

## Testing

Pure, in root `bun test` (no Electron): `tests/core/browser-agent/` — permission matrix
(command × level), origin classification (`localhost`, `127.0.0.1`, `[::1]`, `LOCALHOST`,
lookalikes like `localhost.evil.com`, `127.0.0.1.evil.com`, userinfo tricks), redaction
(headers, query, key=value, no false blank of ordinary text), ring buffer cap/eviction/
clear on origin change, size caps.
Cockpit main with a fake debugger: attach refcount, `off` clears buffers, unknown pane =
off, confirm timeout = deny, prompts serialised, origin read at execution time (page
navigates between request and run). CLI: one-line error format and the `shot` file path.
Live Electron checks (real webview, real CDP) run outside the sandbox like the existing
packaged smoke, and are reported as such.

## Risks

- **Origin race:** the page navigates between the check and the action — the origin is
  re-read immediately before dispatch and the CDP call is scoped to the same frame.
- **`eval` is arbitrary JS on a logged-in page** when confirmed on a non-local origin —
  mitigated only by the confirmation naming the command; the script text is shown in the
  dialog.
- **Memory** — bounded by the caps; buffers die with `off`.

## Known limitations (to write at merge)

- Screenshots, `dom` and `eval` results are not redacted.
- One Browser pane webview per pane; iframes are reachable only through `eval`.
- All Browser panes share one cookie jar (`partition="persist:cockpit-browser"`, per
  partition, not per pane), so a login in one pane is visible to a `control` on another;
  saved logins stay a non-goal, but the jar persists.
- The activity line is in memory only; there is no durable audit trail.
- Network bodies are never captured.
- Reading page text can carry hostile instructions to the agent; the switch is the
  defence, not a filter.
