#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_PATH,
  findRepoRoot,
  loadConfig,
  normalizeChanged,
  nowIso,
  queueDir,
  repoDir,
  saveConfig,
} from './paths.js';
import { appendDigest, latestDigest, makeDigest, recentDigests } from './ledger.js';
import { appendInstruction, consumeInstruction, pending, readInbox } from './queue.js';
import { liveRepos, register, resolveRepo, unregister } from './registry.js';
import { ago, gitBranch, truncate } from './format.js';
import { runHook } from './hooks.js';
import { computeDrift, driftNotice } from './drift.js';
import {
  readManifest,
  writeManifest,
  renderManifest,
  manifestAge,
  manifestPath,
  headCommit,
} from './manifest.js';
import { runHttp, runStdio } from './transports.js';
import {
  DIGEST_STATUSES,
  type DigestStatus,
  type RepoEntry,
  type Manifest,
} from './types.js';
import { VERSION } from './server.js';

// ---- tiny arg parser (no dependency earns its way in here) ----------------

interface Args {
  _: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val: string;
      if (eq !== -1) val = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) val = argv[++i]!;
      else val = 'true';
      out.flags.set(key, [...(out.flags.get(key) ?? []), val]);
    } else {
      out._.push(a);
    }
  }
  return out;
}

const one = (a: Args, k: string): string | undefined => a.flags.get(k)?.[0];
const many = (a: Args, k: string): string[] => a.flags.get(k) ?? [];
const has = (a: Args, k: string): boolean => a.flags.has(k);

// ---- output ---------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

const STATUS_COLOR: Record<DigestStatus, (s: string) => string> = {
  wip: c.cyan,
  blocked: c.red,
  'needs-input': c.yellow,
  exploratory: c.dim,
  shipped: c.green,
};

const say = (s = ''): void => {
  process.stdout.write(s + '\n');
};

function die(msg: string): never {
  process.stderr.write(c.red(`shellphone: ${msg}`) + '\n');
  process.exit(1);
}

function mustResolve(nameOrPath: string | undefined): RepoEntry {
  const target = nameOrPath ?? findRepoRoot(process.cwd());
  if (!target) die('no repo given, and the current directory is not a shellphone repo');
  const entry = resolveRepo(target);
  if (!entry) {
    const known = liveRepos().map((r) => r.name);
    die(
      `unknown repo "${target}".` +
        (known.length ? ` Known: ${known.join(', ')}` : ' None registered yet — run `shellphone init`.'),
    );
  }
  return entry;
}

// ---- commands -------------------------------------------------------------

function cmdInit(args: Args): void {
  const root = path.resolve(args._[0] ?? process.cwd());
  if (!fs.existsSync(root)) die(`no such directory: ${root}`);
  fs.mkdirSync(repoDir(root), { recursive: true });
  fs.mkdirSync(queueDir(root), { recursive: true });
  const entry = register(root, one(args, 'name'));
  loadConfig(); // materialise ~/.shellphone/config.json + token on first run

  say(`🦞📞 registered ${c.bold(entry.name)} → ${c.dim(entry.path)}`);
  say();
  say('Next, install the Claude Code hooks so digests write themselves:');
  say(c.cyan('  shellphone install-hooks --global'));
  say(c.dim('  (hooks no-op in repos without .shellphone/, so global is safe)'));
  say();
  say('Then connect the MCP server. For Claude Code, in this repo:');
  say(c.cyan('  claude mcp add shellphone -- shellphone mcp'));
  say();
  say('Finally, in a Claude Code session in this repo, survey the project so');
  say('chat knows what it IS and not just what changed last:');
  say(c.cyan('  /survey'));
}

function cmdStatus(): void {
  const repos = liveRepos();
  if (!repos.length) {
    say('No repos registered. Run `shellphone init` inside one.');
    return;
  }
  const rows = repos
    .map((e) => ({ e, d: latestDigest(e.path), p: pending(e.path).length }))
    .sort((a, b) => (b.d ? Date.parse(b.d.ts) : 0) - (a.d ? Date.parse(a.d.ts) : 0));

  const nameW = Math.max(...rows.map((r) => r.e.name.length), 4);
  say(c.dim(`${'REPO'.padEnd(nameW)}  ${'STATUS'.padEnd(12)}  ${'LAST'.padEnd(8)}  SUMMARY`));
  for (const { e, d, p } of rows) {
    const flag = p ? c.yellow(` 🦞${p}`) : '';
    if (!d) {
      say(`${c.bold(e.name.padEnd(nameW))}  ${c.dim('—'.padEnd(12))}  ${c.dim('never'.padEnd(8))}  ${c.dim('no digests yet')}${flag}`);
      continue;
    }
    const status = STATUS_COLOR[d.status](d.status.padEnd(12));
    say(
      `${c.bold(e.name.padEnd(nameW))}  ${status}  ${ago(d.ts).padEnd(8)}  ${truncate(d.summary, 60)}${flag}`,
    );
    const drift = computeDrift(e.path, d.ts);
    if (drift.level !== 'fresh') {
      const notice = driftNotice(drift);
      say(`${' '.repeat(nameW)}  ${drift.level === 'stale' ? c.yellow(notice) : c.dim(notice)}`);
    }
  }
  const totalPending = rows.reduce((n, r) => n + r.p, 0);
  if (totalPending) {
    say();
    say(c.yellow(`🦞📞 ${totalPending} unread instruction(s) from chat — \`shellphone inbox\``));
  }
}

function renderAttach(entry: RepoEntry, limit: number): string {
  const lines: string[] = [];
  const digests = recentDigests(entry.path, limit);
  lines.push(c.bold(`🦞📞 ${entry.name}`) + c.dim(`  ${entry.path}`));
  lines.push(c.dim(`branch ${gitBranch(entry.path) ?? '(none)'} · ${entry.machine}`));
  lines.push('');

  const d = digests[0];
  if (!d) {
    lines.push(c.dim('no digests yet'));
  } else {
    lines.push(`${STATUS_COLOR[d.status](d.status)} ${c.dim(`· ${d.ts} (${ago(d.ts)})`)}`);
    const drift = computeDrift(entry.path, d.ts);
    if (drift.level !== 'fresh') {
      lines.push(drift.level === 'stale' ? c.yellow(driftNotice(drift)) : c.dim(driftNotice(drift)));
    }
    lines.push('');
    lines.push(d.summary);
    if (d.changed?.length) lines.push('', c.dim('changed: ') + d.changed.join(', '));
    if (d.next_decision) lines.push('', c.yellow('next decision: ') + d.next_decision);
    if (d.open_questions?.length) {
      lines.push('', c.yellow('open questions:'));
      for (const q of d.open_questions) lines.push(`  - ${q}`);
    }
    if (digests.length > 1) {
      lines.push('', c.dim(`── earlier ${'─'.repeat(40)}`));
      for (const e of digests.slice(1)) {
        lines.push(c.dim(`${ago(e.ts).padStart(8)}  ${e.status.padEnd(12)}  ${truncate(e.summary, 60)}`));
      }
    }
  }

  const p = pending(entry.path);
  if (p.length) {
    lines.push('', c.yellow(`🦞 ${p.length} pending instruction(s) from chat:`));
    for (const i of p) lines.push(`  ${c.bold(i.id)} ${c.dim(ago(i.sent))}  ${truncate(i.text, 70)}`);
  }
  return lines.join('\n');
}

async function cmdAttach(args: Args): Promise<void> {
  const entry = mustResolve(args._[0]);
  const limit = Number(one(args, 'limit') ?? 5);
  if (!has(args, 'watch')) {
    say(renderAttach(entry, limit));
    return;
  }
  const interval = Math.max(1, Number(one(args, 'interval') ?? 3)) * 1000;
  let last = '';
  say(c.dim('watching — ctrl-c to stop'));
  for (;;) {
    const next = renderAttach(entry, limit);
    if (next !== last) {
      process.stdout.write('\x1b[2J\x1b[H');
      say(next);
      last = next;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

function cmdInbox(args: Args): void {
  const entry = mustResolve(args._[0]);
  const all = has(args, 'all') ? readInbox(entry.path) : pending(entry.path);
  if (!all.length) {
    say(c.dim(`${entry.name}: no ${has(args, 'all') ? '' : 'pending '}instructions`));
    return;
  }
  for (const i of all) {
    const state = i.consumed ? c.green(`consumed ${ago(i.consumed)}`) : c.yellow('PENDING');
    say(`${c.bold(i.id)} ${c.dim(`sent ${ago(i.sent)}`)} ${state}`);
    say(i.text.split('\n').map((l) => '  ' + l).join('\n'));
    say();
  }
}

function cmdAck(args: Args): void {
  const [a, b] = args._;
  // `shellphone ack <id>` inside a repo, or `shellphone ack <repo> <id>`.
  const entry = b ? mustResolve(a) : mustResolve(undefined);
  const id = b ?? a;
  if (!id) die('usage: shellphone ack [repo] <id>');
  const done = consumeInstruction(entry.path, id);
  if (!done) die(`no pending instruction "${id}" in ${entry.name}`);
  say(c.green(`acked ${id} in ${entry.name}`));
}

function cmdSend(args: Args): void {
  const entry = mustResolve(args._[0]);
  const body = args._.slice(1).join(' ') || one(args, 'text') || '';
  if (!body.trim()) die('usage: shellphone send <repo> <text...>');
  const inst = appendInstruction(entry.path, body, entry.name);
  say(c.green(`queued ${inst.id} for ${entry.name}`));
}

function cmdDigest(args: Args): void {
  const entry = mustResolve(one(args, 'repo'));
  const summary = one(args, 'summary');
  if (!summary) die('--summary is required');
  const status = (one(args, 'status') ?? 'wip') as DigestStatus;
  if (!DIGEST_STATUSES.includes(status)) {
    die(`--status must be one of: ${DIGEST_STATUSES.join(', ')}`);
  }
  const changed = normalizeChanged(
    entry.path,
    many(args, 'changed').flatMap((v) => v.split(',')),
  );
  const d = makeDigest({
    repo: entry.name,
    summary,
    status,
    branch: one(args, 'branch') ?? gitBranch(entry.path) ?? undefined,
    machine: os.hostname(),
    session: one(args, 'session'),
    changed,
    next_decision: one(args, 'next'),
    open_questions: many(args, 'question'),
  });
  appendDigest(entry.path, d);
  say(c.green(`digest recorded for ${entry.name} (${d.status})`));
}

/**
 * `shellphone survey --stdin < manifest.json` — the fallback for when the MCP
 * server isn't connected, mirroring `shellphone digest`. A manifest is far too
 * structured for command-line flags, so this one takes JSON on stdin.
 */
async function cmdSurvey(args: Args): Promise<void> {
  const entry = mustResolve(one(args, 'repo') ?? args._[0]);
  if (!has(args, 'stdin')) {
    die('usage: shellphone survey [repo] --stdin < manifest.json  (or use /survey in Claude Code)');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    die(`stdin is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw.name || !raw.one_liner) die('manifest needs at least `name` and `one_liner`');

  writeManifest(entry.path, {
    ...(raw as unknown as Manifest),
    name: String(raw.name),
    one_liner: String(raw.one_liner),
    surveyed: nowIso(),
    commit: headCommit(entry.path),
    machine: os.hostname(),
  });
  say(c.green(`manifest recorded for ${entry.name}`));
}

function cmdManifest(args: Args): void {
  const entry = mustResolve(args._[0]);
  const m = readManifest(entry.path);
  if (!m) {
    say(c.dim(`${entry.name}: no manifest yet — run \`/survey\` in Claude Code there`));
    process.exitCode = 1;
    return;
  }
  if (has(args, 'path')) return say(manifestPath(entry.path));
  if (has(args, 'json')) return say(JSON.stringify(m, null, 2));
  const age = manifestAge(entry.path, m);
  say(renderManifest(m, age));
  if (age.commits >= 25 || age.days >= 60) {
    say('');
    say(c.yellow(`This manifest may be behind — consider re-running /survey.`));
  }
}

/** Statusline / PS1 fragment. Prints nothing when there's nothing to say. */
function cmdPrompt(): void {
  const root = findRepoRoot(process.cwd());
  if (!root) return;
  const n = pending(root).length;
  if (n) process.stdout.write(`🦞📞${n}`);
}

function shellphoneCommand(): string {
  try {
    const found = execFileSync('which', ['shellphone'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) return 'shellphone';
  } catch {
    /* not on PATH — fall through to an absolute invocation */
  }
  return `node ${fileURLToPath(import.meta.url)}`;
}

/**
 * The `/digest` slash command — the `/compact` analogue. The prompt lives here
 * rather than in the hook so that asking for a digest by hand and being asked
 * for one by the hook produce the same thing.
 */
const DIGEST_COMMAND = `---
description: Write a shellphone digest of this session to the repo ledger
---

Record a shellphone digest for this repo now.

Call the \`record_digest\` tool from the "shellphone" MCP server. If that server
is not connected, run \`shellphone digest\` instead — see \`shellphone help\`.

Write the summary for a reader who cannot see this conversation and has no repo
access — that reader is a Claude Chat session the user will ask "where is this
at". 2-4 sentences: what landed, what state it is in, what is in the way. Set
\`next_decision\` only if progress is actually waiting on a choice. Terse wins:
if a detail would not change what either side does next, leave it out.

Prefer \`changed\` paths you actually edited this session, repo-relative.

Then stop. Do not summarise for the user or start new work.
`;

/**
 * `/survey` — writes the standing manifest. Separate from `/digest` because the
 * two answer different questions on different clocks: what this is, versus what
 * just happened to it.
 */
const SURVEY_COMMAND = `---
description: Survey this repo and write/refresh its shellphone project manifest
---

Survey this repository and record a shellphone project manifest.

Actually look before you write. At minimum:
- read the README and any docs/ or design notes
- walk the directory structure to identify real subsystems
- check package/build/test config for stack and entry points
- look for existing decision records, ADRs, or a CONTRIBUTING file
- check whether a manifest already exists (\`shellphone manifest\`) and treat it
  as a prior to correct, not as gospel to preserve

Then call the \`record_manifest\` tool from the "shellphone" MCP server. If that
server is not connected, pipe the same fields as JSON to \`shellphone survey
--stdin\` instead.

This is read by someone with no repo access who has never seen the project —
a Claude Chat session. Write for them.

Record only what you verified. A confident wrong manifest is worse than a thin
one: nobody downstream can tell which parts you were sure about. If you could
not determine something, leave the field out rather than guessing.

For \`decisions\`, include the *why*. A decision without its reasoning does not
stop anyone re-litigating it, which is the only reason the field exists.

Put genuinely unresolved things in \`open\` — not things you merely did not look
into.

Then stop. Do not start new work.
`;

function cmdInstallHooks(args: Args): void {
  const global = has(args, 'global');
  const claudeDir = global
    ? path.join(os.homedir(), '.claude')
    : path.join(path.resolve(args._[0] ?? process.cwd()), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  for (const [name, body] of [
    ['digest', DIGEST_COMMAND],
    ['survey', SURVEY_COMMAND],
  ] as const) {
    const cmdPath = path.join(claudeDir, 'commands', `${name}.md`);
    if (fs.existsSync(cmdPath)) continue;
    fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
    fs.writeFileSync(cmdPath, body);
    say(c.green(`installed /${name} → ${cmdPath}`));
  }

  const base = shellphoneCommand();
  const wanted: Record<string, string> = {
    Stop: `${base} hook stop`,
    SessionStart: `${base} hook session-start`,
    UserPromptSubmit: `${base} hook user-prompt`,
  };

  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      die(`${settingsPath} is not valid JSON — fix or move it first`);
    }
  }
  settings.hooks ??= {};

  const added: string[] = [];
  for (const [event, command] of Object.entries(wanted)) {
    const matchers: any[] = (settings.hooks[event] ??= []);
    const already = matchers.some((m) =>
      (m?.hooks ?? []).some((h: any) => typeof h?.command === 'string' && h.command.includes('shellphone')),
    );
    if (already) continue;
    matchers.push({ hooks: [{ type: 'command', command }] });
    added.push(event);
  }

  if (!added.length) {
    say(c.dim(`shellphone hooks already present in ${settingsPath}`));
    return;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  say(c.green(`installed ${added.join(', ')} hooks → ${settingsPath}`));
  say(c.dim('restart Claude Code (or /hooks) to pick them up'));
}

const NUMERIC_CONFIG = ['staleFiles', 'staleCommits', 'staleMinutes'] as const;

function cmdConfig(args: Args): void {
  const cfg = loadConfig();
  let touched = false;
  for (const key of ['autonomous', 'autoDigest'] as const) {
    if (has(args, key)) {
      cfg[key] = one(args, key) !== 'false';
      touched = true;
    }
  }
  for (const key of NUMERIC_CONFIG) {
    if (has(args, key)) {
      const n = Number(one(args, key));
      if (!Number.isFinite(n) || n < 0) die(`--${key} must be a non-negative number`);
      cfg[key] = n;
      touched = true;
    }
  }
  if (touched) {
    saveConfig(cfg);
    say(c.green('updated ' + CONFIG_PATH));
  }
  if (has(args, 'show-token')) {
    say(cfg.token);
    return;
  }
  say(c.dim(CONFIG_PATH));
  say(JSON.stringify({ ...cfg, token: `${cfg.token.slice(0, 6)}… (--show-token)` }, null, 2));
}

const HELP = `🦞📞 shellphone ${VERSION} — a context bridge between Claude Code and Claude Chat

  shellphone init [path] [--name N]     register a repo, create .shellphone/
  shellphone install-hooks [--global]   wire the Claude Code hooks + /digest
  shellphone status                     one line per repo: status, age, summary
  shellphone attach [repo] [--watch]    full latest digest + pending instructions
  shellphone manifest [repo] [--json]  what this project is (written by /survey)
  shellphone survey [repo] --stdin      write a manifest from JSON on stdin
  shellphone inbox [repo] [--all]       instructions sent from chat
  shellphone ack [repo] <id>            mark an instruction acted on
  shellphone send <repo> <text...>      queue an instruction locally (test the write path)
  shellphone digest --summary ... --status ...   append a digest by hand
  shellphone prompt                     statusline fragment, silent when idle
  shellphone config                     show or set config; flags:
      --autonomous B        chat may steer Code without confirmation
      --autoDigest B        stop-hook may ask for a digest when drift is stale
      --staleFiles N --staleCommits N --staleMinutes N   drift thresholds
  shellphone forget <repo>              unregister (leaves files on disk)

  shellphone mcp                        run the MCP server over stdio
  shellphone serve [--port N] [--host H]  run the MCP server over HTTP
  shellphone hook <stop|session-start|user-prompt>   hook entry points
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._.shift();

  if (!cmd || cmd === 'help' || has(args, 'help')) return say(HELP);
  if (cmd === 'version' || has(args, 'version')) return say(VERSION);

  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'install-hooks':
      return cmdInstallHooks(args);
    case 'status':
      return cmdStatus();
    case 'attach':
      return await cmdAttach(args);
    case 'inbox':
      return cmdInbox(args);
    case 'ack':
      return cmdAck(args);
    case 'send':
      return cmdSend(args);
    case 'digest':
      return cmdDigest(args);
    case 'manifest':
      return cmdManifest(args);
    case 'survey':
      return await cmdSurvey(args);
    case 'prompt':
      return cmdPrompt();
    case 'config':
      return cmdConfig(args);
    case 'forget': {
      const target = args._[0] ?? die('usage: shellphone forget <repo>');
      return say(unregister(target) ? c.green(`forgot ${target}`) : c.dim(`not registered: ${target}`));
    }
    case 'mcp':
      return await runStdio();
    case 'serve':
      return await runHttp({
        host: one(args, 'host'),
        port: one(args, 'port') ? Number(one(args, 'port')) : undefined,
      });
    case 'hook':
      return await runHook(args._[0] ?? '');
    default:
      die(`unknown command "${cmd}" — try \`shellphone help\``);
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));
