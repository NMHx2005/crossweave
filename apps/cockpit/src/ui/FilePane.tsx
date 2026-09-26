import { useEffect, useRef, useState } from 'preact/hooks'
import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import { cockpitApi } from '../host/cockpit-api'
import { languageFor } from '../lib/surfaces'

function languageExtension(path: string): Extension[] {
  switch (languageFor(path)) {
    case 'typescript': return [javascript({ typescript: true })]
    case 'tsx': return [javascript({ typescript: true, jsx: true })]
    case 'javascript': return [javascript()]
    case 'jsx': return [javascript({ jsx: true })]
    case 'json': return [json()]
    case 'markdown': return [markdown()]
    case 'css': return [css()]
    case 'html': return [html()]
    case 'python': return [python()]
    default: return []
  }
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  /** The file changed on disk since it was read — the agent shares this worktree. */
  | { kind: 'conflict' }

/**
 * A file from a session's worktree, editable in place. ⌘S saves through the daemon
 * with the mtime it was read at, so an edit the agent made in the meantime is never
 * overwritten silently: the pane stops and asks.
 */
export function FilePane({ sessionId, path, focused }: { sessionId: string; path: string; focused: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const mtimeRef = useRef<number | undefined>(undefined)
  const savedRef = useRef('')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [dirty, setDirty] = useState(false)

  const save = async (force = false): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const content = view.state.doc.toString()
    try {
      const r = await cockpitApi.writeFile(sessionId, path, content, force ? undefined : mtimeRef.current)
      mtimeRef.current = r.mtimeMs
      savedRef.current = content
      setDirty(false)
      setStatus({ kind: 'ready' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(/changed since it was opened/i.test(message) ? { kind: 'conflict' } : { kind: 'error', message })
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const load = async (): Promise<void> => {
    setStatus({ kind: 'loading' })
    try {
      const r = await cockpitApi.readFile(sessionId, path)
      mtimeRef.current = r.mtimeMs
      savedRef.current = r.content
      const view = viewRef.current
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.content } })
      setDirty(false)
      setStatus({ kind: 'ready' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          oneDark,
          ...languageExtension(path),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void saveRef.current(); return true } }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== savedRef.current)
          }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        ],
      }),
    })
    viewRef.current = view
    void load()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Re-created only for another file; load() reads the current props.
  }, [sessionId, path])

  useEffect(() => {
    if (focused) viewRef.current?.focus()
  }, [focused])

  return (
    <div class="cockpit-file">
      <div class="cockpit-file__status">
        <span class="cockpit-file__path">{path}{dirty ? ' ●' : ''}</span>
        {status.kind === 'loading' ? <span class="cockpit-muted">loading…</span> : null}
        {status.kind === 'error' ? <span class="cockpit-error">{status.message}</span> : null}
        {status.kind === 'conflict' ? (
          <span class="cockpit-file__conflict">
            Changed on disk since you opened it.
            <button type="button" onClick={() => { void load() }}>Reload (drop my edits)</button>
            <button type="button" onClick={() => { void save(true) }}>Overwrite</button>
          </span>
        ) : null}
        {dirty && status.kind === 'ready' ? <span class="cockpit-muted">⌘S to save</span> : null}
      </div>
      <div class="cockpit-file__editor" ref={hostRef} />
    </div>
  )
}
