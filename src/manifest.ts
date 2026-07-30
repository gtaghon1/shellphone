import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { repoDir, nowIso } from './paths.js';
import type { Manifest } from './types.js';

/**
 * `.shellphone/manifest.md` — the standing description of a project.
 *
 * Same markdown-plus-fenced-YAML shape as the ledger, for the same reason: it
 * has to be readable and hand-editable with shellphone uninstalled. The one
 * structural difference is that this file is *overwritten*, not appended. A
 * manifest describes the present; keeping a history of what a project used to
 * be is what git is for, and mixing a mutable document into an append-only
 * ledger would make both harder to reason about.
 */

export const manifestPath = (root: string) => path.join(repoDir(root), 'manifest.md');

const FENCE_RE = /^```yaml\n([\s\S]*?)^```$/m;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v];
  return undefined;
}

export function parseManifest(text: string): Manifest | null {
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = YAML.parse(m[1]!);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!str(r.name) || !str(r.one_liner)) return null;

  const layout = Array.isArray(r.layout)
    ? r.layout
        .map((e) => {
          const o = e as Record<string, unknown>;
          return { path: String(o?.path ?? ''), role: String(o?.role ?? '') };
        })
        .filter((e) => e.path)
    : undefined;

  const decisions = Array.isArray(r.decisions)
    ? r.decisions
        .map((e) => {
          if (typeof e === 'string') return { what: e };
          const o = e as Record<string, unknown>;
          return { what: String(o?.what ?? ''), why: str(o?.why) };
        })
        .filter((e) => e.what)
    : undefined;

  const entry =
    r.entry_points && typeof r.entry_points === 'object' && !Array.isArray(r.entry_points)
      ? Object.fromEntries(
          Object.entries(r.entry_points as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        )
      : undefined;

  return {
    name: str(r.name)!,
    one_liner: str(r.one_liner)!,
    purpose: str(r.purpose),
    stack: strList(r.stack),
    layout: layout?.length ? layout : undefined,
    entry_points: entry && Object.keys(entry).length ? entry : undefined,
    decisions: decisions?.length ? decisions : undefined,
    constraints: strList(r.constraints),
    gotchas: strList(r.gotchas),
    open: strList(r.open),
    surveyed: str(r.surveyed) ?? nowIso(),
    commit: str(r.commit),
    machine: str(r.machine),
  };
}

export function formatManifest(m: Manifest): string {
  const ordered: Record<string, unknown> = {
    name: m.name,
    one_liner: m.one_liner,
    ...(m.purpose ? { purpose: m.purpose } : {}),
    ...(m.stack?.length ? { stack: m.stack } : {}),
    ...(m.layout?.length ? { layout: m.layout } : {}),
    ...(m.entry_points && Object.keys(m.entry_points).length
      ? { entry_points: m.entry_points }
      : {}),
    ...(m.decisions?.length ? { decisions: m.decisions } : {}),
    ...(m.constraints?.length ? { constraints: m.constraints } : {}),
    ...(m.gotchas?.length ? { gotchas: m.gotchas } : {}),
    ...(m.open?.length ? { open: m.open } : {}),
    surveyed: m.surveyed,
    ...(m.commit ? { commit: m.commit } : {}),
    ...(m.machine ? { machine: m.machine } : {}),
  };
  return [
    `# shellphone manifest — ${m.name}`,
    '',
    '<!-- What this project IS. Overwritten by `/survey`, not appended to.',
    '     Hand-edit freely: shellphone re-reads this file and will not clobber',
    '     it until the next survey. Digests live in state.md. -->',
    '',
    `> ${m.one_liner}`,
    '',
    '```yaml',
    YAML.stringify(ordered, { lineWidth: 78 }) + '```',
    '',
  ].join('\n');
}

export function readManifest(root: string): Manifest | null {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    return parseManifest(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeManifest(root: string, m: Manifest): void {
  fs.mkdirSync(repoDir(root), { recursive: true });
  fs.writeFileSync(manifestPath(root), formatManifest(m));
}

export function headCommit(root: string): string | undefined {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * How out of date the manifest looks, in commits since the survey.
 *
 * Deliberately reported rather than thresholded. A manifest going stale is a
 * slow, judgement-laden thing — 200 commits of bugfixes may not change what a
 * project *is*, while one commit adding a subsystem does. Give the reader the
 * number and let them decide; a hard threshold here would just cry wolf.
 */
export function manifestAge(root: string, m: Manifest): { commits: number; days: number } {
  const days = Math.max(0, (Date.now() - Date.parse(m.surveyed)) / 86_400_000);
  let commits = 0;
  if (m.commit) {
    try {
      commits =
        Number(
          execFileSync('git', ['-C', root, 'rev-list', '--count', `${m.commit}..HEAD`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim(),
        ) || 0;
    } catch {
      commits = 0; // the recorded rev is gone (rebased, or a fresh clone)
    }
  }
  return { commits, days };
}

/** Markdown rendering for Chat. */
export function renderManifest(m: Manifest, age?: { commits: number; days: number }): string {
  const lines = [`**${m.name}** — ${m.one_liner}`];
  if (m.purpose) lines.push('', m.purpose);
  if (m.stack?.length) lines.push('', `**stack:** ${m.stack.join(', ')}`);
  if (m.layout?.length) {
    lines.push('', '**layout:**', ...m.layout.map((l) => `- \`${l.path}\` — ${l.role}`));
  }
  if (m.entry_points && Object.keys(m.entry_points).length) {
    lines.push(
      '',
      '**entry points:**',
      ...Object.entries(m.entry_points).map(([k, v]) => `- ${k}: \`${v}\``),
    );
  }
  if (m.decisions?.length) {
    lines.push(
      '',
      '**settled decisions** (do not re-litigate without reason):',
      ...m.decisions.map((d) => `- ${d.what}${d.why ? ` — *${d.why}*` : ''}`),
    );
  }
  if (m.constraints?.length) {
    lines.push('', '**constraints / non-goals:**', ...m.constraints.map((c) => `- ${c}`));
  }
  if (m.gotchas?.length) lines.push('', '**gotchas:**', ...m.gotchas.map((g) => `- ${g}`));
  if (m.open?.length) lines.push('', '**open deliberations:**', ...m.open.map((o) => `- ${o}`));

  const surveyed = `surveyed ${Math.round(age?.days ?? 0)}d ago`;
  const drift = age?.commits ? `, ${age.commits} commit(s) since` : '';
  lines.push('', `_${surveyed}${drift}._`);
  return lines.join('\n');
}
