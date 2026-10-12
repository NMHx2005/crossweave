# CI root-test stability — known limitations

## What changed

The first CI adjustment set concurrency to 1 and attempted to scope the Linux job with `bun test tests website/tests --max-concurrency=1`. The remote run proved that incomplete: Bun treats positional arguments as substring filters, so it still discovers Cockpit's Preact tests without their dependencies. The dedicated macOS job remains responsible for the app suite.

The 2026-10-12 branch run `38200756671` still failed with four PTY-backed integration timeouts and six missing-Preact errors. The unchanged `main` run `38111732784` showed the same failures, so they predate this branch. With Bun 1.3.14, the checkpoint case passed three consecutive serial runs locally and the three automatic-check cases passed serially; the full local suite passed outside the restricted sandbox. The exact Linux timeout cause is unknown and must not be labelled environmental until session and process diagnostics are captured.

## Still open

- CI is not complete: the branch's latest remote run failed. Correct Linux test discovery and diagnose the PTY failures before integration.
- PTY and socket tests need host capabilities that the restricted sandbox denies. The full local suite ran outside that sandbox with concurrency 1; sandbox-only failures are not evidence about the change.
- The PTY timeout occurs on unchanged `main` as well as this branch; compare final activity, detected-agent state and process ancestry on Linux before choosing a fix.
