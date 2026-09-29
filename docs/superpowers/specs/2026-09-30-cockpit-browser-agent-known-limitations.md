# Cockpit browser agent access — known limitations

Spec: `2026-09-29-cockpit-browser-agent-access-design.md`. Plan: `docs/superpowers/plans/2026-09-30-browser-agent.md`.
Branch: `feat/browser-agent` (stacked on `feat/pane-bridge`).

## What shipped

`cw browser list|console|network|dom|shot|navigate|click|type|eval` reads and drives a Browser pane through the
command bridge. Every decision is in the cockpit **main** process (`electron/browser-agent.ts`): the pane's
Off/Read/Control switch (off on every creation, never persisted), control off localhost — and `eval` on every
origin — asks a native dialog for that one command (no answer in 20 s is a refusal, one dialog at a time, nothing
remembered), the origin is read from the live guest at execution, and the page is reached only through the
debugger of a `webview` guest that main validated as hosted by its own window. Reads are redacted and bounded,
page text carries `"untrusted": true`, screenshots are written by main under `.crossweave/shots/`. The webview
lockdown (`hardenWebviews`) is unchanged; `scripts/browser-check.ts` proves on the running app that the guest still
has no `require`, `process` or `cockpit`.

## Where the implementation differs from the spec

- **A Browser pane has no session**, so "the caller's session" cannot scope `list` or the default pane. The scope is
  the caller's **project**: the default pane is the only Browser pane of the project, `--pane <id>` picks one, and
  a pane of another open project is not addressable. `CW_SESSION_ID` is not used. `--pane` takes an id, not a name.
- The renderer tells main the project at registration (the window's per-project API adds it), so the registry is
  keyed by pane and filtered by project.
- A debugger `detach` (DevTools opened by the person, a crash) is pushed on `browser.activity` as
  `command: 'detached'` and the switch falls back to Off, instead of a third channel.
- `--failed` on `network` includes HTTP error statuses (≥ 400), not only transport failures: a 404 is what a
  person debugging a page wants to see.
- A request that waited in the dialog queue until fewer than 2 s of its 25 s budget remain is refused without a
  dialog: nobody could answer it before the CLI gave up.

## Limitations

- **Screenshots, `dom` and `eval` results are not redacted** — they are the page. Redaction is best effort on
  console text and network URLs only (names matching `token|key|secret|passw|auth|session`); it has false
  positives (`monkey: …`) and cannot see a secret inside prose.
- **Hostile page text reaches the agent.** `untrusted: true` and `cw browser --help` say so; the switch is the
  defence, not a filter.
- **The switch does not defend integrity against a same-user process that registers on the bridge first** (it
  could swallow requests and forge output). The bridge refuses a second registration and the cockpit tells the
  person when the slot is taken; nothing more is possible without authenticating the caller.
- `eval` on a non-local origin, once confirmed, is arbitrary JS on a page that may be logged in; the dialog shows
  the script (first 2000 characters) and that is the only mitigation.
- One `webview` per pane and one debugger per page: iframes are reachable only through `eval`; if DevTools owns the
  page, raising the switch fails with `BROWSER_DEBUGGER_BUSY`.
- All Browser panes share one cookie jar (`persist:cockpit-browser`); a login in one pane is visible to a
  `control` on another. The jar persists, saved logins remain a non-goal.
- The activity line is in memory (last 50); there is no durable audit trail. The native dialog cannot be answered
  by a script: an unattended run always ends in a refusal, by design.
- `click` is a real mouse event at the element's centre after `scrollIntoView`; an element covered by another
  receives nothing and the command still reports `ok`. `type` inserts text into the focused element, no key events.
- The 20 s no-answer path is covered by unit tests with a fake dialog; the live script measured a refusal in about
  5 s (the dialog was dismissed), so the abort-signal path on a real macOS sheet is not separately exercised.
- Not run: a packaged (`dist:mac`) build of this branch.
