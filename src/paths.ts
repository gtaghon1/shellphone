import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './types.js';

/** Overridable so tests (and multiple daemons) don't fight over one home. */
export const HOME_DIR =
  process.env.SHELLPHONE_HOME ?? path.join(os.homedir(), '.shellphone');

export const REGISTRY_PATH = path.join(HOME_DIR, 'registry.json');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

/** Per-repo layout. */
export const REPO_DIRNAME = '.shellphone';
export const repoDir = (root: string) => path.join(root, REPO_DIRNAME);
export const statePath = (root: string) => path.join(repoDir(root), 'state.md');
export const queueDir = (root: string) => path.join(repoDir(root), 'queue');
export const inboxPath = (root: string) => path.join(queueDir(root), 'inbox.md');
/** Which instruction ids Code has already been shown. Not for humans. */
export const cursorPath = (root: string) => path.join(queueDir(root), 'cursor.json');

export function isShellphoneRepo(root: string): boolean {
  return fs.existsSync(repoDir(root));
}

/**
 * Walk up from `start` looking for a `.shellphone/` directory, so hooks work
 * from any subdirectory of a repo.
 */
export function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (isShellphoneRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function ensureHome(): void {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}

/**
 * A repo-relative path, or null if `filePath` escapes the repo root.
 *
 * Two things make this less trivial than `path.relative`. Symlinks: macOS hands
 * out `/tmp` for `/private/tmp`, so a repo reached through a symlink would
 * otherwise reject its own files. And deleted files: a path edited then removed
 * during a session can't be realpath'd, so we compare every resolved form we can
 * get and accept a match on any of them.
 */
export function relativeToRepo(root: string, filePath: string): string | null {
  // realpathSync throws on a path that no longer exists, which is routine here —
  // a session can create and delete a file in the same turn. Resolve the deepest
  // ancestor that *does* exist and re-attach the rest, so a symlinked parent
  // directory still resolves even when the leaf is gone.
  const real = (p: string): string => {
    let cur = path.resolve(p);
    const tail: string[] = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...tail);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(p);
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };
  const abs = path.resolve(root, filePath);
  const roots = [...new Set([path.resolve(root), real(root)])];
  const candidates = [...new Set([abs, real(abs)])];
  for (const r of roots) {
    for (const c of candidates) {
      const rel = path.relative(r, c);
      // '' means the path *is* the root; '..' means it escapes it.
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    }
  }
  return null;
}

/**
 * The invariant every `changed[]` in the ledger must satisfy: repo-relative,
 * inside the repo, deduped, bounded. Applied at every point that writes a
 * digest, not just where paths are detected — a ledger entry is forever, and
 * an absolute path in one is noise in someone else's checkout.
 */
export function normalizeChanged(
  root: string,
  paths: Iterable<string>,
  limit = 25,
): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p?.trim()) continue;
    const rel = relativeToRepo(root, p.trim());
    if (rel && !rel.startsWith(`${REPO_DIRNAME}/`)) out.add(rel); // our own files aren't news
  }
  return [...out].sort().slice(0, limit);
}

const DEFAULT_PORT = 7373;

export function defaultConfig(): Config {
  return {
    token: crypto.randomBytes(32).toString('base64url'),
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    autonomous: false,
    allowedHosts: [`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`],
  };
}

export function loadConfig(): Config {
  ensureHome();
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  return { ...defaultConfig(), ...raw };
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** ISO 8601 in UTC, seconds precision. Sorts lexicographically, reads fine. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function shortId(): string {
  return crypto.randomBytes(3).toString('hex');
}
