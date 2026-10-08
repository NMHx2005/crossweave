# Session panel overview in the rail

## Goal

Make the panels that belong to a session visible and directly selectable from the project rail, so a person can understand a multi-panel session without opening it first.

## Design

A session with two or more open, session-bound panels (the agent session pane, extra terminals, file panes, Changes, and Debug) shows a small count chip with a chevron on its row, beside the activity time. The chip expands a compact list under the row, in the stage's tab and pane order. A session with one panel or none shows no chip: the row click already opens that panel, and a second control doing the same thing would only make the rail taller. Rows therefore keep their single fixed height. Project-scoped Browser panes are excluded because they have no session owner.

Selecting a panel activates its project when needed, then focuses the reported tab and pane. If that tab is zoomed on a different pane, the zoom is dropped first — a zoomed pane covers its siblings, and focusing one under it would send the keyboard to a pane nobody can see. The existing session-row click continues to focus the session; the chip stops its click and its Enter/Space from reaching the row. If a pane has closed since the rail report, focusing it is a no-op.

Panel labels stay short in the rail: `Agent`, `Terminal` (numbered in reading order when there are several), the file name, `Changes`, or `Debug`. File entries retain the full path as their title so files with the same basename can be distinguished. The pane that has the keyboard in the shown tab is marked (`aria-current`) so the list says where the person is. Panel rows use accessible button names that include the session name.

The expanded state is window-local and ephemeral. The list opens with a grid-row height transition (`--cw-dur-layout`, ease-out) and a short fade; the chevron turns with `--cw-dur`. The app-wide reduced-motion rule removes both. A collapsed list is `inert`, so it leaves the tab order and the accessibility tree together.

## Data flow

The live `ProjectView` derives panel summaries from its existing `StageState` using the session-to-pane relationship already defined by `panesForSession`. It includes those summaries in `ViewReport`, keeping the previous object when nothing the rail shows has changed — dragging a split divider rewrites the stage on every pointer move, and a fresh report each time would re-render the whole rail. The app carries them to `ProjectGroup` and into the rail. A panel selection is sent back to the owning `ProjectView` as a `focus-pane` view action. No daemon RPC, database field, or persisted state is added.

## Acceptance criteria

- A session with two or more open panels shows a count chip with the correct count; a session with one or none shows no chip.
- Expanding a session shows only panes associated with that session, in stage order; Browser panes never appear under a session.
- Selecting a listed panel focuses that exact tab and pane, including after activating a different project, and unzooms a tab zoomed on another pane.
- The pane that has the keyboard is marked in the list.
- Resizing a split does not produce a new rail report.
- The ordinary session-row click still focuses the session.
- Expansion state is not persisted across app restarts.
- The disclosure transition is brief and disabled by `prefers-reduced-motion`.
- Empty and stale panel summaries do not render misleading panel controls.

## Verification

Test the stage-to-summary mapping, disclosure rendering and selection callback. Run the Cockpit tests and build, then inspect the running app with multiple sessions, several session-bound pane kinds, a project-scoped Browser pane, and a reduced-motion setting. Run the repository typecheck, root test suite and build, then the foreground stop gate.

## Known limits

Only live views can report panel layouts. A project view evicted by the six-view cap has session rows but no panel inventory until it becomes live again. The Browser pane is project-scoped by design and is not listed under any session.
