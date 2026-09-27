# Plan — live projects

Spec: `docs/superpowers/specs/2026-09-27-live-projects-design.md`
Branch: `feat/live-projects`

## Steps

1. [x] **Bridge routing for every RPC** (`electron/daemon-bridge.ts`): `projectRoot` routes
   any RPC channel to an open project; refuse others. Tests: route, refuse unknown,
   default to active. Replaces the four-channel `ROUTABLE` set.
2. [x] **Bridge forwards every project's notifications**, tagged with `projectRoot`;
   `daemon.gone` per project; drop `project.invalidate` (channels allowlist + tests).
3. [x] **`projectApi(root)`** (`src/host/cockpit-api.ts`, beside `cockpitApi`): `cockpitApi`'s calls with
   `projectRoot`, event subscriptions filtered to that root. Unit tests with a fake
   `window.cockpit`.
4. [x] **Context + panes**: `ProjectApiContext`; `pane-source`, `XtermPane`, `FilePane`,
   `ChangesPane` take the API from context. Hidden-pane resize guard (0×0).
5. [x] **`ProjectView`**: move per-project state and handlers out of `App`, bound to the
   view's API; `App` keeps the host parts. Views report sessions/attention to the host
   for the rail and the Dock badge.
6. [x] **Switch without reload**: `switchProject` → `workspace.ensure` + set the active
   root; pending actions run in the target view directly (no localStorage hop).
   Close project unmounts its view.
7. [x] **View cap**: pure `mountedViews(order, active, cap)` LRU; tests.
8. [x] **Gates**: root typecheck / tests (`--max-concurrency=1`) / build; cockpit tests and
   build; CDP: start a job in A, switch to B and back — A's pane keeps the output it
   printed meanwhile without a re-attach, no reload (`performance.navigation` count),
   timing of a switch.
9. [x] **Docs**: known limitations + digest line; design-system spec untouched.

## Outcome (2026-09-27)

All steps done. Measured on a debug build with two scratch projects: a switch shows
the other view in ~21 ms with no navigation; a terminal left running in the hidden
view kept streaming (the same xterm element, no re-attach) and both projects' jobs ran
at once; closing a project off the stage left its job running in its daemon; closing
the last one showed the welcome. Open Recent and `cw <dir>` now ask the window to show
the project instead of destroying and recreating it.
