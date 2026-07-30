/**
 * The wire format. Everything that crosses the Code↔Chat boundary is one of
 * these two shapes, and both of them live on disk as readable markdown.
 */

/**
 * Triage enum (SPEC §7, open question 3). Free-text `next_decision` says *what*
 * the decision is; `status` says whether chat should care right now. Having the
 * enum is what makes `list_repos` scannable across a dozen repos.
 */
export const DIGEST_STATUSES = [
  'wip', // moving, nothing needed from you
  'blocked', // stuck on something external (build, dep, upstream)
  'needs-input', // stuck on a decision only the human/chat can make
  'exploratory', // poking around, no committed direction yet
  'shipped', // work item landed
] as const;

export type DigestStatus = (typeof DIGEST_STATUSES)[number];

/** One Claude Code session-stop, boiled down. */
export interface Digest {
  ts: string; // ISO 8601, UTC
  repo: string;
  branch?: string;
  /** SPEC §7 open question 2: same repo on two boxes. Hostname disambiguates. */
  machine?: string;
  /** Claude Code session id, so the stop-hook can tell "already digested". */
  session?: string;
  status: DigestStatus;
  summary: string;
  changed?: string[];
  next_decision?: string;
  open_questions?: string[];
}

/** One instruction sent from chat toward Code. */
export interface Instruction {
  id: string;
  sent: string; // ISO 8601
  consumed?: string; // ISO 8601, set once Code acts on it
  text: string;
}

export interface RepoEntry {
  name: string;
  path: string;
  added: string;
  machine: string;
}

export interface Registry {
  repos: RepoEntry[];
}

export interface Config {
  /** Bearer token for the HTTP transport. Generated on first run. */
  token: string;
  host: string;
  port: number;
  /**
   * SPEC §5: the steer path starts human-confirmed and graduates to autonomous
   * once you trust the digest quality. This flag is the graduation switch — it
   * only changes the wording Code receives, never whether the message arrives.
   */
  autonomous: boolean;
  /** Host headers accepted by the HTTP transport. Empty disables the check. */
  allowedHosts: string[];
}
