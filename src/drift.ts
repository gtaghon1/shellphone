import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeChanged, loadConfig } from './paths.js';
import type { Config } from './types.js';

/**
 * How far the repo has moved since the ledger last described it.
 *
 * Modelled on the context-window warning: a passive signal that escalates, not
 * a clock. A session where you only talked never drifts; a session that landed
 * three commits drifts immediately. The measurement is against the *ledger*,
 * not against the session — the question is "is what Chat would read still
 * true", and that has nothing to do with which session is asking.
 */

export type DriftLevel = 'fresh' | 'drifting' | 'stale';

export interface Drift {
  /** ISO timestamp we measured from — the last digest, or session start. */
  ref: string | null;
  files: string[];
  commits: number;
  minutes: number;
  level: DriftLevel;
  /** One human sentence. Empty when fresh. */
  reason: string;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function commitsSince(root: string, iso: string): number {
  try {
    return Number(git(root, ['rev-list', '--count', `--since=${iso}`, 'HEAD']).trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * `onMissing` is the interesting parameter. A file that cannot be stat'd was
 * deleted, and a deletion is real drift — but only if we know it happened after
 * the reference, which we cannot know without an mtime.
 *
 * So it depends on who is vouching. When git listed the file it is dirty *now*,
 * so a missing file is a current, uncommitted deletion: drift. When the reporter
 * is the session transcript, the edit may predate the last digest entirely, and
 * counting it is what caused the hook to demand a digest seconds after one was
 * written. Trust git, don't trust the transcript.
 */
function newerThan(root: string, rel: string, t: number, onMissing: boolean): boolean {
  try {
    return fs.statSync(path.resolve(root, rel)).mtimeMs > t;
  } catch {
    return onMissing;
  }
}

/**
 * Dirty files whose mtime is newer than the reference. Files that were edited
 * *and* committed since the reference no longer show as dirty — those are
 * counted by `commitsSince` instead, so nothing falls through the gap.
 *
 * Returns null when git could not answer, which is a different fact from an
 * empty list. Collapsing the two makes a clean tree indistinguishable from a
 * missing git, and the caller's fallback then replays the whole session.
 */
function filesModifiedSince(root: string, iso: string, cap = 500): string[] | null {
  try {
    const t = Date.parse(iso);
    const out: string[] = [];
    for (const rel of git(root, ['ls-files', '-mo', '--exclude-standard']).split('\n')) {
      if (!rel.trim() || out.length >= cap) continue;
      if (newerThan(root, rel, t, true)) out.push(rel); // git vouched: dirty now
    }
    return normalizeChanged(root, out, 50);
  } catch {
    return null;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function humanAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * @param since   the ledger's last digest timestamp, or session start if none
 * @param fallbackFiles  files known changed from elsewhere (the transcript),
 *                       used when git can't answer — a non-git repo would
 *                       otherwise report `fresh` forever and never escalate
 */
export function computeDrift(
  root: string,
  since: string | null,
  fallbackFiles: string[] = [],
  cfg: Config = loadConfig(),
  now = Date.now(),
): Drift {
  if (!since) {
    // No reference point at all: everything we know about is drift.
    const files = normalizeChanged(root, fallbackFiles, 50);
    return {
      ref: null,
      files,
      commits: 0,
      minutes: Infinity,
      level: files.length ? 'stale' : 'fresh',
      reason: files.length ? `${plural(files.length, 'file')} changed, no digest yet` : '',
    };
  }

  const t = Date.parse(since);
  const minutes = Math.max(0, (now - t) / 60000);
  const commits = commitsSince(root, since);
  const tracked = filesModifiedSince(root, since);
  // Only fall back when git could not answer at all. An empty answer from git
  // is authoritative: the tree is clean, and files this session touched *before*
  // the last digest are already described by it.
  const files =
    tracked ??
    normalizeChanged(
      root,
      fallbackFiles.filter((f) => newerThan(root, f, t, false)),
      50,
    );

  const moved = files.length > 0 || commits > 0;
  if (!moved) return { ref: since, files, commits, minutes, level: 'fresh', reason: '' };

  const parts: string[] = [];
  if (commits) parts.push(plural(commits, 'commit'));
  if (files.length) parts.push(`${plural(files.length, 'file')} changed`);
  const reason = `${parts.join(' and ')} since the last digest (${humanAge(minutes)} ago)`;

  const level: DriftLevel =
    files.length >= cfg.staleFiles || commits >= cfg.staleCommits || minutes >= cfg.staleMinutes
      ? 'stale'
      : 'drifting';

  return { ref: since, files, commits, minutes, level, reason };
}

/** The warning line shown to Chat and in the CLI. Empty when fresh. */
export function driftNotice(d: Drift): string {
  if (d.level === 'fresh') return '';
  const lead = d.level === 'stale' ? '⚠ STALE' : 'note';
  const advice =
    d.level === 'stale'
      ? ' — this digest no longer describes the repo. Ask Code to run `/digest` before relying on it.'
      : '';
  return `${lead}: ${d.reason}.${advice}`;
}
