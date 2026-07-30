# Submitting shellphone to the Connectors Directory

## Which path, and why

The [submission portal](https://claude.ai/admin-settings/directory/submissions/new)
**accepts remote MCP servers only** — its own docs say local servers are
distributed as desktop extensions instead. shellphone is local by design
(SPEC §2: code never leaves the machine), so the path is:

> **Desktop extension (MCPB)** → <https://clau.de/desktop-extention-submission>

That form needs no Team or Enterprise organisation, unlike the portal.

Making shellphone a *remote* connector would mean hosting users' digests on a
server. That contradicts the first design principle and §5's "no cloud storage
of state", so it is not a fallback — it is a different product.

Reference: [submission requirements](https://claude.com/docs/connectors/building/submission)
· [building an MCPB](https://claude.com/docs/connectors/building/mcpb)
· [review criteria](https://claude.com/docs/connectors/building/review-criteria)

## Requirement status

| Requirement | Status |
|---|---|
| Tool annotations — every tool has `title` + `readOnlyHint`/`destructiveHint` | **done**, all 6 verified against the live server |
| `privacy_policies` array in `manifest.json` (manifest_version 0.2+) | **done** |
| "Privacy Policy" section in `README.md` | **done** |
| Privacy policy at an HTTPS URL, covering collection, use, sharing, retention, contact | **done** — [PRIVACY.md](./PRIVACY.md) |
| Setup and usage documentation | **done** — README |
| Example prompts exercising different tools | **done** — 4 in README |
| Icon (512×512 PNG) | **done** — `icon.png`, source in `assets/icon.svg` |
| Manifest passes `mcpb validate` | **done** |
| Bundle builds and runs from a clean unpack | **done** — `npm run pack` |
| OAuth 2.0 | **n/a** — local stdio extension, no authenticated service |
| Carousel screenshots | **n/a** — not an MCP App (no `ui/` capability) |
| Allowed link URIs | **n/a** — never calls `ui/open-link` |

## Before submitting — still open

1. **Push to GitHub.** The privacy policy URL in `manifest.json` points at
   `blob/master/PRIVACY.md`. It 404s until this is pushed, and a missing or
   unreachable privacy policy is an *immediate rejection*. Verify the URL loads
   in a logged-out browser.
2. **Test on Windows.** `manifest.json` declares `["darwin", "win32"]`. The
   server path uses only cross-platform Node APIs, so it should work, but it has
   not been run there. Either verify it or drop `win32` from `compatibility`
   before submitting — shipping an untested platform claim is worse than
   claiming less.
3. **Attach a built bundle.** `npm run pack` → `build/shellphone-<version>.mcpb`.
   Consider attaching it to a GitHub release so the README download link
   resolves.
4. **Decide on npm.** `npm publish` would make `npm install -g shellphone` work
   as documented. Until then the README's CLI instructions are aspirational, and
   a reviewer following them will fail at step one.
5. **Walk the reviewer path yourself**, on a machine without your `~/.shellphone`:
   install the `.mcpb`, run `scripts/demo-seed.sh`, and try all four example
   prompts.

## The known review risk

A reviewer who installs only the extension, on a clean machine, sees
"No repos registered" and can exercise nothing. shellphone's write side is the
CLI plus Claude Code hooks, which the bundle cannot install for you.

This is inherent — the extension is genuinely one half of a two-part tool — so
the mitigation is to make the other half trivial rather than to hide it:

- `scripts/demo-seed.sh` builds a fully populated repo with a manifest, two
  digests, and a pending instruction, using only the CLI. It is the closest
  thing a local extension has to a test account.
- The README says plainly, before the prompts, that the extension is the read
  side and what else is needed.
- `list_repos` and `get_state` name the next step when there is nothing to show,
  rather than returning an empty result.

Call this out in the submission's setup instructions rather than letting a
reviewer discover it.

## Not required, but worth doing

- A short demo GIF or screenshots of a chat session reading a digest. Not
  required for non-App extensions; useful for the listing.
- Publish to npm and list on the [MCP registry](https://github.com/modelcontextprotocol/registry).
- Tag a release matching `manifest.json`'s `version` — the manifest, the
  `package.json`, and the release tag should not disagree.
