# shellphone manifest — shellphone

<!-- What this project IS. Overwritten by `/survey`, not appended to.
     Hand-edit freely: shellphone re-reads this file and will not clobber
     it until the next survey. Digests live in state.md. -->

> A local context bridge that lets Claude Chat see and steer what Claude Code is doing, without a human copying state between them.

```yaml
name: shellphone
one_liner: A local context bridge that lets Claude Chat see and steer what
  Claude Code is doing, without a human copying state between them.
purpose: Chat and Code don't share context, so every hop between them is a
  manual, lossy serialization step. shellphone moves state *about* code —
  status, decisions, open questions — never the code itself. It is a transport
  layer over plain files, not a memory system.
stack:
  - TypeScript (ES2023, NodeNext)
  - Node >=20
  - "@modelcontextprotocol/sdk"
  - zod
  - yaml
  - express
  - node:test
layout:
  - path: src/ledger.ts
    role: state.md — append-only session digests
  - path: src/manifest.ts
    role: manifest.md — the standing project description (this file's output)
  - path: src/queue.ts
    role: inbox.md — instructions from Chat, with announced/consumed lifecycle
  - path: src/drift.ts
    role: how far the repo moved since the ledger last described it
  - path: src/hooks.ts
    role: Claude Code Stop / SessionStart / UserPromptSubmit entry points
  - path: src/server.ts
    role: "MCP tools: list_repos, get_state, get_queue_status, send_instruction,
      record_digest, record_manifest"
  - path: src/transports.ts
    role: stdio for local clients, bearer-authed HTTP for tunneled claude.ai
  - path: src/cli.ts
    role: the shellphone binary; also ships the /digest and /survey slash commands
  - path: test/parsers.test.js
    role: runs against dist/, covers the parsers and drift logic
entry_points:
  build: npm run build
  test: npm test (build first)
  mcp-stdio: shellphone mcp
  mcp-http: shellphone serve
  setup: shellphone init && shellphone install-hooks --global
decisions:
  - what: Files are the source of truth; shellphone is only a reader
    why: if the tool dies, `less .shellphone/state.md` still tells a human what
      was going on
  - what: Markdown with fenced YAML, not pure YAML or JSON
    why: renders as prose for humans, parses without a markdown library for
      machines
  - what: Claude writes its own digests; hooks only supply mechanical facts
    why: a hook knows which files changed, but only the session knows what the
      work meant
  - what: Digests trigger on drift, not per-stop or per-session
    why: Stop fires every turn (spam) and per-session collapses to the first stop,
      describing the least-finished state the session ever had
  - what: Drift is measured against the ledger, not the session
    why: the question is whether what Chat would read is still true, which does
      not depend on who is asking
  - what: Age alone never marks a digest stale
    why: an old digest for an untouched repo is accurate; nagging would train the
      warning to be ignored
  - what: Manifest is overwritten, ledger is append-only, separate files
    why: mixing a mutable document into an append-only ledger makes both harder to
      reason about
  - what: Read tools are eager, send_instruction is gated behind human confirmation
    why: reading is cheap and safe; writing is instruction injection into a coding
      agent
  - what: Repos self-register into ~/.shellphone/registry.json
    why: the MCP server must never crawl a user's disk to answer list_repos()
constraints:
  - No vector store, embeddings, or semantic search — plain files and
    grep-scale reads
  - No cross-repo reasoning or aggregation; that is a chat job
  - No cloud storage of state; claude.ai access requires the user to run their
    own tunnel
  - Chat can read Code and send it instructions, but cannot see the Code
    transcript — and Code cannot see the Chat transcript at all
gotchas:
  - Stop hooks fire at the end of every assistant turn, not on process exit;
    Ctrl+C does not trigger one
  - Claude Code loads hooks at session start, so newly installed hooks need a
    restart
  - The stdio MCP server is spawned per session, so newly added tools are
    invisible to sessions already running
  - GUI apps (Claude Desktop) do not inherit shell PATH — its config must use
    an absolute node path
  - Tests import from dist/, so `npm run build` must run before `npm test`
  - .shellphone/ is gitignored in this repo, so the ledger and manifest do not
    travel to other clones
open:
  - Autonomous mode, SessionStart instruction delivery, and the Claude Desktop
    connector are all built but never exercised end to end
  - Both bugs found so far were empty-vs-absent confusions at a boundary; the
    remaining boundaries have not been audited for the same shape
  - Whether the manifest belongs under .shellphone/ at all, given it is the
    one artifact that arguably should travel with the repo
surveyed: 2026-07-30T19:50:18Z
commit: "3958182"
machine: M4.local
```
