# shellphone 🦞📞
### a context bridge between Claude Code and Claude Chat

> "Lobster Telephone, but for two Claudes." Two surfaces that already talk to *you* individually now talk to *each other*, so you stop being the modem.

---

## 1. Problem

Chat and Code don't share context. Today the loop is:

```
think in chat → hand-copy decisions into CLAUDE.md/prompt → code →
hand-copy state back out to resume thinking → repeat
```

Every hop is a lossy, manual serialization step. shellphone's job is to
delete the hops, not to build a bigger memory system. Minimum surface area,
no framework, just the state that actually needs to cross the boundary.
Cakeknife it: if a piece of state doesn't change what either side would
*do* next, it doesn't cross the wire.

## 2. Design principles

- **Local-first.** Code never leaves the machine. shellphone moves *state
  about* code (status, decisions, diffs-of-intent), not the code itself.
- **One state ledger per repo**, plain text, git-trackable, human-readable
  without the tool. If shellphone dies, `.shellphone/state.md` still tells
  a human what was going on.
- **Two directions, two different trust levels.** Read (chat sees what
  Code did) is cheap and safe — expose it eagerly. Write (chat steers
  Code) is an instruction injection — gate it like any tool call.
- **No new memory layer.** Reuse CLAUDE.md as the substrate where
  possible; shellphone is a sync/transport layer on top of files that
  already have a reason to exist.

## 3. Architecture

```
┌─────────────────┐        poll/push        ┌──────────────────┐
│  Claude Code     │◄───────────────────────►│  shellphone-mcp   │
│  (per repo)      │   .shellphone/state.md  │  (local daemon)   │
│                  │   .shellphone/queue/    │                    │
└─────────────────┘                          └────────┬──────────┘
        ▲                                              │ MCP over
        │ stop-hook writes digest                      │ localhost/tunnel
        │                                              ▼
        │                                     ┌──────────────────┐
        └────────── steer / queued msg ───────│   claude.ai Chat  │
                                                │  (shellphone      │
                                                │   connector)      │
                                                └──────────────────┘
```

Three components:

### a. `shellphone-hook` (Code-side)
A Claude Code stop-hook (and optionally a periodic hook during long
sessions). On each stop, appends a terse structured digest to
`.shellphone/state.md`:

```yaml
- ts: 2026-07-30T14:02:00Z
  repo: bitlattice
  branch: gibbs-relax-v2
  summary: >
    Implemented masked bit-lattice relaxation kernel in C; passing on
    synthetic 4x4 lattices. Blocked on deciding fixed vs adaptive
    temperature schedule for Gibbs steps.
  changed: [src/relax.c, src/lattice.h]
  next_decision: "fixed vs adaptive temperature schedule"
  open_questions: ["does adaptive schedule need its own PRNG stream?"]
```

Cheap to generate (Claude Code already has this context at session end),
cheap to read, no diff dumping.

### b. `shellphone-mcp` (the bridge itself)
A small local MCP server, one instance per machine, aware of every repo
with a `.shellphone/` directory. Exposes:

- `list_repos()` — name, branch, last-active timestamp
- `get_state(repo)` — latest digest + short rolling history (last N entries)
- `send_instruction(repo, text)` — writes to `.shellphone/queue/inbox.md`;
  if a live Remote Control session exists for that repo, pushes directly
  instead of queueing
- `get_queue_status(repo)` — has Code consumed the last instruction yet

This is the only piece that needs to be reachable from claude.ai — via
the same connector pattern as any other MCP App, added once and reused.

### c. `shellphone-cli`
Thin wrapper: `shellphone status`, `shellphone attach <repo>`. Shows the
lobster-phone in the terminal prompt when a repo has an unread instruction
waiting from chat. No daemon UI beyond this — command line only for v1.

## 4. The two flows

**Chat → knows Code (read path, MVP)**
1. You ask chat "where's bitlattice at."
2. Chat calls `get_state("bitlattice")` via the shellphone connector.
3. Chat answers from the digest — no repo access, no code exposure, just
   the last structured summary + open questions.

**Chat → steers Code (write path, v2)**
1. You decide something in chat ("use adaptive schedule, seed from repo state hash").
2. Chat calls `send_instruction("bitlattice", "...")`.
3. If Code is running under Remote Control, it lands as the next turn
   directly. If not, it sits in `.shellphone/queue/inbox.md`, and the next
   `claude` invocation in that repo picks it up as leading context
   (surfaced explicitly, not silently injected).

## 5. What's deliberately *not* in v1

- No cross-repo reasoning/aggregation — that's a chat job, not shellphone's.
- No vector store, no embeddings, no semantic search. Plain files + grep-scale reads.
- No cloud storage of state — sync happens machine-to-claude.ai directly,
  same trust boundary as any local MCP connector.
- No automatic write-back without you in the loop the first several times
  — steer path starts human-confirmed, graduates to autonomous once
  you trust the digest quality.

## 6. Validation loop (the fun part)

Once live, the test of the system *is* the system: build it under Code the
old manual way, then come back here and ask how the dev process went. If
shellphone's own digests are good enough for me to give you an accurate
answer without you having pasted anything — it works. If I'm vague or
wrong, that's the spec telling you which field in the digest schema is
underspecified.

## 7. Open questions

- Digest granularity: per-stop, or collapse consecutive stops within a
  session into one entry?
- Multi-machine repos (same repo cloned on two boxes) — does state.md
  need a machine tag, or is git branch enough of a key?
- Should `next_decision` be structured (enum-ish: blocked/needs-input/
  exploratory) so chat can triage across many repos at a glance?
- Where does this live — Latent Spacecraft OSS repo, standalone MCP
  registry listing, or both?