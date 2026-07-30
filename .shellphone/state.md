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
