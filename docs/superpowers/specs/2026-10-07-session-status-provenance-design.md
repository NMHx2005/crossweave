# Session status provenance and quickstart

## Goal

Make the Cockpit's session status easier to interpret and give new users a safe, concrete two-session path through Crossweave's existing workflow.

## Design

The session row tooltip will identify whether the status is explicitly reported by `cw notify` or inferred from terminal activity. It will include the relative time of the relevant event: the signal timestamp for an explicit signal, otherwise the daemon's last activity timestamp. If no timestamp exists, omit the time. The row's compact layout and status inference remain unchanged.

The README quickstart will demonstrate two independent worktrees, checking convergence, optionally running the repository's trusted check command, and landing conflict-free work. It will remind users to commit changes in each session before landing. Existing commands and safety gates remain authoritative; this adds no new command or behavior.

## Stability scope

Use existing resource-budget rules and automated gates as the stability baseline. Do not add telemetry or claim real-world capacity from synthetic tests. Record live app checks that remain unverified in the known-limitations notes.

## Verification

- Unit-test provenance and timestamp choice, including absent timestamps.
- Run Cockpit tests and build, then inspect the running scratch app's rendered status tooltip.
- Run the documented quickstart commands against a disposable repository where practical.
- Run the full repository gate and stop gate.
