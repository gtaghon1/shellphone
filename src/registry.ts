import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REGISTRY_PATH,
  ensureHome,
  isShellphoneRepo,
  nowIso,
} from './paths.js';
import type { Registry, RepoEntry } from './types.js';

/**
 * A flat list of known repos in `~/.shellphone/registry.json`. Deliberately not
 * a filesystem scan: the MCP server should never crawl a user's disk to answer
 * `list_repos()`. Repos self-register on `shellphone init` and on first digest.
 */

export function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) return { repos: [] };
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Partial<Registry>;
    return { repos: Array.isArray(r.repos) ? r.repos : [] };
  } catch {
    return { repos: [] };
  }
}

export function saveRegistry(r: Registry): void {
  ensureHome();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
}

/** Drop entries whose `.shellphone/` is gone — repos get deleted and moved. */
export function liveRepos(): RepoEntry[] {
  const reg = loadRegistry();
  const live = reg.repos.filter((e) => isShellphoneRepo(e.path));
  if (live.length !== reg.repos.length) saveRegistry({ repos: live });
  return live;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Idempotent. Returns the entry, creating or updating as needed. */
export function register(root: string, preferredName?: string): RepoEntry {
  const abs = path.resolve(root);
  const reg = loadRegistry();
  const existing = reg.repos.find((e) => e.path === abs);
  if (existing) return existing;

  const taken = new Set(reg.repos.map((e) => e.name));
  const entry: RepoEntry = {
    name: uniqueName(preferredName || path.basename(abs), taken),
    path: abs,
    added: nowIso(),
    machine: os.hostname(),
  };
  reg.repos.push(entry);
  saveRegistry(reg);
  return entry;
}

export function unregister(nameOrPath: string): boolean {
  const reg = loadRegistry();
  const before = reg.repos.length;
  const abs = path.resolve(nameOrPath);
  reg.repos = reg.repos.filter((e) => e.name !== nameOrPath && e.path !== abs);
  if (reg.repos.length === before) return false;
  saveRegistry(reg);
  return true;
}

/** Resolve by registered name, then by path, then by case-insensitive name. */
export function resolveRepo(nameOrPath: string): RepoEntry | null {
  const repos = liveRepos();
  const abs = path.resolve(nameOrPath);
  return (
    repos.find((e) => e.name === nameOrPath) ??
    repos.find((e) => e.path === abs) ??
    repos.find((e) => e.name.toLowerCase() === nameOrPath.toLowerCase()) ??
    null
  );
}

/** For error messages — telling chat what it *could* have asked for. */
export function repoNames(): string[] {
  return liveRepos().map((e) => e.name);
}
