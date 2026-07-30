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
| `Stop` | Asks for a digest, but only once the ledger has gone stale (see below) |
| `SessionStart` | Hands over any instruction still pending from chat |
| `UserPromptSubmit` | Catches instructions that land mid-session |

It also installs a `/digest` slash command.

## Two documents, two clocks

A digest answers *what just changed*. It cannot answer *what is this*, and a
reader who has never seen the repo needs the second question answered first.

So there are two files, deliberately not one:

| | `state.md` | `manifest.md` |
|---|---|---|
| answers | what just changed | what this project is |
| written by | `/digest`, or the stop-hook | `/survey`, on demand |
| lifecycle | append-only, one entry per drift | overwritten in place |
| changes | every session | when the project reshapes |

```bash
/survey                     # in Claude Code — reads the repo, writes the manifest
shellphone manifest         # read it back
shellphone manifest --json  # ...as JSON
```

The manifest records identity, stack, layout, entry points, **settled decisions
with their reasoning**, constraints, gotchas, and open deliberations. The
decisions field is the one that earns its place: a decision without its *why*
doesn't stop anyone re-litigating it, which is the only reason to record it.

`get_state` leads with the manifest and follows with the digest, under separate
headings, so a standing fact is never mistaken for something that happened last
Tuesday. `list_repos` shows each repo's one-liner, which is what makes a list of
repo names mean anything.

Staleness here is **reported, not thresholded** — you get "surveyed 12d ago, 40
commits since" and make your own call. Two hundred commits of bugfixes may not
change what a project is, while one commit adding a subsystem does; a hard
threshold would only cry wolf.

## Drift, or: when does a digest get written

Digests work like context compaction. There's a verb you invoke whenever you
want one, a passive signal that builds up, and an automatic trigger at the far
end that you'll rarely hit.

| Context window | shellphone |
|---|---|
| `/compact` | `/digest` — write one now |
| "context left until auto-compact" | drift, shown in `shellphone status` *and* to Chat |
| auto-compact at the threshold | `Stop` hook asks, once drift is stale |

**Drift is measured against the ledger, not against your session.** The question
is whether what Chat would read is still true, and that doesn't depend on who is
asking or how long they've been asking for. Concretely, drift is commits plus
changed files since the last digest — so a session where you only *talked* never
drifts, and one that landed three commits drifts immediately.

Three levels:

- **fresh** — nothing has moved. No warning anywhere, no interruption.
- **drifting** — something moved, but not much. A quiet note in `status` and in
  what Chat reads. Never interrupts.
- **stale** — past a threshold. Chat is told, in the first line it reads, that
  the digest no longer describes the repo. The `Stop` hook asks for a fresh one.

Age alone never makes a digest stale. A month-old digest for a repo nobody has
touched is still perfectly accurate, and nagging about it would train you to
ignore the warning that matters.

```bash
shellphone config --staleFiles 5 --staleCommits 2 --staleMinutes 45   # defaults
shellphone config --autoDigest false     # never interrupt; /digest only
```

> This design came out of dogfooding. v0.1.0 wrote one digest per session, at the
> *first* stop — so it described the least-finished state a session ever had and
> then went quiet for hours. The ledger didn't just go stale, it went stale while
> reading as current, which is worse than having no ledger at all.

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
| `record_digest(...)` | write (Code-side) | what `/digest` and the stop-hook call |
| `record_manifest(...)` | write (Code-side) | what `/survey` calls |

Read tools are cheap and safe. `send_instruction` is an instruction injection into
a coding agent, and is described to Chat as something to confirm with you first.

## CLI

```
shellphone status                    one line per repo: status, age, summary
shellphone attach [repo] [--watch]   full latest digest + pending instructions
shellphone manifest [repo] [--json]  what this project is
shellphone survey [repo] --stdin     write a manifest from JSON (CLI fallback for /survey)
shellphone inbox [repo] [--all]      instructions sent from chat
shellphone ack [repo] <id>           mark an instruction acted on
shellphone send <repo> <text...>     queue an instruction locally (test the write path)
shellphone prompt                    statusline fragment, silent when idle
shellphone config                    show or set config (see Drift, above)
shellphone forget <repo>             unregister (leaves files on disk)
```

Inside Claude Code, `/digest` writes one immediately — that's the ergonomic path,
and the one to reach for before switching over to Chat.

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
  manifest.md           what the project is — overwritten by /survey
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

- **Digest granularity** — neither per-stop nor per-session: per *drift*. Both of
  the original options are wrong, and dogfooding showed why. Per-stop spams the
  ledger, since `Stop` fires at the end of every turn. Per-session sounds right
  but collapses to the **first** stop, describing the least-finished state the
  session ever had. Writing when the repo has actually moved is the only version
  where the cost is proportional to the value. See *Drift*, above.
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
