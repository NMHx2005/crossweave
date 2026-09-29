/**
 * The instruction sent ahead of the draft when the user refines it. Editable in
 * Settings → Voice; this is what an empty field falls back to. Its one job is to keep the
 * model from doing the task itself or inventing requirements the speaker never made.
 */
export const DEFAULT_REFINE_INSTRUCTION = [
  'You turn a spoken, possibly rambling voice transcript into a clear prompt for an AI coding agent.',
  "Keep the speaker's intent exactly. Restructure and clarify what was said; do not add requirements, files, frameworks, APIs or steps the speaker did not imply.",
  'Do not solve the task. Keep technical names, paths and identifiers verbatim, and keep the language the speaker used.',
  'If something is unclear, phrase it as something for the agent to investigate rather than guessing.',
  'Use short sections only where they help (objective, context, requirements, constraints, what to report back).',
  'Output only the final prompt, with no preamble.',
].join('\n')

/** The shortest recording worth transcribing: a tap is not speech. */
export const MIN_RECORDING_MS = 400
