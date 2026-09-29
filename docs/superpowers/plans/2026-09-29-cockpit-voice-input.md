# Plan — cockpit voice input

Spec: `docs/superpowers/specs/2026-09-29-cockpit-voice-input-design.md`
Branch: `feat/voice-input`
Tier: Large — mic permission, a runner in the main process, a composer, a settings section.
Starts **after the settings page has landed**.

## Tasks

1. [ ] **Pure core, tests first.** `voice-state.ts` (reducer), `voice-command.ts` (argv
   builder, placeholder substitution, empty/invalid command errors), `snippets.ts`; the three
   test files in the spec.
2. [ ] **Runner** in `apps/cockpit/electron/voice.ts`: `execFile` with argv, timeout, output
   cap, private temp dir, audio removed in `finally`; a fake-`execFile` test file; new
   channels in `channels.ts` (allow-listed) for transcribe and refine.
3. [ ] **Recording.** `MediaRecorder` capture in the renderer, the max-length cap, mic
   permission through the main process, the refusal message; `NSMicrophoneUsageDescription`
   in `electron-builder.yml`.
4. [ ] **Composer.** The dock, draft, record button and states, snippets row, Send through
   `term.paste` into the focused pane, `voice.toggle` in the command registry and Keyboard
   settings. Reduced motion respected; tokens only.
5. [ ] **Settings → Voice** rows and the Test button (on the settings page).
6. [ ] **Refine (off by default).** The switch, the button that exists only when it is on,
   Accept/Revert against the raw draft, the editable instruction, the two sub-switches, all
   off by default; tests for the gating.
7. [ ] **CDP with a fake microphone** and a stub transcribe command; a screenshot per state.
   Verify the mic prompt on the **packaged** app (`bun run dist:mac`), not only in dev.
8. [ ] **Measure** with the user's real transcribe command: latency for a 20-second
   utterance and a Vietnamese-with-English-terms sample; record the numbers.
9. [ ] **Gates + docs.** Root `bun run typecheck`, `bun test --max-concurrency=1`,
   `bun run build` if `src/` changed (it should not); cockpit `bun test`, `bun run build`;
   known-limitations file + digest line.

## Gate

`bun run typecheck` · `bun test --max-concurrency=1` · cockpit `bun test` + `bun run build`
· CDP run with the fake mic · a packaged-app smoke.

## Report

The measured latency and accuracy with the user's own command, and screenshots, before the
next phase.
