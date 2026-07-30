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
 * Dirty files whose mtime is newer than the reference. Files that were edited
 * *and* committed since the reference no longer show as dirty — those are
 * counted by `commitsSince` instead, so nothing falls through the gap.
 */
function filesModifiedSince(root: string, iso: string, cap = 500): string[] {
  try {
    const t = Date.parse(iso);
    const out: string[] = [];
    for (const rel of git(root, ['ls-files', '-mo', '--exclude-standard']).split('\n')) {
      if (!rel.trim() || out.length >= cap) continue;
      try {
        if (fs.statSync(path.resolve(root, rel)).mtimeMs > t) out.push(rel);
      } catch {
        /* raced with a delete — not drift worth reporting */
      }
    }
    return normalizeChanged(root, out, 50);
  } catch {
    return [];
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

  const minutes = Math.max(0, (now - Date.parse(since)) / 60000);
  const commits = commitsSince(root, since);
  let files = filesModifiedSince(root, since);
  if (!files.length && !commits) {
    // git had nothing to say (or isn't there); fall back to what we were told.
    files = normalizeChanged(root, fallbackFiles, 50);
  }

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
