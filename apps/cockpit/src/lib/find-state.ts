/** The find bar over a terminal pane (⌘F): what is searched, how, and where it stands. */
export type FindState = {
  open: boolean
  term: string
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
  /** From the search addon; -1 when the current match is not known. */
  resultIndex: number
  resultCount: number
}

export type FindAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'term'; term: string }
  | { type: 'toggle'; option: 'caseSensitive' | 'regex' | 'wholeWord' }
  | { type: 'results'; resultIndex: number; resultCount: number }

export const CLOSED_FIND: FindState = {
  open: false, term: '', caseSensitive: false, regex: false, wholeWord: false, resultIndex: -1, resultCount: 0,
}

/**
 * Reopening keeps the last term and options (as editors do), so ⌘F then Enter repeats
 * the last search; a new term or option forgets the old counts until the addon reports.
 */
export function findReducer(state: FindState, action: FindAction): FindState {
  switch (action.type) {
    case 'open': return { ...state, open: true }
    case 'close': return { ...state, open: false, resultIndex: -1, resultCount: 0 }
    case 'term': return { ...state, term: action.term, resultIndex: -1, resultCount: 0 }
    case 'toggle': return { ...state, [action.option]: !state[action.option], resultIndex: -1, resultCount: 0 }
    case 'results': return { ...state, resultIndex: action.resultIndex, resultCount: action.resultCount }
  }
}

/** What the bar says about the matches. */
export function findLabel(state: FindState): string {
  if (state.term === '') return ''
  if (state.resultCount === 0) return 'No results'
  if (state.resultIndex < 0) return `${state.resultCount} found`
  return `${state.resultIndex + 1} of ${state.resultCount}`
}
