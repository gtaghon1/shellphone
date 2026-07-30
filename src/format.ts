import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeChanged } from './paths.js';
import type { Digest, Instruction } from './types.js';

/** "3m ago" / "2d ago" — chat reasons about recency far better than about timestamps. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

/** Current branch, or null outside a git worktree. Never throws. */
export function gitBranch(root: string): string | null {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Uncommitted paths — a cheap, honest `changed` list when the transcript is thin.
 *
 * Porcelain paths are relative to the *git* root, which is not necessarily the
 * shellphone root (a repo can be initialised in a subdirectory). Resolve against
 * the toplevel before re-relativising, or the ledger records paths that resolve
 * to nothing.
 */
export function gitDirtyFiles(root: string, limit = 20): string[] {
  try {
    const git = (args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const top = git(['rev-parse', '--show-toplevel']).trim() || root;
    const paths = git(['status', '--porcelain'])
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const entry = l.slice(3).trim();
        // Renames arrive as `old -> new`; only the destination still exists.
        const arrow = entry.lastIndexOf(' -> ');
        const p = arrow === -1 ? entry : entry.slice(arrow + 4);
        // Porcelain quotes paths containing spaces or control characters.
        return p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p;
      })
      .map((p: string) => path.resolve(top, p));
    return normalizeChanged(root, paths, limit);
  } catch {
    return [];
  }
}

export function renderDigest(d: Digest): string {
  const lines = [
    `**${d.ts}** · \`${d.branch ?? 'no-branch'}\` · **${d.status}**${
      d.machine ? ` · ${d.machine}` : ''
    }`,
    '',
    d.summary,
  ];
  if (d.changed?.length) lines.push('', `changed: ${d.changed.map((c) => `\`${c}\``).join(', ')}`);
  if (d.next_decision) lines.push('', `next decision: ${d.next_decision}`);
  if (d.open_questions?.length) {
    lines.push('', 'open questions:', ...d.open_questions.map((q) => `- ${q}`));
  }
  return lines.join('\n');
}

export function renderInstruction(i: Instruction): string {
  const state = i.consumed ? `consumed ${ago(i.consumed)}` : 'PENDING';
  return `- \`${i.id}\` · sent ${ago(i.sent)} · ${state}\n  ${truncate(i.text, 200)}`;
}
