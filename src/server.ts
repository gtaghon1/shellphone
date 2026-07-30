import os from 'node:os';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { liveRepos, register, repoNames, resolveRepo } from './registry.js';
import { appendDigest, latestDigest, makeDigest, recentDigests } from './ledger.js';
import { appendInstruction, pending, readCursor, readInbox } from './queue.js';
import { ago, gitBranch, renderDigest, renderInstruction, truncate } from './format.js';
import { loadConfig, normalizeChanged, nowIso } from './paths.js';
import { computeDrift, driftNotice } from './drift.js';
import {
  readManifest,
  writeManifest,
  renderManifest,
  manifestAge,
  manifestPath,
  headCommit,
} from './manifest.js';
import { DIGEST_STATUSES, type Manifest } from './types.js';

export const VERSION = '0.1.0';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function unknownRepo(repo: string) {
  const known = repoNames();
  return text(
    `No repo named "${repo}".` +
      (known.length
        ? ` Known repos: ${known.join(', ')}.`
        : ' No repos are registered yet — run `shellphone init` inside one.'),
  );
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'shellphone', version: VERSION },
    {
      instructions:
        'shellphone bridges Claude Code and Claude Chat. Read tools (list_repos, ' +
        'get_state, get_queue_status) report what Code has been doing — call them ' +
        'freely. get_state returns both what a project IS (its manifest) and what ' +
        'just changed (its digests); do not confuse the two, and prefer the manifest ' +
        'when reasoning about structure or settled decisions. send_instruction steers ' +
        'a coding session and is an instruction injection: confirm the exact wording ' +
        'with the user before calling it. ' +
        'Note: this server is started once by the client. If a tool or field you ' +
        'expect is missing, the process may predate it — restarting the client is ' +
        'more likely to be the fix than requesting the feature again.',
    },
  );

  // ---- read path (SPEC §4, flow 1) -------------------------------------

  server.registerTool(
    'list_repos',
    {
      title: 'List repos',
      description:
        'Every repo on this machine that shellphone knows about, with its branch, ' +
        'triage status, last activity, and count of pending instructions. Start here ' +
        'when the user asks "what am I working on" or names a repo you have not seen.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const repos = liveRepos();
      if (!repos.length) {
        return text('No repos registered. Run `shellphone init` inside a repo to add one.');
      }
      const rows = repos
        .map((e) => {
          const d = latestDigest(e.path);
          const p = pending(e.path).length;
          return { e, d, p, t: d ? Date.parse(d.ts) : 0 };
        })
        .sort((a, b) => b.t - a.t);

      const lines = rows.map(({ e, d, p }) => {
        const man = readManifest(e.path);
        // The one-liner is what makes a list of repo names mean anything.
        const id = man ? `\n  _${truncate(man.one_liner, 120)}_` : '';
        const head = `- **${e.name}** · \`${d?.branch ?? gitBranch(e.path) ?? 'no-branch'}\``;
        if (!d) return `${head} · no digests yet${id}`;
        const flag = p ? ` · 🦞 ${p} pending instruction${p === 1 ? '' : 's'}` : '';
        const notice = driftNotice(computeDrift(e.path, d.ts));
        return (
          `${head} · **${d.status}** · ${ago(d.ts)}${flag}${id}\n  ${truncate(d.summary, 160)}` +
          (d.next_decision ? `\n  next: ${truncate(d.next_decision, 120)}` : '') +
          (notice ? `\n  ${notice}` : '')
        );
      });
      return text(`${repos.length} repo(s) on ${os.hostname()}:\n\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'get_state',
    {
      title: 'Get repo state',
      description:
        'Everything shellphone knows about a repo, in two clearly separated parts. ' +
        'First, what the project IS — its manifest: purpose, stack, layout, settled ' +
        'decisions and why they were settled, constraints, gotchas, open ' +
        'deliberations. Second, what just CHANGED — the latest session digest plus a ' +
        'short rolling history: summary, changed files, the decision Code is waiting ' +
        'on, open questions. Read the manifest part before advising on anything ' +
        'structural; read the digest part to know where things currently stand. If ' +
        'the manifest section is absent, the repo has never been surveyed — say so ' +
        'rather than inferring what the project is from its digests. No code is ' +
        'exposed, only state about it.',
      inputSchema: {
        repo: z.string().describe('Repo name from list_repos (or an absolute path).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(5)
          .describe('How many recent digests to return, newest first.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo, limit }) => {
      const entry = resolveRepo(repo);
      if (!entry) return unknownRepo(repo);
      const digests = recentDigests(entry.path, limit ?? 5);
      const man = readManifest(entry.path);
      // "What this is" before "what just happened" — a reader who has never seen
      // the repo cannot use the second without the first. Kept in separate
      // sections so a session digest is never mistaken for a standing fact.
      const identity = man
        ? `## what this project is\n\n${renderManifest(man, manifestAge(entry.path, man))}\n\n---\n\n`
        : '';

      if (!digests.length) {
        return text(
          `# ${entry.name} (${entry.machine})\n\n${identity}` +
            `**${entry.name}** is registered but has no digests yet — Code has not ` +
            `completed a session there since shellphone was installed.` +
            (man ? '' : ' No manifest either: ask Code to run `/survey` in that repo.'),
        );
      }
      const p = pending(entry.path);
      const head = `# ${entry.name} (${entry.machine})`;
      const queue = p.length
        ? `\n\n---\n\n🦞 ${p.length} instruction(s) still pending in the inbox:\n` +
          p.map(renderInstruction).join('\n')
        : '';
      const [latest, ...rest] = digests;
      // Put staleness above the digest, not below it — a reader who acts on the
      // first paragraph must not have to scroll to learn it is out of date.
      const notice = driftNotice(computeDrift(entry.path, latest!.ts));
      const banner = notice ? `\n\n> ${notice}` : '';
      const history = rest.length
        ? `\n\n---\n\n## earlier (${rest.length})\n\n` +
          rest.map((d) => `- **${d.ts}** · ${d.status} · ${truncate(d.summary, 140)}`).join('\n')
        : '';
      return text(
        `${head}${banner}\n\n${identity}## what just changed\n\n${renderDigest(latest!)}${history}${queue}`,
      );
    },
  );

  server.registerTool(
    'get_queue_status',
    {
      title: 'Get queue status',
      description:
        'Whether Code has picked up the instructions you sent. Reports two distinct ' +
        'things per instruction: announced (Code was shown it) and consumed (Code ' +
        'acted on it). Use this before re-sending anything.',
      inputSchema: {
        repo: z.string().describe('Repo name from list_repos (or an absolute path).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repo }) => {
      const entry = resolveRepo(repo);
      if (!entry) return unknownRepo(repo);
      const all = readInbox(entry.path);
      if (!all.length) return text(`**${entry.name}**: inbox is empty, nothing has been sent.`);
      const cursor = readCursor(entry.path);
      const announced = new Set(cursor.announced);
      const lines = all.slice(-10).reverse().map((i) => {
        const state = i.consumed
          ? `consumed ${ago(i.consumed)}`
          : announced.has(i.id)
            ? 'announced to Code, NOT yet acted on'
            : 'queued, Code has not seen it';
        return `- \`${i.id}\` · sent ${ago(i.sent)} · **${state}**\n  ${truncate(i.text, 200)}`;
      });
      const seen = cursor.lastChecked
        ? `Code last checked this inbox ${ago(cursor.lastChecked)}.`
        : 'Code has never checked this inbox — no session has started since the first send.';
      return text(`**${entry.name}** queue\n\n${lines.join('\n')}\n\n${seen}`);
    },
  );

  // ---- write path (SPEC §4, flow 2 — gated) -----------------------------

  server.registerTool(
    'send_instruction',
    {
      title: 'Send instruction to Code',
      description:
        'Queue an instruction for Claude Code in a repo. It lands in ' +
        '`.shellphone/queue/inbox.md` and is surfaced at the start of the next ' +
        'Claude Code session in that repo. This injects text into a coding agent: ' +
        'confirm the exact wording with the user first, and prefer decisions and ' +
        'constraints over step-by-step commands.',
      inputSchema: {
        repo: z.string().describe('Repo name from list_repos (or an absolute path).'),
        text: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            'The instruction, in the user\'s intent. State the decision and why, ' +
              'not a script. Code has the codebase; it does not have your reasoning.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ repo, text: body }) => {
      const entry = resolveRepo(repo);
      if (!entry) return unknownRepo(repo);
      const cfg = loadConfig();
      const inst = appendInstruction(entry.path, body, entry.name);
      const gate = cfg.autonomous
        ? 'Autonomous mode is on: Code may act on this without asking the user again.'
        : 'Confirmation mode is on (default): Code will show this to the user before acting.';
      return text(
        `Queued for **${entry.name}** as \`${inst.id}\`.\n\n> ${truncate(inst.text, 300)}\n\n` +
          `${gate} It will surface at the start of the next Claude Code session in that ` +
          `repo, or immediately on the next prompt if a session is already open. ` +
          `Check delivery with get_queue_status.`,
      );
    },
  );

  // ---- Code-side writer -------------------------------------------------

  server.registerTool(
    'record_digest',
    {
      title: 'Record session digest',
      description:
        'Claude Code calls this at session end to append a digest to the repo ledger. ' +
        'Write it for a reader who has no access to this transcript: what changed, what ' +
        'you are blocked on, what decision is open. Terse beats complete — if a fact ' +
        'would not change what either side does next, leave it out.',
      inputSchema: {
        repo: z
          .string()
          .describe('Repo name or absolute path. Use the repo root you are working in.'),
        summary: z
          .string()
          .min(1)
          .max(2000)
          .describe('2-4 sentences: what got done, what state it is in, what is in the way.'),
        status: z
          .enum(DIGEST_STATUSES)
          .describe(
            'wip = moving; blocked = stuck on something external; needs-input = stuck on ' +
              'a decision only the human can make; exploratory = no committed direction; ' +
              'shipped = the work item landed.',
          ),
        branch: z.string().optional().describe('Git branch. Omit to detect automatically.'),
        changed: z.array(z.string()).max(50).optional().describe('Paths touched this session.'),
        next_decision: z
          .string()
          .optional()
          .describe('The one open decision blocking progress, phrased as a choice.'),
        open_questions: z
          .array(z.string())
          .max(10)
          .optional()
          .describe('Questions you could not answer from inside the repo.'),
        session: z.string().optional().describe('Claude Code session id, if known.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      // Unregistered repos self-register here, so a fresh clone works without init.
      const entry = resolveRepo(args.repo) ?? register(args.repo);
      const d = makeDigest({
        repo: entry.name,
        summary: args.summary,
        status: args.status,
        branch: args.branch ?? gitBranch(entry.path) ?? undefined,
        machine: os.hostname(),
        changed: normalizeChanged(entry.path, args.changed ?? []),
        next_decision: args.next_decision,
        open_questions: args.open_questions,
        session: args.session,
      });
      appendDigest(entry.path, d);
      return text(`Digest recorded for **${entry.name}** (${d.status}) at ${d.ts}.`);
    },
  );

  server.registerTool(
    'record_manifest',
    {
      title: 'Record project manifest',
      description:
        'Claude Code calls this after surveying a repo, to record what the project ' +
        'IS — as opposed to what changed this session. Overwrites the previous ' +
        'manifest. Survey the actual repo before calling: read the README, walk the ' +
        'directory structure, check build/test config, and look for existing design ' +
        'docs. Record only what you verified; a confident wrong manifest is worse ' +
        'than a thin one, because nobody downstream can tell it is wrong.',
      inputSchema: {
        repo: z.string().describe('Repo name or absolute path.'),
        name: z.string().describe('Project name.'),
        one_liner: z
          .string()
          .max(200)
          .describe('One sentence, for someone who has never heard of this project.'),
        purpose: z
          .string()
          .max(1200)
          .optional()
          .describe('What it is for and who or what it serves. A short paragraph.'),
        stack: z
          .array(z.string())
          .max(30)
          .optional()
          .describe('Languages, runtimes, notable dependencies.'),
        layout: z
          .array(z.object({ path: z.string(), role: z.string() }))
          .max(40)
          .optional()
          .describe('Key directories and the role each plays. How to answer "where would that live".'),
        entry_points: z
          .record(z.string(), z.string())
          .optional()
          .describe('How to build, test, run, deploy. Keys are free-form — projects differ.'),
        decisions: z
          .array(z.object({ what: z.string(), why: z.string().optional() }))
          .max(30)
          .optional()
          .describe(
            'Settled choices and the reasoning behind them. This is what stops a ' +
              'reader re-litigating something already decided deliberately — include ' +
              'the why, or the entry does not do its job.',
          ),
        constraints: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Known limits and explicit non-goals.'),
        gotchas: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Things that will bite someone who does not already know them.'),
        open: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Live deliberations — genuinely unresolved, and known to be.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const entry = resolveRepo(args.repo) ?? register(args.repo);
      const m: Manifest = {
        name: args.name,
        one_liner: args.one_liner,
        purpose: args.purpose,
        stack: args.stack,
        layout: args.layout,
        entry_points: args.entry_points,
        decisions: args.decisions,
        constraints: args.constraints,
        gotchas: args.gotchas,
        open: args.open,
        surveyed: nowIso(),
        commit: headCommit(entry.path),
        machine: os.hostname(),
      };
      writeManifest(entry.path, m);
      return text(
        `Manifest recorded for **${entry.name}** at ${manifestPath(entry.path)}.\n\n` +
          `get_state will now lead with it. Re-run \`/survey\` when the project reshapes.`,
      );
    },
  );

  return server;
}
