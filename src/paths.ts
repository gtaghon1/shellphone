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
