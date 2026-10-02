import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { planSend, type SendTarget } from '../lib/prompt-send'

export type ComposerSession = SendTarget

type RefineResult = { ok: true; text: string } | { ok: false; reason: string }

type PromptComposerProps = {
  sessions: readonly ComposerSession[]
  /** Ticked when the dialog opens, if it is running. */
  focusedId: string | null
  /** A refine command is set in Settings → Prompt. */
  refineConfigured: boolean
  /** The draft survives closing the dialog until it is sent. */
  draft: string
  onDraft: (text: string) => void
  /** Name, branch and changed files of a session, for the refine command when the user allowed it. */
  contextFor: (id: string) => string | undefined
  refine: (text: string, context?: string) => Promise<RefineResult>
  /** Write to a session's terminal. Only called for what the preview showed. */
  send: (id: string, data: string) => Promise<unknown>
  onOpenSettings: () => void
  /** Sent (or partly sent): a sentence for the window to say, and which sessions it reached, then the dialog closes. */
  onSent: (summary: string, sentIds: string[]) => void
  onClose: () => void
}

/**
 * Write a prompt once, optionally have the person's own command refine it, and send it to one or several sessions.
 * Nothing goes anywhere until Send: the preview lists, per session, exactly what will be written and what is
 * refused and why; a refine only ever produces a proposal that is read first; Enter is pressed only if ticked.
 */
export function PromptComposer({ sessions, focusedId, refineConfigured, draft, onDraft, contextFor, refine, send, onOpenSettings, onSent, onClose }: PromptComposerProps) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => {
    // The focused session, running or not: debugging a dead shell is the common
    // case, and the preview must show its refusal ("its shell is closed") rather
    // than open with nothing ticked.
    const focused = sessions.find((s) => s.id === focusedId)
    return new Set(focused ? [focused.id] : [])
  })
  const [enter, setEnter] = useState(false)
  const [proposal, setProposal] = useState<string | null>(null)
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { areaRef.current?.focus() }, [])

  const chosen = useMemo(() => sessions.filter((s) => picked.has(s.id)), [sessions, picked])
  const plan = useMemo(() => planSend(draft, chosen, { enter }), [draft, chosen, enter])
  const sendable = plan.items.filter((i) => i.how !== 'refused')
  const canSend = !sending && sendable.length > 0

  const toggle = (id: string): void => setPicked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const runRefine = async (): Promise<void> => {
    if (refining || draft.trim() === '') return
    setRefining(true)
    setRefineError(null)
    setProposal(null)
    try {
      // The context of the first ticked session, only if the setting allows it (the main process decides).
      const result = await refine(draft, chosen[0] ? contextFor(chosen[0].id) : undefined)
      if (result.ok) setProposal(result.text)
      else setRefineError(result.reason)
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefining(false)
    }
  }

  const doSend = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    const sent: string[] = []
    /** The ids that actually took the prompt: what the Responses view then lists. */
    const sentIds: string[] = []
    const failed: string[] = []
    for (const item of sendable) {
      try {
        await send(item.id, item.data as string)
        sent.push(item.name)
        sentIds.push(item.id)
      } catch {
        failed.push(item.name)
      }
    }
    setSending(false)
    if (sent.length > 0) onDraft('')
    const skipped = plan.items.filter((i) => i.how === 'refused').map((i) => i.name)
    onSent([
      sent.length > 0 ? `Sent to ${sent.join(', ')}` : 'Nothing was sent',
      failed.length > 0 ? `failed: ${failed.join(', ')}` : '',
      skipped.length > 0 ? `skipped: ${skipped.join(', ')}` : '',
    ].filter(Boolean).join(' · '), sentIds)
  }

  return (
    <div class="cockpit-picker__backdrop" onClick={onClose}>
      <div class="cockpit-picker cockpit-prompt" role="dialog" aria-label="Prompt" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          // An explicit chord, never a bare Enter: a newline in a prompt is normal.
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doSend() }
        }}>
        <h2 class="cockpit-picker__title">Prompt</h2>
        <textarea ref={areaRef} class="cockpit-prompt__draft" rows={8} spellcheck={false} value={draft} aria-label="Prompt text"
          placeholder="Write the prompt. Nothing is sent until you press Send."
          onInput={(e) => onDraft((e.target as HTMLTextAreaElement).value)} />
        <div class="cockpit-prompt__bar">
          {refineConfigured ? (
            <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={refining || draft.trim() === ''} onClick={() => { void runRefine() }}>
              {refining ? 'Refining…' : 'Refine'}
            </button>
          ) : (
            <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" onClick={onOpenSettings}
              title="Refine runs a program you choose on the draft; set it under Settings → Prompt">Set up Refine…</button>
          )}
          <span class="cockpit-muted">{draft.length} characters</span>
        </div>
        {refineError !== null ? <p class="cockpit-error" role="alert">{refineError}</p> : null}
        {proposal !== null ? (
          <div class="cockpit-prompt__proposal" role="region" aria-label="Refined proposal">
            <p class="cockpit-muted">Refined by your command — read it, then use it or keep yours:</p>
            <pre>{proposal}</pre>
            <div class="cockpit-picker__actions">
              <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => setProposal(null)}>Keep mine</button>
              <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary" onClick={() => { onDraft(proposal); setProposal(null) }}>Use this</button>
            </div>
          </div>
        ) : null}
        <fieldset class="cockpit-prompt__targets">
          <legend class="cockpit-muted">Send to</legend>
          {sessions.length === 0 ? <p class="cockpit-muted">No sessions yet.</p> : null}
          {sessions.map((s) => (
            <label key={s.id} class={s.running ? '' : 'is-off'}>
              {/* A stopped session cannot be TICKED, but one already ticked (the
                  preselect) can be unticked — otherwise a dead shell could hold the
                  only tick and nothing else could be sent. */}
              <input type="checkbox" checked={picked.has(s.id)} disabled={!s.running && !picked.has(s.id)} onChange={() => toggle(s.id)} />
              <span>{s.name}</span>
              <span class="cockpit-muted">{s.running ? (s.agent ? s.agent : 'shell') : 'shell closed'}</span>
            </label>
          ))}
        </fieldset>
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={enter} onChange={(e) => setEnter((e.target as HTMLInputElement).checked)} />
          <span>Press Enter after sending (off: it waits in each session for you to read it and press Enter)</span>
        </label>
        {plan.items.length > 0 ? (
          <ul class="cockpit-prompt__plan" aria-label="What will be sent">
            {plan.items.map((i) => (
              <li key={i.id} class={i.how === 'refused' ? 'is-refused' : ''}>
                <strong>{i.name}</strong>{' '}
                {i.how === 'refused' ? `— not sent: ${i.reason}` : i.how === 'paste' ? 'one paste into its agent' : 'one line typed into its shell'}
                {enter && i.how !== 'refused' ? ', then Enter' : ''}
              </li>
            ))}
          </ul>
        ) : null}
        <div class="cockpit-picker__actions">
          <button type="button" class="cockpit-btn" onClick={onClose}>Close</button>
          <button type="button" class="cockpit-btn cockpit-btn--primary" disabled={!canSend} onClick={() => { void doSend() }}
            title="Also ⌘Enter">
            {sending ? 'Sending…' : sendable.length > 1 ? `Send to ${sendable.length} sessions` : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
