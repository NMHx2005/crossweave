# CI root-test stability — known limitations

## What changed

The Linux CI job now runs `bun test tests website/tests --max-concurrency=1`. It no longer discovers Cockpit's Preact tests without installing their dependencies; the dedicated macOS job remains responsible for Cockpit tests. The automatic-checkpoint implementation and test assertions were not changed.

The 2026-10-11 run failed for two causes: four PTY-backed integration cases hit their 25–30 second loops under the runner's default test concurrency, and six Cockpit tests could not load `preact/jsx-dev-runtime`. The 2026-10-08 failures showed the dependency-loading issue but not the timeouts. With Bun 1.3.14, the checkpoint case passed three consecutive serial runs locally and the three automatic-check cases passed serially. The full local suite passed outside the restricted sandbox.

## Still open

- The fix is on `codex/post-release-completion`; GitHub Actions has not run against it. CI is not complete until the remote Linux and macOS jobs pass after the branch is integrated.
- PTY and socket tests need host capabilities that the restricted sandbox denies. The full local suite ran outside that sandbox with concurrency 1; sandbox-only failures are not evidence about the change.
- The original CI timeouts remain unexplained beyond runner concurrency and contention. The fix reduces load and sets the job boundary without changing product or timing assertions; monitor the next CI run.
