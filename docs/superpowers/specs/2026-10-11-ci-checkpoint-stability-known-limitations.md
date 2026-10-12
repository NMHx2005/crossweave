# CI root-test stability — known limitations

## What changed

The first CI adjustment set concurrency to 1 and attempted to scope the Linux job with `bun test tests website/tests --max-concurrency=1`. The remote run proved that incomplete: Bun treats positional arguments as substring filters, so it still discovers Cockpit's Preact tests without their dependencies. The dedicated macOS job remains responsible for the app suite.

The 2026-10-12 branch run `38200756671` had four PTY-backed integration timeouts and six missing-Preact errors. The unchanged `main` run `38111732784` showed the same failures, so they predate this branch. Run `38231615436` correctly excluded Cockpit from Linux discovery and kept the Cockpit job green, but the root suite had the same PTY timeouts and one fixture-copy `ENOENT`. Diagnostics showed the daemon found the fake `claude` process and the session remained `working` with only its start checkpoint. The root cause was non-portable test-fixture output: `dash` prints `\\x1b` literally, so the fake agent's final clear-screen control sequence never ran. Both fixtures now use the POSIX `\\033` form; a direct `dash` check confirmed the former prints `5c 78 31 62` and the latter prints `1b`. The diagnostic run `38232700603` confirmed the fake agent completed its busy loop, and the fixture-copy `ENOENT` did not recur. The five focused PTY tests and all 2,362 root tests pass locally after the fix; an updated remote run is still required.

## Still open

- CI is not complete: Linux test discovery and the portable PTY fixtures are fixed locally, but the updated remote run must pass before integration.
- PTY and socket tests need host capabilities that the restricted sandbox denies. The full local suite ran outside that sandbox with concurrency 1; sandbox-only failures are not evidence about the change.
- One fixture-copy `ENOENT` occurred once in a Linux job; it did not recur in the following remote run or local full-suite runs.
