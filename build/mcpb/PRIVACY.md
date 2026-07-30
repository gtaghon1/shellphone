# Privacy Policy

**Effective 30 July 2026.** Applies to the shellphone MCP server, CLI, and
Claude Desktop extension ("shellphone").

## Summary

shellphone runs entirely on your own computer. It has no backend, no accounts,
and no telemetry. The author receives nothing — no usage data, no error
reports, no file contents, no metadata. There is no server for that data to be
sent to.

## What shellphone collects

Nothing is collected by the author or any third party.

shellphone **reads and writes files on your machine only**:

| Path | Contents |
|---|---|
| `<repo>/.shellphone/state.md` | Session digests that Claude Code writes about its own work |
| `<repo>/.shellphone/manifest.md` | A description of the project, written by Claude Code during `/survey` |
| `<repo>/.shellphone/queue/inbox.md` | Instructions you send from a Claude chat session |
| `<repo>/.shellphone/queue/cursor.json` | Which instructions have already been shown |
| `~/.shellphone/registry.json` | Paths of repos you have registered |
| `~/.shellphone/config.json` | Local settings and a locally generated bearer token |

To answer a tool call, shellphone also reads repository metadata via `git`
(current branch, commit counts, which files are modified) and file modification
times. It does not read, transmit, or store your source code.

## How that data is used and stored

Data is stored as plain text on your local filesystem, in the locations above,
and is used only to answer tool calls from an MCP client running on the same
machine. `~/.shellphone/config.json` and `registry.json` are written with
owner-only permissions (`0600`).

The generated bearer token is used solely to authenticate requests to the
optional local HTTP transport. It is never transmitted anywhere by shellphone.

## Sharing with third parties

shellphone shares data with no one. There are no analytics, no crash reporting,
no advertising, and no third-party services.

When you use shellphone, the MCP client you connect it to — such as Claude
Desktop or Claude Code — sends tool results to Anthropic as part of your
conversation, exactly as it does for any other tool. That transfer is performed
by the client under [Anthropic's privacy
policy](https://www.anthropic.com/legal/privacy), not by shellphone. shellphone
controls only what it returns to the client on your machine: digests, manifests,
queued instructions, and repository metadata as described above.

## Optional network exposure — read this

shellphone is local-only by default. Its stdio transport opens no network
sockets at all.

If you explicitly run `shellphone serve`, it starts an HTTP server bound to
`127.0.0.1` and protected by the bearer token from your config. If you then
choose to expose that port through a tunnel you operate (for example
cloudflared, ngrok, or Tailscale) so that claude.ai can reach it, your digests
and manifests will travel over that tunnel to your chat session.

That path is off by default, requires two deliberate actions by you, and uses
infrastructure you choose and control. The author operates no such service and
has no access to it. Anyone holding both your tunnel URL and your bearer token
can read your digests and queue instructions into your repositories, so treat
the token like an SSH key and stop the tunnel when it is not in use.

## Data retention and deletion

shellphone applies no retention policy and expires nothing. Files persist until
you delete them. Because everything is plain text in known locations, you can
inspect, edit, or remove any of it at any time:

```bash
rm -rf <repo>/.shellphone     # everything shellphone knows about one repo
rm -rf ~/.shellphone          # the repo registry, config, and bearer token
```

Uninstalling the extension stops shellphone from running but does not delete
these files; remove them yourself with the commands above.

## Children's privacy

shellphone is a developer tool and is not directed at children under 13. It
collects no personal information from anyone.

## Changes to this policy

Material changes will be published in this file with an updated effective date,
and released in a new version of shellphone.

## Contact

Geoffrey Taghon — geoff.taghon@gmail.com
Issues: https://github.com/gtaghon1/shellphone/issues
