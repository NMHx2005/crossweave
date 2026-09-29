# Cockpit voice input — known limitations

**Date:** 2026-09-29 · Design: `2026-09-29-cockpit-voice-input-design.md` · Branch `feat/voice-input`

## What shipped

Record → the user's transcribe command → a draft under the stage → Send types it into the
focused pane. A mic button on the tab strip and ⌘⇧M (rebindable) open the composer and start
recording. Refinement is a switch in Settings → Voice, **off by default**; when on it adds a
Refine button that never runs by itself (unless *Refine after each transcription* is also on),
shows a proposal beside the draft, and only Accept replaces the draft. Snippets add fixed text
to the draft. The Voice section of the settings page holds the commands, language, maximum
length, snippets, the refine options and a Test button.

- `src/core/settings.ts`: `voice` in the daemon-validated settings (one-line commands that must
  split into arguments, limits, unique snippet names; a corrupt block is dropped on load).
- `electron/voice.ts`: the runner. The command line is split into arguments first and
  `{audio}`/`{language}` filled in afterwards, so nothing in a path can change how it splits;
  argv only, no shell; a timeout and an output cap; the recording is deleted on every path; the
  command is read from the user's saved file, never from the request.
- `lib/voice-state.ts`, `lib/wav.ts`, `lib/voice-recorder.ts`: the state machine, a 16 kHz mono
  WAV encoder, and a recorder that takes raw samples (Chromium's MediaRecorder only makes
  WebM/Opus, which whisper-style tools cannot read).
- `scripts/voice-check.ts`: an end-to-end CDP run.

## Verified

Unit tests for the settings schema, the runner (fake `execFile`), the state machine and the WAV
encoder. On the real app with a scratch `$HOME` and stub commands: the mic button opens the
composer and starts recording; no Refine control while the switch is off; the transcribe
command received a genuine 16 kHz WAV (`magic=RIFF rate=16000`, 82 KB for about 2.5 s) and its
text is in the draft; a snippet lands on its own paragraph; Send types the draft into the pane
and empties it; with refinement on, a proposal appears beside an unchanged draft, the refine
command received the instruction and the draft on stdin, and Accept replaces the draft.

## Not verified

- **Transcription quality and latency with the user's real model.** whisper-cli and ffmpeg are
  installed on this Mac but no `ggml-*.bin` model was found, so no real speech was transcribed.
  The Vietnamese-with-English-terms measurement in the plan (task 8) is still to do.
- **The macOS microphone prompt in the packaged app.** In a development Electron, `getUserMedia`
  waits on the operating system's microphone permission even with Chromium's fake device, so the
  end-to-end run replaces `getUserMedia` in the page with a synthetic stream. The recorder, the
  encoder, the IPC and both commands are real; the OS permission dialog and a real microphone
  are not exercised. `NSMicrophoneUsageDescription` is in `electron-builder.yml`; hardened
  runtime is off so no audio-input entitlement is needed — re-check if that changes.
- The Settings → Voice **Test** button and *Refine after each transcription* are not covered by
  the CDP run.

## Limitations

- **The hotkey works only while the cockpit is focused**; a system-wide hotkey is a later opt-in.
- **The transcript arrives after recording stops**; no live captions.
- **ScriptProcessorNode** is deprecated (an AudioWorklet would need a module URL); it works in
  this Electron and the recording is seconds long.
- **A draft survives closing the composer, not restarting the app**, and is shared by all projects.
- **The transcribe command is checked for `{audio}` when used, not when saved**; a missing
  placeholder is reported by Record and by Test, with the sentence saying what to fix.
- **A command with no `{audio}` cannot hear anything**; a command that reads the audio from
  stdin is not supported.
- **`COCKPIT_FAKE_MIC=1`** makes the app skip only its own request for the macOS permission; it
  exists so an automated run does not raise a system dialog. It does not grant capture.
- The refine context is the session name, branch and the number of uncommitted files: only data
  the app already has, and only when *Include session context* is on.
- Quality and speed are those of the user's chosen command; text sent to a refine command goes to
  whatever that command contacts, which the switch's description says.
