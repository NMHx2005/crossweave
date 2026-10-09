# Diff comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the person comment on lines of an agent's diff (committed changes and checkpoint diffs) and paste all comments, as one message, into the session's shell without pressing Enter.

**Architecture:** Cockpit-only. `patchSections` learns hunk line numbering (and stops misreading `--- x`/`+++ x` content lines as headers). A pure module `review-comments.ts` holds the comment model, matching, formatting, reducer and delivery (via the existing `planSend(..., {enter:false})`). A `CommentableDiff` component renders sections with a gutter button per commentable line; its inner view is hook-free so it is walk-tested like `CheckpointList`. `ChangesPane` and `CheckpointsDialog` use it; `ProjectView` supplies the send target and the `api.sendInput` call.

**Tech Stack:** Bun, TypeScript strict, Preact (`@jsxImportSource preact` pragma in every `.tsx`), `bun test` in `apps/cockpit` AND at repo root (root `bun test` also loads cockpit tests).

**Spec:** `docs/superpowers/specs/2026-10-10-diff-comments-design.md`

## Global Constraints

- No daemon, RPC, DB, schema (`SCHEMA_VERSION` stays 18) or dependency change. No native module.
- Enter (`\r`) is never sent: `planSend(text, [target], { enter: false })`.
- Colours only through tokens (`apps/cockpit/tests/tokens.test.ts` forbids literals and orphan `var()`); WCAG AA pairs enforced there.
- Every new `.tsx` starts with `/** @jsxImportSource preact */`.
- Comments explain WHY; errors/user copy in English; tests pin behaviour, not log strings.
- Gates run sequentially: `bun run typecheck` (root), `bun test --max-concurrency=1` (root), `cd apps/cockpit && bun test`, `bun run build` in `apps/cockpit` (it typechecks the cockpit), root `bun run build` only if `src/` is touched (it is not).
- Limits: comment ≤ 2000 chars; quote cut at 200 chars (`…` suffix).

## Review Focus

- A deleted line whose content starts with `-- ` (SQL/Lua/Haskell comment) arrives as `--- …`; an added `++ x` arrives as `+++ x`. Today `kindOf` calls both `meta`. Numbering must use hunk counts, not the marker prefix heuristics, or every later line number in the file is wrong.
- A file with `\ No newline at end of file` inside a hunk must not advance either counter.
- A hunk header with omitted counts (`@@ -3 +3 @@`) means 1; `-0,0`/`+0,0` means an empty side.
- A truncated patch (cut mid-hunk, mid-line) must not throw; lines present keep exact numbers.
- Text from the diff/comment containing ESC, `\x1b[201~` or NUL must never reach the pty raw (the paste frame closes early otherwise).
- A plain shell (no agent) must refuse the message and KEEP the comments; a rejected `send` keeps them too.
- A diff reload that moves or edits a commented line must surface the comment as outdated, never drop it or attach it to the wrong line.

---

### Task 1: Numbered patch lines (`patch.ts`)

**Files:**
- Modify: `apps/cockpit/src/lib/patch.ts`
- Test: `apps/cockpit/tests/patch.test.ts`

**Interfaces:**
- Produces: `PatchLine = { kind; text; old?: number; new?: number }` — `add` has `new`, `del` has `old`, `context` has both, others none. `patchSections(patch)` keeps its signature.

- [ ] **Step 1: Write failing tests** (append to `patch.test.ts`)

```ts
describe('patchSections numbering', () => {
  const P = [
    'diff --git a/a.sql b/a.sql', 'index 1..2 100644', '--- a/a.sql', '+++ b/a.sql',
    '@@ -10,4 +10,4 @@ ctx',
    ' keep', '--- a sql comment', '+++ replacement', ' tail',
    '@@ -30 +30,2 @@',
    '-gone', '+one', '+two', '\\ No newline at end of file',
    'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt',
    '@@ -0,0 +1,2 @@', '+x', '+y', '',
  ].join('\n')
  test('numbers lines from hunk headers; content that looks like ---/+++ is still a del/add', () => {
    const [a, n] = patchSections(P)
    const body = a!.lines.filter((l) => l.kind !== 'meta' && l.kind !== 'hunk')
    expect(body.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['context', 10, 10], ['del', 11, undefined], ['add', undefined, 11], ['context', 12, 12],
      ['del', 30, undefined], ['add', undefined, 30], ['add', undefined, 31],
    ])
    expect(a!.lines.at(-1)).toEqual({ kind: 'meta', text: '\\ No newline at end of file' })
    expect(n!.lines.filter((l) => l.kind === 'add').map((l) => l.new)).toEqual([1, 2])
  })
  test('file headers before the first hunk stay meta and carry no number', () => {
    const [a] = patchSections(P)
    expect(a!.lines.slice(0, 3).every((l) => l.kind === 'meta' && l.old === undefined && l.new === undefined)).toBe(true)
  })
  test('a patch cut mid-hunk keeps exact numbers for what is there and does not throw', () => {
    const cut = P.slice(0, P.indexOf('+++ replacement') + 6)
    const [a] = patchSections(cut)
    expect(a!.lines.at(-1)?.new).toBe(11)
  })
  test('an omitted count means one line', () => {
    const [s] = patchSections(['diff --git a/x b/x', '@@ -3 +3 @@', '-a', '+b', ''].join('\n'))
    expect(s!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([['hunk', undefined, undefined], ['del', 3, undefined], ['add', undefined, 3]])
  })
})
```

- [ ] **Step 2:** `cd apps/cockpit && bun test tests/patch.test.ts` → FAIL (no `old`/`new`; `--- a sql comment` is `meta`).

- [ ] **Step 3: Implement.** In `patch.ts`:

```ts
export type PatchLine = { kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'; text: string; old?: number; new?: number }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function patchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  // Inside a hunk the header's counts say how many lines are body: that is the only reliable way to tell a deleted
  // "-- comment" (arrives as "--- comment") from a file header, and it keeps the counters exact.
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line)
    if (header && oldLeft === 0 && newLeft === 0) {
      sections.push({ path: header[1] ?? '', lines: [] })
      continue
    }
    const current = sections.at(-1)
    if (current === undefined || line === '') continue
    const hunk = HUNK.exec(line)
    if (hunk && oldLeft === 0 && newLeft === 0) {
      oldNo = Number(hunk[1]); oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newNo = Number(hunk[3]); newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      current.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0]
      if (mark === '+') { current.lines.push({ kind: 'add', text: line, new: newNo++ }); newLeft--; continue }
      if (mark === '-') { current.lines.push({ kind: 'del', text: line, old: oldNo++ }); oldLeft--; continue }
      if (mark === ' ') { current.lines.push({ kind: 'context', text: line, old: oldNo++, new: newNo++ }); oldLeft--; newLeft--; continue }
      if (mark === '\\') { current.lines.push({ kind: 'meta', text: line }); continue }
    }
    current.lines.push({ kind: kindOf(line), text: line })
  }
  return sections
}
```

  `kindOf` is unchanged otherwise (it still classifies the header block). Note the `diff --git` check is guarded by `oldLeft === 0 && newLeft === 0`; in a well-formed patch the counts are exhausted before the next file, and a body line never starts with `diff` (it starts with a marker), so the guard only protects against a truncated hunk running into garbage.

- [ ] **Step 4:** run `bun test tests/patch.test.ts` → PASS (existing tests included).
- [ ] **Step 5:** commit `feat(cockpit): number diff lines from hunk headers`.

### Task 2: Comment model, formatting, delivery (`review-comments.ts`)

**Files:**
- Create: `apps/cockpit/src/lib/review-comments.ts`
- Test: `apps/cockpit/tests/review-comments.test.ts`

**Interfaces:**
- Consumes: `PatchSection`, `PatchLine` (Task 1); `planSend`, `SendTarget` from `./prompt-send`.
- Produces:

```ts
export type Side = 'old' | 'new'
export type Anchor = { path: string; side: Side; line: number; quote: string }
export type ReviewComment = Anchor & { id: number; text: string }
export type ReviewState = { comments: ReviewComment[]; nextId: number }
export type ReviewAction =
  | { type: 'add'; anchor: Anchor; text: string }
  | { type: 'edit'; id: number; text: string }
  | { type: 'delete'; id: number }
  | { type: 'clear' }
export const MAX_COMMENT_CHARS = 2000
export const MAX_QUOTE_CHARS = 200
export const emptyReview: ReviewState
export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState
export function anchorOf(path: string, line: PatchLine): Anchor | null   // null for hunk/meta
export function lineKey(a: Pick<Anchor, 'path' | 'side' | 'line'>): string
export function matchComments(comments: readonly ReviewComment[], sections: readonly PatchSection[]): { byLine: Map<string, ReviewComment[]>; outdated: ReviewComment[] }
export function formatReview(source: string, comments: readonly ReviewComment[]): string
export type Delivery = { ok: boolean; message: string }
export function deliverReview(o: { source: string; comments: readonly ReviewComment[]; target: SendTarget; send: (id: string, data: string) => Promise<unknown> }): Promise<Delivery>
```

- [ ] **Step 1: Write failing tests** covering: `anchorOf` (add→new side with marker stripped; del→old; context→new; hunk/meta→null; quote cut at 200 with `…`); `reviewReducer` (add trims and ignores empty/whitespace, caps at 2000, assigns increasing ids; edit changes text and ignores empty; delete; clear; unknown id no-op); `matchComments` (matches by path+side+line+quote; same line edited → outdated; moved line → outdated; two comments on one line keep creation order); `formatReview` (header with count; sort by path then new-before-old then line then id; `(removed line)` marker for `old`; multi-line comment indented 3 spaces with no trailing spaces; quote line `   > …`); `deliverReview`: agent target → send called once with `\x1b[200~…\x1b[201~` and NO `\r`, ok message names count and says "press Enter"; plain shell target (agent null) → not ok, `send` never called, message contains the planSend reason; closed shell → not ok; `send` rejecting → not ok with the error text; a comment containing `\x1b[201~` and NUL has them stripped from the data (only the frame's own `\x1b[201~` remains, exactly once at the end).
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
import type { PatchLine, PatchSection } from './patch'
import { planSend, type SendTarget } from './prompt-send'

export const MAX_COMMENT_CHARS = 2000
export const MAX_QUOTE_CHARS = 200
export const emptyReview: ReviewState = { comments: [], nextId: 1 }

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function anchorOf(path: string, line: PatchLine): Anchor | null {
  if (line.kind === 'add' && line.new !== undefined) return { path, side: 'new', line: line.new, quote: cut(line.text.slice(1), MAX_QUOTE_CHARS) }
  if (line.kind === 'context' && line.new !== undefined) return { path, side: 'new', line: line.new, quote: cut(line.text.slice(1), MAX_QUOTE_CHARS) }
  if (line.kind === 'del' && line.old !== undefined) return { path, side: 'old', line: line.old, quote: cut(line.text.slice(1), MAX_QUOTE_CHARS) }
  return null
}

export const lineKey = (a: Pick<Anchor, 'path' | 'side' | 'line'>): string => `${a.path}\0${a.side}\0${a.line}`

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'add': {
      const text = action.text.trim().slice(0, MAX_COMMENT_CHARS)
      if (text === '') return state
      return { comments: [...state.comments, { ...action.anchor, id: state.nextId, text }], nextId: state.nextId + 1 }
    }
    case 'edit': {
      const text = action.text.trim().slice(0, MAX_COMMENT_CHARS)
      if (text === '' || !state.comments.some((c) => c.id === action.id)) return state
      return { ...state, comments: state.comments.map((c) => (c.id === action.id ? { ...c, text } : c)) }
    }
    case 'delete': return { ...state, comments: state.comments.filter((c) => c.id !== action.id) }
    case 'clear': return { ...state, comments: [] }
  }
}

export function matchComments(comments: readonly ReviewComment[], sections: readonly PatchSection[]) {
  const quotes = new Map<string, string>()
  for (const s of sections) for (const l of s.lines) {
    const a = anchorOf(s.path, l)
    if (a !== null) quotes.set(lineKey(a), a.quote)
  }
  const byLine = new Map<string, ReviewComment[]>()
  const outdated: ReviewComment[] = []
  for (const c of comments) {
    if (quotes.get(lineKey(c)) === c.quote) byLine.set(lineKey(c), [...(byLine.get(lineKey(c)) ?? []), c])
    else outdated.push(c)
  }
  return { byLine, outdated }
}

export function formatReview(source: string, comments: readonly ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) =>
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || (a.side === b.side ? 0 : a.side === 'new' ? -1 : 1)
    || a.line - b.line || a.id - b.id)
  const items = sorted.map((c, i) => {
    const body = c.text.split('\n').map((l) => `   ${l}`.trimEnd()).join('\n')
    return `${i + 1}. ${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}\n   > ${c.quote}\n${body}`
  })
  return `Review comments on ${source} (${comments.length}):\n\n${items.join('\n')}`
}

export async function deliverReview(o: { ... }): Promise<Delivery> {
  const plan = planSend(formatReview(o.source, o.comments), [o.target], { enter: false })
  const item = plan.items[0]
  if (item === undefined || item.how === 'refused') return { ok: false, message: `Not sent to ${o.target.name}: ${item?.reason ?? 'there is nothing to send'}` }
  try { await o.send(item.id, item.data) } catch (err) { return { ok: false, message: err instanceof Error ? err.message : String(err) } }
  const n = o.comments.length
  return { ok: true, message: `Pasted ${n} comment${n === 1 ? '' : 's'} into ${o.target.name}'s shell — press Enter there to send ${n === 1 ? 'it' : 'them'}` }
}
```

- [ ] **Step 4:** `bun test tests/review-comments.test.ts tests/prompt-send.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(cockpit): model, format and deliver diff review comments`.

### Task 3: `CommentableDiff` (view + shell) and styles

**Files:**
- Create: `apps/cockpit/src/ui/CommentableDiff.tsx`
- Modify: `apps/cockpit/src/ui/app.css`
- Test: `apps/cockpit/tests/commentable-diff.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:

```tsx
export function DiffLines(props: {
  sections: readonly PatchSection[]
  byLine: ReadonlyMap<string, readonly ReviewComment[]>
  composing: string | null          // lineKey being composed
  editing: number | null            // comment id being edited
  onCompose(a: Anchor): void
  onAdd(a: Anchor, text: string): void
  onCancel(): void
  onEdit(id: number): void
  onSave(id: number, text: string): void
  onDelete(id: number): void
  sectionRef?(path: string, el: HTMLElement | null): void
}): VNode                           // hook-free so it is walk-tested
export function CommentableDiff(props: {
  patch: string; truncated: boolean; source: string; target: SendTarget
  send(id: string, data: string): Promise<unknown>; onToast(m: string, tone: 'info' | 'error'): void
  sectionRef?(path: string, el: HTMLElement | null): void
}): VNode                           // owns useReducer(reviewReducer), composing/editing state, the bar
```

Structure of `DiffLines`: per section `<section ref><h3 class="cockpit-changes__file">path</h3><pre>` then per line a `<div class="cockpit-diff-row">` containing, for commentable lines, `<button type="button" class="cockpit-diff-add" aria-label="Comment on {path} line {n}" onClick>+</button>` (else a spacer `<span class="cockpit-diff-gutter">`) and the existing `<div class="cockpit-diff-line is-{kind}">{text}</div>`; after the row, the comments for that line (`<div class="cockpit-diff-comment">` with text, Edit, Delete; or the editor when `editing === id`) and the composer when `composing === lineKey`. The editor is a hook-free `<form onSubmit>` with an uncontrolled `<textarea name="comment" maxLength={2000}>`, **Add**/**Save** (submit) and **Cancel** buttons; submit reads `new FormData(form).get('comment')`; Escape on the form calls `onCancel`. The bar (`<div class="cockpit-review-bar">`, only when comments exist): `{n} comment(s)`, **Send to {target.name}'s shell** (disabled while sending), **Clear**; outdated comments listed above it as `{path}:{line} (outdated) — text` with Delete. `CommentableDiff` renders the truncation note and passes `key`-stable props; `send` flow: `const r = await deliverReview(...)`; `onToast(r.message, r.ok ? 'info' : 'error')`; on `ok` dispatch `clear`.

- [ ] **Step 1: Write failing walk tests** (`checkpoints.test.tsx`'s `walk`): only commentable lines (add/del/context) have a `button.cockpit-diff-add`, hunk/meta do not; its `aria-label` names path and line; a comment under its line shows its text and Edit/Delete; `composing` renders a form with a textarea whose `maxLength` is 2000 under exactly that line; `editing` renders the editor prefilled (`defaultValue`) instead of the text; an outdated list is NOT part of `DiffLines` (it is in the shell) so test `DiffLines` with `byLine` empty renders no comment nodes; clicking handlers: invoke `onClick` of the add button → `onCompose` called with the anchor `{path, side:'new', line, quote}`; Delete's `onClick` → `onDelete(id)`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** as described. CSS (tokens only, near `.cockpit-diff-line`): `.cockpit-diff-row { display:flex; }`, `.cockpit-diff-gutter, .cockpit-diff-add { flex: none; width: 1.5em; }`, `.cockpit-diff-add` transparent background, `color: var(--cw-text-dim)`, hidden until row hover/focus-within (`opacity: 0` → `1`; the button stays in tab order), `.cockpit-diff-comment` with `border-left: 2px solid var(--cw-accent)`, `background: var(--cw-surface-badge)`, `.cockpit-review-bar` sticky bottom with `var(--cw-surface-badge)` background. Run `bun test tests/tokens.test.ts` to check contrast/orphans.
- [ ] **Step 4:** run `bun test tests/commentable-diff.test.tsx tests/tokens.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(cockpit): comment on diff lines`.

### Task 4: Wire it into `ChangesPane`, `CheckpointsDialog`, `ProjectView`

**Files:**
- Modify: `apps/cockpit/src/ui/ChangesPane.tsx`, `apps/cockpit/src/ui/CheckpointsDialog.tsx`, `apps/cockpit/src/ui/ProjectView.tsx`
- Test: `apps/cockpit/tests/checkpoints.test.tsx` (existing `CheckpointList` tests must stay green)

**Interfaces:**
- `ChangesPane` gains props `target: SendTarget`, `send(id, data)`, `onToast`; it renders `<CommentableDiff patch={diff.patch} truncated={diff.truncated} source="the committed changes" … sectionRef={(p, el) => { sectionRefs.current[p] = el }} />` in place of its `sections.map` block (the file list, totals and `patchSections` use for scrolling stay; drop the now-unused `sections` memo, the `patchSections` import, and the truncation note it duplicates).
- `CheckpointsDialog` gains the same three props and renders `<CommentableDiff key={shown.title} patch={shown.diff.patch} … source={`checkpoint ${shown.title}`} />` (title is `#3 → #4` or `#3 → now`) replacing its `sections` rendering; drop its `patchSections`/`useMemo` use if orphaned.
- `ProjectView`: build `target = { id: session.id, name: session.name, running: session.status === 'running' || session.status === 'waiting', agent: session.agent ?? null }` for the changes pane and the dialog; `send = (id, data) => api.sendInput(id, data)`; `onToast = (m, tone) => hostRef.current.toast(m, tone)`.

- [ ] **Step 1:** typecheck-driven: change the props, run `cd apps/cockpit && bun run build` → FAIL at call sites; fix them.
- [ ] **Step 2:** run `bun test` in `apps/cockpit` and at repo root (`bun test --max-concurrency=1 tests/` is NOT needed; root `bun test` loads cockpit tests — run once at the end of Task 5).
- [ ] **Step 3:** commit `feat(cockpit): comment on committed and checkpoint diffs`.

### Task 5: Live check, limits doc, gates

**Files:**
- Create: `apps/cockpit/scripts/diff-comments-check.ts` (pattern: `checkpoints-check.ts`)
- Create: `docs/superpowers/specs/2026-10-10-diff-comments-known-limitations.md`; append one line to `docs/superpowers/specs/2026-08-14-known-limitations-digest.md`
- Modify: memory `ai-support-feature-series.md` (status line)

- [ ] **Step 1:** write the CDP script: create a scratch session with a fake agent-less shell → expect the **refusal toast** and comments kept (plain shell); then start `fake-claude` in it (see `tests/daemon/methods-checkpoint-auto.test.ts` for how an agent is faked) → Send → read the pty bytes via `session.attach`/output and assert the message arrives bracketed with no `\r`. Checks: gutter button present, composer opens, comment shows under the line, bar count, outdated after the file changes, Send result.
- [ ] **Step 2:** run gates sequentially, outside the sandbox where a pty/socket is needed: `bun run typecheck`; `bun test --max-concurrency=1`; `cd apps/cockpit && bun test`; `cd apps/cockpit && bun run build`; the live script with a scratch HOME/user-data-dir (see AGENTS.md traps). Take a screenshot.
- [ ] **Step 3:** write the limitations file (from the spec's "Known limits" plus anything found) and the digest line; commit `docs: record diff comments' known limitations`; commit the script `test(cockpit): live check for diff comments`.

---

## Amendments from the adversarial review (these supersede conflicting task text above)

The reviewer ran Task 1's code against real `git diff` output and the repo's own tests; verdict GO-WITH-FIXES.

**Task 1 (`patch.ts`) — algorithm replaced.**
- A body line always starts with ` `, `+`, `-` or `\`, so a line starting with `diff --git ` or `@@` is **always** a header: a new section
  always starts on `diff --git`, and counters are (re)set on every `@@`. The hunk counts are used for one thing only: telling a content
  line `--- x` / `+++ x` from a file header. The "exhausted counts" guard of the first draft is dropped (it swallowed headers when counts
  were wrong or blank context lines arrived as `''`, which `diff.suppressBlankEmpty` produces).
- Inside a hunk with counts left, `''` is a blank context line. One trailing `\n` is removed before splitting, so a patch cut right after a
  newline does not grow a bogus line.
- `kindOf` classifies any line starting with `\` as `meta` (the final `\ No newline at end of file` falls outside the counts).
- Paths: with `--no-renames` the header is `<p>/P <p>/P`, so `P` is the last `(len-5)/2` characters of the rest (also right for
  `diff.mnemonicPrefix`); a quoted header (`core.quotePath`: `"a/\303\251.txt" "b/\303\251.txt"`) is C-unquoted (octal escapes are UTF-8
  bytes) and its second token is used. Pre-existing bug, but the path now ends up in a message to an agent.
- Both fixtures are corrected (`patch.test.ts`'s `@@ -1,2 +1,3 @@` should be `+1,2`), and the `toEqual({kind:'add', text})` expectation gains `new: 1`:
  the contract grew. Tests added: quoted/accented path, path containing ` b/`, blank context as `''`, `\` after the counts, binary file,
  mode-only change, deleted file, two files back to back, the patch cut mid-hunk, and the whole thing against real `git diff` output.

**Task 2 (`review-comments.ts`).**
- `anchorOf` makes the quote display-safe: `\r`, U+2028/2029 and bidi controls (U+202A–202E, U+2066–2069) become `␍`/`␤`/`⁇`-style visible marks,
  because `cleanPromptText` turns a bare `\r` into a newline and a quote could then forge a numbered item.
- Comment text: strip leading blank lines and trailing whitespace, keep the leading indent of the first non-blank line (`trim()` would eat code indent).
- `formatReview` marks an outdated comment's line `(outdated)`; the caller passes the outdated ids. Sort stays path, new-before-old, line, id (the spec is updated).
- New pure `afterDelivery(state, delivery) → ReviewState` (clear on ok, keep on failure) so Send's contract is tested without a hook.
- Errors via `plainErrorMessage` from `./cockpit-host` if importable in tests, else the `Error.message` fallback.
- Same-text quotes (`}`, blank) can re-match another line with the same number after a diff reload: recorded as a known limit.

**Task 3 (UI).**
- `composing` is an `Anchor`, not a key; the composer renders only on the row whose anchor (quote included) equals it; rows are keyed by
  `${index}:${lineKey}`, the composer by `compose:${lineKey}` (a poll must not move or recreate a half-typed draft).
- The form's `onSubmit` calls `preventDefault()` (a form with no action navigates the Electron page); Escape in the form calls
  `stopPropagation()` (the dialog closes on Escape) and `onCancel`. The textarea is focused through a **stable** ref callback.
- `ReviewBar` (count, Send, Clear, outdated list) is a hook-free view, placed **before** the diff and sticky at the top, so thousands of
  gutter buttons are not in front of it in tab order; walk-tested. `CommentableDiff` is only the thin hooked shell.
- Performance: `patchSections` memoised on the patch string, `matchComments` on `[comments, sections]`, `DiffLines` element memoised on its inputs.
  No `memo()` inside `DiffLines` (it would break the walk test).
- CSS: `.cockpit-diff-comment` gets `white-space: pre-wrap`; the gutter `user-select: none`; the line `flex: 1; min-width: 0`.
- The truncation note is a prop (`truncatedNote`): ChangesPane says `git diff`, the dialog says `cw checkpoint diff`.
- Section keys use index + path (a type change yields two sections with one path).
- Backdrop click in the dialog with unsent comments: not guarded in v1 (known limit).

**Task 5 (live check).** The fake `claude` of `methods-checkpoint-auto.test.ts` leaves the tty cooked (echo shows `^[`, `\n` becomes `\r\n`, the paste
stays unread without Enter). The live script's agent runs `stty raw -echo` and copies stdin to a file; assertions read that file (the bracketed
paste is there, no `\r` after the closing frame). Wait until the cockpit shows the session's agent before pressing Send.

**Spec edits:** units and render-test list now follow this plan (numbering lives in `patch.ts`; `CommentableDiff` takes `target`+`send(id,data)`;
`ReviewBar`/`DiffLines` are walk-tested; Send/clear/keep is `deliverReview` + `afterDelivery`), and the same-text re-match, backdrop-click
and many-buttons performance limits are added to the known limits.
