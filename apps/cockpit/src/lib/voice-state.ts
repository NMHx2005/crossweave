export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'refining'

export interface VoiceState {
  phase: VoicePhase
  /** What the person reads, edits and sends. */
  draft: string
  /** A refinement waiting for Accept or Revert; the draft is untouched until then. */
  proposal: string | null
  /** The last failure, in a sentence. */
  error: string | null
  /** Mirrors Settings → Voice: without it there is no Refine at all. */
  refineEnabled: boolean
}

export type VoiceEvent =
  | { type: 'toggle' }
  | { type: 'cancel' }
  | { type: 'transcribed'; text: string }
  | { type: 'failed'; reason: string }
  | { type: 'edit'; text: string }
  | { type: 'clear' }
  | { type: 'sent' }
  | { type: 'setRefine'; enabled: boolean }
  | { type: 'refine' }
  | { type: 'refined'; text: string }
  | { type: 'accept' }
  | { type: 'revert' }

export function initialVoiceState(refineEnabled = false): VoiceState {
  return { phase: 'idle', draft: '', proposal: null, error: null, refineEnabled }
}

/** Text spoken after what is already there: one space between, never two. */
export function appendText(draft: string, text: string): string {
  if (draft === '') return text
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`
}

/** A snippet on its own paragraph at the end. */
export function appendSnippet(draft: string, snippet: string): string {
  const base = draft.replace(/\s+$/, '')
  return base === '' ? snippet : `${base}\n\n${snippet}`
}

/**
 * The composer's whole state machine. Every transition is a function of the previous
 * state and one event, so the microphone, the transcribe command and the refine command
 * (which are all slow and can fail) can be exercised without any of them.
 *
 * One job at a time: `toggle` and `refine` do nothing while transcribing or refining. A
 * proposal is only ever beside the draft; anything that changes the draft or the setting
 * withdraws it, because it would no longer describe what is on screen.
 */
export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case 'toggle':
      if (state.phase === 'idle') return { ...state, phase: 'recording', error: null }
      if (state.phase === 'recording') return { ...state, phase: 'transcribing' }
      return state
    case 'cancel':
      return state.phase === 'recording' ? { ...state, phase: 'idle' } : state
    case 'transcribed':
      return { ...state, phase: 'idle', draft: appendText(state.draft, event.text), proposal: null, error: null }
    case 'failed':
      return { ...state, phase: 'idle', error: event.reason }
    case 'edit':
      return { ...state, draft: event.text, proposal: null }
    case 'clear':
      return { ...state, draft: '', proposal: null }
    case 'sent':
      return { ...state, draft: '', proposal: null, error: null }
    case 'setRefine':
      return { ...state, refineEnabled: event.enabled, proposal: event.enabled ? state.proposal : null }
    case 'refine':
      if (!state.refineEnabled || state.phase !== 'idle' || state.draft.trim() === '') return state
      return { ...state, phase: 'refining', error: null }
    case 'refined':
      return state.phase === 'refining' ? { ...state, phase: 'idle', proposal: event.text } : state
    case 'accept':
      return state.proposal === null ? state : { ...state, draft: state.proposal, proposal: null }
    case 'revert':
      return { ...state, proposal: null }
  }
}
