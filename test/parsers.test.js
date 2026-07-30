import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests run against the build output; `npm test` assumes `npm run build` ran.
const { formatDigest, parseLedger, makeDigest, appendDigest, readDigests, hasDigestForSession } =
  await import('../dist/ledger.js');
const { parseInbox, appendInstruction, pending, consumeInstruction, takeUnannounced, takeAllPending } =
  await import('../dist/queue.js');
const { ago, truncate } = await import('../dist/format.js');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellphone-test-'));
  fs.mkdirSync(path.join(dir, '.shellphone', 'queue'), { recursive: true });
  return dir;
}

// ---- ledger ---------------------------------------------------------------

test('digest survives a format → parse round trip', () => {
  const d = makeDigest({
    repo: 'bitlattice',
    branch: 'gibbs-relax-v2',
    machine: 'box.local',
    session: 'sess-1',
    status: 'needs-input',
    summary: 'Implemented the kernel. Blocked on schedule choice.',
    changed: ['src/relax.c', 'src/lattice.h'],
    next_decision: 'fixed vs adaptive temperature schedule',
    open_questions: ['does adaptive need its own PRNG stream?'],
  });
  const parsed = parseLedger(formatDigest(d));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], d);
});

test('summaries with YAML-hostile characters round trip intact', () => {
  // The digest is model-written prose; it will contain colons, quotes, and
  // hashes. If YAML quoting is wrong here the whole ledger silently corrupts.
  const nasty = 'Fixed: "the #1 bug" — see {a: b}, [c], 80% @ 3x\nsecond line\ttabbed';
  const d = makeDigest({ repo: 'r', summary: nasty, status: 'wip' });
  const parsed = parseLedger(formatDigest(d));
  assert.equal(parsed[0].summary, nasty);
});

test('a code fence inside a summary does not truncate the entry', () => {
  const d = makeDigest({ repo: 'r', status: 'wip', summary: 'like ```yaml\nx: 1\n``` inline' });
  const parsed = parseLedger(formatDigest(d));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].summary, d.summary);
});

test('unknown status degrades to wip rather than throwing', () => {
  const parsed = parseLedger('```yaml\nts: t\nrepo: r\nstatus: bogus\nsummary: s\n```');
  assert.equal(parsed[0].status, 'wip');
});

test('a hand-mangled entry is skipped, not fatal', () => {
  const good = formatDigest(makeDigest({ repo: 'r', status: 'wip', summary: 'fine' }));
  const bad = '\n## broken\n\n```yaml\n: : not yaml : :\n  - [\n```\n';
  const parsed = parseLedger(bad + good);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].summary, 'fine');
});

test('entries with no ts or summary are not treated as digests', () => {
  assert.equal(parseLedger('```yaml\nrepo: r\n```').length, 0);
});

test('ledger appends in order and tracks sessions', () => {
  const dir = tmpRepo();
  appendDigest(dir, makeDigest({ repo: 'r', status: 'wip', summary: 'one', session: 'a' }));
  appendDigest(dir, makeDigest({ repo: 'r', status: 'shipped', summary: 'two', session: 'b' }));
  const all = readDigests(dir);
  assert.deepEqual(all.map((d) => d.summary), ['one', 'two']);
  assert.ok(hasDigestForSession(dir, 'a'));
  assert.ok(!hasDigestForSession(dir, 'c'));
  // No session id must never count as "already digested".
  assert.ok(!hasDigestForSession(dir, ''));
  assert.match(fs.readFileSync(path.join(dir, '.shellphone', 'state.md'), 'utf8'), /^# shellphone ledger/);
});

// ---- queue ----------------------------------------------------------------

test('instruction round trips, including markdown in the body', () => {
  const dir = tmpRepo();
  const body = '## Use adaptive\n\n- seed from state hash\n- keep `--fixed` as a fallback';
  const inst = appendInstruction(dir, body, 'r');
  const [got] = pending(dir);
  assert.equal(got.id, inst.id);
  assert.equal(got.text, body);
  assert.equal(got.consumed, undefined);
});

test('consuming an instruction is idempotent and id-scoped', () => {
  const dir = tmpRepo();
  const a = appendInstruction(dir, 'first', 'r');
  const b = appendInstruction(dir, 'second', 'r');
  assert.ok(consumeInstruction(dir, a.id));
  assert.equal(consumeInstruction(dir, a.id), null, 'second consume is a no-op');
  assert.deepEqual(pending(dir).map((i) => i.id), [b.id]);
  assert.equal(consumeInstruction(dir, 'nosuch'), null);
});

test('takeUnannounced delivers each instruction exactly once', () => {
  const dir = tmpRepo();
  appendInstruction(dir, 'one', 'r');
  assert.equal(takeUnannounced(dir).length, 1);
  assert.equal(takeUnannounced(dir).length, 0, 'already announced');
  appendInstruction(dir, 'two', 'r');
  assert.deepEqual(takeUnannounced(dir).map((i) => i.text), ['two']);
});

test('takeAllPending re-announces work that was seen but never acted on', () => {
  // The case that matters: a session saw an instruction, then died without
  // acting. The next session still owes the user that instruction.
  const dir = tmpRepo();
  const a = appendInstruction(dir, 'one', 'r');
  takeUnannounced(dir);
  assert.deepEqual(takeAllPending(dir).map((i) => i.id), [a.id]);
  consumeInstruction(dir, a.id);
  assert.deepEqual(takeAllPending(dir), []);
});

test('inbox parser tolerates a hand-written file', () => {
  const parsed = parseInbox(
    '# shellphone inbox — r\n\n## pending · aa11bb · sent 2026-01-01T00:00:00Z\n\nhand written\n',
  );
  assert.deepEqual(parsed, [
    { id: 'aa11bb', sent: '2026-01-01T00:00:00Z', consumed: undefined, text: 'hand written' },
  ]);
});

// ---- format ---------------------------------------------------------------

test('ago renders coarse relative time', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const at = (s) => ago(new Date(now - s * 1000).toISOString(), now);
  assert.equal(at(5), '5s ago');
  assert.equal(at(120), '2m ago');
  assert.equal(at(7200), '2h ago');
  assert.equal(at(172800), '2d ago');
  assert.equal(ago('not-a-date'), 'unknown');
});

test('truncate flattens newlines so table rows stay one line', () => {
  assert.equal(truncate('a\nb   c', 20), 'a b c');
  assert.equal(truncate('abcdef', 4), 'abc…');
});
