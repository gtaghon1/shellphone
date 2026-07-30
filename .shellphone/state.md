# shellphone ledger — shellphone

<!-- Appended by shellphone-hook on each Claude Code session stop.
     Newest entries at the bottom. Plain markdown + YAML on purpose:
     this file is the source of truth, shellphone is just a reader. -->

## 2026-07-30T18:47:31Z · master · wip

```yaml
ts: 2026-07-30T18:47:31Z
repo: shellphone
branch: master
machine: M4.local
status: wip
summary: "shellphone v0.1.0 is built, tested and installed end to end:
  markdown ledger plus inbox, five MCP tools over both stdio and bearer-authed
  HTTP, three Claude Code hooks, and a CLI. It is registered with Claude Code
  (connected, user scope) and added to Claude Desktop's mcpServers, pending a
  Desktop restart to verify that path. This is the first digest written by the
  live stop-hook, and firing it exposed two defects in the hook's changed-file
  detection: it emits absolute paths instead of repo-relative ones, and it
  leaked a scratchpad file from outside the repo root into the changed list."
changed:
  - package.json
  - tsconfig.json
  - .gitignore
  - src/types.ts
  - src/paths.ts
  - src/ledger.ts
  - src/queue.ts
  - src/registry.ts
  - src/format.ts
  - src/server.ts
  - src/transports.ts
  - src/hooks.ts
  - src/cli.ts
  - test/parsers.test.js
  - README.md
open_questions:
  - Does Claude Desktop actually reach the stdio server, or does the GUI need
    more environment than the absolute node path supplies?
session: 18a024c2-0578-473d-b00f-74321cf330e1
```

## 2026-07-30T19:22:32Z · master · wip

```yaml
ts: 2026-07-30T19:22:32Z
repo: shellphone
branch: master
machine: M4.local
status: wip
summary: "Both path bugs from instruction 3880ea are fixed and acked:
  changed[] is now repo-relative and scoped to the repo root, enforced at
  every point that writes a digest rather than only where paths are detected.
  Fixing them surfaced two adjacent bugs, also fixed — git status --porcelain
  emits paths relative to the git root (not necessarily the shellphone root),
  and realpath cannot resolve a symlinked parent when the leaf file is gone.
  Digest triggering was then reworked from per-session to per-drift on the
  context-compaction model: a /digest slash command writes one on demand,
  drift is measured against the ledger as commits plus changed files since the
  last digest, and the Stop hook only asks once drift crosses a threshold. 28
  tests green, three commits on master."
changed:
  - README.md
  - src/cli.ts
  - src/drift.ts
  - src/format.ts
  - src/hooks.ts
  - src/paths.ts
  - src/server.ts
  - src/types.ts
  - test/parsers.test.js
open_questions:
  - "Untested surfaces: autonomous mode, SessionStart delivery of an
    instruction queued while no session is open, and the Claude Desktop
    connector (connected but never exercised)."
  - Is a 5-file / 2-commit / 45-minute threshold the right interruption budget
    in practice, or should drift also weigh how much of the diff is in files
    the last digest already mentioned?
session: 18a024c2-0578-473d-b00f-74321cf330e1
```
