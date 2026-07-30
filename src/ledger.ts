import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { statePath, repoDir, nowIso } from './paths.js';
import { DIGEST_STATUSES, type Digest, type DigestStatus } from './types.js';

/**
 * `.shellphone/state.md` is markdown with fenced YAML entries. The heading line
 * carries enough (when / branch / status) that `less state.md` answers "what was
 * going on here" with shellphone uninstalled — SPEC §2, principle 2. The fence
 * carries the rest, and is trivially parseable without a markdown library.
 */

const FENCE_RE = /^```yaml\n([\s\S]*?)^```$/gm;

function header(repo: string): string {
  return [
    `# shellphone ledger — ${repo}`,
    '',
    '<!-- Appended by shellphone-hook on each Claude Code session stop.',
    '     Newest entries at the bottom. Plain markdown + YAML on purpose:',
    '     this file is the source of truth, shellphone is just a reader. -->',
    '',
  ].join('\n');
}

export function formatDigest(d: Digest): string {
  // Fixed key order so diffs stay small and the file reads top-down.
  const ordered: Record<string, unknown> = {
    ts: d.ts,
    repo: d.repo,
    ...(d.branch ? { branch: d.branch } : {}),
    ...(d.machine ? { machine: d.machine } : {}),
    status: d.status,
    summary: d.summary,
    ...(d.changed?.length ? { changed: d.changed } : {}),
    ...(d.next_decision ? { next_decision: d.next_decision } : {}),
    ...(d.open_questions?.length ? { open_questions: d.open_questions } : {}),
    ...(d.session ? { session: d.session } : {}),
  };
  const body = YAML.stringify(ordered, { lineWidth: 78 });
  const heading = `## ${d.ts} · ${d.branch ?? 'no-branch'} · ${d.status}`;
  return `\n${heading}\n\n\`\`\`yaml\n${body}\`\`\`\n`;
}

function coerceStatus(v: unknown): DigestStatus {
  return DIGEST_STATUSES.includes(v as DigestStatus) ? (v as DigestStatus) : 'wip';
}

function coerceList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return [v];
  return undefined;
}

/** Parse every entry in a ledger. Malformed fences are skipped, never thrown. */
export function parseLedger(text: string): Digest[] {
  const out: Digest[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    let raw: unknown;
    try {
      raw = YAML.parse(m[1]!);
    } catch {
      continue; // a hand-edited entry shouldn't blind the whole ledger
    }
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.ts !== 'string' || typeof r.summary !== 'string') continue;
    out.push({
      ts: r.ts,
      repo: String(r.repo ?? ''),
      branch: typeof r.branch === 'string' ? r.branch : undefined,
      machine: typeof r.machine === 'string' ? r.machine : undefined,
      session: typeof r.session === 'string' ? r.session : undefined,
      status: coerceStatus(r.status),
      summary: r.summary,
      changed: coerceList(r.changed),
      next_decision: typeof r.next_decision === 'string' ? r.next_decision : undefined,
      open_questions: coerceList(r.open_questions),
    });
  }
  return out;
}

export function readDigests(root: string): Digest[] {
  const p = statePath(root);
  if (!fs.existsSync(p)) return [];
  return parseLedger(fs.readFileSync(p, 'utf8'));
}

/** Newest first — the order every caller actually wants. */
export function recentDigests(root: string, limit: number): Digest[] {
  const all = readDigests(root);
  return all.slice(-limit).reverse();
}

export function latestDigest(root: string): Digest | null {
  const all = readDigests(root);
  return all.length ? all[all.length - 1]! : null;
}

export function appendDigest(root: string, d: Digest): void {
  const p = statePath(root);
  fs.mkdirSync(repoDir(root), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, header(d.repo || path.basename(root)));
  fs.appendFileSync(p, formatDigest(d));
}

/**
 * Has this Claude Code session already produced a digest? The stop-hook uses
 * this to avoid asking twice when a session stops more than once.
 */
export function hasDigestForSession(root: string, sessionId: string): boolean {
  if (!sessionId) return false;
  return readDigests(root).some((d) => d.session === sessionId);
}

export function makeDigest(input: Partial<Digest> & { summary: string; repo: string }): Digest {
  return {
    ts: input.ts ?? nowIso(),
    repo: input.repo,
    branch: input.branch,
    machine: input.machine,
    session: input.session,
    status: coerceStatus(input.status),
    summary: input.summary.trim(),
    changed: input.changed?.length ? input.changed : undefined,
    next_decision: input.next_decision || undefined,
    open_questions: input.open_questions?.length ? input.open_questions : undefined,
  };
}
