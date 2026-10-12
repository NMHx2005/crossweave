# CI root-test stability — known limitations

## What changed

The first CI adjustment set concurrency to 1 and attempted to scope the Linux job with `bun test tests website/tests --max-concurrency=1`. The remote run proved that incomplete: Bun treats positional arguments as substring filters, so it still discovers Cockpit's Preact tests without their dependencies. The dedicated macOS job remains responsible for the app suite.

The 2026-10-12 branch run `38200756671` had four PTY-backed integration timeouts and six missing-Preact errors. The unchanged `main` run `38111732784` showed the same failures, so they predated this branch. Run `38231615436` correctly excluded Cockpit from Linux discovery but retained the PTY timeouts and one fixture-copy `ENOENT`. Diagnostics showed the daemon found the fake `claude` process while the session remained `working`. The root cause was non-portable test-fixture output: `dash` prints `\\x1b` literally, so the fake agent's final clear-screen sequence never ran. Both fixtures now use POSIX `\\033`; a direct `dash` check confirmed the former prints `5c 78 31 62` and the latter prints `1b`. Run `38232700603` confirmed the fake agent had reached `sleep 60` after its prompt; the fixture-copy `ENOENT` did not recur. After the fix, all five focused PTY tests and all 2,362 root tests pass locally, and [run `38233229200`](https://github.com/NMHx2005/crossweave/actions/runs/38233229200) passes both the Linux root suite and macOS Cockpit build/tests.

## Still open

- The PTY escape failure is fixed and CI run `38233229200` was green. A separate Linux fixture-copy `ENOENT` appeared in four attempts: the initial run and failed-job rerun of `38234721338`, then `38235758485` and `38237062012`. The fourth captured complete, identical recursive source and destination trees despite the `ENOENT`, implicating Bun's async recursive copy rather than missing fixture data. `makeGitFixture` now uses synchronous `cpSync`; full Linux/Cockpit CI run [`38237502724`](https://github.com/NMHx2005/crossweave/actions/runs/38237502724) passes. Recursive manifests remain attached to exceptional failures to aid diagnosis if this returns.
- PTY and socket tests need host capabilities that the restricted sandbox denies. The full local suite ran outside that sandbox with concurrency 1; sandbox-only failures are not evidence about the change.
