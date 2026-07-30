import fs from 'node:fs';
import path from 'node:path';
import { inboxPath, queueDir, cursorPath, nowIso, shortId } from './paths.js';
import type { Instruction } from './types.js';

/**
 * `.shellphone/queue/inbox.md` — the write path (SPEC §4). Same principle as the
 * ledger: a human can read it, hand-write an entry, or delete one, and shellphone
 * will agree with them.
 *
 * Two distinct lifecycle points, and conflating them is what makes queues lie:
 *   announced — Code has been *shown* the instruction (tracked in cursor.json)
 *   consumed  — Code has *acted* on it (tracked here, in the heading)
 * `get_queue_status` reports both, because "did it arrive" and "did it land"
 * are different questions and chat needs the second one.
 */

const ENTRY_RE =
  /^## (pending|consumed) · ([0-9a-f]+) · sent (\S+)(?: · consumed (\S+))?[ \t]*$/gm;

function header(repo: string): string {
  return [
    `# shellphone inbox — ${repo}`,
    '',
    '<!-- Instructions from Claude Chat, newest at the bottom.',
    '     `pending` means Claude Code has not acted on it yet.',
    '     Edit or delete entries by hand freely; shellphone re-reads this file. -->',
    '',
  ].join('\n');
}

export function parseInbox(text: string): Instruction[] {
  const out: Instruction[] = [];
  const matches = [...text.matchAll(ENTRY_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    out.push({
      id: m[2]!,
      sent: m[3]!,
      consumed: m[1] === 'consumed' ? (m[4] ?? 'unknown') : undefined,
      text: text.slice(start, end).trim(),
    });
  }
  return out;
}

export function readInbox(root: string): Instruction[] {
  const p = inboxPath(root);
  if (!fs.existsSync(p)) return [];
  return parseInbox(fs.readFileSync(p, 'utf8'));
}

export function pending(root: string): Instruction[] {
  return readInbox(root).filter((i) => !i.consumed);
}

export function appendInstruction(root: string, text: string, repoName: string): Instruction {
  const inst: Instruction = { id: shortId(), sent: nowIso(), text: text.trim() };
  const p = inboxPath(root);
  fs.mkdirSync(queueDir(root), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, header(repoName || path.basename(root)));
  fs.appendFileSync(p, `\n## pending · ${inst.id} · sent ${inst.sent}\n\n${inst.text}\n`);
  return inst;
}

/**
 * Mark one instruction consumed. Returns null if the id isn't pending — callers
 * report that rather than silently succeeding.
 */
export function consumeInstruction(root: string, id: string): Instruction | null {
  const p = inboxPath(root);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const found = parseInbox(text).find((i) => i.id === id && !i.consumed);
  if (!found) return null;
  const ts = nowIso();
  const updated = text.replace(
    new RegExp(`^## pending · ${id} · sent (\\S+)[ \\t]*$`, 'm'),
    `## consumed · ${id} · sent $1 · consumed ${ts}`,
  );
  fs.writeFileSync(p, updated);
  return { ...found, consumed: ts };
}

interface Cursor {
  /** Instruction ids already surfaced to Code, so we announce each once. */
  announced: string[];
  /** Last time Code looked at the inbox at all. Chat uses this for liveness. */
  lastChecked?: string;
}

export function readCursor(root: string): Cursor {
  const p = cursorPath(root);
  if (!fs.existsSync(p)) return { announced: [] };
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Cursor>;
    return { announced: c.announced ?? [], lastChecked: c.lastChecked };
  } catch {
    return { announced: [] };
  }
}

export function writeCursor(root: string, c: Cursor): void {
  fs.mkdirSync(queueDir(root), { recursive: true });
  fs.writeFileSync(cursorPath(root), JSON.stringify(c, null, 2) + '\n');
}

/** Record that Code has been shown these ids, and that it looked just now. */
export function markAnnounced(root: string, ids: string[]): void {
  const cursor = readCursor(root);
  const merged = [...new Set([...cursor.announced, ...ids])];
  writeCursor(root, { announced: merged.slice(-200), lastChecked: nowIso() });
}

/**
 * Pending instructions Code hasn't been shown yet, marking them announced as a
 * side effect. This is the "deliver once" primitive, used mid-session so a
 * message that lands while you're typing doesn't get repeated every turn.
 */
export function takeUnannounced(root: string): Instruction[] {
  const seen = new Set(readCursor(root).announced);
  const fresh = pending(root).filter((i) => !seen.has(i.id));
  markAnnounced(root, fresh.map((i) => i.id));
  return fresh;
}

/**
 * Everything still pending, re-announced. Used at session start: an instruction
 * a previous session saw but never acted on is still owed to the user.
 */
export function takeAllPending(root: string): Instruction[] {
  const p = pending(root);
  markAnnounced(root, p.map((i) => i.id));
  return p;
}
