# Cockpit voice input — speak a prompt, review it, send it

**Date:** 2026-09-29
**Status:** Planned (discussed in chat 2026-09-29; two defaults below await confirmation)
**Scope:** `apps/cockpit/electron` (mic permission, a transcribe/refine runner),
`apps/cockpit/src/ui` (a composer, a Voice settings section), `apps/cockpit/src/lib`
(pure state and argv logic), `apps/cockpit/electron-builder.yml` (mic usage string). No
daemon change and no native module.
**Branch:** `feat/voice-input`
**Depends on:** `2026-09-29-cockpit-settings-page-design.md` (the Voice section lives there).

## Problem

Prompts for a coding agent are typed. The user wants to speak them, and asked whether an LLM
should tidy the result. The manual recipe for this is a hotkey dictation app plus a launcher's
AI command plus a paste. The cockpit already knows which pane is focused and can put text in
it, so the whole path can live in the app.

## Decisions taken in chat

- **The LLM step is optional and off by default**, behind a switch in Settings. The agents
  already understand casual speech; a rewrite costs latency and money and can change meaning.
  Voice input ships and is useful without it.
- **Nothing is sent to an agent without a human read.** Speech lands in a draft the person
  reads and edits; sending is a separate action.

## Defaults awaiting confirmation (changeable)

1. **Speech-to-text runs on this Mac through a command the user installs** (for example
   whisper.cpp), so audio never leaves the machine. A cloud option is just another command
   in the same setting; the app ships no key handling.
2. **The hotkey works while the cockpit is focused.** A system-wide hotkey is a later opt-in
   (Electron `globalShortcut`, no native module) once the in-app one has proved useful.

## Non-goals

- Streaming/live captions while speaking, wake words, or speaker identification.
- The app choosing or configuring an AI (see `AGENTS.md`, decisions already made): both
  commands are the user's, typed into Settings.
- Sending audio anywhere by default. The default transcribe command is empty; until one is
  set, the mic button explains what to configure and links to the Voice section.

## Design

**Flow.**
`record` → audio file (temp, mode 0600, in a 0700 directory) → `transcribe` command →
text appended to the **draft** → (optional) `Refine` → person edits → `Send` → `term.paste`
into the focused pane.

**Composer.** A dock under the stage (⌥Space toggles it and starts recording; the command id
`voice.toggle` is rebindable in Settings → Keyboard). It holds a multi-line draft, a record
button with its state (idle, recording with elapsed time, transcribing), Send (⌘Enter),
Clear, and a row of **snippets**. Esc closes it and keeps the draft until the next open.

**Recording.** Chromium `MediaRecorder` in the renderer, mono, 16 kHz where the platform allows,
capped at 5 minutes (a cap the person can raise). The main process asks macOS for the
microphone (`systemPreferences.askForMediaAccess('microphone')`) on first use; a refusal shows
a sentence pointing at System Settings, not a raw error. The packaged app needs
`NSMicrophoneUsageDescription` (`mac.extendInfo` in `electron-builder.yml`); hardened runtime is
currently off, so no audio-input entitlement is required — re-check if that changes.

**Transcribe command.** A user-level setting: an argument list with `{audio}` and `{language}`
placeholders (default language `auto`; `vi`, `en` selectable), e.g.
`whisper-cli -m ~/models/ggml-large-v3.bin -f {audio} -l {language} -nt`. The runner:

- executes with `execFile` and an **argv array — never a shell string** — substituting
  placeholders as whole arguments, so nothing in a transcript or path can be interpreted;
- lives in the Electron main process, like the existing `execFile` uses there (font and
  terminal-settings import), because it starts no session shell; the daemon is not involved;
- has a timeout (default 120 s), an output cap (1 MB), and deletes the audio in a `finally`;
- reads the command **only from user-level settings, never from a repository's config**, so a
  cloned repo cannot make the app run something.

**Snippets.** User-defined named blocks of text (for example "investigate first", "run
typecheck, tests and build, then report") inserted at the end of the draft with one click or a
number key. Static text — this is the deterministic way to add the recurring tail that people
otherwise ask an LLM to invent, with none of its cost or drift.

**Refine (off by default).** Settings → Voice → *Refine the draft with a command* is a switch.
While off, no Refine control exists in the composer. While on, a **Refine** button appears;
it never runs by itself (a second sub-switch, *Refine after each transcription*, is also off by
default). It sends the draft on stdin to a user-set argument list (for example
`claude -p`), with an editable instruction prompt whose default says: restructure and clarify
what was said; **do not add requirements, files, frameworks or steps the speaker did not
imply; keep technical names verbatim; if something is unclear, phrase it as something to
investigate; output only the prompt**. The result appears next to the raw draft with **Accept**
and **Revert**; nothing replaces the draft until Accept. An optional *include session context*
switch (off) prepends the branch name and changed-file list, from data the app already has.
The setting's description states plainly that the text goes to whatever that command does.

**State.** One pure reducer (`voice-state.ts`): `idle → recording → transcribing → idle`,
plus `refining`, with the draft, the last error, and the raw draft kept while a refinement is
pending. Every transition is a function of the previous state and an event, tested without a
microphone.

**Settings → Voice** (rows): Transcribe command, Language, Maximum recording length,
Snippets, *Refine the draft* (switch), Refine command, Refine instruction, *Refine after each
transcription* (switch), *Include session context* (switch), and a **Test** button that records
three seconds and shows the transcript so a broken command is found in Settings, not mid-prompt.

## Security and privacy

- Audio is written to a private temp file and removed after each run; it is not stored.
- Both commands are arbitrary programs the user configured: they run with the user's rights,
  as an argv (no shell), with a timeout and an output cap. They are never taken from project
  config.
- With a local transcribe command nothing leaves the machine. Refine sends text to whatever its
  command contacts, which the switch's description says.
- Transcripts and drafts are not logged.

## Testing

- `voice-state.test.ts` — every transition; a second Record while recording stops; an error
  returns to idle with the draft intact; refine keeps the raw draft until Accept and restores
  it on Revert; Refine is unavailable while its switch is off.
- `voice-command.test.ts` — placeholder substitution yields argv arrays; a path or language
  containing spaces, quotes, `;`, `$()` stays one argument; a missing placeholder or an empty
  command is a clear error; the command is taken from user settings only.
- `snippets.test.ts` — insert at end, dedupe of separators, ordering.
- Runner with a fake `execFile`: timeout, output cap, non-zero exit, empty transcript (reported,
  draft unchanged), audio removed on every path.
- CDP with Chromium's fake microphone (`--use-fake-device-for-media-stream
  --use-file-for-fake-audio-capture=<wav>`) and a stub transcribe script: record → draft →
  Send lands text in the focused pane; a screenshot of the composer in each state.

## Risks

- **Transcription quality for Vietnamese mixed with English terms** depends on the user's model;
  the Test button and the language setting exist for this, and it is measured with their model
  before the feature is called done.
- **Mic permission in a packaged, unsigned-for-distribution app** — verified on the built app,
  not only `bun run dev`.
- **A rewrite that changes meaning** — off by default, never automatic, shown against the raw
  text, explicit instruction not to invent.

## Known limitations (to write at merge)

- No live captions; the transcript arrives after recording stops.
- The hotkey works only while the cockpit is focused, until the global opt-in exists.
- Quality and speed are those of the user's chosen command.

## As built (2026-09-29)

- **Recording is raw samples encoded to WAV in the renderer**, not `MediaRecorder`: Chromium's
  recorder only produces WebM/Opus, which whisper-style tools cannot read, so this avoids needing
  a converter. It is a change from the *Recording* paragraph above.
- **The mic button on the tab strip** was added next to ⌘⇧M (default) — discoverable, and the
  hotkey stays rebindable under Keyboard.
- **Settings validation lives in the daemon** (`voice` in `src/core/settings.ts`) like every other
  setting, so "no daemon change" above meant no new RPC: the existing `settings.get/set` carry it.
- **Send is a `cockpit:paste` event** the focused pane answers with `term.paste` (bracketed when
  the program asked), with an optional Enter keystroke.
