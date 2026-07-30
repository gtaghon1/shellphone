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

/**
 * What a project *is*, as opposed to what just happened to it.
 *
 * Digests are volatile and append-only; a manifest is durable and overwritten.
 * Keeping them in separate files is the whole point — a reader who has never
 * seen the repo needs the manifest first and the digest second.
 *
 * The fields are chosen to generalise across repo types. The test each one had
 * to pass: does knowing this change what a reader would *do* or *advise*? Only
 * `layout` and `decisions` are close calls, and both earn it — layout is how you
 * answer "where would that live", and decisions is how you stop someone
 * re-litigating a choice that was already made deliberately.
 */
export interface Manifest {
  name: string;
  /** One sentence. What this is, for someone who has never heard of it. */
  one_liner: string;
  /** What it is for, and who or what it serves. A short paragraph. */
  purpose?: string;
  /** Languages, runtimes, notable dependencies. */
  stack?: string[];
  /** Key directories and the role each one plays. */
  layout?: { path: string; role: string }[];
  /** How to build, test, and run it. Free-form keys — projects differ. */
  entry_points?: Record<string, string>;
  /** Settled choices, with the reasoning that settled them. */
  decisions?: { what: string; why?: string }[];
  /** Known limits and explicit non-goals. */
  constraints?: string[];
  /** Things that will bite someone who doesn't know them. */
  gotchas?: string[];
  /** Live deliberations — unresolved, and known to be unresolved. */
  open?: string[];

  surveyed: string; // ISO 8601
  /** Git rev at survey time, so staleness can be measured in commits. */
  commit?: string;
  machine?: string;
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

  /**
   * Whether the stop-hook may ask for a digest once drift goes stale — the
   * auto-compact analogue. Off means `/digest` is the only way one gets written.
   */
  autoDigest: boolean;
  /** Drift thresholds. Any one of them crossing marks the ledger stale. */
  staleFiles: number;
  staleCommits: number;
  staleMinutes: number;
}
