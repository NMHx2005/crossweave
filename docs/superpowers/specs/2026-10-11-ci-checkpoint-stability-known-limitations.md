# CI root-test stability — known limitations

## What changed

The first CI adjustment set concurrency to 1 and attempted to scope the Linux job with `bun test tests website/tests --max-concurrency=1`. The remote run proved that incomplete: Bun treats positional arguments as substring filters, so it still discovers Cockpit's Preact tests without their dependencies. The dedicated macOS job remains responsible for the app suite.

The 2026-10-12 branch run `38200756671` still failed with four PTY-backed integration timeouts and six missing-Preact errors. The unchanged `main` run `38111732784` showed the same failures, so they predate this branch. The next run `38231615436` correctly excluded Cockpit from Linux discovery and kept the Cockpit job green, but the root suite still failed with four PTY timeouts and one fixture-copy `ENOENT`. Its timeout diagnostics showed that the daemon found the fake `claude` process and the session remained `working` with only its start checkpoint; the fake CLI was a child of the session shell. That rules out a missing process, but does not yet distinguish a terminal-screen inference defect from a runner limitation. The fixture `ENOENT` needs separate investigation. With Bun 1.3.14, the checkpoint case passed three consecutive serial runs locally, the three automatic-check cases passed locally, and the full local suite passed outside the restricted sandbox.

## Still open

- CI is not complete: Linux test discovery is corrected, but the latest remote run remains red. Diagnose the PTY and fixture-copy failures before integration.
- PTY and socket tests need host capabilities that the restricted sandbox denies. The full local suite ran outside that sandbox with concurrency 1; sandbox-only failures are not evidence about the change.
- The PTY timeout occurs on unchanged `main` as well as this branch; the runner detects the agent, but the session remains `working`. Capture the child process tree and determine why the terminal screen never registers an idle/asked state before choosing a fix.
