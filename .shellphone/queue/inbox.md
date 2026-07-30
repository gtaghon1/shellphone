# shellphone inbox — shellphone

<!-- Instructions from Claude Chat, newest at the bottom.
     `pending` means Claude Code has not acted on it yet.
     Edit or delete entries by hand freely; shellphone re-reads this file. -->

## consumed · 3880ea · sent 2026-07-30T18:55:08Z · consumed 2026-07-30T18:59:40Z

Fix two bugs surfaced by the first live stop-hook digest, both in the changed-file detection path (likely in src/hooks.ts and/or src/paths.ts):

1. Changed-file paths are being emitted as absolute paths instead of repo-relative. Normalize against the repo root before writing to the ledger — digests should read like `src/ledger.ts`, not a full filesystem path.

2. A scratchpad file from outside the repo root leaked into the changed-file list for the shellphone repo itself. The detector needs to filter to paths under the repo root (or under the actual git working tree) before including them — anything outside that boundary should be dropped silently, not surfaced.

After fixing, re-run a session and record a new digest to confirm both are resolved: changed[] should show only repo-relative paths, and nothing from outside the repo root should appear.
