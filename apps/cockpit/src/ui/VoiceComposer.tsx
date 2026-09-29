import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import type { VoiceSettings } from '../../../../src/core/settings.js'
import { cockpitApi } from '../host/cockpit-api'
import { appendSnippet, initialVoiceState, voiceReducer } from '../lib/voice-state'
import { startRecording, type Recording } from '../lib/voice-recorder'
import { MIN_RECORDING_MS } from '../lib/voice-defaults'
import { isPhantomTranscript, isSilent, SILENCE_MESSAGE } from '../lib/voice-audio'

/** The draft survives closing the composer (Esc) until it is sent or cleared. */
let keptDraft = ''
const ENTER_KEY = 'cw.voice-enter.v1'
const DEFAULT_MAX_SECONDS = 300

function readEnter(): boolean {
  try { return localStorage.getItem(ENTER_KEY) === '1' } catch { return false }
}
function writeEnter(on: boolean): void {
  try { localStorage.setItem(ENTER_KEY, on ? '1' : '0') } catch { /* private window: stays per-run */ }
}

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Speak a prompt, read it, send it. The draft is a plain text box: what is transcribed is
 * appended to it, and nothing reaches an agent until Send — a misheard word is fixed here,
 * not after an agent acted on it. Refinement (an LLM tidy-up) exists only when Settings →
 * Voice switches it on, runs only when asked, and never replaces the draft until Accept.
 */
export function VoiceComposer({ getSettings, toggleSignal, contextText, onSend, onOpenSettings, onClose }: {
  /** The saved settings' voice block, read fresh each time the composer opens. */
  getSettings: () => Promise<VoiceSettings | undefined>
  /** Bumped by the ⌘⇧M command: start recording, or stop and transcribe. */
  toggleSignal: number
  /** Branch and session name for the optional refinement context. */
  contextText?: string
  /** Type `text` into the focused pane; `enter` also presses Enter. */
  onSend: (text: string, enter: boolean) => void
  onOpenSettings: (section: string) => void
  onClose: () => void
}) {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState(), (s) => ({ ...s, draft: keptDraft }))
  const [voice, setVoice] = useState<VoiceSettings | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [pressEnter, setPressEnter] = useState(readEnter)
  const recording = useRef<Recording | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let live = true
    void getSettings().then((v) => {
      if (!live) return
      setVoice(v)
      setLoaded(true)
      dispatch({ type: 'setRefine', enabled: v?.refine?.enabled === true })
    }).catch(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [])

  useEffect(() => { keptDraft = state.draft }, [state.draft])
  useEffect(() => () => { recording.current?.cancel(); recording.current = null }, [])

  // A recording shows its running time.
  useEffect(() => {
    if (state.phase !== 'recording') return
    const t = setInterval(() => { setElapsed(recording.current?.elapsedMs() ?? 0); setLevel(recording.current?.level() ?? 0) }, 100)
    return () => clearInterval(t)
  }, [state.phase])

  async function refineNow(text: string): Promise<void> {
    dispatch({ type: 'refine' })
    const wantsContext = voiceRef.current?.refine?.includeContext === true
    const result = await cockpitApi.voiceRefine(text, wantsContext ? contextText : undefined)
    if (result.ok) dispatch({ type: 'refined', text: result.text })
    else dispatch({ type: 'failed', reason: result.reason })
  }

  async function stopAndTranscribe(): Promise<void> {
    const rec = recording.current
    recording.current = null
    if (rec === null) return
    const ms = rec.elapsedMs()
    dispatch({ type: 'toggle' })
    const audio = await rec.stop()
    if (ms < MIN_RECORDING_MS) {
      dispatch({ type: 'failed', reason: 'That was too short to be speech.' })
      return
    }
    // A silent take is not sent: a model given silence invents a sentence.
    if (isSilent(audio.stats)) {
      dispatch({ type: 'failed', reason: SILENCE_MESSAGE })
      return
    }
    const result = await cockpitApi.voiceTranscribe(audio.wav)
    if (!result.ok) {
      dispatch({ type: 'failed', reason: result.reason })
      return
    }
    if (isPhantomTranscript(result.text, audio.stats.peak)) {
      dispatch({ type: 'failed', reason: SILENCE_MESSAGE })
      return
    }
    dispatch({ type: 'transcribed', text: result.text })
    if (voiceRef.current?.refine?.enabled === true && voiceRef.current.refine.auto === true) {
      const merged = stateRef.current.draft === '' ? result.text : `${stateRef.current.draft} ${result.text}`
      void refineNow(merged)
    }
  }

  async function begin(): Promise<void> {
    const v = voiceRef.current
    if (v?.transcribeCommand === undefined || v.transcribeCommand.trim() === '') {
      dispatch({ type: 'failed', reason: 'Set a transcribe command under Settings → Voice first.' })
      return
    }
    const access = await cockpitApi.voiceMicAccess()
    if (access.status !== 'granted') {
      dispatch({ type: 'failed', reason: 'Microphone access is off for crossweave Cockpit. Allow it in System Settings → Privacy & Security → Microphone.' })
      return
    }
    try {
      recording.current = await startRecording({
        maxSeconds: v.maxSeconds ?? DEFAULT_MAX_SECONDS,
        onLimit: () => { void stopAndTranscribe() },
      })
      setElapsed(0)
      dispatch({ type: 'toggle' })
    } catch (err) {
      dispatch({ type: 'failed', reason: `Could not open the microphone: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  function toggle(): void {
    const phase = stateRef.current.phase
    if (phase === 'idle') void begin()
    else if (phase === 'recording') void stopAndTranscribe()
  }

  // The command (⌘⇧M) toggles once settings are read, so the first press both opens the
  // composer and starts recording.
  const lastSignal = useRef(0)
  useEffect(() => {
    if (!loaded || toggleSignal === lastSignal.current) return
    lastSignal.current = toggleSignal
    toggle()
  }, [toggleSignal, loaded])

  const send = (): void => {
    const text = state.draft.trim()
    if (text === '') return
    onSend(text, pressEnter)
    keptDraft = ''
    dispatch({ type: 'sent' })
  }

  const busy = state.phase === 'transcribing' || state.phase === 'refining'
  const snippets = voice?.snippets ?? []

  return (
    <section class="cockpit-voice" aria-label="Voice input">
      <textarea
        ref={areaRef}
        class="cockpit-voice__draft"
        rows={3}
        spellcheck={false}
        placeholder="Speak, then read and edit here. Nothing is sent until you press Send."
        value={state.draft}
        aria-label="Prompt draft"
        onInput={(e) => dispatch({ type: 'edit', text: (e.target as HTMLTextAreaElement).value })}
        onKeyDown={(e) => {
          if (e.isComposing) return
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
      />
      {state.proposal !== null ? (
        <div class="cockpit-voice__proposal" role="region" aria-label="Refined prompt">
          <div>
            <p class="cockpit-muted">What you said</p>
            <pre>{state.draft}</pre>
          </div>
          <div>
            <p class="cockpit-muted">Refined</p>
            <pre>{state.proposal}</pre>
          </div>
          <div class="cockpit-voice__proposal-actions">
            <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary" onClick={() => dispatch({ type: 'accept' })}>Accept</button>
            <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => dispatch({ type: 'revert' })}>Revert</button>
          </div>
        </div>
      ) : null}
      {state.phase === 'recording' ? (
        <div class="cockpit-voice__meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, level)}>
          <div style={{ width: `${Math.round(Math.min(1, level * 4) * 100)}%` }} />
        </div>
      ) : null}
      {state.error !== null ? (
        <p class="cockpit-error" role="alert">
          {state.error}{' '}
          {/Settings → Voice/.test(state.error) ? (
            <button type="button" class="cockpit-btn cockpit-btn--sm" onClick={() => onOpenSettings('voice')}>Open Voice settings</button>
          ) : null}
        </p>
      ) : null}
      <div class="cockpit-voice__bar">
        <button type="button" class={`cockpit-btn cockpit-btn--sm${state.phase === 'recording' ? ' cockpit-btn--danger' : ''}`}
          disabled={busy || !loaded} onClick={toggle}
          aria-label={state.phase === 'recording' ? 'Stop recording' : 'Start recording'}>
          {state.phase === 'recording' ? `■ Stop ${clock(elapsed)}` : state.phase === 'transcribing' ? 'Transcribing…' : state.phase === 'refining' ? 'Refining…' : '● Record'}
        </button>
        {voice?.refine?.enabled === true ? (
          <button type="button" class="cockpit-btn cockpit-btn--sm" disabled={busy || state.phase === 'recording' || state.draft.trim() === ''}
            onClick={() => { void refineNow(state.draft) }}>Refine</button>
        ) : null}
        {snippets.map((sn) => (
          <button key={sn.name} type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" title={sn.text}
            onClick={() => { dispatch({ type: 'edit', text: appendSnippet(state.draft, sn.text) }); areaRef.current?.focus() }}>{sn.name}</button>
        ))}
        <span class="cockpit-sidebar__spring" />
        <label class="cockpit-settings__toggle">
          <input type="checkbox" checked={pressEnter} onChange={(e) => { const on = (e.target as HTMLInputElement).checked; setPressEnter(on); writeEnter(on) }} />
          <span>Press Enter</span>
        </label>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--ghost" disabled={state.draft === ''} onClick={() => dispatch({ type: 'clear' })}>Clear</button>
        <button type="button" class="cockpit-btn cockpit-btn--sm cockpit-btn--primary" disabled={busy || state.draft.trim() === ''} onClick={send}>Send ⌘↵</button>
        <button type="button" class="cockpit-iconbtn" aria-label="Close voice input" onClick={onClose}>×</button>
      </div>
    </section>
  )
}
