# shellphone inbox — shellphone

<!-- Instructions from Claude Chat, newest at the bottom.
     `pending` means Claude Code has not acted on it yet.
     Edit or delete entries by hand freely; shellphone re-reads this file. -->

## consumed · 3880ea · sent 2026-07-30T18:55:08Z · consumed 2026-07-30T18:59:40Z

Fix two bugs surfaced by the first live stop-hook digest, both in the changed-file detection path (likely in src/hooks.ts and/or src/paths.ts):

1. Changed-file paths are being emitted as absolute paths instead of repo-relative. Normalize against the repo root before writing to the ledger — digests should read like `src/ledger.ts`, not a full filesystem path.

2. A scratchpad file from outside the repo root leaked into the changed-file list for the shellphone repo itself. The detector needs to filter to paths under the repo root (or under the actual git working tree) before including them — anything outside that boundary should be dropped silently, not surfaced.

After fixing, re-run a session and record a new digest to confirm both are resolved: changed[] should show only repo-relative paths, and nothing from outside the repo root should appear.

## consumed · e32365 · sent 2026-07-30T19:43:53Z · consumed 2026-07-30T19:50:49Z

Decision: `shellphone init` should also produce a standing project manifest, not just leave get_state scoped to session-by-session digests.

Why: record_digest is correctly scoped to "what changed this session" — that's working as designed. But a chat UI session that only has get_state has no way to learn what the project *is*: stack, subsystems, locked design decisions, known limits, gotchas. Right now a human has to hand-author and paste that in every time (we just did this manually for the redline repo — a hand-written YAML doc covering identity, architecture/pipeline stages, locked art/design decisions, physics model, known limits, gotchas, and an open deliberation section). That doc is the shape we want automated, not copied verbatim — it's one example of what's useful, not a schema to enforce across repo types.

Add to init (or as a command runnable anytime, since projects reshape and a manifest goes stale): have Code survey the actual repo — README, structure, key subsystems, any existing design docs/decisions it can find — and write a general-purpose project manifest. Store it distinctly from digests (e.g. its own file under .shellphone/, or its own entry kind) so get_state can return "what this project is" alongside "what just changed" without conflating the two. Make it refreshable on demand rather than write-once.

Decide the exact survey schema/fields yourself based on what generalizes across repo types — don't hardcode redline's specific keys (art_direction, physics, etc.) into the tool.
