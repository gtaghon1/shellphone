# shellphone 🦞📞

**A context bridge between Claude Code and Claude Chat.** Two surfaces that
already talk to *you* individually now talk to *each other*, so you stop being
the modem.

See [SPEC.md](./SPEC.md) for the design rationale. This README is how to run it.

---

## What it actually does

At the end of every Claude Code session, a stop-hook makes Claude write a terse
digest of what just happened into `.shellphone/state.md` — plain markdown, in
your repo, git-trackable. A small MCP server exposes those digests to Claude
Chat, and lets Chat queue instructions back.

```
you, in chat:  "where's bitlattice at?"
chat:          get_state("bitlattice")
               → needs-input, 2h ago, blocked on fixed vs adaptive
                 temperature schedule; open question about PRNG streams
you, in chat:  "adaptive, seed from the repo state hash"
chat:          send_instruction("bitlattice", "...")
you, later:    $ claude          # in bitlattice
               🦞📞 shellphone: 1 instruction waiting from Claude Chat …
```

No code leaves the machine. shellphone moves *state about* code, never the code.

## Install

```bash
npm install -g shellphone     # or: npm link, from a clone
```

Then, once per repo you want on the wire:

```bash
cd ~/src/bitlattice
shellphone init
shellphone install-hooks --global   # safe: hooks no-op outside shellphone repos
```

`install-hooks` merges three hooks into `~/.claude/settings.json` (or
`.claude/settings.json` with no `--global`). It never overwrites hooks you
already have, and re-running it is a no-op.

| Hook | What it does |
|---|---|
| `Stop` | Blocks once per session to have Claude write its digest, then gets out of the way |
| `SessionStart` | Hands over any instruction still pending from chat |
| `UserPromptSubmit` | Catches instructions that land mid-session |

## Connecting Claude Code (stdio)

```bash
claude mcp add shellphone -- shellphone mcp
```

Worth doing even though Code is the *writing* side: it gives Claude the
`record_digest` tool, which is more reliable than the CLI fallback, and lets a
Code session read the state of your *other* repos.

## Connecting Claude Chat (HTTP)

claude.ai can't reach your laptop directly, so the HTTP transport is meant to sit
behind a tunnel.

```bash
shellphone serve                       # binds 127.0.0.1:7373
cloudflared tunnel --url http://localhost:7373    # or ngrok / tailscale funnel
```

Add the resulting `https://….../mcp` URL as a custom connector in claude.ai, with
an `Authorization: Bearer <token>` header. Get the token with:

```bash
shellphone config --show-token
```

The token is generated on first run and lives in `~/.shellphone/config.json`
(mode 0600). `/health` is unauthenticated so tunnels can probe it; it reports
nothing about your repos. Everything under `/mcp` requires the bearer token.

> The tunnel is the real trust boundary here. Anyone with the URL *and* the token
> can read your digests and queue instructions into your repos. Treat the token
> like an SSH key, and take the tunnel down when you're not using it.

## MCP tools

| Tool | Direction | Notes |
|---|---|---|
| `list_repos` | read | name, branch, triage status, age, pending count |
| `get_state(repo, limit)` | read | latest digest + rolling history |
| `get_queue_status(repo)` | read | announced vs consumed, per instruction |
| `send_instruction(repo, text)` | **write** | queues to `.shellphone/queue/inbox.md` |
| `record_digest(...)` | write (Code-side) | what the stop-hook asks Claude to call |

Read tools are cheap and safe. `send_instruction` is an instruction injection into
a coding agent, and is described to Chat as something to confirm with you first.

## CLI

```
shellphone status                    one line per repo: status, age, summary
shellphone attach [repo] [--watch]   full latest digest + pending instructions
shellphone inbox [repo] [--all]      instructions sent from chat
shellphone ack [repo] <id>           mark an instruction acted on
shellphone send <repo> <text...>     queue an instruction locally (test the write path)
shellphone prompt                    statusline fragment, silent when idle
shellphone config [--autonomous B]   show or set config
shellphone forget <repo>             unregister (leaves files on disk)
```

`shellphone prompt` prints `🦞📞2` when a repo has unread instructions and nothing
at all otherwise, so it drops straight into a statusline:

```json
{ "statusLine": { "type": "command", "command": "shellphone prompt" } }
```

## The two trust levels

Per SPEC §2, read and write are gated differently, and per SPEC §5 the write path
starts human-confirmed:

- **Default (`autonomous: false`)** — an arriving instruction is shown to Claude
  along with a protocol: show it to the user verbatim, wait for a go-ahead, then
  `shellphone ack`. Chat can put words in front of you; it can't put them in
  front of your compiler.
- **`shellphone config --autonomous true`** — Claude may act directly, but still
  has to say which instruction it's following before it starts.

Graduate to autonomous once you trust the digests. That's the whole point of
running in confirmation mode first.

## On-disk layout

```
<repo>/.shellphone/
  state.md              the ledger — append-only markdown + fenced YAML
  queue/inbox.md        instructions from chat, pending/consumed in the heading
  queue/cursor.json     which ids Code has been shown (machine-only)

~/.shellphone/
  registry.json         known repos on this machine
  config.json           bearer token, host/port, autonomous flag
```

Both markdown files are the source of truth. Read them, hand-edit them, delete
entries from them, commit them — shellphone re-reads and agrees with you. If
shellphone vanishes, `less .shellphone/state.md` still tells you what was going
on, which is the point.

## Answers to SPEC §7

- **Digest granularity** — per session, not per stop. The stop-hook records the
  session id and skips any session that already has a digest, so a session that
  stops five times still produces one entry.
- **Multi-machine repos** — every digest carries a `machine` tag (hostname). The
  registry is per-machine, so two boxes with the same repo produce two ledgers
  that reconcile through git like any other file.
- **Structured `next_decision`** — split in two. `status` is an enum
  (`wip` / `blocked` / `needs-input` / `exploratory` / `shipped`) so chat can
  triage a dozen repos at a glance; `next_decision` stays free text for the
  actual content of the choice.

## Development

```bash
npm install
npm run build
npm test
```

Tests cover the two parsers, which are the load-bearing correctness surface —
model-written prose full of colons, quotes, and code fences has to survive a
YAML round trip, and the queue has to deliver each instruction exactly once
without losing one whose session died mid-flight.

## License

MIT
